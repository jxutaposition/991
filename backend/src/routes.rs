/// HTTP route handlers.
use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{
        sse::{Event, Sse},
        IntoResponse,
    },
    Json,
};
use futures_util::stream;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tracing::{error, info};
use uuid::Uuid;

use crate::client as client_mod;
use crate::feedback;
use crate::narrator::{self, CapturedEvent};
use crate::pr_engine;
use crate::workflow as workflow_mod;
use url::Url;
use crate::planner;
use crate::state::AppState;

// ── Health ────────────────────────────────────────────────────────────────────

pub async fn health(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({
        "status": "ok",
        "agents_loaded": state.catalog.len(),
        "catalog_git_sha": state.catalog.git_sha(),
    }))
}

/// GET /api/models — list available models and the current default.
pub async fn models_list(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({
        "default": state.settings.anthropic_model,
        "models": [
            {"id": "claude-haiku-4-5-20251001", "name": "Claude Haiku 4.5", "description": "Fastest, lowest cost. Good for most tasks."},
            {"id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6", "description": "Balanced speed and quality."},
            {"id": "claude-opus-4-6", "name": "Claude Opus 4.6", "description": "Highest quality, slowest. Best for complex planning."},
        ]
    }))
}

// ── Catalog ───────────────────────────────────────────────────────────────────

pub async fn catalog_list(State(state): State<Arc<AppState>>) -> Json<Value> {
    let agents: Vec<Value> = state
        .catalog
        .all()
        .into_iter()
        .map(|a| {
            json!({
                "slug": a.slug,
                "name": a.name,
                "category": a.category,
                "description": a.description,
                "intents": a.intents,
                "version": a.version,
            })
        })
        .collect();

    let count = agents.len();
    Json(json!({"agents": agents, "count": count}))
}

pub async fn catalog_get(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    let agent = state
        .catalog
        .get(&slug)
        .ok_or(StatusCode::NOT_FOUND)?;

    Ok(Json(json!({
        "slug": agent.slug,
        "name": agent.name,
        "category": agent.category,
        "description": agent.description,
        "intents": agent.intents,
        "tools": agent.tools,
        "judge_config": agent.judge_config,
        "max_iterations": agent.max_iterations,
        "model": agent.model,
        "skip_judge": agent.skip_judge,
        "system_prompt": agent.system_prompt,
        "example_count": agent.examples.len(),
        "knowledge_doc_count": agent.knowledge_docs.len(),
    })))
}

// ── Execution ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateExecutionRequest {
    pub request_text: String,
    pub customer_id: Option<String>,
    pub model: Option<String>,
}

#[derive(Serialize)]
pub struct CreateExecutionResponse {
    pub session_id: String,
    pub plan: Value,
    pub node_count: usize,
}

/// GET /api/execute/sessions — list recent execution sessions.
pub async fn execution_sessions_list(
    State(state): State<Arc<AppState>>,
) -> Json<Value> {
    let sql = r#"
        SELECT id, request_text, status, plan_approved_at, created_at, completed_at,
               (SELECT COUNT(*) FROM execution_nodes WHERE session_id = s.id) as node_count,
               (SELECT COUNT(*) FILTER (WHERE status = 'passed') FROM execution_nodes WHERE session_id = s.id) as passed_count
        FROM execution_sessions s
        ORDER BY created_at DESC
        LIMIT 50
    "#;
    let rows = state.db.execute(sql).await.unwrap_or_default();
    Json(json!({"sessions": rows}))
}

/// POST /api/execute — plan a new execution session.
pub async fn execution_create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateExecutionRequest>,
) -> Result<Json<CreateExecutionResponse>, (StatusCode, Json<Value>)> {
    let model = body.model.as_deref().unwrap_or(&state.settings.anthropic_model);
    info!(request = %body.request_text, model = %model, "creating execution session");

    let catalog_summary = state.catalog.catalog_summary();

    // Run LLM planner
    let plan = planner::plan_execution(
        &body.request_text,
        &catalog_summary,
        &state.settings.anthropic_api_key,
        model,
    )
    .await
    .map_err(|e| {
        error!(error = %e, "planner failed");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("Planning failed: {e}")})),
        )
    })?;

    let session_id = Uuid::new_v4();

    // Convert to execution nodes
    let exec_nodes = planner::plan_to_execution_nodes(
        &plan,
        session_id,
        state.catalog.git_sha(),
        &state.catalog,
    )
    .map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": format!("Plan validation failed: {e}")})),
        )
    })?;

    let node_count = exec_nodes.len();
    let plan_json = planner::plan_to_json(&exec_nodes);

    // Persist session and nodes to DB
    persist_session(
        &state.db,
        session_id,
        body.customer_id.as_deref(),
        &body.request_text,
        &plan_json,
        &exec_nodes,
    )
    .await
    .map_err(|e| {
        error!(error = %e, "failed to persist session");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "Failed to create session"})),
        )
    })?;

    info!(session_id = %session_id, nodes = node_count, "session created");

    Ok(Json(CreateExecutionResponse {
        session_id: session_id.to_string(),
        plan: plan_json,
        node_count,
    }))
}

/// POST /api/execute/:session_id/approve — approve the plan and start execution.
pub async fn execution_approve(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid session ID"})))
    })?;

    let sql = format!(
        "UPDATE execution_sessions SET status = 'executing', plan_approved_at = NOW() WHERE id = '{session_uuid}' AND status = 'awaiting_approval'"
    );

    state.db.execute(&sql).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    let unblock_sql = format!(
        "UPDATE execution_nodes SET status = 'ready' WHERE session_id = '{session_uuid}' AND status = 'pending' AND requires = '{{}}'"
    );
    state.db.execute(&unblock_sql).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    // Create SSE channel so clients can subscribe to live execution events
    state.event_bus.create_channel(&session_id).await;

    info!(session = %session_id, "execution approved — work queue will pick up ready nodes");

    Ok(Json(json!({"status": "executing", "session_id": session_id})))
}

