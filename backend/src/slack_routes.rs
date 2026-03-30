/// Inbound Slack HTTP handlers for slash commands, interactions, and events.
///
/// Three endpoints:
///   POST /api/slack/commands     — slash command handler (/lele run, status, etc.)
///   POST /api/slack/interactions — button click handler (approve/reject)
///   POST /api/slack/events       — Events API (thread replies, url_verification)
use std::sync::Arc;
use url::form_urlencoded;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use serde_json::{json, Value};
use tracing::{error, info, warn};

use crate::slack_messages;
use crate::slack_notifier;
use crate::state::AppState;

// ── Slash Commands (/lele) ───────────────────────────────────────────────────

/// POST /api/slack/commands
///
/// Slack sends form-encoded data. We parse the `text` field for subcommands.
/// Must respond within 3 seconds — long operations are done async.
pub async fn commands_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: String,
) -> impl IntoResponse {
    // Verify signature
    if !verify_request(&state, &headers, body.as_bytes()) {
        return (StatusCode::UNAUTHORIZED, "Invalid signature").into_response();
    }

    // Parse form-encoded body
    let params: Vec<(String, String)> = form_urlencoded::parse(body.as_bytes())
        .into_owned()
        .collect();

    let text = get_param(&params, "text");
    let channel_id = get_param(&params, "channel_id");
    let user_id = get_param(&params, "user_id");
    let team_id = get_param(&params, "team_id");

    // Log inbound command
    log_slack_event(&state.db, "inbound", "command", Some(&channel_id), Some(&user_id), None, &json!({"text": &text})).await;

    // Parse subcommand
    let parts: Vec<&str> = text.splitn(2, ' ').collect();
    let subcommand = parts.first().map(|s| s.to_lowercase()).unwrap_or_default();
    let arg = parts.get(1).unwrap_or(&"").to_string();

    match subcommand.as_str() {
        "run" => {
            if arg.is_empty() {
                return Json(json!({
                    "response_type": "ephemeral",
                    "text": "Usage: `/lele run <describe your GTM goal>`"
                }))
                .into_response();
            }

            // Ack immediately, plan async
            let state = state.clone();
            let channel = channel_id.clone();
            let user = user_id.clone();
            let team = team_id.clone();
            let request = arg.clone();

            tokio::spawn(async move {
                handle_run_command(state, &channel, &user, &team, &request).await;
            });

            Json(json!({
                "response_type": "ephemeral",
                "text": ":hourglass_flowing_sand: Planning your workflow..."
            }))
            .into_response()
        }

        "status" => {
            let result = handle_status_command(&state, &arg).await;
            Json(json!({
                "response_type": "ephemeral",
                "blocks": result,
            }))
            .into_response()
        }

        _ => {
            Json(json!({
                "response_type": "ephemeral",
                "text": "Available commands:\n`/lele run <goal>` — Start a new GTM workflow\n`/lele status [session_id]` — Check execution status"
            }))
            .into_response()
        }
    }
}

async fn handle_run_command(
    state: Arc<AppState>,
    channel_id: &str,
    user_id: &str,
    team_id: &str,
    request_text: &str,
) {
    let slack = match &state.slack {
        Some(s) => s.clone(),
        None => return,
    };

    // Call the planner
    let catalog_summary = state.catalog.catalog_summary();
    let plan = match crate::planner::plan_execution(
        request_text,
        &catalog_summary,
        &state.settings.anthropic_api_key,
        &state.settings.anthropic_model,
    )
    .await
    {
        Ok(p) => p,
        Err(e) => {
            error!(error = %e, "Slack /lele run: planner failed");
            let blocks = slack_messages::error_blocks(&format!("Planning failed: {e}"));
            let _ = slack.post_message(channel_id, &blocks, "Planning failed", None).await;
            return;
        }
    };

    let session_id = uuid::Uuid::new_v4();
    let exec_nodes = match crate::planner::plan_to_execution_nodes(
        &plan,
        session_id,
        state.catalog.git_sha(),
        &state.catalog,
    ) {
        Ok(n) => n,
        Err(e) => {
            let blocks = slack_messages::error_blocks(&format!("Plan validation failed: {e}"));
            let _ = slack.post_message(channel_id, &blocks, "Plan validation failed", None).await;
            return;
        }
    };

    let node_count = exec_nodes.len();
    let plan_json = crate::planner::plan_to_json(&exec_nodes);

    // Persist to DB
    if let Err(e) = persist_session_from_slack(
        &state.db,
        session_id,
        request_text,
        &plan_json,
        &exec_nodes,
    )
    .await
    {
        error!(error = %e, "failed to persist Slack-initiated session");
        return;
    }

    // Post plan-ready message with approve/reject buttons
    let plan_nodes: Vec<Value> = exec_nodes
        .iter()
        .map(|n| {
            json!({
                "agent_slug": n.agent_slug,
                "task_description": n.task_description,
            })
        })
        .collect();

    let blocks = slack_messages::plan_ready_blocks(request_text, &plan_nodes);

    match slack
        .post_message(channel_id, &blocks, &format!("New plan: {request_text}"), None)
        .await
    {
        Ok(resp) => {
            // Store the channel mapping so we can route interactions back
            let mapping_sql = format!(
                r#"
                INSERT INTO slack_channel_mappings (slack_team_id, slack_channel_id, slack_user_id, session_id, thread_ts)
                VALUES ('{team_id}', '{channel_id}', '{user_id}', '{session_id}', '{ts}')
                "#,
                ts = resp.ts,
            );
            let _ = state.db.execute(&mapping_sql).await;

            info!(
                session = %session_id,
                channel = channel_id,
                nodes = node_count,
                "Slack session created with plan"
            );
        }
        Err(e) => {
            error!(error = %e, "failed to post plan to Slack");
        }
    }
}

