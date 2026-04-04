/// Agent PR engine — generates and applies proposed changes to agent definitions in the DB.
///
/// Supports PR types: enhancement, new_agent, example_addition, rubric_update,
/// prompt_amendment, workflow_update.
use serde_json::{json, Value};
use tracing::info;
use uuid::Uuid;

use crate::agent_catalog::AgentCatalog;
use crate::anthropic::{user_message, AnthropicClient};
use crate::extraction::AbstractedTask;
use crate::pg::PgClient;

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
    let slug_escaped = agent_slug.replace('\'', "''");

    let current_prompt_rows = db
        .execute(&format!(
            "SELECT system_prompt FROM agent_definitions WHERE slug = '{slug_escaped}'"
        ))
        .await?;

    let old_prompt = current_prompt_rows
        .first()
        .and_then(|r| r.get("system_prompt").and_then(Value::as_str))
        .unwrap_or("");

    let new_prompt = format!("{}\n\n{}\n", old_prompt.trim_end(), drift.prompt_addition.trim());

    let proposed_changes = json!({
        "system_prompt": new_prompt,
    });
    let changes_escaped = proposed_changes.to_string().replace('\'', "''");

    // Build file_diffs with before/after content for each changed field
    let file_diffs = json!([
        {
            "file_path": "system_prompt",
            "old_content": old_prompt,
            "new_content": new_prompt,
        }
    ]);
    let diffs_escaped = file_diffs.to_string().replace('\'', "''");

    let reasoning = format!(
        "## Drift Detected\n\n{}\n\n## Expert Behavior\n\n{}\n\n## Expert Heuristic\n\n{}",
        drift.gap_description, task.description, task.expert_heuristic
    );
    let reasoning_escaped = reasoning.replace('\'', "''");
    let gap_escaped = drift.gap_description.replace('\'', "''");

    let sql = format!(
        r#"INSERT INTO agent_prs
            (id, pr_type, target_agent_slug, file_diffs, proposed_changes, reasoning, gap_summary,
             confidence, evidence_count, evidence_task_ids, evidence_session_ids, status)
           VALUES
            ('{pr_id}', 'enhancement', '{slug_escaped}', '{diffs_escaped}'::jsonb, '{changes_escaped}'::jsonb,
             '{reasoning_escaped}', '{gap_escaped}', {confidence}, 1,
             ARRAY['{task_id}'::uuid], ARRAY['{session_id}'::uuid], 'open')"#,
        task_id = task.id,
    );

    db.execute(&sql).await?;
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

    let agent_def: Value = serde_json::from_str(cleaned).unwrap_or_else(|_| {
        json!({
            "name": proposed_slug,
            "category": "uncategorized",
            "description": format!("Auto-generated from observations"),
            "system_prompt": evidence_text,
            "tools": [],
            "judge_config": {"threshold": 7.0, "rubric": [], "need_to_know": []},
            "intents": []
        })
    });

    let pr_id = Uuid::new_v4();
    let slug_escaped = proposed_slug.replace('\'', "''");
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
    let changes_escaped = proposed_changes.to_string().replace('\'', "''");

    // Build file_diffs — for new agents, old_content is null (new file)
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
    let diffs_escaped = file_diffs.to_string().replace('\'', "''");

    let reasoning = format!(
        "## New Agent Proposed\n\nBased on {} observation(s) where no existing agent matched.\n\n## Evidence:\n{}",
        task_descriptions.len(), evidence_text
    );
    let reasoning_escaped = reasoning.replace('\'', "''");

    let session_arr = if session_ids.is_empty() {
        "'{}'::uuid[]".to_string()
    } else {
        let items: Vec<String> = session_ids.iter().map(|s| format!("\"{s}\"")).collect();
        format!("'{{{}}}'::uuid[]", items.join(","))
    };

    let sql = format!(
        r#"INSERT INTO agent_prs
            (id, pr_type, proposed_slug, file_diffs, proposed_changes, reasoning, gap_summary,
             confidence, evidence_count, evidence_session_ids, status)
           VALUES
            ('{pr_id}', 'new_agent', '{slug_escaped}', '{diffs_escaped}'::jsonb, '{changes_escaped}'::jsonb,
             '{reasoning_escaped}', 'New agent from observation', 0.7,
             {count}, {session_arr}, 'open')"#,
        count = task_descriptions.len(),
    );

    db.execute(&sql).await?;
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
        .execute(&format!(
            "SELECT pr_type, target_agent_slug, proposed_slug, proposed_changes \
             FROM agent_prs WHERE id = '{pr_id}' AND status = 'open'"
        ))
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

    let update_sql = format!(
        "UPDATE agent_prs SET status = 'approved', reviewed_at = NOW() WHERE id = '{pr_id}'"
    );
    db.execute(&update_sql).await?;

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
    let slug_escaped = slug.replace('\'', "''");
    let mut set_clauses = Vec::new();

    if let Some(prompt) = changes.get("system_prompt").and_then(Value::as_str) {
        set_clauses.push(format!(
            "system_prompt = '{}'",
            prompt.replace('\'', "''")
        ));
    }

    if let Some(jc) = changes.get("judge_config") {
        set_clauses.push(format!(
            "judge_config = '{}'::jsonb",
            jc.to_string().replace('\'', "''")
        ));
    }

    if let Some(examples) = changes.get("examples") {
        set_clauses.push(format!(
            "examples = '{}'::jsonb",
            examples.to_string().replace('\'', "''")
        ));
    }

    if set_clauses.is_empty() {
        return Ok(());
    }

    set_clauses.push("version = version + 1".to_string());
    set_clauses.push("updated_at = NOW()".to_string());

    let update_sql = format!(
        "UPDATE agent_definitions SET {} WHERE slug = '{slug_escaped}' RETURNING version",
        set_clauses.join(", ")
    );
    let result = db.execute(&update_sql).await?;

    let new_version = result
        .first()
        .and_then(|r| r.get("version").and_then(Value::as_i64))
        .unwrap_or(1);

    let summary = format!("Applied PR {pr_id}");
    let summary_escaped = summary.replace('\'', "''");
    let snapshot_json = changes.to_string().replace('\'', "''");

    let version_sql = format!(
        r#"INSERT INTO agent_versions (agent_id, version, snapshot, change_summary, change_source, source_pr_id)
           SELECT id, {new_version}, '{snapshot_json}'::jsonb, '{summary_escaped}', 'feedback_pipeline', '{pr_id}'::uuid
           FROM agent_definitions WHERE slug = '{slug_escaped}'
           ON CONFLICT (agent_id, version) DO NOTHING"#
    );
    let _ = db.execute(&version_sql).await;

    Ok(())
}

