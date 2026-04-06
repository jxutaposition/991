/// Agent PR engine — generates and applies proposed changes to agent definitions in the DB.
///
/// Supports PR types: enhancement, new_agent, example_addition, rubric_update,
/// prompt_amendment, workflow_update.
use serde_json::{json, Value};
use tracing::{info, warn};
use uuid::Uuid;

use crate::agent_catalog::AgentCatalog;
use crate::anthropic::{user_message, AnthropicClient};
use crate::extraction::AbstractedTask;
use crate::pg::PgClient;
use crate::pg_args;

pub struct DriftResult {
    pub drift_detected: bool,
    pub gap_description: String,
    pub prompt_addition: String,
    pub rubric_additions: Vec<String>,
}

/// Create an enhancement PR for an existing agent based on drift detection.
/// Now reads from DB instead of disk.
pub async fn create_enhancement_pr(
    db: &PgClient,
    agent_slug: &str,
    drift: &DriftResult,
    task: &AbstractedTask,
    session_id: &str,
    confidence: f64,
) -> anyhow::Result<Uuid> {
    let pr_id = Uuid::new_v4();

    let current_prompt_rows = db
        .execute_with(
            "SELECT system_prompt FROM agent_definitions WHERE slug = $1",
            pg_args!(agent_slug.to_string()),
        )
        .await?;

    let old_prompt = current_prompt_rows
        .first()
        .and_then(|r| r.get("system_prompt").and_then(Value::as_str))
        .unwrap_or("");

    let new_prompt = format!("{}\n\n{}\n", old_prompt.trim_end(), drift.prompt_addition.trim());

    let proposed_changes = json!({
        "system_prompt": new_prompt,
    });

    let file_diffs = json!([
        {
            "file_path": "system_prompt",
            "old_content": old_prompt,
            "new_content": new_prompt,
        }
    ]);

    let reasoning = format!(
        "## Drift Detected\n\n{}\n\n## Expert Behavior\n\n{}\n\n## Expert Heuristic\n\n{}",
        drift.gap_description, task.description, task.expert_heuristic
    );

    let task_uuid = task.id;
    let session_uuid: Uuid = session_id.parse().map_err(|e| anyhow::anyhow!("invalid session_id: {e}"))?;

    db.execute_with(
        "INSERT INTO agent_prs \
            (id, pr_type, target_agent_slug, file_diffs, proposed_changes, reasoning, gap_summary, \
             confidence, evidence_count, evidence_task_ids, evidence_session_ids, status) \
         VALUES ($1, 'enhancement', $2, $3::jsonb, $4::jsonb, $5, $6, $7, 1, \
                 ARRAY[$8::uuid], ARRAY[$9::uuid], 'open')",
        pg_args!(
            pr_id, agent_slug.to_string(), file_diffs, proposed_changes,
            reasoning, drift.gap_description.clone(), confidence,
            task_uuid, session_uuid
        ),
    ).await?;

    info!(pr = %pr_id, agent = agent_slug, "enhancement PR created");
    Ok(pr_id)
}

