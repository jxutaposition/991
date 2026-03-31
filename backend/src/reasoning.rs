/// Post-session reasoning agent — analyzes observation events and distillations
/// to produce structured feedback signals for agent improvement.
///
/// Runs after observe_session_end, alongside extraction. Produces granular
/// per-step feedback signals rather than summary drift detection.
use serde_json::Value;
use tracing::{info, warn};
use uuid::Uuid;

use crate::agent_catalog::AgentCatalog;
use crate::anthropic::{user_message, AnthropicClient};
use crate::feedback::{self, FeedbackSignal};
use crate::pg::PgClient;

/// Run the reasoning agent for a completed observation session.
pub async fn run_reasoning(
    db: &PgClient,
    catalog: &AgentCatalog,
    api_key: &str,
    model: &str,
    session_id: &str,
    expert_id: Option<uuid::Uuid>,
) -> anyhow::Result<Vec<Uuid>> {
    info!(session = session_id, "starting post-session reasoning");

    let dist_sql = format!(
        "SELECT narrator_text, expert_correction, sequence_ref \
         FROM distillations WHERE session_id = '{session_id}' ORDER BY sequence_ref"
    );
    let distillations = db.execute(&dist_sql).await?;

    if distillations.is_empty() {
        info!(session = session_id, "no distillations — skipping reasoning");
        return Ok(Vec::new());
    }

    let client = AnthropicClient::new(api_key.to_string(), model.to_string());
    let catalog_summary = catalog.catalog_summary_for_expert(expert_id);

    let mut narration_text = String::new();
    for d in &distillations {
        let text = d.get("narrator_text").and_then(Value::as_str).unwrap_or("");
        let correction = d.get("expert_correction").and_then(Value::as_str);
        let seq = d.get("sequence_ref").and_then(Value::as_i64).unwrap_or(0);

        narration_text.push_str(&format!("[seq:{}] {}\n", seq, text));
        if let Some(c) = correction {
            narration_text.push_str(&format!("  [EXPERT CORRECTION]: {}\n", c));
        }
    }

    let system = r#"You are analyzing an expert GTM session to identify gaps between what existing AI agents would do and what the expert actually did.

For each significant gap, produce a feedback signal with:
- agent_slug: which agent this relates to (from the catalog)
- description: what the gap is
- expert_approach: what the expert did
- agent_approach: what the agent's current instructions would produce (inferred)
- impact: what should change ('prompt' | 'example' | 'rubric' | 'tool')
- severity: 'major' (clear gap) or 'minor' (stylistic difference)

Expert corrections override narrator text — treat them as ground truth.
Only flag genuine gaps. If the agent's prompt already covers the behavior, skip it.

Output JSON array (no other text):
[{"agent_slug": "...", "description": "...", "expert_approach": "...", "agent_approach": "...", "impact": "...", "severity": "..."}]

If there are no significant gaps, return an empty array: []"#;

    let prompt = format!(
        "## Agent Catalog\n\n{catalog_summary}\n\n## Expert Session Narrations\n\n{narration_text}"
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

    let parsed: Vec<Value> = serde_json::from_str(cleaned).unwrap_or_else(|e| {
        warn!(error = %e, "reasoning output parse failed");
        Vec::new()
    });

    let session_uuid = session_id.parse::<Uuid>().ok();
    let mut signal_ids = Vec::new();

    for item in &parsed {
        let agent_slug = match item.get("agent_slug").and_then(Value::as_str) {
            Some(s) if !s.is_empty() => s,
            _ => continue,
        };
        let description = item
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let expert_approach = item
            .get("expert_approach")
            .and_then(Value::as_str)
            .map(String::from);
        let agent_approach = item
            .get("agent_approach")
            .and_then(Value::as_str)
            .map(String::from);
        let impact = item
            .get("impact")
            .and_then(Value::as_str)
            .unwrap_or("prompt")
            .to_string();
        let severity = item
            .get("severity")
            .and_then(Value::as_str)
            .unwrap_or("minor");

        let (authority, weight) = match severity {
            "major" => ("observed", 1.0),
            _ => ("inferred", 0.3),
        };

        let signal = FeedbackSignal {
            agent_slug: agent_slug.to_string(),
            signal_type: "post_session_analysis".to_string(),
            authority: authority.to_string(),
            weight,
            session_id: session_uuid,
            sequence_ref: None,
            description,
            expert_approach,
            agent_approach,
            impact,
            expert_id,
        };

        match feedback::record_reasoning_signal(db, &signal).await {
            Ok(id) => signal_ids.push(id),
            Err(e) => warn!(error = %e, "failed to record reasoning signal"),
        }
    }

    info!(
        session = session_id,
        signals = signal_ids.len(),
        "reasoning complete"
    );
    Ok(signal_ids)
}
