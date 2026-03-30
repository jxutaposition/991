/// Block Kit message builders for Slack integration.
///
/// Pure functions: domain data in, serde_json::Value Block Kit blocks out.
/// Follows Slack's Block Kit specification for rich, interactive messages.
use serde_json::{json, Value};

/// Build blocks for a plan-ready approval message.
pub fn plan_ready_blocks(request_text: &str, nodes: &[Value]) -> Vec<Value> {
    let mut blocks = vec![
        json!({
            "type": "header",
            "text": {"type": "plain_text", "text": "New Execution Plan Ready", "emoji": true}
        }),
        json!({
            "type": "section",
            "text": {"type": "mrkdwn", "text": format!("*Request:* {request_text}")}
        }),
        json!({"type": "divider"}),
    ];

    // List agents in the plan
    let mut node_list = String::new();
    for (i, node) in nodes.iter().enumerate() {
        let slug = node.get("agent_slug").and_then(Value::as_str).unwrap_or("unknown");
        let task = node.get("task_description").and_then(Value::as_str).unwrap_or("");
        let task_preview: String = task.chars().take(80).collect();
        node_list.push_str(&format!("{}. `{}` — {}\n", i + 1, slug, task_preview));
    }

    blocks.push(json!({
        "type": "section",
        "text": {"type": "mrkdwn", "text": format!("*Plan ({} agents):*\n{}", nodes.len(), node_list)}
    }));

    // Approve / Reject buttons
    blocks.push(json!({
        "type": "actions",
        "elements": [
            {
                "type": "button",
                "text": {"type": "plain_text", "text": "Approve & Execute", "emoji": true},
                "style": "primary",
                "action_id": "approve_plan",
            },
            {
                "type": "button",
                "text": {"type": "plain_text", "text": "Reject", "emoji": true},
                "style": "danger",
                "action_id": "reject_plan",
            }
        ]
    }));

    blocks
}

/// Build blocks to replace the plan message after approval.
pub fn plan_approved_blocks(request_text: &str, user_id: &str) -> Vec<Value> {
    vec![
        json!({
            "type": "section",
            "text": {"type": "mrkdwn", "text": format!(
                "*Request:* {request_text}\n\n:white_check_mark: *Approved by <@{user_id}>* — executing..."
            )}
        }),
    ]
}

/// Build blocks to replace the plan message after rejection.
pub fn plan_rejected_blocks(request_text: &str, user_id: &str) -> Vec<Value> {
    vec![
        json!({
            "type": "section",
            "text": {"type": "mrkdwn", "text": format!(
                "*Request:* {request_text}\n\n:x: *Rejected by <@{user_id}>*"
            )}
        }),
    ]
}

/// Build a threaded update for node started.
pub fn node_started_text(agent_slug: &str) -> String {
    format!(":arrow_forward: Running: `{agent_slug}`")
}

/// Build a threaded update for node completed.
pub fn node_completed_text(agent_slug: &str, status: &str, score: Option<f64>) -> String {
    let icon = match status {
        "passed" => ":white_check_mark:",
        "failed" => ":x:",
        "skipped" => ":fast_forward:",
        _ => ":grey_question:",
    };

    let score_str = score
        .map(|s| format!(" ({:.1}/10)", s))
        .unwrap_or_default();

    format!("{icon} {status}: `{agent_slug}`{score_str}")
}

