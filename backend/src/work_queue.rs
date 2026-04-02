/// Work queue — executes execution nodes in DAG order using Kahn's algorithm.
///
/// Adapted from dataAggregate/work_queue.rs. Core logic is identical:
/// - Poll for ready nodes (FOR UPDATE SKIP LOCKED)
/// - Execute up to MAX_CONCURRENT_NODES in parallel tokio tasks
/// - On completion, eagerly unblock downstream nodes
/// - Stale node recovery every 60s (10-min timeout)
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::agent_catalog::{AgentCatalog, ExecutionPlanNode, NodeStatus};
use crate::pg_args;
use crate::agent_runner::{AgentResult, AgentRunner};
use crate::config::Settings;
use crate::feedback;
use crate::pg::PgClient;
use crate::session::EventBus;
use crate::tier;

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const STALE_NODE_TIMEOUT: Duration = Duration::from_secs(600); // 10 min
const MAX_ATTEMPTS: u32 = 3;
const MAX_CONCURRENT_NODES: usize = 8;

pub fn spawn(
    settings: Arc<Settings>,
    db: PgClient,
    catalog: Arc<AgentCatalog>,
    skill_catalog: Arc<crate::skills::SkillCatalog>,
    event_bus: EventBus,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        info!("work queue started");

        // On startup: recover any stale running nodes from a prior crash
        if let Err(e) = recover_stale_nodes(&db).await {
            warn!(error = %e, "stale node recovery failed on startup");
        }

        let mut interval = tokio::time::interval(POLL_INTERVAL);
        let mut stale_check_counter = 0u32;

        loop {
            tokio::select! {
                _ = interval.tick() => {}
                _ = shutdown.changed() => {
                    if *shutdown.borrow() {
                        info!("work queue shutting down");
                        break;
                    }
                }
            }

            // Periodic stale node sweep (every 60s = 30 poll cycles)
            stale_check_counter += 1;
            if stale_check_counter >= 30 {
                stale_check_counter = 0;
                if let Err(e) = recover_stale_nodes(&db).await {
                    warn!(error = %e, "periodic stale node recovery failed");
                }
            }

            // Claim ready nodes atomically
            let ready_nodes = match claim_ready_nodes(&db, MAX_CONCURRENT_NODES).await {
                Ok(nodes) => nodes,
                Err(e) => {
                    error!(error = %e, "failed to claim ready nodes");
                    continue;
                }
            };

            if ready_nodes.is_empty() {
                continue;
            }

            info!(count = ready_nodes.len(), "claimed ready nodes");

            // Execute nodes concurrently
            let mut handles = Vec::new();
            for node in ready_nodes {
                let settings = settings.clone();
                let db = db.clone();
                let catalog = catalog.clone();
                let skill_catalog = skill_catalog.clone();
                let event_bus = event_bus.clone();

                let handle = tokio::spawn(async move {
                    execute_node(settings, db, catalog, skill_catalog, event_bus, node).await;
                });
                handles.push(handle);
            }

            // Wait for all spawned tasks to complete
            for handle in handles {
                if let Err(e) = handle.await {
                    error!(error = %e, "node execution task panicked");
                }
            }
        }

        info!("work queue stopped");
    })
}

