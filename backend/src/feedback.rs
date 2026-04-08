/// Feedback pipeline — unified learning system for agent evolution.
///
/// Collects weighted feedback signals from all sources (corrections, reasoning,
/// judge failures) and synthesizes them into agent PRs when accumulated weight
/// exceeds the threshold.
use serde_json::{json, Value};
use tracing::info;
use uuid::Uuid;

use crate::agent_catalog::AgentCatalog;
use crate::anthropic::{user_message, AnthropicClient};
use crate::pg::PgClient;
use crate::pr_engine;

const SYNTHESIS_THRESHOLD: f64 = 3.0;
const AUTO_APPLY_WEIGHT_THRESHOLD: f64 = 10.0;

// ── Canonical Weight Schema ──────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct WeightConfig {
    pub ground_truth: f64,
    pub expert_correction: f64,
    pub orchestrator_validation: f64,
    pub judge_failure: f64,
    pub user_thumbs: f64,
    pub self_assessment: f64,
    pub automated_check: f64,
}

impl Default for WeightConfig {
    fn default() -> Self {
        Self {
            ground_truth: 5.0,
            expert_correction: 4.0,
            orchestrator_validation: 3.0,
            judge_failure: 2.0,
            user_thumbs: 1.5,
            self_assessment: 1.0,
            automated_check: 0.5,
        }
    }
}

impl WeightConfig {
    pub fn weight_for(&self, signal_type: &str) -> f64 {
        match signal_type {
            "ground_truth" | "expert_correction" => self.expert_correction,
            "orchestrator_validation" => self.orchestrator_validation,
            "judge_failure" => self.judge_failure,
            "user_thumbs" => self.user_thumbs,
            "self_assessment" | "execution_blocker" => self.self_assessment,
            "automated_check" => self.automated_check,
            "preflight_error" | "auth_error" | "timeout" | "api_error" | "internal_error" | "validation_error" => self.self_assessment,
            _ => {
                tracing::warn!(signal_type, "unknown signal_type in weight_for, using default");
                self.self_assessment
            }
        }
    }
}

/// Resolve the weight for a signal type, checking per-agent overrides first.
pub async fn resolve_weight(db: &PgClient, agent_slug: &str, signal_type: &str) -> f64 {
    let defaults = WeightConfig::default();
    if let Ok(rows) = db.execute_with(
        "SELECT weight_overrides FROM agent_definitions WHERE slug = $1",
        crate::pg_args!(agent_slug.to_string()),
    ).await {
        if let Some(overrides) = rows
            .first()
            .and_then(|r| r.get("weight_overrides"))
        {
            if let Some(w) = overrides.get(signal_type).and_then(Value::as_f64) {
                return w;
            }
        }
    }
    defaults.weight_for(signal_type)
}

// ── Signal Types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct FeedbackSignal {
    pub agent_slug: String,
    pub signal_type: String,
    pub authority: String,
    pub weight: f64,
    pub session_id: Option<Uuid>,
    pub sequence_ref: Option<i64>,
    pub description: String,
    pub expert_approach: Option<String>,
    pub agent_approach: Option<String>,
    pub impact: String,
    pub expert_id: Option<Uuid>,
}

/// Record a feedback signal from an expert correction (ground truth).
pub async fn record_correction_signal(
    db: &PgClient,
    agent_slug: &str,
    session_id: &str,
    sequence_ref: i64,
    correction_text: &str,
    narrator_text: &str,
) -> anyhow::Result<Uuid> {
    let weight = resolve_weight(db, agent_slug, "expert_correction").await;
    let signal_id = Uuid::new_v4();
    let desc = format!("Expert corrected narrator: '{}'", correction_text);
    let session_uuid = session_id.parse::<Uuid>().map_err(|e| anyhow::anyhow!("invalid session_id: {e}"))?;

    db.execute_with(
        "INSERT INTO feedback_signals \
            (id, agent_slug, signal_type, authority, weight, session_id, sequence_ref, \
             description, expert_approach, agent_approach, impact) \
         VALUES ($1, $2, 'expert_correction', 'ground_truth', $3, $4, $5, $6, $7, $8, 'prompt')",
        crate::pg_args!(
            signal_id, agent_slug.to_string(), weight, session_uuid, sequence_ref,
            desc, correction_text.to_string(), narrator_text.to_string()
        ),
    ).await?;
    info!(signal = %signal_id, agent = agent_slug, weight, "recorded ground_truth correction signal");
    Ok(signal_id)
}