/// Create a PR for a brand new agent definition bootstrapped from observation.
pub async fn create_new_agent_pr(
    db: &PgClient,
    api_key: &str,
    model: &str,
    proposed_slug: &str,
    task_descriptions: &[String],
    expert_heuristics: &[String],
    session_ids: &[String],
) -> anyhow::Result<Uuid> {
    let client = AnthropicClient::new(api_key.to_string(), model.to_string());

    let mut evidence_text = String::new();
    for (i, (desc, heuristic)) in task_descriptions.iter().zip(expert_heuristics).enumerate() {
        evidence_text.push_str(&format!(
            "Observation {}: {}\nExpert Heuristic: {}\n\n",
            i + 1, desc, heuristic
        ));
    }

    let system = r#"You are generating a new AI agent definition based on observed expert behavior.
Create a complete agent definition with:
- name: human-readable agent name
- category: GTM category (e.g., "outreach", "research", "analytics")
- description: what this agent does
- system_prompt: detailed instructions for the agent
- tools: list of tool names the agent needs
- judge_config: quality criteria (threshold, rubric items)
- intents: list of intent phrases that should trigger this agent

Output JSON only (no other text):
{"name": "...", "category": "...", "description": "...", "system_prompt": "...", "tools": [...], "judge_config": {"threshold": 7.0, "rubric": [...], "need_to_know": [...]}, "intents": [...]}"#;

    let prompt = format!(
        "## Proposed Slug: {proposed_slug}\n\n## Expert Evidence:\n{evidence_text}"
    );

    let response = client
        .messages(system, &[user_message(prompt)], &[], 8192, Some(model))
        .await?;

    let text = response.text();
    let cleaned = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let agent_def: Value = match serde_json::from_str(cleaned) {
        Ok(v) => v,
        Err(e) => {
            warn!(error = %e, raw_len = text.len(), "LLM returned invalid JSON for new agent definition, using fallback");
            json!({
                "name": proposed_slug,
                "category": "uncategorized",
                "description": format!("Auto-generated from observations"),
                "system_prompt": evidence_text,
                "tools": [],
                "judge_config": {"threshold": 7.0, "rubric": [], "need_to_know": []},
                "intents": []
            })
        }
    };

    let pr_id = Uuid::new_v4();
    let agent_prompt = agent_def.get("system_prompt").and_then(Value::as_str).unwrap_or("");
    let proposed_changes = json!({
        "slug": proposed_slug,
        "name": agent_def.get("name").and_then(Value::as_str).unwrap_or(proposed_slug),
        "category": agent_def.get("category").and_then(Value::as_str).unwrap_or("uncategorized"),
        "description": agent_def.get("description").and_then(Value::as_str).unwrap_or(""),
        "system_prompt": agent_prompt,
        "tools": agent_def.get("tools").unwrap_or(&json!([])),
        "judge_config": agent_def.get("judge_config").unwrap_or(&json!({})),
        "intents": agent_def.get("intents").unwrap_or(&json!([])),
    });

    let file_diffs = json!([
        {
            "file_path": "system_prompt",
            "old_content": null,
            "new_content": agent_prompt,
        },
        {
            "file_path": "agent.toml",
            "old_content": null,
            "new_content": format!(
                "slug = \"{}\"\nname = \"{}\"\ncategory = \"{}\"\ndescription = \"{}\"\nintents = {:?}\nmax_iterations = 12\nskip_judge = false",
                proposed_slug,
                agent_def.get("name").and_then(Value::as_str).unwrap_or(proposed_slug),
                agent_def.get("category").and_then(Value::as_str).unwrap_or("uncategorized"),
                agent_def.get("description").and_then(Value::as_str).unwrap_or(""),
                agent_def.get("intents").unwrap_or(&json!([])),
            ),
        }
    ]);

    let reasoning = format!(
        "## New Agent Proposed\n\nBased on {} observation(s) where no existing agent matched.\n\n## Evidence:\n{}",
        task_descriptions.len(), evidence_text
    );

    let session_uuids: Vec<Uuid> = session_ids
        .iter()
        .filter_map(|s| s.parse::<Uuid>().ok())
        .collect();

    db.execute_with(
        "INSERT INTO agent_prs \
            (id, pr_type, proposed_slug, file_diffs, proposed_changes, reasoning, gap_summary, \
             confidence, evidence_count, evidence_session_ids, status) \
         VALUES ($1, 'new_agent', $2, $3::jsonb, $4::jsonb, $5, 'New agent from observation', \
                 0.7, $6, $7, 'open')",
        pg_args!(
            pr_id, proposed_slug.to_string(), file_diffs, proposed_changes,
            reasoning, task_descriptions.len() as i32, session_uuids
        ),
    ).await?;

    info!(pr = %pr_id, slug = proposed_slug, "new_agent PR created");
    Ok(pr_id)
}

