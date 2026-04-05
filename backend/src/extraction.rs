/// Post-session extraction pipeline.
///
/// Converts distillations → abstracted_tasks → agent PRs.
/// Uses Claude Sonnet for segmentation, matching, and drift detection.
/// Now also triggers reasoning pipeline and genesis path for unmatched tasks.
use serde_json::Value;
use tracing::{info, warn};
use uuid::Uuid;

use crate::agent_catalog::AgentCatalog;
use crate::anthropic::{user_message, AnthropicClient};
use crate::pg::PgClient;
use crate::pr_engine::{self, DriftResult};
use crate::reasoning;

/// Run the full extraction pipeline for a completed observation session.
pub async fn run_extraction(
    db: &PgClient,
    catalog: &AgentCatalog,
    api_key: &str,
    model: &str,
    session_id: &str,
    expert_id: Option<uuid::Uuid>,
) -> anyhow::Result<()> {
    info!(session = %session_id, "starting extraction pipeline");

    let sid: uuid::Uuid = session_id.parse()
        .map_err(|_| anyhow::anyhow!("invalid session_id UUID"))?;
    let distillations = db.execute_with(
        "SELECT narrator_text, expert_correction, sequence_ref FROM distillations WHERE session_id = $1 ORDER BY sequence_ref",
        crate::pg_args!(sid),
    ).await?;

    if distillations.is_empty() {
        info!(session = %session_id, "no distillations — skipping extraction");
        return Ok(());
    }

    let client = AnthropicClient::new(api_key.to_string(), model.to_string());

    // Step 1: Segment distillations into abstracted tasks
    let tasks = segment_distillations(&client, &distillations, model).await?;
    info!(session = %session_id, tasks = tasks.len(), "segmentation complete");

    // Persist tasks (now includes expert_heuristic)
    for task in &tasks {
        if let Err(e) = db.execute_with(
            "INSERT INTO abstracted_tasks (id, session_id, description, expert_heuristic, status) \
             VALUES ($1, $2, $3, $4, 'pending')",
            crate::pg_args!(task.id, sid, task.description.clone(), task.expert_heuristic.clone()),
        ).await {
            warn!(task_id = %task.id, error = %e, "failed to persist abstracted task");
        }
    }

    // Step 2: Match tasks to agents
    let catalog_summary = catalog.catalog_summary_for_expert(expert_id);
    let matches = match_tasks_to_agents(&client, &tasks, &catalog_summary, model).await?;
    info!(session = %session_id, matches = matches.len(), "matching complete");

    for m in &matches {
        let status = if m.confidence >= 0.60 { "matched" } else { "unmatched" };
        if let Err(e) = db.execute_with(
            "UPDATE abstracted_tasks SET matched_agent_slug = $1, match_confidence = $2, status = $3 WHERE id = $4",
            crate::pg_args!(
                m.matched_agent_slug.clone(),
                m.confidence,
                status.to_string(),
                m.task_id
            ),
        ).await {
            warn!(task_id = %m.task_id, error = %e, "failed to update task match");
        }
    }

    // Step 3: Drift detection for high-confidence matches
    let high_confidence: Vec<_> = matches
        .iter()
        .filter(|m| m.confidence >= 0.85 && m.matched_agent_slug.is_some())
        .collect();

    info!(session = %session_id, high_confidence = high_confidence.len(), "running drift detection");

    for m in high_confidence {
        let slug = m.matched_agent_slug.as_deref().unwrap();
        let task = match tasks.iter().find(|t| t.id == m.task_id) {
            Some(t) => t,
            None => continue,
        };

        let agent = match catalog.get(slug) {
            Some(a) => a,
            None => continue,
        };

        let drift = detect_drift(
            &client,
            &task.description,
            &task.expert_heuristic,
            slug,
            &agent.system_prompt,
            &agent.judge_config.rubric,
            model,
        )
        .await;

        match drift {
            Ok(drift) if drift.drift_detected => {
                info!(agent = slug, gap = %drift.gap_description, "drift detected — creating PR");
                let _ = pr_engine::create_enhancement_pr(
                    db, slug, &drift, task, session_id, m.confidence,
                )
                .await;
            }
            Ok(_) => {
                info!(agent = slug, "no drift detected");
            }
            Err(e) => {
                warn!(agent = slug, error = %e, "drift detection failed");
            }
        }
    }

    // Step 4: Genesis path — propose new agents for unmatched tasks
    let unmatched: Vec<_> = matches
        .iter()
        .filter(|m| m.confidence < 0.60)
        .collect();

    if !unmatched.is_empty() {
        info!(session = %session_id, unmatched = unmatched.len(), "checking genesis path for unmatched tasks");

        let unmatched_tasks: Vec<&AbstractedTask> = unmatched
            .iter()
            .filter_map(|m| tasks.iter().find(|t| t.id == m.task_id))
            .collect();

        if unmatched_tasks.len() >= 2 {
            let proposed_slug = infer_slug(api_key, model, &unmatched_tasks).await;
            let descriptions: Vec<String> = unmatched_tasks.iter().map(|t| t.description.clone()).collect();
            let heuristics: Vec<String> = unmatched_tasks.iter().map(|t| t.expert_heuristic.clone()).collect();
            let session_ids = vec![session_id.to_string()];

            match pr_engine::create_new_agent_pr(
                db, api_key, model, &proposed_slug, &descriptions, &heuristics, &session_ids,
            )
            .await
            {
                Ok(pr_id) => info!(pr = %pr_id, slug = proposed_slug, "genesis PR created"),
                Err(e) => warn!(error = %e, "genesis PR creation failed"),
            }
        }
    }

    // Step 5: Run reasoning pipeline (analyzes for deeper feedback signals)
    if let Err(e) = reasoning::run_reasoning(db, catalog, api_key, model, session_id, expert_id).await {
        warn!(error = %e, "reasoning pipeline failed");
    }

    info!(session = %session_id, "extraction pipeline complete");
    Ok(())
}

