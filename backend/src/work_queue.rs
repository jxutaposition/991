/// Work queue — executes execution nodes in DAG order using Kahn's algorithm.
///
/// Core logic:
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
    tool_catalog: Arc<crate::tool_catalog::ToolCatalog>,
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
                let tool_catalog = tool_catalog.clone();
                let event_bus = event_bus.clone();

                let handle = tokio::spawn(async move {
                    execute_node(settings, db, catalog, skill_catalog, tool_catalog, event_bus, node).await;
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

#[tracing::instrument(
    skip(settings, db, catalog, skill_catalog, tool_catalog, event_bus, node),
    fields(session_id = %node.session_id, node_uid = %node.uid, agent = %node.agent_slug)
)]
async fn execute_node(
    settings: Arc<Settings>,
    db: PgClient,
    catalog: Arc<AgentCatalog>,
    skill_catalog: Arc<crate::skills::SkillCatalog>,
    tool_catalog: Arc<crate::tool_catalog::ToolCatalog>,
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
    if let Err(e) = db.execute_with(
        "INSERT INTO execution_events (session_id, node_id, event_type, payload) VALUES ($1, $2, $3, $4)",
        pg_args!(session_id, uid, "node_started".to_string(), start_payload),
    ).await {
        warn!(uid = %uid, error = %e, "failed to persist node_started event");
    }

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

    // Manual-mode nodes: skip agent loop, set awaiting_reply with structured instructions
    if node.execution_mode == "manual" {
        info!(uid = %uid, agent = %agent_slug, "manual-mode node — entering awaiting_reply");

        let description = db.execute_with(
            "SELECT description, acceptance_criteria, task_description FROM execution_nodes WHERE id = $1",
            pg_args!(uid),
        ).await.ok().and_then(|rows| rows.into_iter().next());

        let desc_json = description.as_ref()
            .and_then(|r| r.get("description").cloned())
            .unwrap_or(serde_json::json!({}));

        let _user_actions = desc_json.get("user_actions")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join("\n- "))
            .unwrap_or_default();

        let io_outputs = desc_json.get("io_contract")
            .and_then(|v| v.get("outputs"))
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.get("name").and_then(|n| n.as_str())).collect::<Vec<_>>().join(", "))
            .unwrap_or_default();

        let validation_hints = desc_json.get("validation_hints")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.get("description").and_then(|d| d.as_str())).collect::<Vec<_>>().join("\n- "))
            .unwrap_or_default();

        let instructions = serde_json::json!({
            "type": "manual_action",
            "sub_type": "manual_execution",
            "overview": format!("This step needs to be completed manually: {}", node.task_description),
            "sections": [
                {
                    "title": "Steps",
                    "items": desc_json.get("user_actions").cloned().unwrap_or(serde_json::json!([node.task_description])),
                },
                {
                    "title": "Expected Outputs",
                    "content": if io_outputs.is_empty() { "Reply when complete.".to_string() } else { format!("Please provide: {io_outputs}") },
                },
                {
                    "title": "Verification",
                    "content": if validation_hints.is_empty() { "We'll verify completion after you reply.".to_string() } else { format!("- {validation_hints}") },
                }
            ],
        });

        let _ = db.execute_with(
            "INSERT INTO execution_events (session_id, node_id, event_type, payload) VALUES ($1, $2, $3, $4)",
            pg_args!(session_id, uid, "manual_action_requested".to_string(), instructions.clone()),
        ).await;

        let _ = db.execute_with(
            "UPDATE execution_nodes SET status = 'awaiting_reply' WHERE id = $1",
            pg_args!(uid),
        ).await;

        event_bus.send(
            &session_id.to_string(),
            serde_json::json!({
                "type": "node_status",
                "node_uid": uid.to_string(),
                "status": "awaiting_reply",
                "manual_action": instructions,
            }),
        ).await;

        // Emit stream entry so the chat shows the manual action card
        let _stream_entry = serde_json::json!({
            "stream_type": "message",
            "sub_type": "request_user_action",
            "role": "assistant",
            "content": serde_json::to_string(&instructions).unwrap_or_default(),
            "metadata": instructions,
        });
        let _ = db.execute_with(
            "INSERT INTO node_messages (node_id, stream_type, sub_type, role, content, metadata) \
             VALUES ($1, $2, $3, $4, $5, $6)",
            pg_args!(
                uid, "message".to_string(), "request_user_action".to_string(),
                "assistant".to_string(),
                serde_json::to_string(&instructions).unwrap_or_default(),
                instructions
            ),
        ).await;

        return;
    }

    let runner = AgentRunner::new(settings.clone(), db.clone(), catalog.clone(), skill_catalog.clone(), tool_catalog.clone(), event_bus.clone());
    let result = runner.run(&node, &upstream_outputs).await;

    info!(
        uid = %uid,
        session = %session_id,
        agent = %agent_slug,
        status = %result.status.as_str(),
        duration_ms = result.duration_ms,
        score = ?result.judge_score,
        "node execution finished"
    );

    // Broadcast via the event bus channel (currently just logs; SSE route polls DB)
    emit_to_session(&event_bus, &session_id.to_string(), &result).await;

    // Persist result to DB
    if let Err(e) = persist_node_result(&db, &uid, &result).await {
        error!(uid = %uid, error = %e, "failed to persist node result");
        return;
    }

    // Record run history for tier computation
    if let Err(e) = tier::record_run(
        &db,
        &agent_slug,
        &node.task_description,
        &session_id.to_string(),
        &uid.to_string(),
        result.status.as_str(),
        result.judge_score,
    ).await {
        warn!(uid = %uid, error = %e, "failed to record tier run history");
    }

    // Record failures as feedback signals for agent learning
    if result.status == NodeStatus::Failed {
        if let Some(judge_fb) = &result.judge_feedback {
            if let Err(e) = feedback::record_judge_failure_signal(
                &db,
                &agent_slug,
                &session_id.to_string(),
                judge_fb,
                &node.task_description,
            ).await {
                warn!(uid = %uid, error = %e, "failed to record judge failure signal");
            }
        }
        let category = classify_error(&result);
        if let Some(ref cat) = category {
            if cat != "validation_error" {
                if let Err(e) = feedback::record_failure_signal(
                    &db,
                    &agent_slug,
                    &session_id.to_string(),
                    cat,
                    result.error.as_deref().unwrap_or("unknown"),
                    &node.task_description,
                ).await {
                    warn!(uid = %uid, error = %e, "failed to record failure signal");
                }
            }
        }
    }

    // Extract blockers/errors from agent output and record as feedback signals
    if let Some(ref output) = result.output {
        if let Err(e) = feedback::record_blockers_from_output(
            &db,
            &agent_slug,
            &session_id.to_string(),
            output,
        ).await {
            warn!(uid = %uid, error = %e, "failed to record blockers from output");
        }
    }

    // Auto-resolve credential issues on successful execution
    if result.status == NodeStatus::Passed {
        if let Err(e) = crate::system_description::auto_resolve_credential_issues(&db, uid).await {
            warn!(uid = %uid, error = %e, "failed to auto-resolve credential issues");
        }
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
            warn!(
                uid = %uid,
                session = %session_id,
                agent = %agent_slug,
                error = ?result.error,
                "node failed — skipping downstream"
            );
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
                SELECT en.id FROM execution_nodes en
                JOIN execution_sessions es ON es.id = en.session_id
                WHERE en.status = 'ready'
                  AND en.attempt_count < {MAX_ATTEMPTS}
                  AND (en.breakpoint IS NULL OR en.breakpoint = false)
                  AND es.status = 'executing'
                ORDER BY en.created_at
                LIMIT {limit}
                FOR UPDATE OF en SKIP LOCKED
            )
            RETURNING *
        )
        SELECT
            id, session_id, agent_slug, agent_git_sha, task_description,
            status, requires, attempt_count, parent_uid,
            input, output, judge_score, judge_feedback,
            judge_config, max_iterations, model, skip_judge,
            variant_group, variant_label, variant_selected, client_id,
            tool_id, execution_mode, integration_overrides
        FROM claimed
        "#
    );

    let rows = db.execute(&sql).await?;
    let nodes = rows.iter().filter_map(parse_node_row).collect();
    Ok(nodes)
}