/// Apply an approved PR to the agent_definitions table.
/// Bumps version, creates snapshot in agent_versions, and reloads catalog.
pub async fn apply_pr(
    db: &PgClient,
    catalog: &AgentCatalog,
    pr_id: Uuid,
) -> anyhow::Result<()> {
    let pr_rows = db
        .execute_with(
            "SELECT pr_type, target_agent_slug, proposed_slug, proposed_changes \
             FROM agent_prs WHERE id = $1 AND status = 'open'",
            pg_args!(pr_id),
        )
        .await?;

    let pr = pr_rows
        .first()
        .ok_or_else(|| anyhow::anyhow!("PR not found or not open: {pr_id}"))?;

    let pr_type = pr.get("pr_type").and_then(Value::as_str).unwrap_or("");
    let changes = pr.get("proposed_changes").cloned().unwrap_or(json!({}));

    let applied_slug: Option<String>;

    match pr_type {
        "new_agent" => {
            let slug = changes
                .get("slug")
                .and_then(Value::as_str)
                .or_else(|| pr.get("proposed_slug").and_then(Value::as_str))
                .ok_or_else(|| anyhow::anyhow!("new_agent PR missing slug"))?;

            apply_new_agent(db, slug, &changes).await?;
            catalog.reload_agent(db, slug).await?;
            applied_slug = Some(slug.to_string());
        }
        _ => {
            let slug = pr
                .get("target_agent_slug")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("PR missing target_agent_slug"))?;

            apply_changes_to_agent(db, slug, &changes, pr_id).await?;
            catalog.reload_agent(db, slug).await?;
            applied_slug = Some(slug.to_string());
        }
    }

    db.execute_with(
        "UPDATE agent_prs SET status = 'approved', reviewed_at = NOW() WHERE id = $1",
        pg_args!(pr_id),
    ).await?;

    if let Some(slug) = &applied_slug {
        create_overlay_from_pr(db, slug, &changes, pr_id).await;
    }

    info!(pr = %pr_id, pr_type, "PR applied");
    Ok(())
}

async fn apply_changes_to_agent(
    db: &PgClient,
    slug: &str,
    changes: &Value,
    pr_id: Uuid,
) -> anyhow::Result<()> {
    let mut prompt_val: Option<String> = None;
    let mut judge_val: Option<Value> = None;
    let mut examples_val: Option<Value> = None;

    if let Some(prompt) = changes.get("system_prompt").and_then(Value::as_str) {
        prompt_val = Some(prompt.to_string());
    }
    if let Some(jc) = changes.get("judge_config") {
        judge_val = Some(jc.clone());
    }
    if let Some(ex) = changes.get("examples") {
        examples_val = Some(ex.clone());
    }

    if prompt_val.is_none() && judge_val.is_none() && examples_val.is_none() {
        return Ok(());
    }

    // Build the update dynamically based on which fields changed.
    // Use a single query with all optional fields to avoid multiple round-trips.
    let result = db.execute_with(
        "UPDATE agent_definitions SET \
            system_prompt = COALESCE($2, system_prompt), \
            judge_config = COALESCE($3, judge_config), \
            examples = COALESCE($4, examples), \
            version = version + 1, \
            updated_at = NOW() \
         WHERE slug = $1 \
         RETURNING version",
        pg_args!(
            slug.to_string(),
            prompt_val,
            judge_val,
            examples_val
        ),
    ).await?;

    let new_version = result
        .first()
        .and_then(|r| r.get("version").and_then(Value::as_i64))
        .unwrap_or(1);

    let summary = format!("Applied PR {pr_id}");
    let snapshot = changes.clone();

    let _ = db.execute_with(
        "INSERT INTO agent_versions (agent_id, version, snapshot, change_summary, change_source, source_pr_id) \
         SELECT id, $2, $3::jsonb, $4, 'feedback_pipeline', $5 \
         FROM agent_definitions WHERE slug = $1 \
         ON CONFLICT (agent_id, version) DO NOTHING",
        pg_args!(slug.to_string(), new_version as i32, snapshot, summary, pr_id),
    ).await;

    Ok(())
}