/// GET /api/execute/:session_id — get session status and nodes.
pub async fn execution_get(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    let sql = format!(
        r#"
        SELECT id, status, request_text, plan, plan_approved_at, created_at, completed_at
        FROM execution_sessions WHERE id = '{session_id}'
        "#
    );

    let rows = state.db.execute(&sql).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let session = rows.first().ok_or(StatusCode::NOT_FOUND)?.clone();

    let nodes_sql = format!(
        r#"
        SELECT id, agent_slug, task_description, status, requires,
               judge_score, judge_feedback, judge_config, output, input,
               attempt_count, max_iterations, model, skip_judge,
               parent_uid, variant_group, variant_label, variant_selected,
               started_at, completed_at
        FROM execution_nodes WHERE session_id = '{session_id}'
        ORDER BY created_at
        "#
    );

    let nodes = state.db.execute(&nodes_sql).await.unwrap_or_default();

    Ok(Json(json!({
        "session": session,
        "nodes": nodes,
    })))
}

/// GET /api/execute/:session_id/nodes/:node_id/events — get execution events for a node.
pub async fn execution_node_events(
    State(state): State<Arc<AppState>>,
    Path((session_id, node_id)): Path<(String, String)>,
) -> Result<Json<Value>, StatusCode> {
    let node_uuid = node_id.parse::<Uuid>().map_err(|_| StatusCode::BAD_REQUEST)?;
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| StatusCode::BAD_REQUEST)?;

    let sql = format!(
        r#"
        SELECT id, node_id, event_type, payload, created_at
        FROM execution_events
        WHERE session_id = '{session_uuid}' AND node_id = '{node_uuid}'
        ORDER BY created_at ASC
        "#
    );

    let events = state.db.execute(&sql).await.unwrap_or_default();
    Ok(Json(json!({ "events": events })))
}