async fn execute_node(
    settings: Arc<Settings>,
    db: PgClient,
    catalog: Arc<AgentCatalog>,
    skill_catalog: Arc<crate::skills::SkillCatalog>,
    event_bus: EventBus,
    node: ExecutionPlanNode,
) {
    let uid = node.uid;
    let session_id = node.session_id;
    let agent_slug = node.agent_slug.clone();

    info!(
        uid = %uid,
        session = %session_id,
        agent = %agent_slug,
        "executing node"
    );

    // Persist + broadcast node_started event
    let start_payload = serde_json::json!({"agent_slug": &agent_slug});
    let _ = db.execute_with(
        "INSERT INTO execution_events (session_id, node_id, event_type, payload) VALUES ($1, $2, $3, $4)",
        pg_args!(session_id, uid, "node_started".to_string(), start_payload),
    ).await;

    event_bus.send(
        &session_id.to_string(),
        serde_json::json!({
            "type": "node_started",
            "node_uid": uid.to_string(),
            "agent_slug": &agent_slug,
        }),
    ).await;

    // Get upstream outputs for context
    let upstream_outputs = match load_upstream_outputs(&db, &node).await {
        Ok(o) => o,
        Err(e) => {
            warn!(uid = %uid, error = %e, "failed to load upstream outputs");
            std::collections::HashMap::new()
        }
    };

    let runner = AgentRunner::new(settings.clone(), db.clone(), catalog.clone(), skill_catalog.clone(), event_bus.clone());
    let result = runner.run(&node, &upstream_outputs).await;

    // Broadcast via the event bus channel (currently just logs; SSE route polls DB)
    emit_to_session(&event_bus, &session_id.to_string(), &result).await;

    // Persist result to DB
    if let Err(e) = persist_node_result(&db, &uid, &result).await {
        error!(uid = %uid, error = %e, "failed to persist node result");
        return;
    }

    // Record run history for tier computation
    let _ = tier::record_run(
        &db,
        &agent_slug,
        &node.task_description,
        &session_id.to_string(),
        &uid.to_string(),
        result.status.as_str(),
        result.judge_score,
    )
    .await;

    // Record judge failures as feedback signals for agent learning
    if result.status == NodeStatus::Failed {
        if let Some(judge_fb) = &result.judge_feedback {
            let _ = feedback::record_judge_failure_signal(
                &db,
                &agent_slug,
                &session_id.to_string(),
                judge_fb,
                &node.task_description,
            )
            .await;
        }
    }

    // Extract blockers/errors from agent output and record as feedback signals
    if let Some(ref output) = result.output {
        let _ = feedback::record_blockers_from_output(
            &db,
            &agent_slug,
            &session_id.to_string(),
            output,
        )
        .await;
    }

    // Unblock or skip downstream nodes
    match result.status {
        NodeStatus::Passed => {
            if let Err(e) = unblock_downstream(&db, &uid, &session_id).await {
                error!(uid = %uid, error = %e, "failed to unblock downstream");
            }
            // Check if all nodes are terminal → mark session completed
            check_session_completion(&db, &session_id, &event_bus).await;
        }
        NodeStatus::Failed => {
            if let Err(e) = skip_downstream(&db, &uid, &session_id).await {
                error!(uid = %uid, error = %e, "failed to skip downstream");
            }
            check_session_completion(&db, &session_id, &event_bus).await;
        }
        _ => {}
    }
}

/// Atomically claim up to `limit` ready nodes.
/// Uses PostgreSQL advisory lock pattern to avoid double-claiming.
async fn claim_ready_nodes(
    db: &PgClient,
    limit: usize,
) -> anyhow::Result<Vec<ExecutionPlanNode>> {
    // Mark nodes as running atomically using a CTE
    // Skip breakpoint nodes — they stay "ready" until user explicitly removes the breakpoint
    let sql = format!(
        r#"
        WITH claimed AS (
            UPDATE execution_nodes
            SET status = 'running',
                started_at = NOW(),
                attempt_count = attempt_count + 1
            WHERE id IN (
                SELECT id FROM execution_nodes
                WHERE status = 'ready'
                  AND attempt_count < {MAX_ATTEMPTS}
                  AND (breakpoint IS NULL OR breakpoint = false)
                ORDER BY created_at
                LIMIT {limit}
                FOR UPDATE SKIP LOCKED
            )
            RETURNING *
        )
        SELECT
            id, session_id, agent_slug, agent_git_sha, task_description,
            status, requires, attempt_count, parent_uid,
            input, output, judge_score, judge_feedback,
            judge_config, max_iterations, model, skip_judge,
            variant_group, variant_label, variant_selected, client_id
        FROM claimed
        "#
    );

    let rows = db.execute(&sql).await?;
    let nodes = rows.iter().filter_map(parse_node_row).collect();
    Ok(nodes)
}