async fn handle_status_command(state: &AppState, session_id_prefix: &str) -> Vec<Value> {
    if session_id_prefix.is_empty() {
        // List recent sessions
        let sql = "SELECT id, request_text, status FROM execution_sessions ORDER BY created_at DESC LIMIT 5";
        let rows = state.db.execute(sql).await.unwrap_or_default();

        if rows.is_empty() {
            return slack_messages::error_blocks("No recent sessions found.");
        }

        let mut text = "*Recent Sessions:*\n".to_string();
        for row in &rows {
            let id = row.get("id").and_then(Value::as_str).unwrap_or("?");
            let req = row.get("request_text").and_then(Value::as_str).unwrap_or("?");
            let status = row.get("status").and_then(Value::as_str).unwrap_or("?");
            let preview: String = req.chars().take(60).collect();
            text.push_str(&format!("`{}` — {} — {}\n", &id[..8], status, preview));
        }

        return vec![json!({"type": "section", "text": {"type": "mrkdwn", "text": text}})];
    }

    // Look up specific session
    let sql = format!(
        "SELECT id, status FROM execution_sessions WHERE id::text LIKE '{}%' LIMIT 1",
        session_id_prefix.replace('\'', "")
    );
    let sessions = state.db.execute(&sql).await.unwrap_or_default();

    let session = match sessions.first() {
        Some(s) => s,
        None => return slack_messages::error_blocks("Session not found."),
    };

    let full_id = session.get("id").and_then(Value::as_str).unwrap_or("");
    let status = session.get("status").and_then(Value::as_str).unwrap_or("");

    let nodes_sql = format!(
        "SELECT agent_slug, status, judge_score FROM execution_nodes WHERE session_id = '{}' ORDER BY created_at",
        full_id
    );
    let nodes = state.db.execute(&nodes_sql).await.unwrap_or_default();

    slack_messages::status_blocks(full_id, status, &nodes)
}

// ── Interactions (button clicks) ─────────────────────────────────────────────