fn parse_node_row(row: &Value) -> Option<ExecutionPlanNode> {
    use crate::agent_catalog::JudgeConfig;

    let uid = match row.get("id").and_then(Value::as_str).and_then(|s| s.parse::<Uuid>().ok()) {
        Some(v) => v,
        None => {
            warn!(row_id = ?row.get("id"), "parse_node_row: failed to parse id");
            return None;
        }
    };
    let session_id = match row.get("session_id").and_then(Value::as_str).and_then(|s| s.parse::<Uuid>().ok()) {
        Some(v) => v,
        None => {
            warn!(uid = %"?", "parse_node_row: failed to parse session_id");
            return None;
        }
    };
    let agent_slug = row.get("agent_slug").and_then(Value::as_str).unwrap_or_else(|| {
        warn!(%uid, "parse_node_row: missing agent_slug");
        ""
    }).to_string();
    let agent_git_sha = row.get("agent_git_sha").and_then(Value::as_str).unwrap_or("").to_string();
    let task_description = row.get("task_description").and_then(Value::as_str).unwrap_or("").to_string();
    let model = row.get("model").and_then(Value::as_str).unwrap_or_else(|| {
        warn!(%uid, "parse_node_row: missing model, defaulting to empty");
        ""
    }).to_string();
    let max_iterations = row.get("max_iterations").and_then(Value::as_u64).unwrap_or(15) as u32;
    let skip_judge = row.get("skip_judge").and_then(Value::as_bool).unwrap_or(false);
    let attempt_count = row.get("attempt_count").and_then(Value::as_u64).unwrap_or(0) as u32;

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
        tool_id: row.get("tool_id").and_then(Value::as_str).map(String::from),
        execution_mode: row.get("execution_mode").and_then(Value::as_str).unwrap_or("agent").to_string(),
        integration_overrides: row.get("integration_overrides").cloned().unwrap_or(serde_json::json!({})),
    })
}