fn parse_node_row(row: &Value) -> Option<ExecutionPlanNode> {
    use crate::agent_catalog::JudgeConfig;

    let uid = row.get("id")?.as_str()?.parse::<Uuid>().ok()?;
    let session_id = row.get("session_id")?.as_str()?.parse::<Uuid>().ok()?;
    let agent_slug = row.get("agent_slug")?.as_str()?.to_string();
    let agent_git_sha = row.get("agent_git_sha")?.as_str()?.to_string();
    let task_description = row.get("task_description")?.as_str()?.to_string();
    let model = row.get("model")?.as_str()?.to_string();
    let max_iterations = row.get("max_iterations")?.as_u64()? as u32;
    let skip_judge = row.get("skip_judge")?.as_bool().unwrap_or(false);
    let attempt_count = row.get("attempt_count")?.as_u64()? as u32;

    let requires: Vec<Uuid> = row
        .get("requires")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str()?.parse::<Uuid>().ok())
                .collect()
        })
        .unwrap_or_default();

    let judge_config = row
        .get("judge_config")
        .and_then(|v| serde_json::from_value::<JudgeConfig>(v.clone()).ok())
        .unwrap_or_default();

    Some(ExecutionPlanNode {
        uid,
        session_id,
        agent_slug,
        agent_git_sha,
        task_description,
        status: NodeStatus::Running,
        requires,
        attempt_count,
        parent_uid: row
            .get("parent_uid")
            .and_then(Value::as_str)
            .and_then(|s| s.parse::<Uuid>().ok()),
        input: row.get("input").cloned(),
        output: None,
        judge_score: None,
        judge_feedback: None,
        judge_config,
        max_iterations,
        model,
        skip_judge,
        variant_group: row.get("variant_group").and_then(Value::as_str).and_then(|s| s.parse::<Uuid>().ok()),
        variant_label: row.get("variant_label").and_then(Value::as_str).map(String::from),
        variant_selected: row.get("variant_selected").and_then(Value::as_bool),
        client_id: row.get("client_id").and_then(Value::as_str).and_then(|s| s.parse::<Uuid>().ok()),
    })
}

async fn persist_node_result(
    db: &PgClient,
    uid: &Uuid,
    result: &AgentResult,
) -> anyhow::Result<()> {
    let status = result.status.as_str().to_string();

    // If there's an error but no judge_feedback, surface the error in judge_feedback
    let effective_feedback: Option<String> = result
        .judge_feedback
        .clone()
        .or_else(|| result.error.clone());

    let completed_clause = if result.status.is_terminal() {
        "completed_at = NOW()"
    } else {
        "completed_at = completed_at" // no-op for awaiting_reply
    };
    let sql = format!(
        "UPDATE execution_nodes SET status = $1, output = $2, judge_score = $3, judge_feedback = $4, {} WHERE id = $5",
        completed_clause
    );
    db.execute_with(
        &sql,
        pg_args!(status, result.output.clone(), result.judge_score, effective_feedback, *uid),
    ).await?;

    // Log execution event with rich payload
    let narrative_preview: String = result
        .final_summary
        .as_ref()
        .map(|s| s.chars().take(300).collect())
        .unwrap_or_default();
    let event_payload = serde_json::json!({
        "status": result.status.as_str(),
        "duration_ms": result.duration_ms,
        "narrative_preview": narrative_preview,
        "score": result.judge_score,
    });
    let _ = db.execute_with(
        r#"INSERT INTO execution_events (session_id, node_id, event_type, payload)
           SELECT session_id, id, 'node_completed', $1
           FROM execution_nodes WHERE id = $2"#,
        pg_args!(event_payload, *uid),
    ).await;

    Ok(())
}