/// POST /api/slack/interactions
pub async fn interactions_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: String,
) -> impl IntoResponse {
    if !verify_request(&state, &headers, body.as_bytes()) {
        return (StatusCode::UNAUTHORIZED, "Invalid signature").into_response();
    }

    // Slack sends interactions as form-encoded with a "payload" JSON field
    let params: Vec<(String, String)> = form_urlencoded::parse(body.as_bytes())
        .into_owned()
        .collect();
    let payload_str = get_param(&params, "payload");

    let payload: Value = match serde_json::from_str(&payload_str) {
        Ok(p) => p,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid payload").into_response(),
    };

    let actions = payload
        .get("actions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let user_id = payload
        .pointer("/user/id")
        .and_then(Value::as_str)
        .unwrap_or("unknown");

    let channel_id = payload
        .pointer("/channel/id")
        .and_then(Value::as_str)
        .unwrap_or("");

    let message_ts = payload
        .pointer("/message/ts")
        .and_then(Value::as_str)
        .unwrap_or("");

    for action in &actions {
        let action_id = action.get("action_id").and_then(Value::as_str).unwrap_or("");

        match action_id {
            "approve_plan" | "reject_plan" => {
                let is_approve = action_id == "approve_plan";
                log_slack_event(&state.db, "inbound", "button_click", Some(channel_id), Some(user_id), None, &json!({"action": action_id})).await;

                // Look up the session for this channel + message
                let mapping_sql = format!(
                    "SELECT session_id FROM slack_channel_mappings WHERE slack_channel_id = '{}' AND thread_ts = '{}' AND is_active = true LIMIT 1",
                    channel_id.replace('\'', ""),
                    message_ts.replace('\'', ""),
                );

                let mappings = state.db.execute(&mapping_sql).await.unwrap_or_default();
                let session_id = match mappings.first().and_then(|m| m.get("session_id")).and_then(Value::as_str) {
                    Some(id) => id.to_string(),
                    None => {
                        warn!("No session mapping found for interaction");
                        continue;
                    }
                };

                // Get request_text for the updated message
                let session_sql = format!(
                    "SELECT request_text FROM execution_sessions WHERE id = '{session_id}'"
                );
                let sessions = state.db.execute(&session_sql).await.unwrap_or_default();
                let request_text = sessions
                    .first()
                    .and_then(|s| s.get("request_text"))
                    .and_then(Value::as_str)
                    .unwrap_or("unknown request");

                if let Some(slack) = &state.slack {
                    if is_approve {
                        // Approve the session
                        let approve_sql = format!(
                            "UPDATE execution_sessions SET status = 'executing', plan_approved_at = NOW() WHERE id = '{session_id}' AND status = 'awaiting_approval'"
                        );
                        let _ = state.db.execute(&approve_sql).await;

                        let unblock_sql = format!(
                            "UPDATE execution_nodes SET status = 'ready' WHERE session_id = '{session_id}' AND status = 'pending' AND requires = '{{}}'"
                        );
                        let _ = state.db.execute(&unblock_sql).await;

                        // Create EventBus channel
                        state.event_bus.create_channel(&session_id).await;

                        // Start Slack notifier
                        slack_notifier::subscribe_to_session(
                            session_id.clone(),
                            state.event_bus.clone(),
                            slack.clone(),
                            state.db.clone(),
                            channel_id.to_string(),
                            message_ts.to_string(),
                        );

                        // Update the message to show approval
                        let blocks = slack_messages::plan_approved_blocks(request_text, user_id);
                        let _ = slack
                            .update_message(channel_id, message_ts, &blocks, "Plan approved")
                            .await;

                        info!(session = %session_id, user = user_id, "plan approved via Slack");
                    } else {
                        // Reject
                        let reject_sql = format!(
                            "UPDATE execution_sessions SET status = 'failed', completed_at = NOW() WHERE id = '{session_id}'"
                        );
                        let _ = state.db.execute(&reject_sql).await;

                        let blocks = slack_messages::plan_rejected_blocks(request_text, user_id);
                        let _ = slack
                            .update_message(channel_id, message_ts, &blocks, "Plan rejected")
                            .await;

                        info!(session = %session_id, user = user_id, "plan rejected via Slack");
                    }
                }
            }
            _ => {}
        }
    }

    // Slack expects 200 OK for interactions
    (StatusCode::OK, "").into_response()
}

// ── Events API ───────────────────────────────────────────────────────────────

/// POST /api/slack/events
///
/// Handles Events API including url_verification challenge and message events
/// for thread replies (clarification flow).
pub async fn events_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: String,
) -> impl IntoResponse {
    // URL verification challenge (no signature check needed per Slack docs)
    if let Ok(payload) = serde_json::from_str::<Value>(&body) {
        if payload.get("type").and_then(Value::as_str) == Some("url_verification") {
            let challenge = payload.get("challenge").and_then(Value::as_str).unwrap_or("");
            return Json(json!({"challenge": challenge})).into_response();
        }
    }

    // Verify signature for all other events
    if !verify_request(&state, &headers, body.as_bytes()) {
        return (StatusCode::UNAUTHORIZED, "Invalid signature").into_response();
    }

    let payload: Value = match serde_json::from_str(&body) {
        Ok(p) => p,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid JSON").into_response(),
    };

    // Handle message events (thread replies for clarification)
    if let Some(event) = payload.get("event") {
        let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");

        if event_type == "message" {
            // Only handle thread replies (has thread_ts and is not from a bot)
            let thread_ts = event.get("thread_ts").and_then(Value::as_str);
            let bot_id = event.get("bot_id");
            let text = event.get("text").and_then(Value::as_str).unwrap_or("");
            let channel = event.get("channel").and_then(Value::as_str).unwrap_or("");

            if let (Some(thread_ts), None) = (thread_ts, bot_id) {
                log_slack_event(&state.db, "inbound", "thread_reply", Some(channel), None, None, &json!({"text": text, "thread_ts": thread_ts})).await;
                handle_thread_reply(&state, channel, thread_ts, text).await;
            }
        }
    }

    (StatusCode::OK, "").into_response()
}