/// Record a feedback signal from post-session reasoning analysis.
pub async fn record_reasoning_signal(
    db: &PgClient,
    signal: &FeedbackSignal,
) -> anyhow::Result<Uuid> {
    let signal_id = Uuid::new_v4();
    let expert_approach = signal.expert_approach.clone();
    let agent_approach = signal.agent_approach.clone();
    let session_id = signal.session_id;
    let sequence_ref = signal.sequence_ref;

    db.execute_with(
        "INSERT INTO feedback_signals \
            (id, agent_slug, signal_type, authority, weight, session_id, sequence_ref, \
             description, expert_approach, agent_approach, impact, expert_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
        crate::pg_args!(
            signal_id, signal.agent_slug.clone(), signal.signal_type.clone(),
            signal.authority.clone(), signal.weight, session_id, sequence_ref,
            signal.description.clone(), expert_approach, agent_approach,
            signal.impact.clone(), signal.expert_id
        ),
    ).await?;
    Ok(signal_id)
}

/// Record a feedback signal from a judge failure during execution.
pub async fn record_judge_failure_signal(
    db: &PgClient,
    agent_slug: &str,
    session_id: &str,
    judge_feedback: &str,
    task_description: &str,
) -> anyhow::Result<Uuid> {
    let weight = resolve_weight(db, agent_slug, "judge_failure").await;
    let signal_id = Uuid::new_v4();
    let desc = format!("Judge rejected output: {}", judge_feedback);
    let session_uuid = session_id.parse::<Uuid>().map_err(|e| anyhow::anyhow!("invalid session_id: {e}"))?;

    db.execute_with(
        "INSERT INTO feedback_signals \
            (id, agent_slug, signal_type, authority, weight, session_id, \
             description, agent_approach, impact) \
         VALUES ($1, $2, 'judge_failure', 'inferred', $3, $4, $5, $6, 'prompt')",
        crate::pg_args!(
            signal_id, agent_slug.to_string(), weight, session_uuid,
            desc, task_description.to_string()
        ),
    ).await?;
    Ok(signal_id)
}

/// Record a feedback signal for any execution failure (preflight, timeout, api, internal, etc.).
pub async fn record_failure_signal(
    db: &PgClient,
    agent_slug: &str,
    session_id: &str,
    error_category: &str,
    error_message: &str,
    task_description: &str,
) -> anyhow::Result<Uuid> {
    let weight = resolve_weight(db, agent_slug, error_category).await;
    let signal_id = Uuid::new_v4();
    let desc = format!(
        "Execution failure [{}]: {}",
        error_category,
        &error_message[..error_message.len().min(500)]
    );

    let sql = r#"INSERT INTO feedback_signals
            (id, agent_slug, signal_type, authority, weight, session_id,
             description, agent_approach, impact)
           VALUES
            ($1, $2, $3, 'inferred', $4, $5::uuid, $6, $7, 'prompt')"#;

    if let Err(e) = db.execute_with(
        sql,
        crate::pg_args!(signal_id, agent_slug.to_string(), error_category.to_string(), weight, session_id.to_string(), desc, task_description.to_string()),
    ).await {
        tracing::warn!(signal = %signal_id, agent = agent_slug, error = %e, "failed to persist failure signal");
    } else {
        info!(signal = %signal_id, agent = agent_slug, category = error_category, weight, "recorded failure signal");
    }
    Ok(signal_id)
}

