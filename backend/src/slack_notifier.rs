/// Outbound Slack notifier — subscribes to EventBus and posts updates to Slack.
///
/// When an execution session is associated with a Slack channel (via slash command
/// or thread), a notifier task is spawned that listens for events and translates
/// them to Slack messages. Node-started events within 2 seconds are batched.
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tracing::{info, warn};

use crate::pg::PgClient;
use crate::session::EventBus;
use crate::slack::SlackClient;
use crate::slack_messages;

const BATCH_WINDOW: Duration = Duration::from_secs(2);

/// Start a notifier task for a session. Returns the JoinHandle.
pub fn subscribe_to_session(
    session_id: String,
    event_bus: EventBus,
    slack: Arc<SlackClient>,
    db: PgClient,
    channel_id: String,
    thread_ts: String,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let rx = event_bus.subscribe(&session_id).await;
        let mut receiver = match rx {
            Some(r) => r,
            None => {
                warn!(session = %session_id, "no EventBus channel — notifier exiting");
                return;
            }
        };

        info!(session = %session_id, channel = %channel_id, "Slack notifier started");

        let mut pending_starts: Vec<String> = Vec::new();
        let mut batch_deadline: Option<tokio::time::Instant> = None;

        loop {
            let event = if let Some(deadline) = batch_deadline {
                // Wait for either a new event or the batch window to expire
                tokio::select! {
                    result = receiver.recv() => {
                        match result {
                            Ok(e) => Some(e),
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                                warn!(lagged = n, "Slack notifier lagged");
                                continue;
                            }
                        }
                    }
                    _ = tokio::time::sleep_until(deadline) => {
                        // Flush batched node_started events
                        if !pending_starts.is_empty() {
                            flush_node_starts(&slack, &channel_id, &thread_ts, &pending_starts).await;
                            pending_starts.clear();
                        }
                        batch_deadline = None;
                        continue;
                    }
                }
            } else {
                match receiver.recv().await {
                    Ok(e) => Some(e),
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        warn!(lagged = n, "Slack notifier lagged");
                        continue;
                    }
                }
            };

            let event = match event {
                Some(e) => e,
                None => continue,
            };

            let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");

            match event_type {
                "node_started" => {
                    let slug = event
                        .get("agent_slug")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string();
                    pending_starts.push(slug);
                    batch_deadline = Some(tokio::time::Instant::now() + BATCH_WINDOW);
                }

                "node_completed" => {
                    // Flush any pending starts first
                    if !pending_starts.is_empty() {
                        flush_node_starts(&slack, &channel_id, &thread_ts, &pending_starts).await;
                        pending_starts.clear();
                        batch_deadline = None;
                    }

                    let slug = event.get("agent_slug").and_then(Value::as_str).unwrap_or("unknown");
                    let status = event.get("status").and_then(Value::as_str).unwrap_or("unknown");
                    let score = event.get("judge_score").and_then(Value::as_f64);

                    let text = slack_messages::node_completed_text(slug, status, score);
                    let _ = slack
                        .post_message(&channel_id, &[], &text, Some(&thread_ts))
                        .await;
                }

                "session_completed" => {
                    // Fetch full session data for the summary
                    let summary = load_session_summary(&db, &session_id).await;
                    if let Some((request_text, nodes)) = summary {
                        let orchestrator_output = load_orchestrator_output(&db, &session_id).await;
                        let blocks = slack_messages::session_completed_blocks(
                            &request_text,
                            &nodes,
                            &std::env::var("FRONTEND_URL").unwrap_or_else(|_| "http://localhost:3000".to_string()),
                            &session_id,
                            orchestrator_output.as_deref(),
                        );
                        let _ = slack
                            .post_message(&channel_id, &blocks, "Execution complete", Some(&thread_ts))
                            .await;
                    }
                    break; // Session done, exit notifier
                }

                "clarification_needed" => {
                    let slug = event.get("agent_slug").and_then(Value::as_str).unwrap_or("unknown");
                    let question = event.get("question").and_then(Value::as_str).unwrap_or("");
                    let blocks = slack_messages::clarification_blocks(slug, question);
                    let _ = slack
                        .post_message(&channel_id, &blocks, "Agent needs your input", Some(&thread_ts))
                        .await;
                }

                _ => {} // Ignore unknown event types
            }
        }

        info!(session = %session_id, "Slack notifier finished");
    })
}

/// Flush batched node_started events as a single message.
async fn flush_node_starts(
    slack: &SlackClient,
    channel: &str,
    thread_ts: &str,
    slugs: &[String],
) {
    let text = if slugs.len() == 1 {
        slack_messages::node_started_text(&slugs[0])
    } else {
        let list: Vec<String> = slugs.iter().map(|s| format!("`{s}`")).collect();
        format!(":arrow_forward: Running: {}", list.join(", "))
    };

    let _ = slack.post_message(channel, &[], &text, Some(thread_ts)).await;
}

/// Load session summary from DB for the completion message.
async fn load_session_summary(
    db: &PgClient,
    session_id: &str,
) -> Option<(String, Vec<Value>)> {
    let session_uuid = session_id.parse::<uuid::Uuid>().ok()?;
    let sessions = db.execute_with(
        "SELECT request_text FROM execution_sessions WHERE id = $1",
        crate::pg_args!(session_uuid),
    ).await.ok()?;
    let request_text = sessions
        .first()?
        .get("request_text")?
        .as_str()?
        .to_string();

    let nodes = db.execute_with(
        "SELECT agent_slug, status, judge_score FROM execution_nodes \
         WHERE session_id = $1 ORDER BY created_at",
        crate::pg_args!(session_uuid),
    ).await.ok()?;

    Some((request_text, nodes))
}

/// Load the master orchestrator's final output/summary for the completion message.
async fn load_orchestrator_output(
    db: &PgClient,
    session_id: &str,
) -> Option<String> {
    let session_uuid = session_id.parse::<uuid::Uuid>().ok()?;
    let rows = db.execute_with(
        "SELECT output FROM execution_nodes \
         WHERE session_id = $1 AND agent_slug = 'master_orchestrator' AND depth = 0 \
         LIMIT 1",
        crate::pg_args!(session_uuid),
    ).await.ok()?;
    let output = rows.first()?.get("output")?;

    // Try extracting a summary string, fall back to the full output text
    if let Some(summary) = output.get("summary").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        return Some(summary.to_string());
    }
    if let Some(text) = output.as_str() {
        return Some(text.to_string());
    }
    // For JSON output, pretty-print a truncated version
    let rendered = output.to_string();
    if rendered.len() > 2 && rendered != "null" {
        return Some(rendered);
    }
    None
}