/// GET /api/execute/:session_id/events — SSE stream for live execution progress.
pub async fn execution_events_sse(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let rx = state.event_bus.subscribe(&session_id).await;

    match rx {
        Some(mut receiver) => {
            let stream = async_stream::stream! {
                loop {
                    match receiver.recv().await {
                        Ok(event) => {
                            yield Ok::<Event, std::convert::Infallible>(
                                Event::default().data(event.to_string())
                            );
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            tracing::warn!(lagged = n, "SSE receiver lagged");
                        }
                    }
                }
            };
            Sse::new(stream).into_response()
        }
        None => {
            // No active channel — poll DB for current status instead
            let stream = stream::once(async move {
                let event = Event::default().data(json!({"type": "no_active_stream"}).to_string());
                Ok::<Event, std::convert::Infallible>(event)
            });
            Sse::new(stream).into_response()
        }
    }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async fn persist_session(
    db: &crate::pg::PgClient,
    session_id: Uuid,
    customer_id: Option<&str>,
    request_text: &str,
    plan_json: &Value,
    nodes: &[crate::agent_catalog::ExecutionPlanNode],
) -> anyhow::Result<()> {
    let customer_val = customer_id
        .map(|id| format!("'{id}'"))
        .unwrap_or_else(|| "NULL".to_string());

    let request_escaped = request_text.replace('\'', "''");
    let plan_escaped = plan_json.to_string().replace('\'', "''");

    let session_sql = format!(
        r#"
        INSERT INTO execution_sessions (id, customer_id, request_text, plan, status)
        VALUES ('{session_id}', {customer_val}, '{request_escaped}', '{plan_escaped}'::jsonb, 'awaiting_approval')
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

        let computed_tier =
            crate::tier::compute_tier(db, &node.agent_slug, &node.task_description).await;

        let node_sql = format!(
            r#"
            INSERT INTO execution_nodes
              (id, session_id, agent_slug, agent_git_sha, task_description, status,
               requires, attempt_count, judge_config, max_iterations, model, skip_judge,
               computed_tier)
            VALUES
              ('{uid}', '{session_id}', '{slug}', '{sha}', '{task}', '{status}',
               {requires}, 0, '{judge}'::jsonb, {max_iter}, '{model}', {skip_judge},
               '{computed_tier}')
            "#,
            uid = node.uid,
            slug = node.agent_slug,
            sha = node.agent_git_sha,
            task = task_escaped,
            status = node.status.as_str(),
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

// ── Observation API ───────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct StartSessionRequest {
    pub expert_id: String,
}

/// POST /api/observe/session/start
pub async fn observe_session_start(
    State(state): State<Arc<AppState>>,
    Json(body): Json<StartSessionRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let session_id = Uuid::new_v4();
    let expert_id = body.expert_id.replace('\'', "''");

    let sql = format!(
        r#"
        INSERT INTO observation_sessions (id, expert_id, started_at, status)
        VALUES ('{session_id}', '{expert_id}', NOW(), 'recording')
        "#
    );

    state.db.execute(&sql).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    // Create SSE channel for narrator stream
    state.event_bus.create_channel(&session_id.to_string()).await;

    info!(session = %session_id, expert = %body.expert_id, "observation session started");

    Ok(Json(json!({"session_id": session_id.to_string()})))
}

#[derive(Deserialize)]
pub struct ScreenshotPayload {
    pub timestamp: i64,
    pub base64: String,
}

#[derive(Deserialize)]
pub struct EventBatchRequest {
    pub events: Vec<CapturedEvent>,
    pub screenshots: Option<Vec<ScreenshotPayload>>,
}

/// POST /api/observe/session/:session_id/events
pub async fn observe_session_events(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(body): Json<EventBatchRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if body.events.is_empty() && body.screenshots.as_ref().map_or(true, |s| s.is_empty()) {
        return Ok(Json(json!({"received": 0, "screenshots_stored": 0, "gaps_detected": []})));
    }

    let received = body.events.len();
    let screenshots_received = body.screenshots.as_ref().map_or(0, |s| s.len());

    // Persist events to DB
    for event in &body.events {
        let url = event.url.as_deref().unwrap_or("").replace('\'', "''");
        let domain = event
            .url
            .as_deref()
            .and_then(|u| Url::parse(u).ok())
            .and_then(|u| u.host_str().map(|h| h.to_string()))
            .unwrap_or_default();
        let dom_ctx = event
            .dom_context
            .as_ref()
            .map(|v| v.to_string().replace('\'', "''"))
            .unwrap_or_else(|| "null".to_string());
        let event_type = event.event_type.replace('\'', "''");

        let sql = format!(
            r#"
            INSERT INTO action_events
              (session_id, sequence_number, event_type, url, domain, dom_context, created_at)
            VALUES
              ('{session_id}', {seq}, '{event_type}', '{url}', '{domain}', '{dom_ctx}'::jsonb, NOW())
            ON CONFLICT (session_id, sequence_number) DO NOTHING
            "#,
            seq = event.sequence_number,
        );
        let _ = state.db.execute(&sql).await;
    }

    // Update event count
    let _ = state.db.execute(&format!(
        "UPDATE observation_sessions SET event_count = (SELECT COUNT(*) FROM action_events WHERE session_id = '{session_id}') WHERE id = '{session_id}'"
    )).await;

    // Persist screenshots to DB and grab the latest for vision narrator
    let latest_screenshot_b64: Option<String> = if let Some(screenshots) = &body.screenshots {
        let mut latest: Option<String> = None;
        for (i, ss) in screenshots.iter().enumerate() {
            // Store screenshot as BYTEA using Postgres decode()
            let _ = state.db.execute(&format!(
                "INSERT INTO observation_screenshots (session_id, sequence_number, image_jpeg, captured_at) VALUES ('{session_id}', {ts}, decode('{b64}', 'base64'), NOW()) ON CONFLICT DO NOTHING",
                ts = ss.timestamp,
                b64 = ss.base64.replace('\'', ""),
            )).await;
            // Keep the latest screenshot for the narrator
            if i == screenshots.len() - 1 {
                latest = Some(ss.base64.clone());
            }
        }
        latest
    } else {
        None
    };

    // Trigger narrator asynchronously (fire and forget)
    {
        let db = state.db.clone();
        let api_key = state.settings.anthropic_api_key.clone();
        let model = state.settings.anthropic_model.clone();
        let events = body.events.clone();
        let session_id_clone = session_id.clone();
        let event_bus = state.event_bus.clone();
        let screenshot = latest_screenshot_b64;

        tokio::spawn(async move {
            narrate_batch(&db, &api_key, &model, &session_id_clone, &events, &event_bus, screenshot.as_deref()).await;
        });
    }

    Ok(Json(json!({"received": received, "screenshots_stored": screenshots_received, "gaps_detected": []})))
}

async fn narrate_batch(
    db: &crate::pg::PgClient,
    api_key: &str,
    model: &str,
    session_id: &str,
    events: &[CapturedEvent],
    event_bus: &crate::session::EventBus,
    screenshot_b64: Option<&str>,
) {
    // Skip heartbeat-only batches
    let meaningful: Vec<&CapturedEvent> = events
        .iter()
        .filter(|e| e.event_type != "heartbeat")
        .collect();

    if meaningful.is_empty() {
        return;
    }

    let max_seq = meaningful.iter().map(|e| e.sequence_number).max().unwrap_or(0);
    let prior = narrator::load_prior_narrations(db, session_id, 5).await;

    let narr = narrator::Narrator::new(api_key.to_string(), model.to_string());
    let meaningful_owned: Vec<CapturedEvent> = meaningful.iter().map(|e| (*e).clone()).collect();

    match narr.narrate(&meaningful_owned, &prior, screenshot_b64).await {
        Ok(text) => {
            let _ = narrator::persist_narration(db, session_id, max_seq, &text, model).await;

            // Broadcast to any connected side panel via SSE
            event_bus.send(
                session_id,
                serde_json::json!({
                    "type": "narration_chunk",
                    "text": text,
                    "sequence_ref": max_seq,
                }),
            ).await;
        }
        Err(e) => {
            tracing::warn!(session = %session_id, error = %e, "narrator failed for batch");
        }
    }
}

/// GET /api/observe/session/:session_id/narration — SSE stream of narration chunks.
pub async fn observe_narration_sse(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let rx = state.event_bus.subscribe(&session_id).await;

    match rx {
        Some(mut receiver) => {
            let stream = async_stream::stream! {
                loop {
                    match receiver.recv().await {
                        Ok(event) => {
                            yield Ok::<Event, std::convert::Infallible>(
                                Event::default().event("narration_chunk").data(event.to_string())
                            );
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    }
                }
            };
            Sse::new(stream).into_response()
        }
        None => {
            // Poll DB for latest narrations
            let sql = format!(
                "SELECT id, sequence_ref, narrator_text, expert_correction, created_at FROM distillations WHERE session_id = '{session_id}' ORDER BY sequence_ref DESC LIMIT 20"
            );
            let rows = state.db.execute(&sql).await.unwrap_or_default();
            let stream = stream::once(async move {
                let event = Event::default()
                    .event("history")
                    .data(json!(rows).to_string());
                Ok::<Event, std::convert::Infallible>(event)
            });
            Sse::new(stream).into_response()
        }
    }
}

#[derive(Deserialize)]
pub struct CorrectionRequest {
    pub sequence_ref: i64,
    pub correction: String,
}

/// POST /api/observe/session/:session_id/correction
pub async fn observe_correction(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(body): Json<CorrectionRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let correction_escaped = body.correction.replace('\'', "''");

    let sql = format!(
        r#"
        UPDATE distillations
        SET expert_correction = '{correction_escaped}'
        WHERE session_id = '{session_id}'
          AND sequence_ref = {seq}
        RETURNING narrator_text
        "#,
        seq = body.sequence_ref,
    );

    let rows = state.db.execute(&sql).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    let narrator_text = rows
        .first()
        .and_then(|r| r.get("narrator_text").and_then(Value::as_str))
        .unwrap_or("");

    // Record as ground_truth feedback signal (weight 5.0)
    // Try to find matching agent from prior abstracted_tasks for this session
    let agent_sql = format!(
        "SELECT matched_agent_slug FROM abstracted_tasks WHERE session_id = '{session_id}' AND matched_agent_slug IS NOT NULL LIMIT 1"
    );
    let agent_slug = state.db.execute(&agent_sql).await.ok()
        .and_then(|rows| rows.first().and_then(|r| r.get("matched_agent_slug").and_then(Value::as_str).map(String::from)))
        .unwrap_or_else(|| "unknown".to_string());

    let _ = feedback::record_correction_signal(
        &state.db,
        &agent_slug,
        &session_id,
        body.sequence_ref,
        &body.correction,
        narrator_text,
    )
    .await;

    info!(session = %session_id, seq = body.sequence_ref, "expert correction stored + feedback recorded");
    Ok(Json(json!({"ok": true})))
}

/// POST /api/observe/session/:session_id/end
pub async fn observe_session_end(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let coverage = narrator::compute_coverage_score(&state.db, &session_id).await;

    let sql = format!(
        "UPDATE observation_sessions SET status = 'completed', ended_at = NOW(), coverage_score = {coverage} WHERE id = '{session_id}'"
    );

    state.db.execute(&sql).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    // Cleanup SSE channel
    state.event_bus.cleanup(&session_id).await;

    info!(session = %session_id, coverage = coverage, "observation session ended");

    // Trigger extraction + reasoning + synthesis pipeline asynchronously
    {
        let db = state.db.clone();
        let catalog = state.catalog.clone();
        let api_key = state.settings.anthropic_api_key.clone();
        let model = state.settings.anthropic_model.clone();
        let session_id_clone = session_id.clone();

        tokio::spawn(async move {
            info!(session = %session_id_clone, "starting post-session extraction + reasoning");
            if let Err(e) = crate::extraction::run_extraction(
                &db,
                &catalog,
                &api_key,
                &model,
                &session_id_clone,
            ).await {
                tracing::warn!(session = %session_id_clone, error = %e, "extraction pipeline failed");
            }

            // After extraction + reasoning, synthesize accumulated feedback into PRs
            match crate::feedback::synthesize_feedback(&db, &api_key, &model, Some(&catalog)).await {
                Ok(prs) if !prs.is_empty() => {
                    info!(session = %session_id_clone, prs = prs.len(), "post-session feedback synthesized");
                }
                Err(e) => {
                    tracing::warn!(session = %session_id_clone, error = %e, "feedback synthesis failed");
                }
                _ => {}
            }
        });
    }

    Ok(Json(json!({
        "session_id": session_id,
        "coverage_score": coverage,
    })))
}

/// GET /api/observe/sessions — list observation sessions.
pub async fn observe_sessions_list(
    State(state): State<Arc<AppState>>,
) -> Json<Value> {
    let sql = "SELECT id, expert_id, started_at, ended_at, status, coverage_score, event_count, distillation_count FROM observation_sessions ORDER BY created_at DESC LIMIT 50";
    let rows = state.db.execute(sql).await.unwrap_or_default();
    Json(json!({"sessions": rows}))
}

/// GET /api/observe/session/:session_id — get session detail with distillations.
pub async fn observe_session_get(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    let sql = format!(
        "SELECT id, expert_id, started_at, ended_at, status, coverage_score, event_count FROM observation_sessions WHERE id = '{session_id}'"
    );
    let rows = state.db.execute(&sql).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let session = rows.first().ok_or(StatusCode::NOT_FOUND)?.clone();

    let dist_sql = format!(
        "SELECT id, sequence_ref, narrator_text, expert_correction, created_at FROM distillations WHERE session_id = '{session_id}' ORDER BY sequence_ref"
    );
    let distillations = state.db.execute(&dist_sql).await.unwrap_or_default();

    Ok(Json(json!({"session": session, "distillations": distillations})))
}

// ── Agent PRs ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct AgentPrsQuery {
    pub status: Option<String>,
}

/// GET /api/agent-prs — list agent PRs, optionally filtered by status.
pub async fn agent_prs_list(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<AgentPrsQuery>,
) -> Json<Value> {
    let status_filter = query.status.unwrap_or_else(|| "open".to_string());
    let status_escaped = status_filter.replace('\'', "''");

    let sql = format!(
        r#"
        SELECT id, pr_type, target_agent_slug, proposed_slug, gap_summary,
               confidence, evidence_count, status, created_at
        FROM agent_prs
        WHERE status = '{status_escaped}'
        ORDER BY created_at DESC
        LIMIT 100
        "#
    );

    let rows = state.db.execute(&sql).await.unwrap_or_default();
    Json(json!({"prs": rows}))
}

/// GET /api/agent-prs/:pr_id — get a single PR with full details.
pub async fn agent_pr_get(
    State(state): State<Arc<AppState>>,
    Path(pr_id): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    let pr_uuid = pr_id.parse::<Uuid>().map_err(|_| StatusCode::BAD_REQUEST)?;

    let sql = format!(
        r#"
        SELECT id, pr_type, target_agent_slug, proposed_slug, file_diffs,
               proposed_changes, reasoning, gap_summary, confidence, evidence_count,
               status, created_at
        FROM agent_prs
        WHERE id = '{pr_uuid}'
        "#
    );

    let rows = state.db.execute(&sql).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let pr = rows.first().ok_or(StatusCode::NOT_FOUND)?;

    Ok(Json(pr.clone()))
}

/// POST /api/agent-prs/:pr_id/approve — approve and apply a PR to agent definitions.
pub async fn agent_pr_approve(
    State(state): State<Arc<AppState>>,
    Path(pr_id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let pr_uuid = pr_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid PR ID"})))
    })?;

    pr_engine::apply_pr(&state.db, &state.catalog, pr_uuid)
        .await
        .map_err(|e| {
            error!(error = %e, "failed to apply PR");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
        })?;

    info!(pr = %pr_id, "agent PR approved and applied");
    Ok(Json(json!({"ok": true, "status": "approved"})))
}

/// POST /api/agent-prs/:pr_id/reject — reject a PR.
pub async fn agent_pr_reject(
    State(state): State<Arc<AppState>>,
    Path(pr_id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let pr_uuid = pr_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid PR ID"})))
    })?;

    let sql = format!(
        "UPDATE agent_prs SET status = 'rejected', reviewed_at = NOW() WHERE id = '{pr_uuid}' AND status = 'open'"
    );

    state.db.execute(&sql).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    info!(pr = %pr_id, "agent PR rejected");
    Ok(Json(json!({"ok": true, "status": "rejected"})))
}

// ── Data Viewer ──────────────────────────────────────────────────────────────

/// GET /api/data/schemas — list all tables with row counts.
pub async fn data_schemas(
    State(state): State<Arc<AppState>>,
) -> Json<Value> {
    let sql = r#"
        SELECT schemaname AS schema, relname AS table_name, n_live_tup AS row_count
        FROM pg_stat_user_tables
        ORDER BY schemaname, relname
    "#;
    let rows = state.db.execute(sql).await.unwrap_or_default();

    // Also list views
    let views_sql = r#"
        SELECT schemaname AS schema, viewname AS table_name, -1 AS row_count
        FROM pg_views
        WHERE schemaname = 'public'
        ORDER BY viewname
    "#;
    let views = state.db.execute(views_sql).await.unwrap_or_default();

    let mut all = rows;
    all.extend(views);

    Json(json!({"tables": all}))
}

#[derive(Deserialize)]
pub struct QueryRequest {
    pub sql: String,
}

/// POST /api/data/query — execute read-only SQL.
pub async fn data_query(
    State(state): State<Arc<AppState>>,
    Json(body): Json<QueryRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let trimmed = body.sql.trim();

    // Validate read-only
    let first_word = trimmed
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_uppercase();

    if !matches!(first_word.as_str(), "SELECT" | "WITH" | "EXPLAIN") {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({"error": "Only SELECT, WITH, and EXPLAIN queries are allowed"})),
        ));
    }

    match state.db.execute(trimmed).await {
        Ok(rows) => {
            let row_count = rows.len();
            // Extract column names from first row
            let columns: Vec<String> = rows
                .first()
                .and_then(|r| r.as_object())
                .map(|obj| obj.keys().cloned().collect())
                .unwrap_or_default();

            Ok(Json(json!({
                "columns": columns,
                "rows": rows,
                "row_count": row_count,
                "sql": trimmed,
            })))
        }
        Err(e) => Ok(Json(json!({
            "columns": [],
            "rows": [],
            "row_count": 0,
            "sql": trimmed,
            "error": format!("{e}"),
        }))),
    }
}