/// Extract blockers from a completed node's output and record them as feedback signals.
/// Agents include blockers in their write_output verification section. This parses them
/// out and feeds them into the existing feedback -> PR pipeline.
pub async fn record_blockers_from_output(
    db: &PgClient,
    agent_slug: &str,
    session_id: &str,
    output: &Value,
) -> anyhow::Result<u32> {
    let weight = resolve_weight(db, agent_slug, "execution_blocker").await;
    let mut count = 0u32;

    let blockers = output
        .get("verification")
        .and_then(|v| v.get("blockers"))
        .and_then(Value::as_array);

    if let Some(blockers) = blockers {
        for b in blockers {
            let text = b.as_str().unwrap_or("").trim();
            if text.is_empty() {
                continue;
            }
            let signal_id = Uuid::new_v4();
            let desc = format!("Execution blocker: {}", text);

            let sql = r#"INSERT INTO feedback_signals
                    (id, agent_slug, signal_type, authority, weight, session_id,
                     description, impact)
                   VALUES
                    ($1, $2, 'execution_blocker', 'agent_self_report', $3,
                     $4::uuid, $5, 'prompt')"#;
            if let Err(e) = db.execute_with(
                sql,
                crate::pg_args!(signal_id, agent_slug.to_string(), weight, session_id.to_string(), desc),
            ).await {
                tracing::warn!(signal = %signal_id, agent = agent_slug, error = %e, "failed to persist blocker signal");
                continue;
            }
            info!(signal = %signal_id, agent = agent_slug, "recorded execution blocker signal");
            count += 1;
        }
    }

    if let Some(error) = output.get("error").and_then(Value::as_str) {
        if !error.is_empty() {
            let signal_id = Uuid::new_v4();
            let desc = format!("Agent-reported error: {}", &error[..error.len().min(500)]);

            let sql = r#"INSERT INTO feedback_signals
                    (id, agent_slug, signal_type, authority, weight, session_id,
                     description, impact)
                   VALUES
                    ($1, $2, 'execution_blocker', 'agent_self_report', $3,
                     $4::uuid, $5, 'prompt')"#;
            if let Err(e) = db.execute_with(
                sql,
                crate::pg_args!(signal_id, agent_slug.to_string(), weight, session_id.to_string(), desc),
            ).await {
                tracing::warn!(signal = %signal_id, agent = agent_slug, error = %e, "failed to persist error signal");
            } else {
                info!(signal = %signal_id, agent = agent_slug, "recorded execution error signal");
                count += 1;
            }
        }
    }

    Ok(count)
}

/// Record a user thumbs-up/thumbs-down feedback signal.
pub async fn record_user_thumbs_signal(
    db: &PgClient,
    agent_slug: &str,
    session_id: &str,
    is_positive: bool,
    comment: &str,
) -> anyhow::Result<Uuid> {
    let weight = resolve_weight(db, agent_slug, "user_thumbs").await;
    let signal_id = Uuid::new_v4();
    let polarity = if is_positive { "positive" } else { "negative" };
    let desc = format!("User {polarity} feedback: {comment}");
    let session_uuid = session_id.parse::<Uuid>().map_err(|e| anyhow::anyhow!("invalid session_id: {e}"))?;

    db.execute_with(
        "INSERT INTO feedback_signals \
            (id, agent_slug, signal_type, authority, weight, session_id, \
             description, impact) \
         VALUES ($1, $2, 'user_thumbs', 'user', $3, $4, $5, 'prompt')",
        crate::pg_args!(signal_id, agent_slug.to_string(), weight, session_uuid, desc),
    ).await?;
    info!(signal = %signal_id, agent = agent_slug, polarity, "recorded user thumbs signal");
    Ok(signal_id)
}

/// Record a signal from an automated check (linting, test, schema validation, etc.).
pub async fn record_automated_check_signal(
    db: &PgClient,
    agent_slug: &str,
    session_id: &str,
    check_name: &str,
    details: &str,
) -> anyhow::Result<Uuid> {
    let weight = resolve_weight(db, agent_slug, "automated_check").await;
    let signal_id = Uuid::new_v4();
    let desc = format!("Automated check '{check_name}': {details}");
    let session_uuid = session_id.parse::<Uuid>().map_err(|e| anyhow::anyhow!("invalid session_id: {e}"))?;

    db.execute_with(
        "INSERT INTO feedback_signals \
            (id, agent_slug, signal_type, authority, weight, session_id, \
             description, impact) \
         VALUES ($1, $2, 'automated_check', 'automated', $3, $4, $5, 'prompt')",
        crate::pg_args!(signal_id, agent_slug.to_string(), weight, session_uuid, desc),
    ).await?;
    info!(signal = %signal_id, agent = agent_slug, check_name, "recorded automated check signal");
    Ok(signal_id)
}