/// Eagerly unblock downstream nodes when a node passes.
/// A node becomes ready when ALL its required nodes are in a terminal state.
async fn unblock_downstream(
    db: &PgClient,
    completed_uid: &Uuid,
    session_id: &Uuid,
) -> anyhow::Result<()> {
    // Find all nodes in this session that depend on the completed node
    let dependents_sql = format!(
        r#"
        SELECT id, requires
        FROM execution_nodes
        WHERE session_id = '{session_id}'
          AND status IN ('pending', 'waiting')
          AND requires @> ARRAY['{completed_uid}'::uuid]
        "#
    );

    let dependents = db.execute(&dependents_sql).await?;

    for dep in &dependents {
        let dep_uid = match dep.get("id").and_then(Value::as_str).and_then(|s| s.parse::<Uuid>().ok()) {
            Some(u) => u,
            None => continue,
        };

        let requires: Vec<Uuid> = dep
            .get("requires")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str()?.parse::<Uuid>().ok())
                    .collect()
            })
            .unwrap_or_default();

        if requires.is_empty() {
            continue;
        }

        // Check if all required nodes are in terminal state
        let req_uuids: Vec<String> = requires.iter().map(|u| format!("'{u}'")).collect();
        let check_sql = format!(
            r#"
            SELECT COUNT(*) as total,
                   COUNT(*) FILTER (WHERE status IN ('passed', 'failed', 'skipped')) as terminal
            FROM execution_nodes
            WHERE id = ANY(ARRAY[{}]::uuid[])
            "#,
            req_uuids.join(",")
        );

        let check_rows = db.execute(&check_sql).await?;
        if let Some(row) = check_rows.first() {
            let total = row.get("total").and_then(Value::as_i64).unwrap_or(0);
            let terminal = row.get("terminal").and_then(Value::as_i64).unwrap_or(0);

            // All deps passed? (not failed/skipped) — mark ready
            if total > 0 && total == terminal {
                // Only mark ready if all deps passed (not failed/skipped)
                let all_passed_sql = format!(
                    r#"
                    SELECT COUNT(*) FILTER (WHERE status = 'passed') as passed
                    FROM execution_nodes
                    WHERE id = ANY(ARRAY[{}]::uuid[])
                    "#,
                    req_uuids.join(",")
                );
                let pass_rows = db.execute(&all_passed_sql).await?;
                let passed = pass_rows
                    .first()
                    .and_then(|r| r.get("passed").and_then(Value::as_i64))
                    .unwrap_or(0);

                if passed == total {
                    let update_sql = format!(
                        "UPDATE execution_nodes SET status = 'ready' WHERE id = '{dep_uid}'"
                    );
                    db.execute(&update_sql).await?;
                    info!(uid = %dep_uid, "unblocked downstream node");
                }
            }
        }
    }

    Ok(())
}

/// Skip all downstream nodes when a node fails.
async fn skip_downstream(
    db: &PgClient,
    failed_uid: &Uuid,
    session_id: &Uuid,
) -> anyhow::Result<()> {
    // Find direct dependents
    let sql = format!(
        r#"
        UPDATE execution_nodes
        SET status = 'skipped', completed_at = NOW()
        WHERE session_id = '{session_id}'
          AND status IN ('pending', 'waiting')
          AND requires @> ARRAY['{failed_uid}'::uuid]
        RETURNING id
        "#
    );

    let skipped = db.execute(&sql).await?;

    // Recursively skip their dependents too
    for row in skipped {
        if let Some(uid_str) = row.get("id").and_then(Value::as_str) {
            if let Ok(uid) = uid_str.parse::<Uuid>() {
                // Best-effort recursive skip
                let _ = skip_downstream_recursive(db, &uid, session_id).await;
            }
        }
    }

    Ok(())
}

async fn skip_downstream_recursive(
    db: &PgClient,
    skipped_uid: &Uuid,
    session_id: &Uuid,
) -> anyhow::Result<()> {
    let sql = format!(
        r#"
        UPDATE execution_nodes
        SET status = 'skipped', completed_at = NOW()
        WHERE session_id = '{session_id}'
          AND status IN ('pending', 'waiting')
          AND requires @> ARRAY['{skipped_uid}'::uuid]
        "#
    );
    db.execute(&sql).await?;
    Ok(())
}