// ── Data types ───────────────────────────────────────────────────────────────

pub struct AbstractedTask {
    pub id: Uuid,
    pub description: String,
    pub expert_heuristic: String,
    pub tools_used: Vec<String>,
    pub sequence_refs: Vec<i64>,
}

pub struct MatchResult {
    pub task_id: Uuid,
    pub matched_agent_slug: Option<String>,
    pub confidence: f64,
    pub reasoning: String,
}

// ── Step 1: Segmentation ─────────────────────────────────────────────────────

async fn segment_distillations(
    client: &AnthropicClient,
    distillations: &[Value],
    model: &str,
) -> anyhow::Result<Vec<AbstractedTask>> {
    let mut narration_text = String::new();
    for d in distillations {
        let text = d
            .get("narrator_text")
            .and_then(Value::as_str)
            .unwrap_or("");
        let correction = d.get("expert_correction").and_then(Value::as_str);
        let seq = d.get("sequence_ref").and_then(Value::as_i64).unwrap_or(0);

        narration_text.push_str(&format!("[seq:{}] {}", seq, text));
        if let Some(c) = correction {
            narration_text.push_str(&format!("\n  [EXPERT CORRECTION]: {}", c));
        }
        narration_text.push('\n');
    }

    let system = r#"You are a GTM workflow analyst. Given a sequence of real-time narrations from an expert GTM session, extract distinct, atomic tasks the expert performed.

Each task should be:
- One discrete action or decision (not a compound activity)
- Described in terms of WHAT was done and WHY (intent, not mechanics)
- Specific enough to match against an agent catalog

Expert corrections override narrator interpretations — treat corrections as ground truth.

Output a JSON array (no other text):
[
  {
    "description": "Built ICP targeting mid-market fintech companies (50-200 employees) in NYC metro area",
    "expert_heuristic": "Expert prioritized company size 50-200 as sweet spot for product price point",
    "tools_used": ["LinkedIn Sales Navigator filters"],
    "sequence_refs": [1, 2, 3]
  }
]"#;

    let prompt = format!("## Expert Session Narrations\n\n{}", narration_text);

    let response = client
        .messages(system, &[user_message(prompt)], &[], 4096, Some(model))
        .await?;

    let text = response.text();
    let cleaned = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let parsed: Vec<Value> = serde_json::from_str(cleaned)
        .map_err(|e| anyhow::anyhow!("segmentation JSON parse error: {e}\nRaw: {cleaned}"))?;

    let tasks = parsed
        .into_iter()
        .map(|v| AbstractedTask {
            id: Uuid::new_v4(),
            description: v
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            expert_heuristic: v
                .get("expert_heuristic")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            tools_used: v
                .get("tools_used")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(String::from)
                        .collect()
                })
                .unwrap_or_default(),
            sequence_refs: v
                .get("sequence_refs")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_i64).collect())
                .unwrap_or_default(),
        })
        .collect();

    Ok(tasks)
}

// ── Step 2: Agent Matching ───────────────────────────────────────────────────