/// Synthesize unresolved feedback signals into agent PRs.
/// Groups by (agent_slug, impact) and triggers PR creation when weight >= threshold.
/// Auto-applies PRs where all signals are ground_truth (expert corrections).
pub async fn synthesize_feedback(
    db: &PgClient,
    api_key: &str,
    model: &str,
    catalog: Option<&AgentCatalog>,
) -> anyhow::Result<Vec<Uuid>> {
    // sql-format-ok: SYNTHESIS_THRESHOLD is a compile-time constant.
    let groups_sql = format!(
        r#"SELECT agent_slug, impact, SUM(weight) as total_weight, COUNT(*) as cnt
        FROM feedback_signals
        WHERE resolution IS NULL
        GROUP BY agent_slug, impact
        HAVING SUM(weight) >= {SYNTHESIS_THRESHOLD}
        ORDER BY SUM(weight) DESC"#
    );

    let groups = db.execute_unparameterized(&groups_sql).await?;
    let mut created_prs = Vec::new();

    for group in &groups {
        let agent_slug = match group.get("agent_slug").and_then(Value::as_str) {
            Some(s) => s,
            None => continue,
        };
        let impact = match group.get("impact").and_then(Value::as_str) {
            Some(s) => s,
            None => continue,
        };
        let total_weight = group
            .get("total_weight")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);

        let signals = db.execute_with(
            "SELECT id, description, expert_approach, agent_approach, authority \
             FROM feedback_signals \
             WHERE agent_slug = $1 AND impact = $2 AND resolution IS NULL \
             ORDER BY weight DESC, created_at LIMIT 10",
            crate::pg_args!(agent_slug.to_string(), impact.to_string()),
        ).await?;

        if signals.is_empty() {
            continue;
        }

        let all_ground_truth = signals.iter().all(|s| {
            s.get("authority")
                .and_then(Value::as_str)
                .map(|a| a == "ground_truth")
                .unwrap_or(false)
        });

        let agent_rows = db.execute_with(
            "SELECT system_prompt, judge_config FROM agent_definitions WHERE slug = $1",
            crate::pg_args!(agent_slug.to_string()),
        ).await?;
        let current_prompt = agent_rows
            .first()
            .and_then(|r| r.get("system_prompt").and_then(Value::as_str))
            .unwrap_or("");

        let pr_type = match impact {
            "example" => "example_addition",
            "rubric" => "rubric_update",
            _ => "prompt_amendment",
        };

        let change = synthesize_change(api_key, model, agent_slug, impact, current_prompt, &signals).await?;

        let pr_id = Uuid::new_v4();
        let reasoning = build_pr_reasoning(&signals);

        let signal_ids: Vec<String> = signals
            .iter()
            .filter_map(|s| s.get("id").and_then(Value::as_str).map(String::from))
            .collect();
        let evidence_count = signal_ids.len() as i32;

        db.execute_with(
            "INSERT INTO agent_prs \
                (id, pr_type, target_agent_slug, proposed_changes, reasoning, gap_summary, \
                 confidence, evidence_count, status, auto_merge_eligible) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9)",
            crate::pg_args!(
                pr_id, pr_type.to_string(), agent_slug.to_string(),
                change.proposed_changes.clone(), reasoning, change.gap_summary.clone(),
                total_weight, evidence_count, all_ground_truth
            ),
        ).await?;

        for sid in &signal_ids {
            if let Ok(signal_uuid) = sid.parse::<Uuid>() {
                let _ = db.execute_with(
                    "UPDATE feedback_signals SET resolution = 'applied', resolved_pr_id = $1 WHERE id = $2",
                    crate::pg_args!(pr_id, signal_uuid),
                ).await;
            }
        }

        info!(pr = %pr_id, agent = agent_slug, impact, weight = total_weight, "synthesized feedback into PR");

        if all_ground_truth && total_weight >= AUTO_APPLY_WEIGHT_THRESHOLD {
            if let Some(catalog) = catalog {
                match pr_engine::apply_pr(db, catalog, pr_id).await {
                    Ok(_) => info!(pr = %pr_id, "auto-applied ground_truth PR (weight {total_weight} >= {AUTO_APPLY_WEIGHT_THRESHOLD})"),
                    Err(e) => info!(pr = %pr_id, error = %e, "auto-apply failed — PR stays open for manual review"),
                }
            }
        } else if all_ground_truth {
            info!(pr = %pr_id, weight = total_weight, threshold = AUTO_APPLY_WEIGHT_THRESHOLD,
                  "ground_truth PR below auto-apply threshold — queued for human confirmation");
        }

        created_prs.push(pr_id);
    }

    Ok(created_prs)
}