#[derive(Deserialize)]
pub struct TableRowsQuery {
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

/// GET /api/data/tables/:table/rows — get paginated rows for a table.
pub async fn data_table_rows(
    State(state): State<Arc<AppState>>,
    Path(table): Path<String>,
    axum::extract::Query(query): axum::extract::Query<TableRowsQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    // Validate table name (alphanumeric + underscore only)
    if !table.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "Invalid table name"})),
        ));
    }

    let limit = query.limit.unwrap_or(100).min(10000);
    let offset = query.offset.unwrap_or(0);

    // Check if table has created_at for ordering
    let has_created_at = state.db.execute(&format!(
        "SELECT 1 FROM information_schema.columns WHERE table_name = '{table}' AND column_name = 'created_at' LIMIT 1"
    )).await.map(|r| !r.is_empty()).unwrap_or(false);

    let order = if has_created_at { "ORDER BY created_at DESC" } else { "" };

    let sql = format!(
        "SELECT * FROM {table} {order} LIMIT {limit} OFFSET {offset}"
    );

    match state.db.execute(&sql).await {
        Ok(rows) => {
            let row_count = rows.len();
            let columns: Vec<String> = rows
                .first()
                .and_then(|r| r.as_object())
                .map(|obj| obj.keys().cloned().collect())
                .unwrap_or_default();

            Ok(Json(json!({
                "table": table,
                "columns": columns,
                "rows": rows,
                "row_count": row_count,
                "limit": limit,
                "offset": offset,
            })))
        }
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("{e}")})),
        )),
    }
}