fn classify_error(result: &AgentResult) -> Option<String> {
    if result.status != NodeStatus::Failed {
        return None;
    }
    let err = result.error.as_deref().unwrap_or("");
    let err_lower = err.to_lowercase();

    if err_lower.contains("blocked") || err_lower.contains("missing credentials")
        || err_lower.contains("credential verification failed")
    {
        return Some("preflight_error".into());
    }
    if err_lower.contains("auth_failed") || err_lower.contains("unauthorized") {
        return Some("auth_error".into());
    }
    if result.judge_feedback.is_some() && result.judge_score.is_some() {
        return Some("validation_error".into());
    }
    if err_lower.contains("max retries") || err_lower.contains("timeout") {
        return Some("timeout".into());
    }
    if err_lower.contains("api") || err_lower.contains("rate limit") {
        return Some("api_error".into());
    }
    if !err.is_empty() {
        return Some("internal_error".into());
    }
    None
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

    let error_category = classify_error(result);

    // Extract artifacts from the output for easy querying.
    // Only overwrite the column if write_output actually provided artifacts;
    // otherwise keep whatever early-detection artifacts are already stored.
    let new_artifacts: Option<serde_json::Value> = result.output.as_ref()
        .and_then(|o| o.get("artifacts").or_else(|| o.get("result").and_then(|r| r.get("artifacts"))))
        .filter(|a| a.as_array().map_or(false, |arr| !arr.is_empty()))
        .cloned();

    let completed_clause = if result.status.is_terminal() {
        "completed_at = NOW()"
    } else {
        "completed_at = completed_at" // no-op for awaiting_reply
    };

    if let Some(ref artifacts) = new_artifacts {
        let sql = format!(
            "UPDATE execution_nodes SET status = $1, output = $2, judge_score = $3, judge_feedback = $4, artifacts = $6, error_category = $7, {} WHERE id = $5",
            completed_clause
        );
        db.execute_with(
            &sql,
            pg_args!(status, result.output.clone(), result.judge_score, effective_feedback, *uid, artifacts.clone(), error_category),
        ).await?;
    } else {
        let sql = format!(
            "UPDATE execution_nodes SET status = $1, output = $2, judge_score = $3, judge_feedback = $4, error_category = $6, {} WHERE id = $5",
            completed_clause
        );
        db.execute_with(
            &sql,
            pg_args!(status, result.output.clone(), result.judge_score, effective_feedback, *uid, error_category),
        ).await?;
    }

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
    if let Err(e) = db.execute_with(
        r#"INSERT INTO execution_events (session_id, node_id, event_type, payload)
           SELECT session_id, id, 'node_completed', $1
           FROM execution_nodes WHERE id = $2"#,
        pg_args!(event_payload, *uid),
    ).await {
        warn!(uid = %uid, error = %e, "failed to persist node_completed event");
    }

    Ok(())
}

/// Eagerly unblock downstream nodes when a node passes.
/// A node becomes ready when ALL its required nodes have passed.
/// Uses a single CTE to find and update all eligible nodes atomically.
pub async fn unblock_downstream(
    db: &PgClient,
    completed_uid: &Uuid,
    session_id: &Uuid,
) -> anyhow::Result<()> {
    let sql = r#"
        WITH dependents AS (
            SELECT en.id, en.requires
            FROM execution_nodes en
            WHERE en.session_id = $1
              AND en.status IN ('pending', 'waiting')
              AND en.requires @> ARRAY[$2::uuid]
        ),
        ready AS (
            SELECT d.id
            FROM dependents d
            WHERE NOT EXISTS (
                SELECT 1
                FROM unnest(d.requires) AS req_id
                JOIN execution_nodes rn ON rn.id = req_id AND rn.session_id = $1
                WHERE rn.status != 'passed'
            )
        )
        UPDATE execution_nodes
        SET status = 'ready'
        WHERE id IN (SELECT id FROM ready)
        RETURNING id
    "#;

    let updated = db.execute_with(sql, pg_args!(*session_id, *completed_uid)).await?;
    for row in &updated {
        if let Some(uid) = row.get("id").and_then(Value::as_str) {
            info!(uid = %uid, "unblocked downstream node");
        }
    }

    Ok(())
}

