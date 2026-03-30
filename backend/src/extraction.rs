/// Post-session extraction pipeline.
///
/// Converts distillations → abstracted_tasks → agent PRs.
/// Uses Claude Sonnet for segmentation, matching, and drift detection
/// (skipping embeddings/pgvector for simplicity).
use serde_json::{json, Value};
use tracing::{info, warn};
use uuid::Uuid;

use crate::agent_catalog::AgentCatalog;
use crate::anthropic::{user_message, AnthropicClient};
use crate::pg::PgClient;
use crate::pr_engine;

/// Run the full extraction pipeline for a completed observation session.
pub async fn run_extraction(
    db: &PgClient,
    catalog: &AgentCatalog,
    api_key: &str,
    model: &str,
    session_id: &str,
    agents_dir: &str,
) -> anyhow::Result<()> {
    info!(session = %session_id, "starting extraction pipeline");

    // Load distillations for this session
    let dist_sql = format!(
        "SELECT narrator_text, expert_correction, sequence_ref FROM distillations WHERE session_id = '{}' ORDER BY sequence_ref",
        session_id
    );
    let distillations = db.execute(&dist_sql).await?;

    if distillations.is_empty() {
        info!(session = %session_id, "no distillations — skipping extraction");
        return Ok(());
    }

    let client = AnthropicClient::new(api_key.to_string(), model.to_string());

    // Step 1: Segment distillations into abstracted tasks
    let tasks = segment_distillations(&client, &distillations, model).await?;
    info!(session = %session_id, tasks = tasks.len(), "segmentation complete");

    // Persist tasks
    for task in &tasks {
        let desc_escaped = task.description.replace('\'', "''");
        let heuristic_escaped = task.expert_heuristic.replace('\'', "''");
        let sql = format!(
            r#"INSERT INTO abstracted_tasks (id, session_id, description, status)
               VALUES ('{}', '{}', '{}', 'pending')"#,
            task.id, session_id, desc_escaped
        );
        let _ = db.execute(&sql).await;
    }

    // Step 2: Match tasks to agents
    let catalog_summary = catalog.catalog_summary();
    let matches = match_tasks_to_agents(&client, &tasks, &catalog_summary, model).await?;
    info!(session = %session_id, matches = matches.len(), "matching complete");

    // Update tasks with match results
    for m in &matches {
        let status = if m.confidence >= 0.85 {
            "matched"
        } else if m.confidence >= 0.60 {
            "matched"
        } else {
            "unmatched"
        };

        let slug_val = m.matched_agent_slug.as_deref()
            .map(|s| format!("'{}'", s.replace('\'', "''")))
            .unwrap_or_else(|| "NULL".to_string());

        let sql = format!(
            "UPDATE abstracted_tasks SET matched_agent_slug = {}, match_confidence = {}, status = '{}' WHERE id = '{}'",
            slug_val, m.confidence, status, m.task_id
        );
        let _ = db.execute(&sql).await;
    }

    // Step 3: Drift detection for high-confidence matches
    let high_confidence: Vec<_> = matches.iter()
        .filter(|m| m.confidence >= 0.85 && m.matched_agent_slug.is_some())
        .collect();

    info!(session = %session_id, high_confidence = high_confidence.len(), "running drift detection");

    for m in high_confidence {
        let slug = m.matched_agent_slug.as_deref().unwrap();
        let task = tasks.iter().find(|t| t.id == m.task_id);
        let task = match task {
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
        ).await;

        match drift {
            Ok(drift) if drift.drift_detected => {
                info!(agent = slug, gap = %drift.gap_description, "drift detected — creating PR");
                let _ = pr_engine::create_enhancement_pr(
                    db,
                    slug,
                    &drift,
                    task,
                    session_id,
                    m.confidence,
                    agents_dir,
                ).await;
            }
            Ok(_) => {
                info!(agent = slug, "no drift detected");
            }
            Err(e) => {
                warn!(agent = slug, error = %e, "drift detection failed");
            }
        }
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

pub struct DriftResult {
    pub drift_detected: bool,
    pub gap_description: String,
    pub prompt_addition: String,
    pub rubric_additions: Vec<String>,
}

// ── Step 1: Segmentation ─────────────────────────────────────────────────────

async fn segment_distillations(
    client: &AnthropicClient,
    distillations: &[Value],
    model: &str,
) -> anyhow::Result<Vec<AbstractedTask>> {
    let mut narration_text = String::new();
    for d in distillations {
        let text = d.get("narrator_text").and_then(Value::as_str).unwrap_or("");
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
        .map(|v| {
            AbstractedTask {
                id: Uuid::new_v4(),
                description: v.get("description").and_then(Value::as_str).unwrap_or("").to_string(),
                expert_heuristic: v.get("expert_heuristic").and_then(Value::as_str).unwrap_or("").to_string(),
                tools_used: v.get("tools_used")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
                    .unwrap_or_default(),
                sequence_refs: v.get("sequence_refs")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_i64).collect())
                    .unwrap_or_default(),
            }
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
                matched_agent_slug: v.get("matched_agent_slug")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(String::from),
                confidence: v.get("confidence").and_then(Value::as_f64).unwrap_or(0.0),
                reasoning: v.get("reasoning").and_then(Value::as_str).unwrap_or("").to_string(),
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
        drift_detected: parsed.get("drift_detected").and_then(Value::as_bool).unwrap_or(false),
        gap_description: parsed.get("gap_description").and_then(Value::as_str).unwrap_or("").to_string(),
        prompt_addition: parsed.get("prompt_addition").and_then(Value::as_str).unwrap_or("").to_string(),
        rubric_additions: parsed.get("rubric_additions")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
            .unwrap_or_default(),
    })
}