// ── Demo ─────────────────────────────────────────────────────────────────────

/// POST /api/demo/run — run a scripted demo session through the full pipeline.
/// Creates an observation session, sends 3 batches of realistic events,
/// ends the session (triggering extraction). Returns session_id immediately.
pub async fn demo_run(
    State(state): State<Arc<AppState>>,
) -> Json<Value> {
    let session_id = Uuid::new_v4();
    let expert_id = Uuid::new_v4();

    // Create observation session
    let sql = format!(
        "INSERT INTO observation_sessions (id, expert_id, started_at, status) VALUES ('{session_id}', '{expert_id}', NOW(), 'recording')"
    );
    if let Err(e) = state.db.execute(&sql).await {
        return Json(json!({"error": format!("Failed to create session: {e}")}));
    }

    // Create SSE channel
    state.event_bus.create_channel(&session_id.to_string()).await;

    info!(session = %session_id, "demo session started");

    // Spawn background task that sends events and runs pipeline
    let db = state.db.clone();
    let api_key = state.settings.anthropic_api_key.clone();
    let model = state.settings.anthropic_model.clone();
    let catalog = state.catalog.clone();
    let event_bus = state.event_bus.clone();
    let sid = session_id.to_string();

    tokio::spawn(async move {
        let ts = chrono::Utc::now().timestamp_millis();

        // Batch 1: ICP definition on Sales Navigator
        let batch1 = serde_json::json!([
            {"event_type": "navigation", "url": "http://localhost:4000/sales-nav/search", "dom_context": {"page_title": "Sales Navigator - Lead Search"}, "sequence_number": 1, "timestamp": ts},
            {"event_type": "click", "url": "http://localhost:4000/sales-nav/search", "dom_context": {"element": "button", "text": "Industry: Financial Technology", "class": "search-filter-btn"}, "sequence_number": 2, "timestamp": ts + 1},
            {"event_type": "click", "url": "http://localhost:4000/sales-nav/search", "dom_context": {"element": "button", "text": "Company size: 51-200 employees", "class": "search-filter-btn"}, "sequence_number": 3, "timestamp": ts + 2},
            {"event_type": "click", "url": "http://localhost:4000/sales-nav/search", "dom_context": {"element": "button", "text": "Funding: Series A, Series B", "class": "search-filter-btn"}, "sequence_number": 4, "timestamp": ts + 3}
        ]);
        ingest_demo_events(&db, &sid, &batch1).await;
        run_narrator(&db, &api_key, &model, &sid, &batch1, &event_bus).await;
        tokio::time::sleep(std::time::Duration::from_secs(8)).await;

        // Batch 2: Company research
        let batch2 = serde_json::json!([
            {"event_type": "click", "url": "http://localhost:4000/sales-nav/search", "dom_context": {"element": "a", "text": "Sarah Chen - VP Engineering at FinFlow", "class": "result-lockup__name"}, "sequence_number": 5, "timestamp": ts + 10000},
            {"event_type": "navigation", "url": "http://localhost:4000/crunchbase/finflow", "dom_context": {"page_title": "FinFlow - Crunchbase"}, "sequence_number": 6, "timestamp": ts + 10001},
            {"event_type": "click", "url": "http://localhost:4000/crunchbase/finflow", "dom_context": {"element": "div", "text": "Series B: $45M led by Sequoia Capital", "section": "funding_rounds"}, "sequence_number": 7, "timestamp": ts + 10002},
            {"event_type": "click", "url": "http://localhost:4000/crunchbase/finflow", "dom_context": {"element": "span", "text": "Salesforce CRM", "class": "tech-item"}, "sequence_number": 8, "timestamp": ts + 10003}
        ]);
        ingest_demo_events(&db, &sid, &batch2).await;
        run_narrator(&db, &api_key, &model, &sid, &batch2, &event_bus).await;
        tokio::time::sleep(std::time::Duration::from_secs(8)).await;

        // Batch 3: Contact finding + email
        let batch3 = serde_json::json!([
            {"event_type": "navigation", "url": "http://localhost:4000/sales-nav/profile/sarah-chen", "dom_context": {"page_title": "Sarah Chen | Sales Navigator"}, "sequence_number": 9, "timestamp": ts + 20000},
            {"event_type": "click", "url": "http://localhost:4000/sales-nav/profile/sarah-chen", "dom_context": {"element": "button", "text": "Save to list", "class": "save-lead-btn"}, "sequence_number": 10, "timestamp": ts + 20001},
            {"event_type": "click", "url": "http://localhost:4000/sales-nav/profile/sarah-chen", "dom_context": {"element": "button", "text": "Copy email", "class": "copy-email-btn", "data-email": "sarah.chen@finflow.com"}, "sequence_number": 11, "timestamp": ts + 20002},
            {"event_type": "navigation", "url": "http://localhost:4000/gmail/compose", "dom_context": {"page_title": "Gmail - Compose"}, "sequence_number": 12, "timestamp": ts + 20003},
            {"event_type": "form_submit", "url": "http://localhost:4000/gmail/compose", "dom_context": {"form_data": {"to": "sarah.chen@finflow.com", "subject": "scaling eng at FinFlow", "body_preview": "Saw your post about growing the eng team post-Series B..."}}, "sequence_number": 13, "timestamp": ts + 20004}
        ]);
        ingest_demo_events(&db, &sid, &batch3).await;
        run_narrator(&db, &api_key, &model, &sid, &batch3, &event_bus).await;
        tokio::time::sleep(std::time::Duration::from_secs(8)).await;

        // End session + trigger extraction
        let coverage = crate::narrator::compute_coverage_score(&db, &sid).await;
        let _ = db.execute(&format!(
            "UPDATE observation_sessions SET status = 'completed', ended_at = NOW(), coverage_score = {coverage} WHERE id = '{sid}'"
        )).await;

        info!(session = %sid, "demo session ended, starting extraction");

        if let Err(e) = crate::extraction::run_extraction(&db, &catalog, &api_key, &model, &sid).await {
            tracing::warn!(session = %sid, error = %e, "demo extraction failed");
        }

        info!(session = %sid, "demo pipeline complete");
    });

    Json(json!({
        "session_id": session_id.to_string(),
        "estimated_seconds": 90,
    }))
}