/// Skip all downstream nodes (transitively) when a node fails.
/// Uses a recursive CTE to find the entire downstream subgraph in one query.
pub async fn skip_downstream(
    db: &PgClient,
    failed_uid: &Uuid,
    session_id: &Uuid,
) -> anyhow::Result<()> {
    let sql = r#"
        WITH RECURSIVE downstream AS (
            -- Base: direct dependents of the failed node
            SELECT id
            FROM execution_nodes
            WHERE session_id = $1
              AND status IN ('pending', 'waiting')
              AND requires @> ARRAY[$2::uuid]
            UNION
            -- Recursive: dependents of already-identified nodes
            SELECT en.id
            FROM execution_nodes en
            JOIN downstream d ON en.requires @> ARRAY[d.id]
            WHERE en.session_id = $1
              AND en.status IN ('pending', 'waiting')
        )
        UPDATE execution_nodes
        SET status = 'skipped', completed_at = NOW()
        WHERE id IN (SELECT id FROM downstream)
        RETURNING id
    "#;

    let skipped = db.execute_with(sql, pg_args!(*session_id, *failed_uid)).await?;
    if !skipped.is_empty() {
        info!(count = skipped.len(), failed_uid = %failed_uid, "skipped downstream nodes");
    }

    Ok(())
}

/// Mark session as completed if all nodes are in a terminal state.
/// Preview nodes (spawned but never started) and awaiting_reply nodes
/// (waiting for user input) are treated as terminal.
pub async fn check_session_completion(db: &PgClient, session_id: &Uuid, event_bus: &EventBus) {
    let sql = r#"
        SELECT
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE status IN ('passed', 'failed', 'skipped', 'preview', 'cancelled', 'awaiting_reply')) as terminal
        FROM execution_nodes
        WHERE session_id = $1
    "#;

    if let Ok(rows) = db.execute_with(sql, pg_args!(*session_id)).await {
        if let Some(row) = rows.first() {
            let total = row.get("total").and_then(Value::as_i64).unwrap_or(0);
            let terminal = row.get("terminal").and_then(Value::as_i64).unwrap_or(0);

            if total > 0 && total == terminal {
                // Use WHERE status != 'completed' to prevent duplicate completion
                // when multiple nodes finish concurrently.
                let updated = db.execute_with(
                    "UPDATE execution_sessions SET status = 'completed', completed_at = NOW() WHERE id = $1 AND status != 'completed' RETURNING id",
                    pg_args!(*session_id),
                ).await.unwrap_or_default();
                if updated.is_empty() {
                    return;
                }

                event_bus.send(
                    &session_id.to_string(),
                    serde_json::json!({"type": "session_completed"}),
                ).await;

                // Clean up the EventBus channel now that the session is done
                event_bus.cleanup(&session_id.to_string()).await;

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
        error_category = CASE
            WHEN attempt_count >= {MAX_ATTEMPTS} THEN 'timeout'
            ELSE error_category
        END,
        started_at = NULL
        WHERE status = 'running'
          AND (started_at IS NULL OR started_at < NOW() - INTERVAL '{timeout_secs} seconds')
        RETURNING id, attempt_count, session_id, agent_slug, task_description
        "#
    );

    let recovered = db.execute(&sql).await?;
    if !recovered.is_empty() {
        warn!(count = recovered.len(), "recovered stale running nodes");
    }

    for row in &recovered {
        let attempt = row.get("attempt_count").and_then(Value::as_u64).unwrap_or(0) as u32;
        if attempt >= MAX_ATTEMPTS {
            let agent_slug = row.get("agent_slug").and_then(Value::as_str).unwrap_or("unknown");
            let session_id = row.get("session_id").and_then(Value::as_str).unwrap_or("");
            let task_desc = row.get("task_description").and_then(Value::as_str).unwrap_or("");
            if let Err(e) = feedback::record_failure_signal(
                db,
                agent_slug,
                session_id,
                "timeout",
                "Node timed out after exceeding stale threshold",
                task_desc,
            ).await {
                warn!(agent = agent_slug, error = %e, "failed to record timeout failure signal");
            }
        }
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

    let rows = db.execute_with(
        "SELECT agent_slug, output \
         FROM execution_nodes \
         WHERE id = ANY($1) \
           AND status = 'passed' \
           AND output IS NOT NULL",
        pg_args!(node.requires.clone()),
    ).await?;
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