/// Mark session as completed if all nodes are in a terminal state.
/// Preview nodes (spawned but never started) are treated as terminal.
async fn check_session_completion(db: &PgClient, session_id: &Uuid, event_bus: &EventBus) {
    let sql = format!(
        r#"
        SELECT
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE status IN ('passed', 'failed', 'skipped', 'preview')) as terminal
        FROM execution_nodes
        WHERE session_id = '{session_id}'
        "#
    );

    if let Ok(rows) = db.execute(&sql).await {
        if let Some(row) = rows.first() {
            let total = row.get("total").and_then(Value::as_i64).unwrap_or(0);
            let terminal = row.get("terminal").and_then(Value::as_i64).unwrap_or(0);

            if total > 0 && total == terminal {
                // Use WHERE status != 'completed' to prevent duplicate completion
                // when multiple nodes finish concurrently.
                let update_sql = format!(
                    "UPDATE execution_sessions SET status = 'completed', completed_at = NOW() WHERE id = '{session_id}' AND status != 'completed' RETURNING id"
                );
                let updated = db.execute(&update_sql).await.unwrap_or_default();
                if updated.is_empty() {
                    // Another task already completed this session
                    return;
                }

                // Broadcast session_completed (consumed by SSE and Slack notifier)
                event_bus.send(
                    &session_id.to_string(),
                    serde_json::json!({"type": "session_completed"}),
                ).await;

                info!(session = %session_id, "session completed");
            }
        }
    }
}

/// Recover nodes stuck in 'running' state for longer than STALE_NODE_TIMEOUT.
async fn recover_stale_nodes(db: &PgClient) -> anyhow::Result<()> {
    let timeout_secs = STALE_NODE_TIMEOUT.as_secs();

    let sql = format!(
        r#"
        UPDATE execution_nodes
        SET status = CASE
            WHEN attempt_count >= {MAX_ATTEMPTS} THEN 'failed'
            ELSE 'ready'
        END,
        started_at = NULL
        WHERE status = 'running'
          AND started_at < NOW() - INTERVAL '{timeout_secs} seconds'
        RETURNING id, attempt_count
        "#
    );

    let recovered = db.execute(&sql).await?;
    if !recovered.is_empty() {
        warn!(count = recovered.len(), "recovered stale running nodes");
    }

    Ok(())
}

/// Load upstream node outputs for context injection.
async fn load_upstream_outputs(
    db: &PgClient,
    node: &ExecutionPlanNode,
) -> anyhow::Result<std::collections::HashMap<String, Value>> {
    if node.requires.is_empty() {
        return Ok(std::collections::HashMap::new());
    }

    let req_uuids: Vec<String> = node.requires.iter().map(|u| format!("'{u}'")).collect();
    let sql = format!(
        r#"
        SELECT agent_slug, output
        FROM execution_nodes
        WHERE id = ANY(ARRAY[{}]::uuid[])
          AND status = 'passed'
          AND output IS NOT NULL
        "#,
        req_uuids.join(",")
    );

    let rows = db.execute(&sql).await?;
    let mut map = std::collections::HashMap::new();
    for row in rows {
        if let (Some(slug), Some(output)) = (
            row.get("agent_slug").and_then(Value::as_str),
            row.get("output"),
        ) {
            map.insert(slug.to_string(), output.clone());
        }
    }

    Ok(map)
}

/// Emit a completion event to the session's SSE channel.
async fn emit_to_session(event_bus: &EventBus, session_id: &str, result: &AgentResult) {
    let event = serde_json::json!({
        "type": "node_completed",
        "node_uid": result.node_uid,
        "status": result.status.as_str(),
        "judge_score": result.judge_score,
        "duration_ms": result.duration_ms,
    });

    event_bus.send(session_id, event).await;

    info!(
        session = %session_id,
        node = %result.node_uid,
        status = %result.status.as_str(),
        "node execution complete"
    );
}