/// Ingest demo events into action_events table.
async fn ingest_demo_events(db: &crate::pg::PgClient, session_id: &str, events: &Value) {
    let events_arr = events.as_array().unwrap();
    for event in events_arr {
        let url = event.get("url").and_then(Value::as_str).unwrap_or("").replace('\'', "''");
        let domain = url::Url::parse(&url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
        let dom_ctx = event.get("dom_context").map(|v| v.to_string().replace('\'', "''")).unwrap_or_else(|| "null".to_string());
        let event_type = event.get("event_type").and_then(Value::as_str).unwrap_or("").replace('\'', "''");
        let seq = event.get("sequence_number").and_then(Value::as_i64).unwrap_or(0);

        let sql = format!(
            "INSERT INTO action_events (session_id, sequence_number, event_type, url, domain, dom_context, created_at) VALUES ('{session_id}', {seq}, '{event_type}', '{url}', '{domain}', '{dom_ctx}'::jsonb, NOW()) ON CONFLICT (session_id, sequence_number) DO NOTHING"
        );
        let _ = db.execute(&sql).await;
    }
    let _ = db.execute(&format!(
        "UPDATE observation_sessions SET event_count = (SELECT COUNT(*) FROM action_events WHERE session_id = '{session_id}') WHERE id = '{session_id}'"
    )).await;
}

/// Run narrator on a batch of events.
async fn run_narrator(
    db: &crate::pg::PgClient,
    api_key: &str,
    model: &str,
    session_id: &str,
    events: &Value,
    event_bus: &crate::session::EventBus,
) {
    use crate::narrator::{self, CapturedEvent};

    let captured: Vec<CapturedEvent> = events.as_array().unwrap().iter().filter_map(|e| {
        serde_json::from_value(e.clone()).ok()
    }).collect();

    if captured.is_empty() { return; }

    let meaningful: Vec<&CapturedEvent> = captured.iter().filter(|e| e.event_type != "heartbeat").collect();
    if meaningful.is_empty() { return; }

    let max_seq = meaningful.iter().map(|e| e.sequence_number).max().unwrap_or(0);
    let prior = narrator::load_prior_narrations(db, session_id, 5).await;
    let narr = narrator::Narrator::new(api_key.to_string(), model.to_string());
    let meaningful_owned: Vec<CapturedEvent> = meaningful.iter().map(|e| (*e).clone()).collect();

    match narr.narrate(&meaningful_owned, &prior, None).await {
        Ok(text) => {
            let _ = narrator::persist_narration(db, session_id, max_seq, &text, model).await;
            event_bus.send(session_id, serde_json::json!({"type": "narration_chunk", "text": &text, "sequence_ref": max_seq})).await;
        }
        Err(e) => tracing::warn!(session = %session_id, error = %e, "demo narrator failed"),
    }
}

// ── Workflow Routes ──────────────────────────────────────────────────────────

/// GET /api/workflows — list all workflows.
pub async fn workflows_list(
    State(state): State<Arc<AppState>>,
) -> Json<Value> {
    let workflows = workflow_mod::list_workflows(&state.db).await.unwrap_or_default();
    Json(json!({"workflows": workflows}))
}

#[derive(Deserialize)]
pub struct CreateWorkflowRequest {
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub client_id: Option<String>,
    pub steps: Vec<CreateWorkflowStepRequest>,
}

#[derive(Deserialize)]
pub struct CreateWorkflowStepRequest {
    pub agent_slug: String,
    pub task_description_template: Option<String>,
    pub requires: Option<Vec<usize>>,
    pub tier_override: Option<String>,
    pub breakpoint: Option<bool>,
}

/// POST /api/workflows — create a new workflow with steps.
pub async fn workflow_create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateWorkflowRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let client_uuid = body.client_id
        .as_deref()
        .and_then(|s| s.parse::<Uuid>().ok());

    let workflow_id = workflow_mod::create_workflow(
        &state.db, &body.slug, &body.name, body.description.as_deref(), client_uuid,
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    let mut step_ids: Vec<Uuid> = Vec::new();

    for (i, step) in body.steps.iter().enumerate() {
        let requires: Vec<Uuid> = step.requires
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .filter_map(|&idx| step_ids.get(idx).copied())
            .collect();

        let step_id = workflow_mod::add_step(
            &state.db,
            workflow_id,
            i as i32,
            &step.agent_slug,
            step.task_description_template.as_deref(),
            &requires,
            step.tier_override.as_deref(),
            step.breakpoint.unwrap_or(false),
            None,
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

        step_ids.push(step_id);
    }

    Ok(Json(json!({"workflow_id": workflow_id.to_string(), "steps": step_ids.len()})))
}

/// GET /api/workflows/:slug — get workflow detail with steps.
pub async fn workflow_get(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    let workflow = workflow_mod::get_workflow(&state.db, &slug)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let steps = workflow_mod::get_workflow_steps(&state.db, workflow.id)
        .await
        .unwrap_or_default();

    Ok(Json(json!({"workflow": workflow, "steps": steps})))
}

#[derive(Deserialize)]
pub struct RunWorkflowRequest {
    pub request_text: String,
}

/// POST /api/workflows/:slug/run — instantiate a workflow into an execution session.
pub async fn workflow_run(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Json(body): Json<RunWorkflowRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let session_id = workflow_mod::instantiate_workflow(
        &state.db, &state.catalog, &slug, &body.request_text,
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({"session_id": session_id.to_string()})))
}

#[derive(Deserialize)]
pub struct SaveAsWorkflowRequest {
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
}

/// POST /api/execute/:session_id/save-as-workflow — save session DAG as workflow template.
pub async fn execution_save_as_workflow(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(body): Json<SaveAsWorkflowRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid session ID"})))
    })?;

    let workflow_id = workflow_mod::save_session_as_workflow(
        &state.db, session_uuid, &body.slug, &body.name, body.description.as_deref(),
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({"workflow_id": workflow_id.to_string()})))
}

