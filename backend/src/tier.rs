/// Tier system — computes autonomy levels from execution history.
///
/// T1 (Proven): 3+ passes → auto-execute, log only
/// T2 (Developing): 1-2 passes → execute, pause for review
/// T3 (Unproven): 0 passes or mostly failures → pause before executing
use serde_json::Value;

use crate::pg::PgClient;
use crate::pg_args;

const T1_THRESHOLD: i64 = 3;

/// Compute the tier for a given agent + task.
/// Uses task_fingerprint matching: for now, a simple slug-based lookup.
/// Future: LLM-based or embedding-based fingerprinting for semantic matching.
pub async fn compute_tier(db: &PgClient, agent_slug: &str, _task_description: &str) -> String {
    let rows = match db.execute_with(
        r#"SELECT
            COUNT(*) FILTER (WHERE status = 'passed') as passes,
            COUNT(*) FILTER (WHERE status = 'failed') as failures,
            AVG(judge_score) FILTER (WHERE judge_score IS NOT NULL) as avg_score
           FROM agent_run_history
           WHERE agent_slug = $1"#,
        pg_args!(agent_slug.to_string()),
    ).await {
        Ok(r) => r,
        Err(_) => return "T3".to_string(),
    };

    let row = match rows.first() {
        Some(r) => r,
        None => return "T3".to_string(),
    };

    let passes = row
        .get("passes")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let failures = row
        .get("failures")
        .and_then(Value::as_i64)
        .unwrap_or(0);

    if passes >= T1_THRESHOLD && passes > failures * 2 {
        "T1".to_string()
    } else if passes > 0 {
        "T2".to_string()
    } else {
        "T3".to_string()
    }
}

/// Record a completed execution into run history for future tier computation.
pub async fn record_run(
    db: &PgClient,
    agent_slug: &str,
    task_description: &str,
    session_id: &str,
    node_id: &str,
    status: &str,
    judge_score: Option<f64>,
) -> anyhow::Result<()> {
    let fingerprint = compute_fingerprint(agent_slug, task_description);
    let session_uuid: uuid::Uuid = session_id.parse().map_err(|e| anyhow::anyhow!("invalid session_id: {e}"))?;
    let node_uuid: uuid::Uuid = node_id.parse().map_err(|e| anyhow::anyhow!("invalid node_id: {e}"))?;

    db.execute_with(
        r#"INSERT INTO agent_run_history
            (agent_slug, task_fingerprint, session_id, node_id, status, judge_score)
           VALUES ($1, $2, $3, $4, $5, $6)"#,
        pg_args!(
            agent_slug.to_string(),
            fingerprint,
            session_uuid,
            node_uuid,
            status.to_string(),
            judge_score,
        ),
    ).await?;
    Ok(())
}

/// Resolve the effective tier for a node: user override > template override > computed.
pub fn effective_tier(
    computed: Option<&str>,
    tier_override: Option<&str>,
) -> String {
    tier_override
        .or(computed)
        .unwrap_or("T3")
        .to_string()
}

/// Simple fingerprint: just the agent slug for now.
/// Future: LLM-based semantic hashing of the task description.
fn compute_fingerprint(agent_slug: &str, _task_description: &str) -> String {
    agent_slug.to_string()
}