async fn apply_new_agent(
    db: &PgClient,
    slug: &str,
    changes: &Value,
) -> anyhow::Result<()> {
    let name = changes
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(slug)
        .to_string();
    let category = changes
        .get("category")
        .and_then(Value::as_str)
        .unwrap_or("uncategorized")
        .to_string();
    let description = changes
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let system_prompt = changes
        .get("system_prompt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let tools: Vec<String> = changes
        .get("tools")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(Value::as_str).map(String::from).collect())
        .unwrap_or_default();

    let judge_config = changes
        .get("judge_config")
        .cloned()
        .unwrap_or_else(|| json!({"threshold": 7.0, "rubric": [], "need_to_know": []}));

    let intents: Vec<String> = changes
        .get("intents")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(Value::as_str).map(String::from).collect())
        .unwrap_or_default();

    db.execute_with(
        "INSERT INTO agent_definitions \
            (slug, name, category, description, system_prompt, tools, judge_config, intents) \
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) \
         ON CONFLICT (slug) DO NOTHING",
        pg_args!(
            slug.to_string(), name, category, description, system_prompt,
            tools, judge_config, intents
        ),
    ).await?;

    let snapshot = changes.clone();
    let _ = db.execute_with(
        "INSERT INTO agent_versions (agent_id, version, snapshot, change_summary, change_source) \
         SELECT id, 1, $2::jsonb, 'New agent from observation', 'observation' \
         FROM agent_definitions WHERE slug = $1 \
         ON CONFLICT (agent_id, version) DO NOTHING",
        pg_args!(slug.to_string(), snapshot),
    ).await;

    info!(slug = slug, "new agent created in DB");
    Ok(())
}

/// When a PR is applied, also create a base-scope overlay for the matching
/// skill so the learning persists as contextual guidance even if the agent
/// definition is later modified.
async fn create_overlay_from_pr(db: &PgClient, agent_slug: &str, changes: &Value, pr_id: Uuid) {
    let skill_rows = match db.execute_with(
        "SELECT id FROM skills WHERE slug = $1 LIMIT 1",
        pg_args!(agent_slug.to_string()),
    ).await {
        Ok(rows) => rows,
        Err(_) => return,
    };

    let skill_id = match skill_rows.first().and_then(|r| r.get("id").and_then(Value::as_str)) {
        Some(id) => id.to_string(),
        None => return,
    };
    let skill_uuid: Uuid = match skill_id.parse() {
        Ok(u) => u,
        Err(_) => return,
    };

    let content = if let Some(addition) = changes.get("system_prompt_addition").and_then(Value::as_str) {
        addition.to_string()
    } else if let Some(prompt) = changes.get("system_prompt").and_then(Value::as_str) {
        let truncated = &prompt[prompt.len().saturating_sub(500)..];
        format!("PR-applied learning: {truncated}")
    } else {
        return;
    };

    let overlay_id = Uuid::new_v4();
    let meta = json!({"source_pr_id": pr_id.to_string(), "agent_slug": agent_slug});
    let null_scope_id: Option<Uuid> = None;

    match db.execute_with(
        "INSERT INTO overlays \
            (id, primitive_type, primitive_id, scope, scope_id, content, source, metadata) \
         VALUES ($1, 'skill', $2, 'base', $3, $4, 'feedback', $5::jsonb)",
        pg_args!(overlay_id, skill_uuid, null_scope_id, content, meta),
    ).await {
        Ok(_) => info!(overlay = %overlay_id, skill = %skill_id, pr = %pr_id, "created overlay from applied PR"),
        Err(e) => warn!(pr = %pr_id, error = %e, "failed to create overlay from PR"),
    }
}