// ── Client Routes ────────────────────────────────────────────────────────────

/// GET /api/clients — list clients.
pub async fn clients_list(
    State(state): State<Arc<AppState>>,
) -> Json<Value> {
    let clients = client_mod::list_clients(&state.db).await.unwrap_or_default();
    Json(json!({"clients": clients}))
}

#[derive(Deserialize)]
pub struct CreateClientRequest {
    pub slug: String,
    pub name: String,
    pub brief: Option<String>,
    pub industry: Option<String>,
}

/// POST /api/clients — create a client.
pub async fn client_create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateClientRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let id = client_mod::create_client(
        &state.db, &body.slug, &body.name, body.brief.as_deref(), body.industry.as_deref(), None,
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({"client_id": id.to_string()})))
}

/// GET /api/clients/:slug — get client detail with contacts and state.
pub async fn client_get(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    let client = client_mod::get_client(&state.db, &slug)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let client_id: Uuid = client.get("id")
        .and_then(Value::as_str)
        .and_then(|s| s.parse().ok())
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;

    let contacts = client_mod::get_contacts(&state.db, client_id).await.unwrap_or_default();
    let state_items = client_mod::list_state(&state.db, client_id, None).await.unwrap_or_default();

    Ok(Json(json!({
        "client": client,
        "contacts": contacts,
        "state": state_items,
    })))
}

#[derive(Deserialize)]
pub struct SetClientStateRequest {
    pub workflow_slug: Option<String>,
    pub state_key: String,
    pub state_value: Value,
}

/// POST /api/clients/:slug/state — set client state.
pub async fn client_set_state(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Json(body): Json<SetClientStateRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let client = client_mod::get_client(&state.db, &slug)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, Json(json!({"error": "Client not found"}))))?;

    let client_id: Uuid = client.get("id")
        .and_then(Value::as_str)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "Invalid client ID"}))))?;

    client_mod::set_state(
        &state.db, client_id, body.workflow_slug.as_deref(), &body.state_key, &body.state_value,
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({"ok": true})))
}

// ── Feedback Routes ──────────────────────────────────────────────────────────

/// GET /api/feedback — list feedback signals for an agent.
pub async fn feedback_list(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<FeedbackQuery>,
) -> Json<Value> {
    let mut clauses = vec!["1=1".to_string()];
    if let Some(slug) = &query.agent_slug {
        clauses.push(format!("agent_slug = '{}'", slug.replace('\'', "''")));
    }
    if query.unresolved_only.unwrap_or(false) {
        clauses.push("resolution IS NULL".to_string());
    }

    let sql = format!(
        "SELECT * FROM feedback_signals WHERE {} ORDER BY created_at DESC LIMIT 100",
        clauses.join(" AND ")
    );
    let rows = state.db.execute(&sql).await.unwrap_or_default();
    Json(json!({"signals": rows}))
}

#[derive(Deserialize)]
pub struct FeedbackQuery {
    pub agent_slug: Option<String>,
    pub unresolved_only: Option<bool>,
}