async fn handle_thread_reply(state: &AppState, channel: &str, thread_ts: &str, text: &str) {
    // Look up the session for this thread
    let mapping_sql = format!(
        "SELECT session_id FROM slack_channel_mappings WHERE slack_channel_id = '{}' AND thread_ts = '{}' AND is_active = true LIMIT 1",
        channel.replace('\'', ""),
        thread_ts.replace('\'', ""),
    );

    let mappings = state.db.execute(&mapping_sql).await.unwrap_or_default();
    let session_id = match mappings.first().and_then(|m| m.get("session_id")).and_then(Value::as_str) {
        Some(id) => id.to_string(),
        None => return, // Not a tracked thread
    };

    // Find a node with a pending clarification request
    let node_sql = format!(
        "SELECT id FROM execution_nodes WHERE session_id = '{}' AND clarification_request IS NOT NULL AND clarification_response IS NULL AND status = 'waiting' LIMIT 1",
        session_id
    );

    let nodes = state.db.execute(&node_sql).await.unwrap_or_default();
    if let Some(node) = nodes.first() {
        if let Some(node_id) = node.get("id").and_then(Value::as_str) {
            let text_escaped = text.replace('\'', "''");
            let update_sql = format!(
                "UPDATE execution_nodes SET clarification_response = '{text_escaped}', status = 'ready' WHERE id = '{node_id}'"
            );
            let _ = state.db.execute(&update_sql).await;
            info!(session = %session_id, node = node_id, "clarification response received via Slack");
        }
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn verify_request(state: &AppState, headers: &HeaderMap, body: &[u8]) -> bool {
    let slack = match &state.slack {
        Some(s) => s,
        None => return false,
    };

    let timestamp = headers
        .get("x-slack-request-timestamp")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let signature = headers
        .get("x-slack-signature")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    slack.verify_signature(timestamp, body, signature)
}

/// Log a Slack event to the slack_events table for the data viewer.
async fn log_slack_event(
    db: &crate::pg::PgClient,
    direction: &str,
    event_type: &str,
    channel_id: Option<&str>,
    user_id: Option<&str>,
    session_id: Option<&str>,
    payload: &Value,
) {
    let channel_val = channel_id.map(|s| format!("'{}'", s.replace('\'', "''"))).unwrap_or_else(|| "NULL".to_string());
    let user_val = user_id.map(|s| format!("'{}'", s.replace('\'', "''"))).unwrap_or_else(|| "NULL".to_string());
    let session_val = session_id.map(|s| format!("'{}'", s.replace('\'', "''"))).unwrap_or_else(|| "NULL".to_string());
    let payload_escaped = payload.to_string().replace('\'', "''");

    let sql = format!(
        r#"INSERT INTO slack_events (direction, event_type, slack_channel_id, slack_user_id, session_id, payload)
           VALUES ('{direction}', '{event_type}', {channel_val}, {user_val}, {session_val}, '{payload_escaped}'::jsonb)"#
    );
    let _ = db.execute(&sql).await;
}

fn get_param(params: &[(String, String)], key: &str) -> String {
    params
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.clone())
        .unwrap_or_default()
}

/// Helper to persist a session created from Slack (mirrors routes::persist_session).
async fn persist_session_from_slack(
    db: &crate::pg::PgClient,
    session_id: uuid::Uuid,
    request_text: &str,
    plan_json: &Value,
    nodes: &[crate::agent_catalog::ExecutionPlanNode],
) -> anyhow::Result<()> {
    let request_escaped = request_text.replace('\'', "''");
    let plan_escaped = plan_json.to_string().replace('\'', "''");

    let session_sql = format!(
        r#"
        INSERT INTO execution_sessions (id, request_text, plan, status)
        VALUES ('{session_id}', '{request_escaped}', '{plan_escaped}'::jsonb, 'awaiting_approval')
        "#
    );
    db.execute(&session_sql).await?;

    for node in nodes {
        let requires_arr = if node.requires.is_empty() {
            "ARRAY[]::uuid[]".to_string()
        } else {
            let items: Vec<String> = node.requires.iter().map(|u| format!("'{u}'::uuid")).collect();
            format!("ARRAY[{}]", items.join(","))
        };

        let judge_config_json = serde_json::to_string(&node.judge_config)
            .unwrap_or_else(|_| "{}".to_string())
            .replace('\'', "''");
        let task_escaped = node.task_description.replace('\'', "''");

        let node_sql = format!(
            r#"
            INSERT INTO execution_nodes
              (id, session_id, agent_slug, agent_git_sha, task_description, status,
               requires, attempt_count, judge_config, max_iterations, model, skip_judge)
            VALUES
              ('{uid}', '{session_id}', '{slug}', '{sha}', '{task}', 'pending',
               {requires}, 0, '{judge}'::jsonb, {max_iter}, '{model}', {skip_judge})
            "#,
            uid = node.uid,
            slug = node.agent_slug,
            sha = node.agent_git_sha,
            task = task_escaped,
            requires = requires_arr,
            judge = judge_config_json,
            max_iter = node.max_iterations,
            model = node.model,
            skip_judge = node.skip_judge,
        );
        db.execute(&node_sql).await?;
    }

    Ok(())
}
