/// Real-time LLM narrator for observation sessions.
///
/// Receives batched browser events, distills them into plain-English narration
/// of what the expert is doing and why, streams output back to the extension
/// via SSE. Uses Claude Haiku for low-latency streaming.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::{info, warn};

use crate::anthropic::{user_message, AnthropicClient};
use crate::pg::PgClient;

const NARRATOR_SYSTEM: &str = r#"You are a real-time observer of a GTM expert's workflow. You receive browser events AND a screenshot of what the expert is currently looking at.

Your job: narrate what you observe — what task are they performing, what decision are they making, and what heuristic or judgment are they applying?

When a screenshot is provided, use it to understand:
- What information is visible on screen (company names, funding amounts, contact details, etc.)
- What the expert is evaluating or reading
- What signals on the page are driving their actions

Focus on: WHAT they did, WHY they likely did it, and any decision logic you can infer from both their actions AND what's visible on screen.
Be concise (1-3 sentences per batch). Flag when you're uncertain with "(inferred)".

Do not describe mechanical events. Describe the expert's *intent* and *judgment*.

The expert can correct you in real-time. Their corrections are ground truth."#;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapturedEvent {
    pub sequence_number: i64,
    pub event_type: String,
    pub url: Option<String>,
    pub dom_context: Option<Value>,
    pub screenshot_b64: Option<String>,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriorNarration {
    pub narrator_text: String,
    pub expert_correction: Option<String>,
    pub sequence_ref: i64,
}

pub struct Narrator {
    api_key: String,
    model: String,
}

impl Narrator {
    pub fn new(api_key: String, model: String) -> Self {
        Self { api_key, model }
    }

    /// Narrate a batch of events given prior context and optional screenshot.
    pub async fn narrate(
        &self,
        events: &[CapturedEvent],
        prior_narrations: &[PriorNarration],
        screenshot_b64: Option<&str>,
    ) -> anyhow::Result<String> {
        let client = AnthropicClient::new(
            self.api_key.clone(),
            self.model.clone(),
        );

        let prior_context = build_prior_context(prior_narrations);
        let events_text = build_events_text(events);

        let prompt_text = format!(
            "{prior_context}\n## Current Event Batch\n{events_text}\n\nNarrate:"
        );

        // Use vision message if screenshot available, otherwise text-only
        let message = if let Some(img_b64) = screenshot_b64 {
            crate::anthropic::user_message_with_image(prompt_text, img_b64, "image/jpeg")
        } else {
            user_message(prompt_text)
        };

        let response = client
            .messages(NARRATOR_SYSTEM, &[message], &[], 512, None)
            .await
            .map_err(|e| anyhow::anyhow!("narrator LLM call failed: {e}"))?;

        Ok(response.text())
    }
}

fn build_prior_context(prior: &[PriorNarration]) -> String {
    if prior.is_empty() {
        return String::new();
    }
    let mut parts = vec!["## Prior Narrations (last 5)\n".to_string()];
    for n in prior.iter().take(5) {
        parts.push(format!("Narration (seq {}): {}", n.sequence_ref, n.narrator_text));
        if let Some(correction) = &n.expert_correction {
            parts.push(format!("Expert correction: {correction}"));
        }
    }
    parts.join("\n") + "\n"
}

fn build_events_text(events: &[CapturedEvent]) -> String {
    events
        .iter()
        .map(|e| {
            let context = e
                .dom_context
                .as_ref()
                .map(|v| serde_json::to_string(v).unwrap_or_default())
                .unwrap_or_default();
            format!(
                "[seq={}] {} | url={} | {}",
                e.sequence_number,
                e.event_type,
                e.url.as_deref().unwrap_or(""),
                context
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Persist a narration to the DB and return its id.
pub async fn persist_narration(
    db: &PgClient,
    session_id: &str,
    sequence_ref: i64,
    narrator_text: &str,
    model: &str,
) -> anyhow::Result<String> {
    let id = uuid::Uuid::new_v4();
    let text_escaped = narrator_text.replace('\'', "''");
    let sql = format!(
        r#"
        INSERT INTO distillations (id, session_id, sequence_ref, narrator_text, model)
        VALUES ('{id}', '{session_id}', {sequence_ref}, '{text_escaped}', '{model}')
        "#
    );
    db.execute(&sql).await?;

    // Increment distillation_count on the session
    let count_sql = format!(
        "UPDATE observation_sessions SET distillation_count = distillation_count + 1 WHERE id = '{session_id}'"
    );
    let _ = db.execute(&count_sql).await;

    info!(session = %session_id, seq = sequence_ref, "narration persisted");
    Ok(id.to_string())
}

/// Load the last N narrations for a session (for context window).
pub async fn load_prior_narrations(
    db: &PgClient,
    session_id: &str,
    limit: i64,
) -> Vec<PriorNarration> {
    let sql = format!(
        r#"
        SELECT sequence_ref, narrator_text, expert_correction
        FROM distillations
        WHERE session_id = '{session_id}'
        ORDER BY sequence_ref DESC
        LIMIT {limit}
        "#
    );

    match db.execute(&sql).await {
        Ok(rows) => {
            let mut narrations: Vec<PriorNarration> = rows
                .iter()
                .filter_map(|r| {
                    Some(PriorNarration {
                        sequence_ref: r.get("sequence_ref")?.as_i64()?,
                        narrator_text: r.get("narrator_text")?.as_str()?.to_string(),
                        expert_correction: r
                            .get("expert_correction")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    })
                })
                .collect();
            narrations.reverse(); // chronological order
            narrations
        }
        Err(e) => {
            warn!(error = %e, "failed to load prior narrations");
            Vec::new()
        }
    }
}

/// Compute a coverage score for a completed session (0.0–1.0).
pub async fn compute_coverage_score(db: &PgClient, session_id: &str) -> f64 {
    let total_sql = format!(
        "SELECT COUNT(*) as total FROM action_events WHERE session_id = '{session_id}'"
    );
    let narrated_sql = format!(
        "SELECT COUNT(DISTINCT sequence_ref) as narrated FROM distillations WHERE session_id = '{session_id}'"
    );

    let total = db
        .execute(&total_sql)
        .await
        .ok()
        .and_then(|r| r.first()?.get("total")?.as_i64())
        .unwrap_or(0);

    let narrated = db
        .execute(&narrated_sql)
        .await
        .ok()
        .and_then(|r| r.first()?.get("narrated")?.as_i64())
        .unwrap_or(0);

    if total == 0 {
        return 0.0;
    }

    (narrated as f64 / total as f64).min(1.0)
}
