/// Project Learner — real-time feedback capture at project scope.
///
/// Every piece of feedback is stored as an overlay at the most specific scope
/// (project). No guessing about broader applicability. The Pattern Promoter
/// handles generalization separately.
use serde_json::json;
use tracing::{info, warn};
use uuid::Uuid;

use crate::anthropic::{user_message, AnthropicClient};
use crate::pg::PgClient;

/// Record a lesson from user feedback on a specific execution node.
///
/// 1. Determines which skill(s) the node used
/// 2. Extracts the lesson via LLM
/// 3. Stores as an overlay at scope='project', source='feedback'
pub async fn record_lesson(
    db: &PgClient,
    api_key: &str,
    model: &str,
    session_id: Uuid,
    node_id: Uuid,
    feedback_text: &str,
    project_id: Option<Uuid>,
) -> anyhow::Result<Vec<Uuid>> {
    // Look up which skills/agents the node used
    let node_rows = db.execute_with(
        "SELECT agent_slug, skill_slugs, task_description, output \
         FROM execution_nodes WHERE id = $1",
        crate::pg_args!(node_id),
    ).await?;
    let node_row = node_rows
        .first()
        .ok_or_else(|| anyhow::anyhow!("node not found: {node_id}"))?;

    let agent_slug = node_row
        .get("agent_slug")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let skill_slugs: Vec<String> = node_row
        .get("skill_slugs")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let task_desc = node_row
        .get("task_description")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    // Determine target skills: use skill_slugs if present, otherwise agent_slug
    let target_slugs: Vec<String> = if skill_slugs.is_empty() {
        vec![agent_slug.to_string()]
    } else {
        skill_slugs
    };

    // Extract the lesson via LLM
    let lesson = extract_lesson(api_key, model, feedback_text, task_desc).await?;

    let mut overlay_ids = Vec::new();

    for slug in &target_slugs {
        // Look up skill ID (try skills table first, then use a generated UUID for agent-based)
        let skill_id = lookup_skill_id(db, slug).await;
        let skill_id = match skill_id {
            Some(id) => id,
            None => {
                warn!(slug = %slug, "no skill found for overlay — skipping");
                continue;
            }
        };

        let overlay_id = Uuid::new_v4();

        let scope = if project_id.is_some() { "project" } else { "base" };

        let meta = json!({
            "session_id": session_id.to_string(),
            "node_id": node_id.to_string(),
            "feedback": feedback_text,
            "agent_slug": agent_slug,
        });

        match db.execute_with(
            "INSERT INTO overlays \
                (id, primitive_type, primitive_id, scope, scope_id, content, source, metadata) \
             VALUES ($1, 'skill', $2, $3, $4, $5, 'feedback', $6)",
            crate::pg_args!(overlay_id, skill_id, scope.to_string(), project_id, lesson.clone(), meta),
        ).await {
            Ok(_) => {
                info!(
                    overlay = %overlay_id,
                    skill = %slug,
                    scope = scope,
                    "recorded lesson overlay"
                );
                overlay_ids.push(overlay_id);
            }
            Err(e) => {
                warn!(skill = %slug, error = %e, "failed to store lesson overlay");
            }
        }
    }

    Ok(overlay_ids)
}

async fn extract_lesson(
    api_key: &str,
    model: &str,
    feedback_text: &str,
    task_description: &str,
) -> anyhow::Result<String> {
    let client = AnthropicClient::new(api_key.to_string(), model.to_string());

    let system = "You extract concise, actionable lessons from user feedback. \
                  Output a single lesson statement that can be applied to future similar tasks. \
                  Be specific and prescriptive. Do not include meta-commentary.";

    let prompt = format!(
        "Task that was performed: {task_description}\n\n\
         User feedback: {feedback_text}\n\n\
         Extract the lesson: what should be done differently next time? \
         Write one clear, specific instruction (1-3 sentences)."
    );

    let response = client
        .messages(system, &[user_message(prompt)], &[], 512, Some(model))
        .await?;

    Ok(response.text().trim().to_string())
}

async fn lookup_skill_id(db: &PgClient, slug: &str) -> Option<Uuid> {
    let rows = db
        .execute_with(
            "SELECT id FROM skills WHERE slug = $1",
            crate::pg_args!(slug.to_string()),
        )
        .await
        .ok()?;

    rows.first()
        .and_then(|r| r.get("id").and_then(|v| v.as_str()))
        .and_then(|s| s.parse::<Uuid>().ok())
}