/// POST /api/feedback/synthesize — trigger feedback synthesis into PRs.
/// Ground truth PRs are auto-applied to the agent definitions.
pub async fn feedback_synthesize(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let pr_ids = feedback::synthesize_feedback(
        &state.db,
        &state.settings.anthropic_api_key,
        &state.settings.anthropic_model,
        Some(&state.catalog),
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({
        "created_prs": pr_ids.iter().map(|id| id.to_string()).collect::<Vec<_>>(),
        "count": pr_ids.len(),
    })))
}

// ── DAG Editor Routes ────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct UpdateNodeRequest {
    pub agent_slug: Option<String>,
    pub task_description: Option<String>,
    pub tier_override: Option<String>,
    pub breakpoint: Option<bool>,
}

/// PATCH /api/execute/:session_id/nodes/:node_id — update a node (DAG editor).
pub async fn execution_node_update(
    State(state): State<Arc<AppState>>,
    Path((session_id, node_id)): Path<(String, String)>,
    Json(body): Json<UpdateNodeRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let node_uuid = node_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid node ID"})))
    })?;

    let mut set_clauses = Vec::new();

    if let Some(slug) = &body.agent_slug {
        set_clauses.push(format!("agent_slug = '{}'", slug.replace('\'', "''")));
    }
    if let Some(desc) = &body.task_description {
        set_clauses.push(format!("task_description = '{}'", desc.replace('\'', "''")));
    }
    if let Some(tier) = &body.tier_override {
        set_clauses.push(format!("tier_override = '{tier}'"));
    }
    if let Some(bp) = body.breakpoint {
        set_clauses.push(format!("breakpoint = {bp}"));
    }

    if set_clauses.is_empty() {
        return Ok(Json(json!({"ok": true, "updated": false})));
    }

    let sql = format!(
        "UPDATE execution_nodes SET {} WHERE id = '{}' AND session_id = '{}'",
        set_clauses.join(", "), node_uuid, session_id
    );

    state.db.execute(&sql).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    Ok(Json(json!({"ok": true, "updated": true})))
}

#[derive(Deserialize)]
pub struct AddNodeRequest {
    pub agent_slug: String,
    pub task_description: String,
    pub requires: Option<Vec<String>>,
    pub tier_override: Option<String>,
    pub breakpoint: Option<bool>,
}

/// POST /api/execute/:session_id/nodes — add a new node to a session (DAG editor).
pub async fn execution_node_add(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(body): Json<AddNodeRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let node_id = Uuid::new_v4();
    let slug_escaped = body.agent_slug.replace('\'', "''");
    let desc_escaped = body.task_description.replace('\'', "''");

    let requires = body.requires.unwrap_or_default();
    let requires_arr = if requires.is_empty() {
        "ARRAY[]::uuid[]".to_string()
    } else {
        let items: Vec<String> = requires.iter().map(|u| format!("'{u}'::uuid")).collect();
        format!("ARRAY[{}]", items.join(","))
    };

    let status = if requires.is_empty() { "pending" } else { "waiting" };
    let tier_val = body.tier_override
        .as_deref()
        .map(|t| format!("'{t}'"))
        .unwrap_or_else(|| "NULL".to_string());
    let breakpoint = body.breakpoint.unwrap_or(false);

    let agent = state.catalog.get(&body.agent_slug);
    let model = agent.as_ref().and_then(|a| a.model.as_deref()).unwrap_or("claude-haiku-4-5-20251001");
    let max_iter = agent.as_ref().map(|a| a.max_iterations).unwrap_or(15);
    let skip_judge = agent.as_ref().map(|a| a.skip_judge).unwrap_or(false);
    let judge_config = agent.as_ref()
        .map(|a| serde_json::to_string(&a.judge_config).unwrap_or_default())
        .unwrap_or_else(|| r#"{"threshold":7.0,"rubric":[],"need_to_know":[]}"#.to_string())
        .replace('\'', "''");

    let sql = format!(
        r#"INSERT INTO execution_nodes
            (id, session_id, agent_slug, agent_git_sha, task_description, status,
             requires, attempt_count, judge_config, max_iterations, model, skip_judge,
             tier_override, breakpoint)
           VALUES
            ('{node_id}', '{session_id}', '{slug_escaped}', 'manual', '{desc_escaped}',
             '{status}', {requires_arr}, 0, '{judge_config}'::jsonb, {max_iter},
             '{model}', {skip_judge}, {tier_val}, {breakpoint})"#
    );

    state.db.execute(&sql).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    Ok(Json(json!({"node_id": node_id.to_string()})))
}

/// DELETE /api/execute/:session_id/nodes/:node_id — remove a node (DAG editor).
pub async fn execution_node_delete(
    State(state): State<Arc<AppState>>,
    Path((session_id, node_id)): Path<(String, String)>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let sql = format!(
        "DELETE FROM execution_nodes WHERE id = '{node_id}' AND session_id = '{session_id}' AND status IN ('pending', 'waiting', 'ready')"
    );

    state.db.execute(&sql).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    Ok(Json(json!({"ok": true})))
}

/// POST /api/execute/:session_id/nodes/:node_id/release — release a breakpoint node.
pub async fn execution_node_release(
    State(state): State<Arc<AppState>>,
    Path((session_id, node_id)): Path<(String, String)>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let sql = format!(
        "UPDATE execution_nodes SET breakpoint = false WHERE id = '{node_id}' AND session_id = '{session_id}' AND status = 'ready'"
    );

    state.db.execute(&sql).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    Ok(Json(json!({"ok": true, "released": true})))
}

// ── Agent Version Routes ─────────────────────────────────────────────────────

/// GET /api/catalog/:slug/versions — list agent versions.
pub async fn catalog_versions(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    let slug_escaped = slug.replace('\'', "''");
    let sql = format!(
        r#"SELECT av.id, av.version, av.change_summary, av.change_source, av.created_at
           FROM agent_versions av
           JOIN agent_definitions ad ON av.agent_id = ad.id
           WHERE ad.slug = '{slug_escaped}'
           ORDER BY av.version DESC"#
    );

    let rows = state.db.execute(&sql).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(json!({"versions": rows})))
}