async fn apply_new_agent(
    db: &PgClient,
    slug: &str,
    changes: &Value,
) -> anyhow::Result<()> {
    let slug_escaped = slug.replace('\'', "''");
    let name = changes
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(slug)
        .replace('\'', "''");
    let category = changes
        .get("category")
        .and_then(Value::as_str)
        .unwrap_or("uncategorized")
        .replace('\'', "''");
    let description = changes
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("")
        .replace('\'', "''");
    let system_prompt = changes
        .get("system_prompt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .replace('\'', "''");

    let tools_json = changes
        .get("tools")
        .unwrap_or(&json!([]))
        .as_array()
        .map(|arr| {
            let items: Vec<String> = arr
                .iter()
                .filter_map(Value::as_str)
                .map(|s| format!("\"{}\"", s.replace('"', r#"\""#)))
                .collect();
            format!("'{{{}}}'::text[]", items.join(","))
        })
        .unwrap_or_else(|| "'{}'::text[]".to_string());

    let judge_config_json = changes
        .get("judge_config")
        .unwrap_or(&json!({"threshold": 7.0, "rubric": [], "need_to_know": []}))
        .to_string()
        .replace('\'', "''");

    let intents_arr = changes
        .get("intents")
        .and_then(Value::as_array)
        .map(|arr| {
            let items: Vec<String> = arr
                .iter()
                .filter_map(Value::as_str)
                .map(|s| format!("\"{}\"", s.replace('"', r#"\""#)))
                .collect();
            format!("'{{{}}}'::text[]", items.join(","))
        })
        .unwrap_or_else(|| "'{}'::text[]".to_string());

    let sql = format!(
        r#"INSERT INTO agent_definitions
            (slug, name, category, description, system_prompt, tools, judge_config, intents)
           VALUES
            ('{slug_escaped}', '{name}', '{category}', '{description}', '{system_prompt}',
             {tools_json}, '{judge_config_json}'::jsonb, {intents_arr})
           ON CONFLICT (slug) DO NOTHING"#
    );
    db.execute(&sql).await?;

    let snapshot_json = changes.to_string().replace('\'', "''");
    let version_sql = format!(
        r#"INSERT INTO agent_versions (agent_id, version, snapshot, change_summary, change_source)
           SELECT id, 1, '{snapshot_json}'::jsonb, 'New agent from observation', 'observation'
           FROM agent_definitions WHERE slug = '{slug_escaped}'
           ON CONFLICT (agent_id, version) DO NOTHING"#
    );
    let _ = db.execute(&version_sql).await;

    info!(slug = slug, "new agent created in DB");
    Ok(())
}

/// When a PR is applied, also create a base-scope overlay for the matching
/// skill so the learning persists as contextual guidance even if the agent
/// definition is later modified.
async fn create_overlay_from_pr(db: &PgClient, agent_slug: &str, changes: &Value, pr_id: Uuid) {
    let slug_escaped = agent_slug.replace('\'', "''");
    let skill_sql = format!(
        "SELECT id FROM skills WHERE slug = '{slug_escaped}' LIMIT 1"
    );
    let skill_id = match db.execute(&skill_sql).await {
        Ok(rows) => match rows.first().and_then(|r| r.get("id").and_then(Value::as_str)) {
            Some(id) => id.to_string(),
            None => return,
        },
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
    let content_escaped = content.replace('\'', "''");
    let meta = json!({"source_pr_id": pr_id.to_string(), "agent_slug": agent_slug});
    let meta_escaped = meta.to_string().replace('\'', "''");

    let sql = format!(
        r#"INSERT INTO overlays
            (id, primitive_type, primitive_id, scope, scope_id, content, source, metadata)
           VALUES
            ('{overlay_id}', 'skill', '{skill_id}', 'base', NULL,
             '{content_escaped}', 'feedback', '{meta_escaped}'::jsonb)"#
    );

    match db.execute(&sql).await {
        Ok(_) => info!(overlay = %overlay_id, skill = %skill_id, pr = %pr_id, "created overlay from applied PR"),
        Err(e) => tracing::warn!(pr = %pr_id, error = %e, "failed to create overlay from PR"),
    }
}