async fn match_tasks_to_agents(
    client: &AnthropicClient,
    tasks: &[AbstractedTask],
    catalog_summary: &str,
    model: &str,
) -> anyhow::Result<Vec<MatchResult>> {
    let mut task_descriptions = String::new();
    for (i, task) in tasks.iter().enumerate() {
        task_descriptions.push_str(&format!(
            "Task {}: {}\n  Heuristic: {}\n",
            i, task.description, task.expert_heuristic
        ));
    }

    let system = r#"You are matching expert GTM tasks to an agent catalog. For each task, find the most relevant agent.

Confidence scale:
- 0.85+: Strong match — agent handles this exact task type
- 0.60-0.84: Partial match — agent covers related area but task has nuances
- <0.60: No match — no existing agent handles this

Output a JSON array (no other text):
[
  {
    "task_index": 0,
    "matched_agent_slug": "icp_builder",
    "confidence": 0.92,
    "reasoning": "Expert was defining firmographic criteria which is exactly what icp_builder does"
  }
]

If no agent matches, set matched_agent_slug to null and confidence to 0.0."#;

    let prompt = format!(
        "## Agent Catalog\n\n{}\n\n## Tasks to Match\n\n{}",
        catalog_summary, task_descriptions
    );

    let response = client
        .messages(system, &[user_message(prompt)], &[], 4096, Some(model))
        .await?;

    let text = response.text();
    let cleaned = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let parsed: Vec<Value> = serde_json::from_str(cleaned)
        .map_err(|e| anyhow::anyhow!("matching JSON parse error: {e}"))?;

    let results = parsed
        .into_iter()
        .filter_map(|v| {
            let idx = v.get("task_index")?.as_u64()? as usize;
            let task = tasks.get(idx)?;
            Some(MatchResult {
                task_id: task.id,
                matched_agent_slug: v
                    .get("matched_agent_slug")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(String::from),
                confidence: v.get("confidence").and_then(Value::as_f64).unwrap_or(0.0),
                reasoning: v
                    .get("reasoning")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            })
        })
        .collect();

    Ok(results)
}

// ── Step 3: Drift Detection ──────────────────────────────────────────────────

async fn detect_drift(
    client: &AnthropicClient,
    task_description: &str,
    expert_heuristic: &str,
    agent_slug: &str,
    agent_prompt: &str,
    agent_rubric: &[String],
    model: &str,
) -> anyhow::Result<DriftResult> {
    let rubric_text = agent_rubric
        .iter()
        .enumerate()
        .map(|(i, r)| format!("{}. {}", i + 1, r))
        .collect::<Vec<_>>()
        .join("\n");

    let system = "You are comparing an expert's actual behavior to an AI agent's current instructions to detect gaps.\n\nBe precise: only flag drift if the expert demonstrably did something the agent's prompt does NOT cover. If the prompt already addresses the behavior (even implicitly), drift_detected should be false.\n\nWhen writing prompt_addition, write it in the same style as the existing prompt — specific, actionable, with examples. Not generic advice.\n\nOutput JSON only (no other text):\n{\"drift_detected\": true/false, \"gap_description\": \"...\", \"prompt_addition\": \"## Section Title\\nGuidance text...\", \"rubric_additions\": [\"New rubric item if needed\"]}";

    let prompt = format!(
        "## Agent: {agent_slug}\n\n## Current Agent Prompt:\n{agent_prompt}\n\n## Current Rubric:\n{rubric_text}\n\n## Expert's Actual Behavior:\n{task_description}\n\n## Expert's Heuristic:\n{expert_heuristic}"
    );

    let response = client
        .messages(system, &[user_message(prompt)], &[], 4096, Some(model))
        .await?;

    let text = response.text();
    let cleaned = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let parsed: Value = serde_json::from_str(cleaned)
        .map_err(|e| anyhow::anyhow!("drift detection JSON parse error: {e}"))?;

    Ok(DriftResult {
        drift_detected: parsed
            .get("drift_detected")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        gap_description: parsed
            .get("gap_description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        prompt_addition: parsed
            .get("prompt_addition")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        rubric_additions: parsed
            .get("rubric_additions")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default(),
    })
}

// ── Genesis helpers ──────────────────────────────────────────────────────────

async fn infer_slug(api_key: &str, model: &str, tasks: &[&AbstractedTask]) -> String {
    let client = AnthropicClient::new(api_key.to_string(), model.to_string());

    let mut desc_text = String::new();
    for (i, t) in tasks.iter().enumerate() {
        desc_text.push_str(&format!("{}: {}\n", i + 1, t.description));
    }

    let system = "Given a list of similar tasks, generate a short snake_case slug (2-4 words) for the agent that would handle them. Output only the slug, nothing else.";
    let prompt = format!("Tasks:\n{desc_text}");

    match client
        .messages(system, &[user_message(prompt)], &[], 64, Some(model))
        .await
    {
        Ok(resp) => {
            let slug = resp.text().trim().to_lowercase().replace(' ', "_");
            slug.chars()
                .filter(|c| c.is_alphanumeric() || *c == '_')
                .collect::<String>()
        }
        Err(_) => "auto_generated_agent".to_string(),
    }
}