struct SynthesizedChange {
    gap_summary: String,
    proposed_changes: Value,
}

async fn synthesize_change(
    api_key: &str,
    model: &str,
    agent_slug: &str,
    impact: &str,
    current_prompt: &str,
    signals: &[Value],
) -> anyhow::Result<SynthesizedChange> {
    let client = AnthropicClient::new(api_key.to_string(), model.to_string());

    let mut signal_text = String::new();
    for (i, s) in signals.iter().enumerate() {
        let desc = s.get("description").and_then(Value::as_str).unwrap_or("");
        let expert = s.get("expert_approach").and_then(Value::as_str).unwrap_or("N/A");
        let agent = s.get("agent_approach").and_then(Value::as_str).unwrap_or("N/A");
        signal_text.push_str(&format!(
            "Signal {}: {}\n  Expert: {}\n  Agent: {}\n\n",
            i + 1, desc, expert, agent
        ));
    }

    let system = format!(
        "You are improving an AI agent's {} based on feedback signals. \
         Write specific, actionable changes in the same style as the existing content. \
         Output JSON only:\n\
         {{\"gap_summary\": \"...\", \"proposed_changes\": {{...}}}}",
        impact
    );

    let prompt = format!(
        "## Agent: {agent_slug}\n\n## Current Prompt (first 500 chars):\n{prompt_preview}\n\n\
         ## Feedback Signals:\n{signal_text}\n\n\
         ## Impact Type: {impact}\n\n\
         Generate proposed_changes as a JSON object with field names as keys \
         and new values. For prompt changes, include the full updated section. \
         For rubric changes, include the new rubric array. For example changes, \
         include the new example object.",
        prompt_preview = &current_prompt[..current_prompt.len().min(500)],
    );

    let response = client
        .messages(&system, &[user_message(prompt)], &[], 4096, Some(model))
        .await?;

    let text = response.text();
    let cleaned = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let parsed: Value = serde_json::from_str(cleaned).unwrap_or_else(|_| {
        json!({
            "gap_summary": format!("Feedback synthesis for {agent_slug} ({impact})"),
            "proposed_changes": {"system_prompt_addition": signal_text}
        })
    });

    Ok(SynthesizedChange {
        gap_summary: parsed
            .get("gap_summary")
            .and_then(Value::as_str)
            .unwrap_or("Feedback-driven update")
            .to_string(),
        proposed_changes: parsed
            .get("proposed_changes")
            .cloned()
            .unwrap_or(json!({})),
    })
}

fn build_pr_reasoning(signals: &[Value]) -> String {
    let mut parts = vec!["## Feedback Signals\n".to_string()];
    for (i, s) in signals.iter().enumerate() {
        let desc = s.get("description").and_then(Value::as_str).unwrap_or("");
        let authority = s.get("authority").and_then(Value::as_str).unwrap_or("");
        parts.push(format!("{}. [{}] {}", i + 1, authority, desc));
    }
    parts.join("\n")
}
