/// Agent PR engine.
///
/// Generates Agent PRs (proposed file diffs) from extraction pipeline output.
/// Reads the agent's current prompt.md, appends the proposed addition,
/// and creates a row in agent_prs with the diff.
use serde_json::json;
use tracing::{info, warn};
use uuid::Uuid;

use crate::extraction::{AbstractedTask, DriftResult};
use crate::pg::PgClient;

/// Create an enhancement PR for an existing agent based on drift detection.
pub async fn create_enhancement_pr(
    db: &PgClient,
    agent_slug: &str,
    drift: &DriftResult,
    task: &AbstractedTask,
    session_id: &str,
    confidence: f64,
    agents_dir: &str,
) -> anyhow::Result<Uuid> {
    let pr_id = Uuid::new_v4();

    // Read current prompt.md
    let prompt_path = format!("{}/{}/prompt.md", agents_dir, agent_slug);
    let old_content = match std::fs::read_to_string(&prompt_path) {
        Ok(c) => c,
        Err(e) => {
            warn!(agent = agent_slug, error = %e, "could not read prompt.md");
            return Err(anyhow::anyhow!("could not read prompt.md for {agent_slug}: {e}"));
        }
    };

    // Append the proposed addition
    let new_content = format!(
        "{}\n\n{}\n",
        old_content.trim_end(),
        drift.prompt_addition.trim()
    );

    // Build file_diffs JSON
    let file_diffs = json!([{
        "file_path": format!("agents/{}/prompt.md", agent_slug),
        "old_content": old_content,
        "new_content": new_content,
    }]);

    // Build reasoning
    let reasoning = format!(
        "## Drift Detected\n\n{}\n\n## Expert Behavior\n\n{}\n\n## Expert Heuristic\n\n{}",
        drift.gap_description, task.description, task.expert_heuristic
    );

    let reasoning_escaped = reasoning.replace('\'', "''");
    let gap_escaped = drift.gap_description.replace('\'', "''");
    let diffs_escaped = file_diffs.to_string().replace('\'', "''");

    let sql = format!(
        r#"
        INSERT INTO agent_prs
          (id, pr_type, target_agent_slug, file_diffs, reasoning, gap_summary,
           confidence, evidence_count, evidence_task_ids, evidence_session_ids, status)
        VALUES
          ('{pr_id}', 'enhancement', '{agent_slug}', '{diffs_escaped}'::jsonb,
           '{reasoning_escaped}', '{gap_escaped}', {confidence}, 1,
           ARRAY['{task_id}'::uuid], ARRAY['{session_id}'::uuid], 'open')
        "#,
        task_id = task.id,
    );

    db.execute(&sql).await?;

    info!(
        pr = %pr_id,
        agent = agent_slug,
        gap = %drift.gap_description,
        "enhancement PR created"
    );

    Ok(pr_id)
}