/// Build blocks for session completion summary.
pub fn session_completed_blocks(
    request_text: &str,
    nodes: &[Value],
    frontend_url: &str,
    session_id: &str,
) -> Vec<Value> {
    let total = nodes.len();
    let passed = nodes.iter().filter(|n| n.get("status").and_then(Value::as_str) == Some("passed")).count();
    let failed = nodes.iter().filter(|n| n.get("status").and_then(Value::as_str) == Some("failed")).count();
    let skipped = nodes.iter().filter(|n| n.get("status").and_then(Value::as_str) == Some("skipped")).count();

    let mut summary = format!(":tada: *Execution Complete*\n\n*Request:* {request_text}\n");
    summary.push_str(&format!(
        "*Results:* {passed}/{total} passed",
    ));
    if failed > 0 {
        summary.push_str(&format!(", {failed} failed"));
    }
    if skipped > 0 {
        summary.push_str(&format!(", {skipped} skipped"));
    }

    let mut blocks = vec![
        json!({
            "type": "section",
            "text": {"type": "mrkdwn", "text": summary}
        }),
    ];

    // Node-by-node results
    let mut detail = String::new();
    for node in nodes {
        let slug = node.get("agent_slug").and_then(Value::as_str).unwrap_or("?");
        let status = node.get("status").and_then(Value::as_str).unwrap_or("?");
        let score = node.get("judge_score").and_then(Value::as_f64);
        let icon = match status {
            "passed" => ":white_check_mark:",
            "failed" => ":x:",
            "skipped" => ":fast_forward:",
            _ => ":grey_question:",
        };
        let score_str = score.map(|s| format!(" ({:.1})", s)).unwrap_or_default();
        detail.push_str(&format!("{icon} `{slug}` {status}{score_str}\n"));
    }

    blocks.push(json!({
        "type": "section",
        "text": {"type": "mrkdwn", "text": detail}
    }));

    // View Results button
    blocks.push(json!({
        "type": "actions",
        "elements": [{
            "type": "button",
            "text": {"type": "plain_text", "text": "View Results", "emoji": true},
            "url": format!("{frontend_url}/execute/{session_id}"),
            "action_id": "view_results",
        }]
    }));

    blocks
}

/// Build blocks for a clarification request.
pub fn clarification_blocks(agent_slug: &str, question: &str) -> Vec<Value> {
    vec![
        json!({
            "type": "section",
            "text": {"type": "mrkdwn", "text": format!(
                ":question: *Agent needs your input*\n\n*Agent:* `{agent_slug}`\n*Question:* {question}\n\n_Reply in this thread to answer._"
            )}
        }),
    ]
}

/// Build blocks for status summary.
pub fn status_blocks(session_id: &str, status: &str, nodes: &[Value]) -> Vec<Value> {
    let mut text = format!("*Session:* `{}`\n*Status:* {}\n\n", &session_id[..8], status);

    for node in nodes {
        let slug = node.get("agent_slug").and_then(Value::as_str).unwrap_or("?");
        let node_status = node.get("status").and_then(Value::as_str).unwrap_or("?");
        let icon = match node_status {
            "passed" => ":white_check_mark:",
            "failed" => ":x:",
            "running" => ":hourglass_flowing_sand:",
            "ready" => ":soon:",
            "waiting" | "pending" => ":white_circle:",
            "skipped" => ":fast_forward:",
            _ => ":grey_question:",
        };
        text.push_str(&format!("{icon} `{slug}` — {node_status}\n"));
    }

    vec![json!({
        "type": "section",
        "text": {"type": "mrkdwn", "text": text}
    })]
}

/// Build suggested prompts for new assistant threads.
pub fn suggested_prompts() -> Vec<(&'static str, &'static str)> {
    vec![
        ("Cold outbound", "Run cold outbound to fintech companies 50-500 employees in NYC"),
        ("Launch campaign", "Launch a lead gen campaign on Meta and Google, $5k budget"),
        ("Qualify leads", "We got 200 leads from SaaStr, qualify and reach out within 48 hours"),
        ("Q1 analysis", "Analyze our Q1 outbound performance and build a Q2 plan"),
    ]
}

/// Build an error message block.
pub fn error_blocks(message: &str) -> Vec<Value> {
    vec![json!({
        "type": "section",
        "text": {"type": "mrkdwn", "text": format!(":warning: *Error:* {message}")}
    })]
}
