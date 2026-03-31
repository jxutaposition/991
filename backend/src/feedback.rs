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

/// Record a feedback signal from an expert correction (ground truth, weight 5.0).
pub async fn record_correction_signal(
    db: &PgClient,
    agent_slug: &str,
    session_id: &str,
    sequence_ref: i64,
    correction_text: &str,
    narrator_text: &str,
) -> anyhow::Result<Uuid> {
    let signal_id = Uuid::new_v4();
    let desc = format!("Expert corrected narrator: '{}'", correction_text);
    let desc_escaped = desc.replace('\'', "''");
    let expert_escaped = correction_text.replace('\'', "''");
    let agent_escaped = narrator_text.replace('\'', "''");
    let slug_escaped = agent_slug.replace('\'', "''");

    let sql = format!(
        r#"INSERT INTO feedback_signals
            (id, agent_slug, signal_type, authority, weight, session_id, sequence_ref,
             description, expert_approach, agent_approach, impact)
           VALUES
            ('{signal_id}', '{slug_escaped}', 'expert_correction', 'ground_truth', 5.0,
             '{session_id}'::uuid, {sequence_ref}, '{desc_escaped}',
             '{expert_escaped}', '{agent_escaped}', 'prompt')"#,
    );

    db.execute(&sql).await?;
    info!(signal = %signal_id, agent = agent_slug, "recorded ground_truth correction signal");
    Ok(signal_id)
}

/// Record a feedback signal from post-session reasoning analysis.
pub async fn record_reasoning_signal(
    db: &PgClient,
    signal: &FeedbackSignal,
) -> anyhow::Result<Uuid> {
    let signal_id = Uuid::new_v4();
    let slug_escaped = signal.agent_slug.replace('\'', "''");
    let desc_escaped = signal.description.replace('\'', "''");
    let expert = signal
        .expert_approach
        .as_deref()
        .map(|s| format!("'{}'", s.replace('\'', "''")))
        .unwrap_or_else(|| "NULL".to_string());
    let agent = signal
        .agent_approach
        .as_deref()
        .map(|s| format!("'{}'", s.replace('\'', "''")))
        .unwrap_or_else(|| "NULL".to_string());
    let session = signal
        .session_id
        .map(|s| format!("'{s}'::uuid"))
        .unwrap_or_else(|| "NULL".to_string());
    let seq = signal
        .sequence_ref
        .map(|s| s.to_string())
        .unwrap_or_else(|| "NULL".to_string());
    let impact_escaped = signal.impact.replace('\'', "''");

    let expert_id_val = signal
        .expert_id
        .map(|id| format!("'{}'", id))
        .unwrap_or_else(|| "NULL".to_string());

    let sql = format!(
        r#"INSERT INTO feedback_signals
            (id, agent_slug, signal_type, authority, weight, session_id, sequence_ref,
             description, expert_approach, agent_approach, impact, expert_id)
           VALUES
            ('{signal_id}', '{slug_escaped}', '{signal_type}', '{authority}', {weight},
             {session}, {seq}, '{desc_escaped}', {expert}, {agent}, '{impact_escaped}',
             {expert_id_val})"#,
        signal_type = signal.signal_type,
        authority = signal.authority,
        weight = signal.weight,
        expert_id_val = expert_id_val,
    );

    db.execute(&sql).await?;
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
    let signal_id = Uuid::new_v4();
    let slug_escaped = agent_slug.replace('\'', "''");
    let desc = format!("Judge rejected output: {}", judge_feedback);
    let desc_escaped = desc.replace('\'', "''");
    let task_escaped = task_description.replace('\'', "''");

    let sql = format!(
        r#"INSERT INTO feedback_signals
            (id, agent_slug, signal_type, authority, weight, session_id,
             description, agent_approach, impact)
           VALUES
            ('{signal_id}', '{slug_escaped}', 'judge_failure', 'inferred', 1.0,
             '{session_id}'::uuid, '{desc_escaped}', '{task_escaped}', 'prompt')"#,
    );

    db.execute(&sql).await?;
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
    let groups_sql = format!(
        r#"SELECT agent_slug, impact, SUM(weight) as total_weight, COUNT(*) as cnt
        FROM feedback_signals
        WHERE resolution IS NULL
        GROUP BY agent_slug, impact
        HAVING SUM(weight) >= {SYNTHESIS_THRESHOLD}
        ORDER BY SUM(weight) DESC"#
    );

    let groups = db.execute(&groups_sql).await?;
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

        let slug_escaped = agent_slug.replace('\'', "''");
        let impact_escaped = impact.replace('\'', "''");

        let signals_sql = format!(
            r#"SELECT id, description, expert_approach, agent_approach, authority
               FROM feedback_signals
               WHERE agent_slug = '{slug_escaped}'
                 AND impact = '{impact_escaped}'
                 AND resolution IS NULL
               ORDER BY weight DESC, created_at
               LIMIT 10"#
        );
        let signals = db.execute(&signals_sql).await?;

        if signals.is_empty() {
            continue;
        }

        let all_ground_truth = signals.iter().all(|s| {
            s.get("authority")
                .and_then(Value::as_str)
                .map(|a| a == "ground_truth")
                .unwrap_or(false)
        });

        let agent_row_sql = format!(
            "SELECT system_prompt, judge_config FROM agent_definitions WHERE slug = '{slug_escaped}'"
        );
        let agent_rows = db.execute(&agent_row_sql).await?;
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
        let reasoning_escaped = reasoning.replace('\'', "''");
        let gap_escaped = change.gap_summary.replace('\'', "''");
        let changes_json = change.proposed_changes.to_string().replace('\'', "''");

        let signal_ids: Vec<String> = signals
            .iter()
            .filter_map(|s| s.get("id").and_then(Value::as_str).map(String::from))
            .collect();
        let evidence_count = signal_ids.len();

        let pr_sql = format!(
            r#"INSERT INTO agent_prs
                (id, pr_type, target_agent_slug, proposed_changes, reasoning, gap_summary,
                 confidence, evidence_count, status, auto_merge_eligible)
               VALUES
                ('{pr_id}', '{pr_type}', '{slug_escaped}', '{changes_json}'::jsonb,
                 '{reasoning_escaped}', '{gap_escaped}', {total_weight},
                 {evidence_count}, 'open', {auto_merge})"#,
            auto_merge = all_ground_truth,
        );
        db.execute(&pr_sql).await?;

        for sid in &signal_ids {
            let update_sql = format!(
                "UPDATE feedback_signals SET resolution = 'applied', resolved_pr_id = '{pr_id}' WHERE id = '{sid}'::uuid"
            );
            let _ = db.execute(&update_sql).await;
        }

        info!(pr = %pr_id, agent = agent_slug, impact, weight = total_weight, "synthesized feedback into PR");

        if all_ground_truth {
            if let Some(catalog) = catalog {
                match pr_engine::apply_pr(db, catalog, pr_id).await {
                    Ok(_) => info!(pr = %pr_id, "auto-applied ground_truth PR"),
                    Err(e) => info!(pr = %pr_id, error = %e, "auto-apply failed — PR stays open for manual review"),
                }
            }
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
