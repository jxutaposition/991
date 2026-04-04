/// HTTP route handlers.
use std::sync::Arc;

use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse,
    },
    Json,
};
use futures_util::stream;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::agent_catalog::MASTER_ORCHESTRATOR_SLUG;
use crate::client as client_mod;
use crate::pg_args;
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

#[derive(Deserialize)]
pub struct CatalogQuery {
    pub category: Option<String>,
    pub expert_id: Option<String>,
}

pub async fn catalog_list(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<CatalogQuery>,
) -> Json<Value> {
    let expert_uuid = query.expert_id.as_deref()
        .and_then(|s| s.parse::<Uuid>().ok());

    let agents: Vec<Value> = state
        .catalog
        .all()
        .into_iter()
        .filter(|a| {
            if let Some(ref cat) = query.category {
                if &a.category != cat {
                    return false;
                }
            }
            if let Some(eid) = expert_uuid {
                match a.expert_id {
                    None => {}
                    Some(aid) if aid == eid => {}
                    _ => return false,
                }
            }
            true
        })
        .map(|a| {
            let tool_details: Vec<Value> = a.tools.iter().map(|t| {
                json!({
                    "name": t,
                    "credential": crate::tools::tool_credential(t),
                })
            }).collect();
            json!({
                "slug": a.slug,
                "name": a.name,
                "category": a.category,
                "description": a.description,
                "intents": a.intents,
                "tools": tool_details,
                "required_integrations": a.required_integrations,
                "version": a.version,
                "expert_id": a.expert_id.map(|id| id.to_string()),
            })
        })
        .collect();

    let categories: Vec<String> = {
        let mut cats: Vec<String> = state.catalog.all().iter()
            .map(|a| a.category.clone())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        cats.sort();
        cats
    };

    let count = agents.len();
    Json(json!({"agents": agents, "count": count, "categories": categories}))
}

pub async fn catalog_get(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    let agent = state
        .catalog
        .get(&slug)
        .ok_or(StatusCode::NOT_FOUND)?;

    let tool_details: Vec<Value> = agent.tools.iter().map(|t| {
        let cred = crate::tools::tool_credential(t);
        let display = cred.as_deref().map(integration_display_name).unwrap_or_default();
        json!({
            "name": t,
            "credential": cred,
            "display_name": display,
            "icon": cred.as_deref().unwrap_or("generic"),
        })
    }).collect();

    let examples: Vec<Value> = agent.examples.iter().enumerate().map(|(i, ex)| {
        json!({ "index": i, "input": ex.input, "output": ex.output })
    }).collect();

    let knowledge_docs: Vec<Value> = agent.knowledge_docs.iter().enumerate().map(|(i, doc)| {
        let preview = doc.chars().take(200).collect::<String>();
        json!({ "index": i, "preview": preview, "full": doc, "char_count": doc.len() })
    }).collect();

    // Resolve expert name if set
    let expert_info = if let Some(eid) = agent.expert_id {
        let rows = state.db.execute(&format!(
            "SELECT slug, name FROM experts WHERE id = '{eid}'"
        )).await.unwrap_or_default();
        rows.first().cloned()
    } else {
        None
    };

    Ok(Json(json!({
        "slug": agent.slug,
        "name": agent.name,
        "category": agent.category,
        "description": agent.description,
        "intents": agent.intents,
        "tools": tool_details,
        "required_integrations": agent.required_integrations,
        "judge_config": agent.judge_config,
        "max_iterations": agent.max_iterations,
        "model": agent.model,
        "skip_judge": agent.skip_judge,
        "flexible_tool_use": agent.flexible_tool_use,
        "system_prompt": agent.system_prompt,
        "examples": examples,
        "knowledge_docs": knowledge_docs,
        "input_schema": agent.input_schema,
        "output_schema": agent.output_schema,
        "version": agent.version,
        "git_sha": agent.git_sha,
        "expert_id": agent.expert_id.map(|id| id.to_string()),
        "expert": expert_info,
    })))
}

/// GET /api/catalog/:slug/stats — execution stats for an agent.
pub async fn catalog_agent_stats(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    let slug_escaped = slug.replace('\'', "''");

    // Aggregate stats from execution_nodes
    let stats_sql = format!(
        r#"
        SELECT
            COUNT(*) as total_runs,
            COUNT(*) FILTER (WHERE status = 'passed') as passed,
            COUNT(*) FILTER (WHERE status = 'failed') as failed,
            COUNT(*) FILTER (WHERE status = 'skipped') as skipped,
            ROUND(AVG(judge_score)::numeric, 2) as avg_score,
            MIN(judge_score) as min_score,
            MAX(judge_score) as max_score,
            ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - started_at)))::numeric, 1) as avg_duration_secs,
            MAX(completed_at) as last_run_at
        FROM execution_nodes
        WHERE agent_slug = '{slug_escaped}'
          AND status IN ('passed', 'failed', 'skipped')
        "#
    );
    let stats = state.db.execute(&stats_sql).await.unwrap_or_default();

    // Recent runs (last 20)
    let runs_sql = format!(
        r#"
        SELECT en.id, en.session_id, en.status, en.judge_score, en.judge_feedback,
               en.task_description, en.attempt_count, en.model,
               en.started_at, en.completed_at,
               es.request_text as session_request
        FROM execution_nodes en
        JOIN execution_sessions es ON en.session_id = es.id
        WHERE en.agent_slug = '{slug_escaped}'
          AND en.status IN ('passed', 'failed', 'skipped')
        ORDER BY en.completed_at DESC NULLS LAST
        LIMIT 20
        "#
    );
    let runs = state.db.execute(&runs_sql).await.unwrap_or_default();

    // Feedback signals
    let feedback_sql = format!(
        "SELECT * FROM feedback_signals WHERE agent_slug = '{slug_escaped}' ORDER BY created_at DESC LIMIT 20"
    );
    let feedback = state.db.execute(&feedback_sql).await.unwrap_or_default();

    // PRs targeting this agent
    let prs_sql = format!(
        r#"
        SELECT id, pr_type, gap_summary, confidence, status, created_at
        FROM agent_prs
        WHERE target_agent_slug = '{slug_escaped}'
        ORDER BY created_at DESC
        LIMIT 20
        "#
    );
    let prs = state.db.execute(&prs_sql).await.unwrap_or_default();

    Ok(Json(json!({
        "stats": stats.first().cloned().unwrap_or(json!({})),
        "recent_runs": runs,
        "feedback": feedback,
        "prs": prs,
    })))
}

// ── Execution ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateExecutionRequest {
    pub request_text: String,
    pub customer_id: Option<String>,
    pub model: Option<String>,
    pub expert_id: Option<String>,
    pub client_slug: Option<String>,
    pub mode: Option<String>,
    pub project_slug: Option<String>,
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

    let expert_uuid = body.expert_id.as_deref()
        .and_then(|s| s.parse::<Uuid>().ok());
    let catalog_summary = state.catalog.catalog_summary_for_expert(expert_uuid);

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

    // Resolve client_slug to client_id for credential injection
    let client_id: Option<Uuid> = if let Some(ref slug) = body.client_slug {
        let rows = state.db.execute_with(
            "SELECT id FROM clients WHERE slug = $1",
            pg_args!(slug.clone()),
        ).await.ok().unwrap_or_default();
        rows.first()
            .and_then(|r| r.get("id").and_then(Value::as_str))
            .and_then(|s| s.parse::<Uuid>().ok())
    } else {
        None
    };

    let mode = body.mode.as_deref().unwrap_or("orchestrated");

    // Resolve project_slug to project_id
    let project_id: Option<Uuid> = if let Some(ref pslug) = body.project_slug {
        if let Some(cid) = client_id {
            let rows = state.db.execute_with(
                "SELECT id FROM projects WHERE client_id = $1 AND slug = $2",
                pg_args!(cid, pslug.clone()),
            ).await.ok().unwrap_or_default();
            rows.first()
                .and_then(|r| r.get("id").and_then(Value::as_str))
                .and_then(|s| s.parse::<Uuid>().ok())
        } else {
            None
        }
    } else {
        None
    };

    if mode == "orchestrated" {
        let master_agent = state.catalog.get(MASTER_ORCHESTRATOR_SLUG).ok_or_else(|| {
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "master_orchestrator agent not found in catalog. Ensure it is loaded."})))
        })?;

        let master_uid = Uuid::new_v4();

        // Generate a preview decomposition so the user can see the intended structure
        let catalog_summary = state.catalog.catalog_summary();
        let preview_nodes = planner::plan_execution(
            &body.request_text,
            &catalog_summary,
            &state.settings.anthropic_api_key,
            model,
        ).await.unwrap_or_default();

        // Build plan JSON: master node + preview children
        let mut plan_entries = vec![json!({
            "uid": master_uid.to_string(),
            "agent_slug": MASTER_ORCHESTRATOR_SLUG,
            "task_description": &body.request_text,
            "requires": [],
        })];
        let mut preview_uids: Vec<Uuid> = Vec::new();
        for pn in &preview_nodes {
            let uid = Uuid::new_v4();
            preview_uids.push(uid);
            plan_entries.push(json!({
                "uid": uid.to_string(),
                "agent_slug": &pn.agent_slug,
                "task_description": &pn.task_description,
                "requires": [],
                "parent_uid": master_uid.to_string(),
                "preview": true,
            }));
        }
        let plan_json: Value = plan_entries.into();

        // Persist session
        let customer_uuid = body.customer_id.as_deref()
            .and_then(|id| id.parse::<Uuid>().ok());

        state.db.execute_with(
            r#"INSERT INTO execution_sessions (id, customer_id, client_id, project_id, request_text, plan, status, mode)
               VALUES ($1, $2, $3, $4, $5, $6, 'awaiting_approval', 'orchestrated')"#,
            pg_args!(session_id, customer_uuid, client_id, project_id, body.request_text.clone(), plan_json.clone()),
        ).await.map_err(|e| {
            error!(error = %e, "failed to persist session");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "Failed to create session"})))
        })?;

        // Persist master node
        let node_model = master_agent.model.as_deref().unwrap_or(model).to_string();
        let jc_val = serde_json::to_value(&master_agent.judge_config).unwrap_or(json!({}));
        let empty_uuids: Vec<Uuid> = vec![];

        state.db.execute_with(
            r#"INSERT INTO execution_nodes
                (id, session_id, agent_slug, agent_git_sha, task_description, status,
                 requires, attempt_count, judge_config, max_iterations, model, skip_judge,
                 client_id, depth)
               VALUES ($1, $2, $3, $4, $5, 'pending', $6, 0, $7, $8, $9, $10, $11, 0)"#,
            pg_args!(
                master_uid, session_id, MASTER_ORCHESTRATOR_SLUG.to_string(), "orchestrated".to_string(),
                body.request_text.clone(), &empty_uuids as &[Uuid], jc_val,
                master_agent.max_iterations as i32, node_model.clone(), master_agent.skip_judge,
                client_id
            ),
        ).await.map_err(|e| {
            error!(error = %e, "failed to persist master node");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "Failed to create master node"})))
        })?;

        // Persist preview child nodes (status = 'preview', won't be picked up by work queue)
        for (i, pn) in preview_nodes.iter().enumerate() {
            let child_uid = preview_uids[i];
            let child_jc_val = state.catalog.get(&pn.agent_slug)
                .map(|a| serde_json::to_value(&a.judge_config).unwrap_or(json!({})))
                .unwrap_or_else(|| json!({"threshold":7.0,"rubric":[],"need_to_know":[]}));

            let _ = state.db.execute_with(
                r#"INSERT INTO execution_nodes
                    (id, session_id, agent_slug, agent_git_sha, task_description, status,
                     requires, attempt_count, parent_uid, judge_config, max_iterations,
                     model, skip_judge, client_id, depth)
                   VALUES ($1, $2, $3, $4, $5, 'preview', $6, 0, $7, $8, 15, $9, true, $10, 1)"#,
                pg_args!(
                    child_uid, session_id, pn.agent_slug.clone(), "preview".to_string(),
                    pn.task_description.clone(), &empty_uuids as &[Uuid], master_uid,
                    child_jc_val, node_model.clone(), client_id
                ),
            ).await;
        }

        let total_nodes = 1 + preview_nodes.len();
        info!(
            session_id = %session_id,
            mode = "orchestrated",
            preview_children = preview_nodes.len(),
            "orchestrated session created with preview plan"
        );

        return Ok(Json(CreateExecutionResponse {
            session_id: session_id.to_string(),
            plan: plan_json,
            node_count: total_nodes,
        }));
    }

    // Planned mode (existing behavior)
    let mut exec_nodes = planner::plan_to_execution_nodes(
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

    if let Some(cid) = client_id {
        for node in &mut exec_nodes {
            node.client_id = Some(cid);
        }
    }

    let node_count = exec_nodes.len();
    let plan_json = planner::plan_to_json(&exec_nodes);

    persist_session(
        &state.db,
        session_id,
        body.customer_id.as_deref(),
        &body.request_text,
        &plan_json,
        &exec_nodes,
        client_id,
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

    // --- Preflight: verify all required integrations have working credentials ---
    let session_rows = state.db.execute_with(
        "SELECT client_id, project_id FROM execution_sessions WHERE id = $1",
        pg_args!(session_uuid),
    ).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;
    let session_row = session_rows.first().ok_or_else(|| {
        (StatusCode::NOT_FOUND, Json(json!({"error": "Session not found"})))
    })?;
    let client_id: Option<Uuid> = session_row.get("client_id")
        .and_then(Value::as_str)
        .and_then(|s| s.parse().ok());
    let project_id: Option<Uuid> = session_row.get("project_id")
        .and_then(Value::as_str)
        .and_then(|s| s.parse().ok());

    if let Some(client_id) = client_id {
        let node_rows = state.db.execute_with(
            "SELECT DISTINCT agent_slug FROM execution_nodes WHERE session_id = $1 AND status IN ('pending', 'preview')",
            pg_args!(session_uuid),
        ).await.map_err(|e| {
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
        })?;

        let mut all_required: Vec<String> = Vec::new();
        for row in &node_rows {
            let slug = row.get("agent_slug").and_then(Value::as_str).unwrap_or("");
            if let Some(agent) = state.catalog.get(slug) {
                for s in crate::preflight::required_slugs_for_agent(&agent.required_integrations, &agent.tools) {
                    if !all_required.contains(&s) {
                        all_required.push(s);
                    }
                }
            }
        }

        if !all_required.is_empty() {
            if let Some(ref master_key) = state.settings.credential_master_key {
                // Use project credentials (with client fallback) when a project is set
                let all_credentials = if let Some(pid) = project_id {
                    crate::credentials::load_credentials_for_project(
                        &state.db, master_key, pid, client_id,
                    ).await.unwrap_or_default()
                } else {
                    crate::credentials::load_credentials_for_client(
                        &state.db, master_key, client_id,
                    ).await.unwrap_or_default()
                };

                let needed = crate::preflight::filter_required_credentials(
                    &all_credentials, &all_required, &state.settings,
                );

                let probes = crate::preflight::probe_integrations(&needed, Some(&state.settings)).await;

                let mut all_issues: Vec<Value> = Vec::new();

                for p in &probes {
                    if !p.success() {
                        all_issues.push(json!({
                            "integration": p.integration_slug,
                            "type": p.status.as_str(),
                            "error": p.error,
                            "hint": p.hint,
                            "http_status": p.http_status,
                        }));
                    }
                }

                // Required integrations that have no credential at all
                for s in all_required.iter().filter(|s| !needed.contains_key(s.as_str())) {
                    all_issues.push(json!({
                        "integration": s,
                        "type": "missing",
                        "error": format!("No credentials configured for {s}"),
                        "hint": format!("Add {s} credentials in Settings > Integrations."),
                    }));
                }

                if !all_issues.is_empty() {
                    warn!(
                        session = %session_id,
                        issues = ?all_issues,
                        "preflight credential check found issues — blocking approval"
                    );
                    return Err((StatusCode::UNPROCESSABLE_ENTITY, Json(json!({
                        "error": "Credential preflight check failed",
                        "preflight_failures": all_issues,
                    }))));
                }

                info!(session = %session_id, probes = probes.len(), "preflight checks passed");
            }
        }
    }
    // --- End preflight ---

    state.db.execute_with(
        "UPDATE execution_sessions SET status = 'executing', plan_approved_at = NOW() WHERE id = $1 AND status = 'awaiting_approval'",
        pg_args!(session_uuid),
    ).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    state.db.execute_with(
        "UPDATE execution_nodes SET status = 'ready' WHERE session_id = $1 AND status = 'pending' AND requires = '{}'",
        pg_args!(session_uuid),
    ).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    // Create SSE channel so clients can subscribe to live execution events
    state.event_bus.create_channel(&session_id).await;

    info!(session = %session_id, "execution approved — work queue will pick up ready nodes");

    Ok(Json(json!({"status": "executing", "session_id": session_id})))
}

/// POST /api/execute/:session_id/stop — cancel a running orchestration.
/// Sets session to 'cancelled' and all non-terminal nodes to 'cancelled'.
pub async fn execution_stop(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid session ID"})))
    })?;

    state.db.execute_with(
        "UPDATE execution_sessions SET status = 'cancelled', completed_at = NOW() WHERE id = $1 AND status IN ('executing', 'awaiting_approval')",
        pg_args!(session_uuid),
    ).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    state.db.execute_with(
        "UPDATE execution_nodes SET status = 'cancelled', completed_at = NOW() WHERE session_id = $1 AND status IN ('pending', 'ready', 'preview', 'waiting')",
        pg_args!(session_uuid),
    ).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    info!(session = %session_id, "execution stopped by user");

    Ok(Json(json!({"status": "cancelled", "session_id": session_id})))
}

/// GET /api/execute/:session_id — get session status and nodes.
pub async fn execution_get(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| StatusCode::BAD_REQUEST)?;

    let sql = format!(
        r#"
        SELECT id, status, request_text, plan, plan_approved_at, created_at, completed_at
        FROM execution_sessions WHERE id = '{session_uuid}'
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
               computed_tier, tier_override, breakpoint,
               workflow_id, workflow_step_id, client_id,
               depth, spawn_context, acceptance_criteria,
               artifacts, step_index,
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

/// GET /api/execute/:session_id/nodes/:node_id/thinking — thinking blocks for a node.
pub async fn execution_node_thinking(
    State(state): State<Arc<AppState>>,
    Path((session_id, node_id)): Path<(String, String)>,
) -> Result<Json<Value>, StatusCode> {
    let node_uuid = node_id.parse::<Uuid>().map_err(|_| StatusCode::BAD_REQUEST)?;
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| StatusCode::BAD_REQUEST)?;

    let sql = format!(
        r#"
        SELECT id, node_id, iteration, thinking_text, token_count, created_at
        FROM thinking_blocks
        WHERE session_id = '{session_uuid}' AND node_id = '{node_uuid}'
        ORDER BY iteration ASC, created_at ASC
        "#
    );

    let blocks = state.db.execute(&sql).await.unwrap_or_default();
    Ok(Json(json!({ "thinking_blocks": blocks })))
}

/// GET /api/execute/:session_id/nodes/:node_id/stream — unified chronological stream
/// combining execution events, thinking blocks, and conversation messages.
pub async fn execution_node_stream(
    State(state): State<Arc<AppState>>,
    Path((session_id, node_id)): Path<(String, String)>,
) -> Result<Json<Value>, StatusCode> {
    let node_uuid = node_id.parse::<Uuid>().map_err(|_| StatusCode::BAD_REQUEST)?;
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| StatusCode::BAD_REQUEST)?;

    let sql = format!(
        r#"
        SELECT id, node_id, 'event' AS stream_type, event_type AS sub_type,
               payload::text AS content, NULL::text AS thinking_text,
               NULL::int AS iteration, NULL::int AS token_count,
               NULL::text AS role, NULL::jsonb AS metadata,
               created_at
        FROM execution_events
        WHERE session_id = '{session_uuid}' AND node_id = '{node_uuid}'

        UNION ALL

        SELECT id, node_id, 'thinking' AS stream_type, 'thinking_block' AS sub_type,
               NULL AS content, thinking_text,
               iteration, token_count,
               NULL AS role, NULL AS metadata,
               created_at
        FROM thinking_blocks
        WHERE session_id = '{session_uuid}' AND node_id = '{node_uuid}'

        UNION ALL

        SELECT id, node_id, 'message' AS stream_type, role AS sub_type,
               content, NULL AS thinking_text,
               NULL AS iteration, NULL AS token_count,
               role, metadata,
               created_at
        FROM node_messages
        WHERE session_id = '{session_uuid}' AND node_id = '{node_uuid}'

        ORDER BY created_at ASC
        "#
    );

    let stream = state.db.execute(&sql).await.unwrap_or_default();
    Ok(Json(json!({ "stream": stream })))
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
            Sse::new(stream)
                .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
                .into_response()
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
    client_id: Option<Uuid>,
) -> anyhow::Result<()> {
    let customer_uuid = customer_id.and_then(|id| id.parse::<Uuid>().ok());

    db.execute_with(
        r#"INSERT INTO execution_sessions (id, customer_id, client_id, request_text, plan, status)
           VALUES ($1, $2, $3, $4, $5, 'awaiting_approval')"#,
        pg_args!(session_id, customer_uuid, client_id, request_text.to_string(), plan_json.clone()),
    ).await?;

    for node in nodes {
        let judge_config_val = serde_json::to_value(&node.judge_config)
            .unwrap_or_else(|_| serde_json::json!({}));

        let computed_tier =
            crate::tier::compute_tier(db, &node.agent_slug, &node.task_description).await;

        db.execute_with(
            r#"INSERT INTO execution_nodes
              (id, session_id, agent_slug, agent_git_sha, task_description, status,
               requires, attempt_count, judge_config, max_iterations, model, skip_judge,
               computed_tier, client_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10, $11, $12, $13)"#,
            pg_args!(
                node.uid, session_id, node.agent_slug.clone(), node.agent_git_sha.clone(),
                node.task_description.clone(), node.status.as_str().to_string(),
                &node.requires as &[Uuid], judge_config_val,
                node.max_iterations as i32, node.model.clone(), node.skip_judge,
                computed_tier, node.client_id
            ),
        ).await?;
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
            Sse::new(stream)
                .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
                .into_response()
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

    // Look up expert_id from the observation session
    let expert_id_for_extraction = {
        let rows = state.db.execute(&format!(
            "SELECT expert_id FROM observation_sessions WHERE id = '{}'", session_id
        )).await.unwrap_or_default();
        rows.first()
            .and_then(|r| r.get("expert_id").and_then(serde_json::Value::as_str))
            .and_then(|s| s.parse::<Uuid>().ok())
    };

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
                expert_id_for_extraction,
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

    let events_sql = format!(
        "SELECT id, event_type, url, domain, dom_context, created_at FROM action_events WHERE session_id = '{session_id}' ORDER BY sequence_number LIMIT 100"
    );
    let events = state.db.execute(&events_sql).await.unwrap_or_default();

    let tasks_sql = format!(
        "SELECT id, description, matched_agent_slug, match_confidence, status FROM abstracted_tasks WHERE session_id = '{session_id}' ORDER BY match_confidence DESC NULLS LAST"
    );
    let tasks = state.db.execute(&tasks_sql).await.unwrap_or_default();

    let prs_sql = format!(
        "SELECT id, pr_type, target_agent_slug, gap_summary, confidence, status FROM agent_prs WHERE evidence_session_ids @> ARRAY['{session_id}'::uuid] ORDER BY created_at DESC"
    );
    let prs = state.db.execute(&prs_sql).await.unwrap_or_default();

    Ok(Json(json!({
        "session": session,
        "distillations": distillations,
        "events": events,
        "tasks": tasks,
        "prs": prs,
    })))
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

/// GET /api/agent-prs/:pr_id — get a single PR with full details plus the
/// current agent definition so the reviewer can see before/after in context.
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

    let slug = pr.get("target_agent_slug").and_then(Value::as_str)
        .or_else(|| pr.get("proposed_slug").and_then(Value::as_str));

    let current_agent = if let Some(slug) = slug {
        state.catalog.get(slug).map(|agent| {
            let tool_details: Vec<Value> = agent.tools.iter().map(|t| {
                let cred = crate::tools::tool_credential(t);
                let display = cred.as_deref().map(integration_display_name).unwrap_or_default();
                json!({ "name": t, "credential": cred, "display_name": display, "icon": cred.as_deref().unwrap_or("generic") })
            }).collect();
            let examples: Vec<Value> = agent.examples.iter().enumerate().map(|(i, ex)| {
                json!({ "index": i, "input": ex.input, "output": ex.output })
            }).collect();
            let knowledge_docs: Vec<Value> = agent.knowledge_docs.iter().enumerate().map(|(i, doc)| {
                let preview = doc.chars().take(200).collect::<String>();
                json!({ "index": i, "preview": preview, "full": doc, "char_count": doc.len() })
            }).collect();
            json!({
                "slug": agent.slug,
                "name": agent.name,
                "category": agent.category,
                "description": agent.description,
                "intents": agent.intents,
                "tools": tool_details,
                "required_integrations": agent.required_integrations,
                "judge_config": agent.judge_config,
                "max_iterations": agent.max_iterations,
                "model": agent.model,
                "skip_judge": agent.skip_judge,
                "flexible_tool_use": agent.flexible_tool_use,
                "system_prompt": agent.system_prompt,
                "examples": examples,
                "knowledge_docs": knowledge_docs,
                "input_schema": agent.input_schema,
                "output_schema": agent.output_schema,
                "version": agent.version,
            })
        })
    } else {
        None
    };

    let mut result = pr.clone();
    if let Value::Object(ref mut map) = result {
        map.insert("current_agent".to_string(), current_agent.unwrap_or(Value::Null));
    }

    Ok(Json(result))
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

    // Validate read-only: check first keyword AND reject DML keywords anywhere
    // in the query (WITH clauses can contain INSERT/UPDATE/DELETE).
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

    let upper = trimmed.to_uppercase();
    let dml_keywords = ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE", "CREATE", "GRANT", "REVOKE", "COPY"];
    for keyword in &dml_keywords {
        // Check for keyword as a whole word (preceded by whitespace or start-of-string)
        if upper.split_whitespace().any(|w| w == *keyword) {
            return Err((
                StatusCode::FORBIDDEN,
                Json(json!({"error": format!("Query contains forbidden keyword: {keyword}")})),
            ));
        }
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

        if let Err(e) = crate::extraction::run_extraction(&db, &catalog, &api_key, &model, &sid, None).await {
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

// ── Experts ───────────────────────────────────────────────────────────────────

/// GET /api/experts
pub async fn experts_list(State(state): State<Arc<AppState>>) -> Json<Value> {
    let rows = state.db.execute("SELECT * FROM experts ORDER BY name").await.unwrap_or_default();
    Json(json!({"experts": rows}))
}

#[derive(Deserialize)]
pub struct CreateExpertRequest {
    pub slug: String,
    pub name: String,
    pub identity: Option<String>,
    pub voice: Option<String>,
    pub methodology: Option<String>,
}

/// POST /api/experts
pub async fn expert_create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateExpertRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let id = Uuid::new_v4();
    let slug = body.slug.replace('\'', "''");
    let name = body.name.replace('\'', "''");
    let identity = body.identity.as_deref()
        .map(|s| format!("'{}'", s.replace('\'', "''")))
        .unwrap_or_else(|| "NULL".to_string());
    let voice = body.voice.as_deref()
        .map(|s| format!("'{}'", s.replace('\'', "''")))
        .unwrap_or_else(|| "NULL".to_string());
    let methodology = body.methodology.as_deref()
        .map(|s| format!("'{}'", s.replace('\'', "''")))
        .unwrap_or_else(|| "NULL".to_string());

    let sql = format!(
        "INSERT INTO experts (id, slug, name, identity, voice, methodology) VALUES ('{id}', '{slug}', '{name}', {identity}, {voice}, {methodology})"
    );
    state.db.execute(&sql).await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({"expert_id": id.to_string()})))
}

/// GET /api/experts/:slug
pub async fn expert_get(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    let slug_escaped = slug.replace('\'', "''");
    let rows = state.db.execute(&format!(
        "SELECT * FROM experts WHERE slug = '{slug_escaped}'"
    )).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let expert = rows.into_iter().next().ok_or(StatusCode::NOT_FOUND)?;

    let expert_id = expert.get("id").and_then(Value::as_str).unwrap_or("");
    let agents = state.db.execute(&format!(
        "SELECT slug, name, category, description FROM agent_definitions WHERE expert_id = '{expert_id}' ORDER BY slug"
    )).await.unwrap_or_default();

    let engagements = state.db.execute(&format!(
        "SELECT e.*, c.name as client_name FROM engagements e JOIN clients c ON e.client_id = c.id WHERE e.expert_id = '{expert_id}' ORDER BY e.created_at DESC"
    )).await.unwrap_or_default();

    Ok(Json(json!({
        "expert": expert,
        "agents": agents,
        "engagements": engagements,
    })))
}

// ── Engagements ──────────────────────────────────────────────────────────────

/// GET /api/engagements
pub async fn engagements_list(State(state): State<Arc<AppState>>) -> Json<Value> {
    let rows = state.db.execute(
        "SELECT e.*, ex.name as expert_name, c.name as client_name FROM engagements e JOIN experts ex ON e.expert_id = ex.id JOIN clients c ON e.client_id = c.id ORDER BY e.created_at DESC"
    ).await.unwrap_or_default();
    Json(json!({"engagements": rows}))
}

#[derive(Deserialize)]
pub struct CreateEngagementRequest {
    pub slug: String,
    pub name: String,
    pub expert_slug: String,
    pub client_slug: String,
    pub scope: Option<String>,
}

/// POST /api/engagements
pub async fn engagement_create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateEngagementRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let expert_slug = body.expert_slug.replace('\'', "''");
    let client_slug = body.client_slug.replace('\'', "''");

    let expert_rows = state.db.execute(&format!(
        "SELECT id FROM experts WHERE slug = '{expert_slug}'"
    )).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;
    let expert_id = expert_rows.first()
        .and_then(|r| r.get("id").and_then(Value::as_str))
        .ok_or_else(|| (StatusCode::NOT_FOUND, Json(json!({"error": "Expert not found"}))))?;

    let client_rows = state.db.execute(&format!(
        "SELECT id FROM clients WHERE slug = '{client_slug}'"
    )).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;
    let client_id = client_rows.first()
        .and_then(|r| r.get("id").and_then(Value::as_str))
        .ok_or_else(|| (StatusCode::NOT_FOUND, Json(json!({"error": "Client not found"}))))?;

    let id = Uuid::new_v4();
    let slug = body.slug.replace('\'', "''");
    let name = body.name.replace('\'', "''");
    let scope = body.scope.as_deref()
        .map(|s| format!("'{}'", s.replace('\'', "''")))
        .unwrap_or_else(|| "NULL".to_string());

    let sql = format!(
        "INSERT INTO engagements (id, slug, name, expert_id, client_id, scope) VALUES ('{id}', '{slug}', '{name}', '{expert_id}', '{client_id}', {scope})"
    );
    state.db.execute(&sql).await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({"engagement_id": id.to_string()})))
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
    pub model: Option<String>,
    pub max_iterations: Option<u32>,
    pub skip_judge: Option<bool>,
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
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid session ID"})))
    })?;

    use sqlx::Arguments as _;
    let mut set_clauses = Vec::new();
    let mut args = sqlx::postgres::PgArguments::default();
    let mut idx = 1u32;

    if let Some(slug) = &body.agent_slug {
        set_clauses.push(format!("agent_slug = ${idx}"));
        args.add(slug.clone()).expect("encode");
        idx += 1;
    }
    if let Some(desc) = &body.task_description {
        set_clauses.push(format!("task_description = ${idx}"));
        args.add(desc.clone()).expect("encode");
        idx += 1;
    }
    if let Some(tier) = &body.tier_override {
        set_clauses.push(format!("tier_override = ${idx}"));
        args.add(tier.clone()).expect("encode");
        idx += 1;
    }
    if let Some(bp) = body.breakpoint {
        set_clauses.push(format!("breakpoint = ${idx}"));
        args.add(bp).expect("encode");
        idx += 1;
    }
    if let Some(model) = &body.model {
        set_clauses.push(format!("model = ${idx}"));
        args.add(model.clone()).expect("encode");
        idx += 1;
    }
    if let Some(mi) = body.max_iterations {
        set_clauses.push(format!("max_iterations = ${idx}"));
        args.add(mi as i32).expect("encode");
        idx += 1;
    }
    if let Some(sj) = body.skip_judge {
        set_clauses.push(format!("skip_judge = ${idx}"));
        args.add(sj).expect("encode");
        idx += 1;
    }

    if set_clauses.is_empty() {
        return Ok(Json(json!({"ok": true, "updated": false})));
    }

    let sql = format!(
        "UPDATE execution_nodes SET {} WHERE id = ${} AND session_id = ${} AND status IN ('pending', 'waiting', 'ready')",
        set_clauses.join(", "), idx, idx + 1
    );
    args.add(node_uuid).expect("encode");
    args.add(session_uuid).expect("encode");

    state.db.execute_with(&sql, args).await.map_err(|e| {
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
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid session ID"})))
    })?;

    // Validate agent exists in catalog
    if state.catalog.get(&body.agent_slug).is_none() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": format!("Unknown agent slug: {}", body.agent_slug)})),
        ));
    }

    let node_id = Uuid::new_v4();

    let requires: Vec<Uuid> = body.requires.unwrap_or_default()
        .iter()
        .filter_map(|u| u.parse::<Uuid>().ok())
        .collect();
    let status = if requires.is_empty() { "pending" } else { "waiting" };
    let breakpoint = body.breakpoint.unwrap_or(false);

    let agent = state.catalog.get(&body.agent_slug);
    let model = agent.as_ref().and_then(|a| a.model.as_deref()).unwrap_or("claude-haiku-4-5-20251001").to_string();
    let max_iter = agent.as_ref().map(|a| a.max_iterations).unwrap_or(15) as i32;
    let skip_judge = agent.as_ref().map(|a| a.skip_judge).unwrap_or(false);
    let judge_config_val = agent.as_ref()
        .map(|a| serde_json::to_value(&a.judge_config).unwrap_or(json!({})))
        .unwrap_or_else(|| json!({"threshold":7.0,"rubric":[],"need_to_know":[]}));

    state.db.execute_with(
        r#"INSERT INTO execution_nodes
            (id, session_id, agent_slug, agent_git_sha, task_description, status,
             requires, attempt_count, judge_config, max_iterations, model, skip_judge,
             tier_override, breakpoint)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10, $11, $12, $13)"#,
        pg_args!(
            node_id, session_uuid, body.agent_slug.clone(), "manual".to_string(),
            body.task_description.clone(), status.to_string(),
            &requires as &[Uuid], judge_config_val, max_iter, model, skip_judge,
            body.tier_override.clone(), breakpoint
        ),
    ).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    Ok(Json(json!({"node_id": node_id.to_string()})))
}

/// DELETE /api/execute/:session_id — delete an entire session and its nodes.
pub async fn execution_session_delete(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid session ID"})))
    })?;

    // Delete related data first
    let _ = state.db.execute_with("DELETE FROM thinking_blocks WHERE session_id = $1", pg_args!(session_uuid)).await;
    let _ = state.db.execute_with("DELETE FROM execution_events WHERE session_id = $1", pg_args!(session_uuid)).await;
    let _ = state.db.execute_with("DELETE FROM execution_nodes WHERE session_id = $1", pg_args!(session_uuid)).await;

    // Delete the session
    state.db.execute_with(
        "DELETE FROM execution_sessions WHERE id = $1",
        pg_args!(session_uuid),
    ).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    Ok(Json(json!({"ok": true})))
}

/// DELETE /api/execute/:session_id/nodes/:node_id — remove a node (DAG editor).
pub async fn execution_node_delete(
    State(state): State<Arc<AppState>>,
    Path((session_id, node_id)): Path<(String, String)>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let node_uuid = node_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid node ID"})))
    })?;
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid session ID"})))
    })?;

    state.db.execute_with(
        "DELETE FROM execution_nodes WHERE id = $1 AND session_id = $2 AND status IN ('pending', 'waiting', 'ready')",
        pg_args!(node_uuid, session_uuid),
    ).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    Ok(Json(json!({"ok": true})))
}

/// POST /api/execute/:session_id/nodes/:node_id/release — release a breakpoint node.
pub async fn execution_node_release(
    State(state): State<Arc<AppState>>,
    Path((session_id, node_id)): Path<(String, String)>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let node_uuid = node_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid node ID"})))
    })?;
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid session ID"})))
    })?;

    state.db.execute_with(
        "UPDATE execution_nodes SET breakpoint = false WHERE id = $1 AND session_id = $2 AND status IN ('ready', 'waiting', 'pending')",
        pg_args!(node_uuid, session_uuid),
    ).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    Ok(Json(json!({"ok": true, "released": true})))
}

// ── Node Conversation Routes ─────────────────────────────────────────────────

/// GET /api/execute/:session_id/nodes/:node_id/messages — fetch conversation messages for a node.
pub async fn execution_node_messages(
    State(state): State<Arc<AppState>>,
    Path((session_id, node_id)): Path<(String, String)>,
) -> Result<Json<Value>, StatusCode> {
    let node_uuid = node_id.parse::<Uuid>().map_err(|_| StatusCode::BAD_REQUEST)?;
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| StatusCode::BAD_REQUEST)?;

    let sql = format!(
        r#"
        SELECT id, node_id, role, content, metadata, created_at
        FROM node_messages
        WHERE session_id = '{session_uuid}' AND node_id = '{node_uuid}'
        ORDER BY created_at ASC
        "#
    );

    let messages = state.db.execute(&sql).await.unwrap_or_default();
    Ok(Json(json!({ "messages": messages })))
}

#[derive(Deserialize)]
pub struct NodeReplyRequest {
    pub message: String,
}

/// POST /api/execute/:session_id/nodes/:node_id/reply — send a user reply to a node's conversation.
pub async fn execution_node_reply(
    State(state): State<Arc<AppState>>,
    Path((session_id, node_id)): Path<(String, String)>,
    Json(body): Json<NodeReplyRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let node_uuid = node_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid node ID"})))
    })?;
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid session ID"})))
    })?;

    // Mark node as running
    state.db.execute_with(
        "UPDATE execution_nodes SET status = 'running' WHERE id = $1 AND session_id = $2",
        pg_args!(node_uuid, session_uuid),
    ).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    // Broadcast status change
    state.event_bus.send(
        &session_id,
        serde_json::json!({
            "type": "node_resumed",
            "node_uid": node_id,
        }),
    ).await;

    // Spawn async task to run the reply conversation
    let runner = crate::agent_runner::AgentRunner::new(
        state.settings.clone(),
        state.db.clone(),
        state.catalog.clone(),
        state.skill_catalog.clone(),
        state.event_bus.clone(),
    );
    let sid = session_id.clone();
    let nid = node_id.clone();
    let reply_text = body.message.clone();

    tokio::spawn(async move {
        let result = runner.resume_with_reply(&sid, &nid, &reply_text).await;

        // Persist result
        let status = result.status.as_str().to_string();
        let _ = runner.db().execute_with(
            r#"UPDATE execution_nodes
               SET status = $1, output = COALESCE($2, output), completed_at = CASE WHEN $1 NOT IN ('running', 'awaiting_reply') THEN NOW() ELSE completed_at END
               WHERE id = $3 AND session_id = $4"#,
            crate::pg_args!(status.clone(), result.output.clone(), node_uuid, session_uuid),
        ).await;

        // Broadcast completion
        runner.event_bus().send(
            &sid,
            serde_json::json!({
                "type": if result.status.is_terminal() { "node_completed" } else { "node_awaiting_reply" },
                "node_uid": nid,
                "status": status,
            }),
        ).await;
    });

    Ok(Json(json!({
        "ok": true,
        "status": "running",
        "message": "Reply sent, agent is processing...",
    })))
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

// ── Credentials ─────────────────────────────────────────────────────────────

/// GET /api/clients/:slug/credentials
pub async fn client_credentials_list(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    let client = client_mod::get_client(&state.db, &slug)
        .await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let client_id: uuid::Uuid = client.get("id").and_then(Value::as_str)
        .and_then(|s| s.parse().ok()).ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;

    let creds = crate::credentials::list_credentials(&state.db, client_id)
        .await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(json!({"credentials": creds})))
}

#[derive(Deserialize)]
pub struct SetCredentialRequest {
    pub integration_slug: String,
    pub credential_type: Option<String>,
    pub value: String,
    pub metadata: Option<Value>,
}

enum ValidationResult {
    Validated,
    Skipped,
    Failed(String),
}

/// Validate an API key by making a lightweight read-only call to the service.
/// Delegates to the shared preflight probe registry.
async fn validate_credential(slug: &str, value: &str) -> ValidationResult {
    use crate::credentials::DecryptedCredential;
    use crate::preflight;

    let cred = DecryptedCredential {
        credential_type: "api_key".into(),
        value: value.to_string(),
        metadata: json!({}),
    };

    match preflight::probe_one(slug, &cred, None).await {
        Some(result) => {
            if result.success() {
                ValidationResult::Validated
            } else {
                let msg = if result.error.is_empty() {
                    format!("{slug} probe failed")
                } else {
                    result.error
                };
                ValidationResult::Failed(msg)
            }
        }
        None => ValidationResult::Skipped,
    }
}

/// POST /api/clients/:slug/credentials
pub async fn client_credential_set(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Json(body): Json<SetCredentialRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let client = client_mod::get_client(&state.db, &slug)
        .await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, Json(json!({"error": "Client not found"}))))?;

    let client_id: uuid::Uuid = client.get("id").and_then(Value::as_str)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "Bad client id"}))))?;

    let validation = validate_credential(&body.integration_slug, &body.value).await;
    if let ValidationResult::Failed(ref msg) = validation {
        return Err((StatusCode::UNPROCESSABLE_ENTITY, Json(json!({
            "error": msg,
            "validated": false,
        }))));
    }

    let validated = matches!(validation, ValidationResult::Validated);

    let master_key = state.settings.credential_master_key.as_deref()
        .ok_or_else(|| (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "Credential encryption not configured (CREDENTIAL_MASTER_KEY missing)"}))))?;

    let encrypted = crate::credentials::encrypt(master_key, &body.value)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("Encryption failed: {e}")}))))?;

    let cred_type = body.credential_type.as_deref().unwrap_or("api_key");
    crate::credentials::upsert_credential(&state.db, client_id, &body.integration_slug, cred_type, &encrypted, body.metadata.as_ref())
        .await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({"ok": true, "integration_slug": body.integration_slug, "validated": validated})))
}

/// DELETE /api/clients/:slug/credentials/:integration_slug
pub async fn client_credential_delete(
    State(state): State<Arc<AppState>>,
    Path((slug, integration_slug)): Path<(String, String)>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let client = client_mod::get_client(&state.db, &slug)
        .await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, Json(json!({"error": "Client not found"}))))?;

    let client_id: uuid::Uuid = client.get("id").and_then(Value::as_str)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "Bad client id"}))))?;

    crate::credentials::delete_credential(&state.db, client_id, &integration_slug)
        .await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({"ok": true})))
}

// ── OAuth ───────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct OAuthAuthorizeParams {
    pub client_slug: String,
    pub redirect: Option<String>,
}

/// GET /api/oauth/:provider/authorize?client_slug=xxx&redirect=xxx
pub async fn oauth_authorize(
    State(state): State<Arc<AppState>>,
    Path(provider): Path<String>,
    axum::extract::Query(params): axum::extract::Query<OAuthAuthorizeParams>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let client = client_mod::get_client(&state.db, &params.client_slug)
        .await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, Json(json!({"error": "Client not found"}))))?;

    let client_id: uuid::Uuid = client.get("id").and_then(Value::as_str)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "Bad client id"}))))?;

    let redirect = params.redirect.as_deref().unwrap_or("/settings/integrations");
    let url = crate::oauth::start_authorize(&state.db, &state.settings, &provider, client_id, redirect)
        .await.map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({"authorize_url": url})))
}

#[derive(Deserialize)]
pub struct OAuthCallbackParams {
    pub code: String,
    pub state: String,
}

/// GET /api/oauth/:provider/callback?code=xxx&state=xxx
pub async fn oauth_callback(
    State(state): State<Arc<AppState>>,
    Path(provider): Path<String>,
    axum::extract::Query(params): axum::extract::Query<OAuthCallbackParams>,
) -> impl IntoResponse {
    match crate::oauth::handle_callback(&state.db, &state.settings, &provider, &params.code, &params.state).await {
        Ok(redirect_url) => axum::response::Redirect::to(&redirect_url).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({"error": format!("{e}")}))).into_response(),
    }
}

// ── Auth ────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct GoogleAuthRequest {
    pub id_token: String,
}

/// POST /api/auth/google
pub async fn auth_google(
    State(state): State<Arc<AppState>>,
    Json(body): Json<GoogleAuthRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let jwt_secret = state.settings.jwt_secret.as_deref()
        .ok_or_else(|| (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "JWT_SECRET not configured"}))))?;

    let (token, user) = crate::auth::google_sign_in(&state.db, jwt_secret, &body.id_token)
        .await.map_err(|e| (StatusCode::UNAUTHORIZED, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({
        "token": token,
        "user": {
            "id": user.user_id.to_string(),
            "email": user.email,
            "name": user.name,
        }
    })))
}

/// GET /api/auth/me
pub async fn auth_me(
    State(state): State<Arc<AppState>>,
    request: axum::extract::Request,
) -> Result<Json<Value>, StatusCode> {
    let user = request.extensions().get::<crate::auth::AuthenticatedUser>()
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let sql = format!(
        "SELECT u.id, u.email, u.name, u.avatar_url FROM users u WHERE u.id = '{}'", user.user_id
    );
    let rows = state.db.execute(&sql).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let user_data = rows.first().cloned().unwrap_or(json!({}));

    let roles_sql = format!(
        "SELECT c.slug, c.name, ucr.role FROM user_client_roles ucr JOIN clients c ON ucr.client_id = c.id WHERE ucr.user_id = '{}'",
        user.user_id
    );
    let clients = state.db.execute(&roles_sql).await.unwrap_or_default();

    Ok(Json(json!({"user": user_data, "clients": clients})))
}

// ── Workspace creation (authenticated) ───────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateWorkspaceRequest {
    pub slug: String,
    pub name: String,
    pub brief: Option<String>,
    pub industry: Option<String>,
}

/// POST /api/auth/workspaces — create a workspace and link the authenticated user as admin.
pub async fn auth_create_workspace(
    State(state): State<Arc<AppState>>,
    request: axum::extract::Request,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let user = request.extensions().get::<crate::auth::AuthenticatedUser>()
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, Json(json!({"error": "Not authenticated"}))))?
        .clone();

    let body: CreateWorkspaceRequest = {
        let bytes = axum::body::to_bytes(request.into_body(), 1024 * 64)
            .await
            .map_err(|_| (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid body"}))))?;
        serde_json::from_slice(&bytes)
            .map_err(|_| (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid JSON"}))))?
    };

    let client_id = client_mod::create_client(
        &state.db, &body.slug, &body.name, body.brief.as_deref(), body.industry.as_deref(), None,
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    let role_sql = format!(
        "INSERT INTO user_client_roles (user_id, client_id, role) VALUES ('{}', '{}', 'admin') ON CONFLICT DO NOTHING",
        user.user_id, client_id
    );
    state.db.execute(&role_sql).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    info!(user = %user.email, client = %body.slug, "workspace created and linked");

    Ok(Json(json!({
        "client_id": client_id.to_string(),
        "slug": body.slug,
        "name": body.name,
        "role": "admin",
    })))
}

// ── Credential check ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CredentialCheckQuery {
    pub agents: Option<String>, // comma-separated agent slugs
    pub verify: Option<bool>,   // if true, run live API probes
}

// ── Integration Registry ─────────────────────────────────────────────────────

fn integration_metadata() -> Vec<Value> {
    vec![
        json!({"slug": "tavily",     "name": "Tavily",      "auth_type": "api_key", "icon": "tavily",     "description": "Web search API for research agents",
               "key_url": "https://app.tavily.com/home",    "key_help": "Copy your API key from the Tavily dashboard"}),
        json!({"slug": "apollo",     "name": "Apollo",      "auth_type": "oauth2",  "icon": "apollo",     "description": "Contact & company enrichment for prospecting",
               "key_url": "https://developer.apollo.io/keys/", "key_help": "Create an API key in the Apollo developer portal"}),
        json!({"slug": "clay",       "name": "Clay",        "auth_type": "api_key", "icon": "clay",       "description": "Data enrichment and social listening",
               "key_url": "https://app.clay.com/settings",   "key_help": "Find your API key under Settings → API Keys"}),
        json!({"slug": "n8n",        "name": "n8n",         "auth_type": "api_key", "icon": "n8n",        "description": "Workflow automation",                 "extra_fields": ["base_url"],
               "key_help": "In your n8n instance go to Settings → n8n API → Create API key"}),
        json!({"slug": "tolt",       "name": "Tolt",        "auth_type": "api_key", "icon": "tolt",       "description": "Referral and affiliate tracking",
               "key_url": "https://app.tolt.io/settings?tab=integrations", "key_help": "Copy your API key from Settings → Integrations"}),
        json!({"slug": "supabase",   "name": "Supabase",    "auth_type": "api_key", "icon": "supabase",   "description": "Database and storage",                "extra_fields": ["project_url"],
               "key_url": "https://supabase.com/dashboard/projects", "key_help": "Select your project → Settings → API Keys"}),
        json!({"slug": "notion",     "name": "Notion",      "auth_type": "oauth2",  "icon": "notion",     "description": "Knowledge base and documentation",
               "key_url": "https://www.notion.so/profile/integrations", "key_help": "Create an internal integration to get a token",
               "setup_steps": [
                   {"label": "Share a page with the integration", "help": "Open a Notion page → click Share → invite your integration by name. The agent can only access pages explicitly shared with it.", "doc_url": "https://developers.notion.com/docs/authorization#sharing-pages-with-integrations", "required": true}
               ]}),
        json!({"slug": "hubspot",    "name": "HubSpot",     "auth_type": "oauth2",  "icon": "hubspot",    "description": "CRM — contacts, deals, and pipeline",
               "key_url": "https://app.hubspot.com/private-apps/", "key_help": "Create a Private App under Settings → Integrations",
               "setup_steps": [
                   {"label": "Enable required scopes", "help": "Your Private App needs scopes for the objects you want to manage (contacts, deals, companies). Edit the app → Scopes → enable the CRM scopes you need.", "required": true}
               ]}),
        json!({"slug": "google",     "name": "Google",      "auth_type": "oauth2",  "icon": "google",     "description": "Google Ads, Sheets, and other Google APIs"}),
        json!({"slug": "meta",       "name": "Meta Ads",    "auth_type": "oauth2",  "icon": "meta",       "description": "Meta/Facebook advertising platform"}),
        json!({"slug": "slack",      "name": "Slack",       "auth_type": "oauth2",  "icon": "slack",      "description": "Team messaging and notifications"}),
    ]
}

fn integration_display_name(slug: &str) -> String {
    integration_metadata()
        .iter()
        .find(|m| m.get("slug").and_then(Value::as_str) == Some(slug))
        .and_then(|m| m.get("name").and_then(Value::as_str))
        .unwrap_or(slug)
        .to_string()
}

fn integration_setup_steps(slug: &str) -> Option<Value> {
    integration_metadata()
        .into_iter()
        .find(|m| m.get("slug").and_then(Value::as_str) == Some(slug))
        .and_then(|m| m.get("setup_steps").cloned())
        .filter(|v| v.as_array().map_or(false, |a| !a.is_empty()))
}

/// GET /api/integrations — list all known integrations with metadata.
pub async fn integrations_list(
    State(state): State<Arc<AppState>>,
) -> Json<Value> {
    let mut list = integration_metadata();
    for item in &mut list {
        if item.get("auth_type").and_then(Value::as_str) == Some("oauth2") {
            let slug = item.get("slug").and_then(Value::as_str).unwrap_or("");
            let configured = crate::oauth::get_provider_config(&state.settings, slug).is_some();
            item.as_object_mut().unwrap().insert("oauth_configured".to_string(), json!(configured));
        }
    }
    Json(json!({"integrations": list}))
}

/// GET /api/clients/:slug/credential-check?agents=notion_operator,clay_operator
/// Returns credential status for each agent: which integrations are required and which are missing.
pub async fn client_credential_check(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    axum::extract::Query(query): axum::extract::Query<CredentialCheckQuery>,
) -> Result<Json<Value>, StatusCode> {
    let client = client_mod::get_client(&state.db, &slug)
        .await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let client_id: Uuid = client.get("id").and_then(Value::as_str)
        .and_then(|s| s.parse().ok()).ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;

    // Get connected integration slugs for this client
    let creds = crate::credentials::list_credentials(&state.db, client_id)
        .await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let connected: Vec<String> = creds.iter()
        .filter_map(|c| c.get("integration_slug").and_then(Value::as_str).map(String::from))
        .collect();

    // Check global fallbacks
    let has_global_tavily = state.settings.tavily_api_key.is_some();
    let has_global_n8n = state.settings.n8n_api_key.is_some();

    let agent_slugs: Vec<&str> = query.agents.as_deref()
        .unwrap_or("")
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();

    let mut agents_status = json!({});

    for agent_slug in &agent_slugs {
        let agent = match state.catalog.get(agent_slug) {
            Some(a) => a,
            None => continue,
        };

        // Collect all required integrations:
        // 1. From agent's required_integrations (for http_request context)
        // 2. From each tool's required_credential
        let mut all_required: Vec<String> = agent.required_integrations.clone();
        for tool_name in &agent.tools {
            if let Some(cred) = crate::tools::tool_credential(tool_name) {
                if !all_required.contains(&cred) {
                    all_required.push(cred);
                }
            }
        }

        // Determine which are missing
        let missing: Vec<String> = all_required.iter()
            .filter(|req| {
                if *req == "tavily" && has_global_tavily { return false; }
                if *req == "n8n" && has_global_n8n { return false; }
                !connected.contains(req)
            })
            .cloned()
            .collect();

        let tool_details: Vec<Value> = agent.tools.iter().map(|t| {
            let cred = crate::tools::tool_credential(t);
            let cred_status = match &cred {
                Some(c) => {
                    if connected.contains(c) || (c == "tavily" && has_global_tavily) || (c == "n8n" && has_global_n8n) {
                        "connected"
                    } else {
                        "missing"
                    }
                }
                None => "not_required",
            };
            let display = cred.as_deref().map(integration_display_name).unwrap_or_default();
            let icon = cred.as_deref().unwrap_or("generic");
            json!({
                "name": t,
                "credential": cred,
                "credential_status": cred_status,
                "display_name": display,
                "icon": icon,
            })
        }).collect();

        let status = if all_required.is_empty() {
            "no_tools"
        } else if missing.is_empty() {
            "ready"
        } else {
            "blocked"
        };

        let integration_details: Vec<Value> = all_required.iter().map(|slug| {
            let is_missing = missing.contains(slug);
            let mut detail = json!({
                "slug": slug,
                "display_name": integration_display_name(slug),
                "icon": slug,
                "status": if is_missing { "missing" } else { "connected" },
            });
            if let Some(steps) = integration_setup_steps(slug) {
                detail.as_object_mut().unwrap().insert("setup_steps".to_string(), steps);
            }
            detail
        }).collect();

        agents_status[*agent_slug] = json!({
            "tools": tool_details,
            "required_integrations": all_required,
            "integration_details": integration_details,
            "missing": missing,
            "status": status,
        });
    }

    // Live probe verification when ?verify=true
    let mut probe_results_json = json!({});
    if query.verify.unwrap_or(false) {
        if let Some(ref master_key) = state.settings.credential_master_key {
            let all_credentials = crate::credentials::load_credentials_for_client(
                &state.db, master_key, client_id,
            ).await.unwrap_or_default();

            // Collect union of all required integrations from the agents
            let mut all_required: Vec<String> = Vec::new();
            for agent_slug in &agent_slugs {
                if let Some(agent) = state.catalog.get(agent_slug) {
                    for s in crate::preflight::required_slugs_for_agent(&agent.required_integrations, &agent.tools) {
                        if !all_required.contains(&s) {
                            all_required.push(s);
                        }
                    }
                }
            }

            // When no agents specified, probe ALL connected integrations
            let needed = if all_required.is_empty() {
                all_credentials.clone()
            } else {
                crate::preflight::filter_required_credentials(
                    &all_credentials, &all_required, &state.settings,
                )
            };
            let probes = crate::preflight::probe_integrations(&needed, Some(&state.settings)).await;

            for p in &probes {
                probe_results_json[&p.integration_slug] = json!({
                    "status": p.status.as_str(),
                    "ok": p.success(),
                    "http_status": p.http_status,
                    "error": if p.error.is_empty() { None } else { Some(&p.error) },
                    "hint": if p.hint.is_empty() { None } else { Some(&p.hint) },
                    "latency_ms": p.latency_ms,
                });
            }
            // Mark integrations that have no credential at all
            for slug in &all_required {
                if probe_results_json.get(slug).is_none() {
                    if needed.contains_key(slug.as_str()) {
                        probe_results_json[slug] = json!({ "status": "skipped", "ok": false });
                    } else {
                        probe_results_json[slug] = json!({
                            "status": "missing",
                            "ok": false,
                            "error": format!("No credentials configured for {slug}"),
                            "hint": format!("Add {slug} credentials in Settings > Integrations."),
                        });
                    }
                }
            }
        }
    }

    Ok(Json(json!({
        "agents": agents_status,
        "connected": connected,
        "probe_results": probe_results_json,
    })))
}


// ── Lesson / Overlay Routes ─────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct RecordLessonRequest {
    pub session_id: String,
    pub node_id: String,
    pub feedback_text: String,
    pub project_id: Option<String>,
}

/// POST /api/feedback/lesson — record a lesson from user feedback.
pub async fn feedback_record_lesson(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RecordLessonRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let session_uuid = body.session_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid session_id"})))
    })?;
    let node_uuid = body.node_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid node_id"})))
    })?;
    let project_uuid = body.project_id.as_deref()
        .and_then(|s| s.parse::<Uuid>().ok());

    let overlay_ids = crate::project_learner::record_lesson(
        &state.db,
        &state.settings.anthropic_api_key,
        &state.settings.anthropic_model,
        session_uuid,
        node_uuid,
        &body.feedback_text,
        project_uuid,
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({
        "overlay_ids": overlay_ids.iter().map(|id| id.to_string()).collect::<Vec<_>>(),
        "count": overlay_ids.len(),
    })))
}

/// GET /api/overlays — list overlays with optional filtering.
pub async fn overlays_list(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<OverlaysQuery>,
) -> Json<Value> {
    let mut clauses = vec!["1=1".to_string()];
    if let Some(ref scope) = query.scope {
        clauses.push(format!("scope = '{}'", scope.replace('\'', "''")));
    }
    if let Some(ref scope_id) = query.scope_id {
        clauses.push(format!("scope_id = '{}'", scope_id.replace('\'', "''")));
    }
    if let Some(ref ptype) = query.primitive_type {
        clauses.push(format!("primitive_type = '{}'", ptype.replace('\'', "''")));
    }

    let sql = format!(
        "SELECT * FROM overlays WHERE {} ORDER BY created_at DESC LIMIT 100",
        clauses.join(" AND ")
    );
    let rows = state.db.execute(&sql).await.unwrap_or_default();
    Json(json!({"overlays": rows}))
}

#[derive(Deserialize)]
pub struct OverlaysQuery {
    pub scope: Option<String>,
    pub scope_id: Option<String>,
    pub primitive_type: Option<String>,
}

/// POST /api/overlays/promote — trigger a manual promotion scan.
pub async fn overlays_promote(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let count = crate::pattern_promoter::run_promotion_scan(
        &state.db,
        &state.settings.anthropic_api_key,
        &state.settings.anthropic_model,
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({"promoted": count})))
}

// ── Projects Routes ─────────────────────────────────────────────────────────

/// GET /api/projects — list projects.
pub async fn projects_list(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<ProjectsQuery>,
) -> Json<Value> {
    let mut clauses = vec!["1=1".to_string()];
    if let Some(ref client_id) = query.client_id {
        clauses.push(format!("p.client_id = '{}'", client_id.replace('\'', "''")));
    }
    if let Some(ref client_slug) = query.client_slug {
        let slug_esc = client_slug.replace('\'', "''");
        clauses.push(format!("c.slug = '{slug_esc}'"));
    }

    let sql = format!(
        "SELECT p.*, c.name as client_name FROM projects p \
         JOIN clients c ON p.client_id = c.id \
         WHERE {} ORDER BY p.created_at DESC LIMIT 100",
        clauses.join(" AND ")
    );
    let rows = state.db.execute(&sql).await.unwrap_or_default();
    Json(json!({"projects": rows}))
}

#[derive(Deserialize)]
pub struct ProjectsQuery {
    pub client_id: Option<String>,
    pub client_slug: Option<String>,
}

#[derive(Deserialize)]
pub struct CreateProjectRequest {
    pub slug: String,
    pub name: String,
    pub client_slug: String,
    pub expert_slug: Option<String>,
    pub description: Option<String>,
}

/// POST /api/projects — create a project.
pub async fn project_create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateProjectRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let client_slug_escaped = body.client_slug.replace('\'', "''");
    let client_rows = state.db.execute(&format!(
        "SELECT id FROM clients WHERE slug = '{client_slug_escaped}'"
    )).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;
    let client_id = client_rows.first()
        .and_then(|r| r.get("id").and_then(Value::as_str))
        .ok_or_else(|| (StatusCode::NOT_FOUND, Json(json!({"error": "Client not found"}))))?;

    let expert_id_val = if let Some(ref es) = body.expert_slug {
        let es_escaped = es.replace('\'', "''");
        let rows = state.db.execute(&format!(
            "SELECT id FROM experts WHERE slug = '{es_escaped}'"
        )).await.unwrap_or_default();
        rows.first()
            .and_then(|r| r.get("id").and_then(Value::as_str))
            .map(|id| format!("'{}'", id))
            .unwrap_or_else(|| "NULL".to_string())
    } else {
        "NULL".to_string()
    };

    let id = Uuid::new_v4();
    let slug_escaped = body.slug.replace('\'', "''");
    let name_escaped = body.name.replace('\'', "''");
    let desc_val = body.description.as_deref()
        .map(|d| format!("'{}'", d.replace('\'', "''")))
        .unwrap_or_else(|| "NULL".to_string());

    let sql = format!(
        "INSERT INTO projects (id, slug, name, client_id, expert_id, description)          VALUES ('{id}', '{slug_escaped}', '{name_escaped}', '{client_id}', {expert_id_val}, {desc_val})"
    );
    state.db.execute(&sql).await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({"project_id": id.to_string()})))
}

// ── Project Credentials Routes ──────────────────────────────────────────────

/// GET /api/projects/:project_id/credentials — list project-level overrides + inherited
pub async fn project_credentials_list(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    let pid: uuid::Uuid = project_id.parse().map_err(|_| StatusCode::BAD_REQUEST)?;

    // Get client_id for this project
    let rows = state.db.execute(&format!(
        "SELECT client_id FROM projects WHERE id = '{pid}'"
    )).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let client_id: uuid::Uuid = rows.first()
        .and_then(|r| r.get("client_id").and_then(Value::as_str))
        .and_then(|s| s.parse().ok())
        .ok_or(StatusCode::NOT_FOUND)?;

    let project_creds = crate::credentials::list_project_credentials(&state.db, pid)
        .await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let client_creds = crate::credentials::list_credentials(&state.db, client_id)
        .await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let project_slugs: Vec<String> = project_creds.iter()
        .filter_map(|c| c.get("integration_slug").and_then(Value::as_str).map(String::from))
        .collect();

    // Merge: project overrides shown as "project", client-level as "inherited"
    let mut merged: Vec<Value> = project_creds.iter().map(|c| {
        let mut entry = c.clone();
        entry.as_object_mut().unwrap().insert("scope".into(), json!("project"));
        entry
    }).collect();

    for c in &client_creds {
        let slug = c.get("integration_slug").and_then(Value::as_str).unwrap_or("");
        if !project_slugs.contains(&slug.to_string()) {
            let mut entry = c.clone();
            entry.as_object_mut().unwrap().insert("scope".into(), json!("inherited"));
            merged.push(entry);
        }
    }

    Ok(Json(json!({ "credentials": merged, "project_id": project_id, "client_id": client_id.to_string() })))
}

/// POST /api/projects/:project_id/credentials — set a project-level credential override
pub async fn project_credential_set(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let pid: uuid::Uuid = project_id.parse()
        .map_err(|_| (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid project_id"}))))?;

    let slug = body.get("integration_slug").and_then(Value::as_str)
        .ok_or_else(|| (StatusCode::BAD_REQUEST, Json(json!({"error": "integration_slug required"}))))?;
    let value = body.get("value").and_then(Value::as_str)
        .ok_or_else(|| (StatusCode::BAD_REQUEST, Json(json!({"error": "value required"}))))?;
    let cred_type = body.get("credential_type").and_then(Value::as_str).unwrap_or("api_key");

    let master_key = state.settings.credential_master_key.as_deref()
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "CREDENTIAL_MASTER_KEY not set"}))))?;

    let encrypted = crate::credentials::encrypt(master_key, value)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    // Validate by probing
    let mut validated = None;
    let cred = crate::credentials::DecryptedCredential {
        credential_type: cred_type.to_string(),
        value: value.to_string(),
        metadata: serde_json::json!({}),
    };
    if let Some(probe) = crate::preflight::probe_one(slug, &cred, Some(&state.settings)).await {
        validated = Some(probe.success());
    }

    let id = crate::credentials::upsert_project_credential(
        &state.db, pid, slug, cred_type, &encrypted, None,
    ).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({ "id": id.to_string(), "validated": validated })))
}

/// DELETE /api/projects/:project_id/credentials/:integration_slug
pub async fn project_credential_delete(
    State(state): State<Arc<AppState>>,
    Path((project_id, integration_slug)): Path<(String, String)>,
) -> Result<Json<Value>, StatusCode> {
    let pid: uuid::Uuid = project_id.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
    crate::credentials::delete_project_credential(&state.db, pid, &integration_slug)
        .await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(json!({"deleted": true})))
}

/// GET /api/projects/:project_id/credential-check?verify=true — probe project credentials
pub async fn project_credential_check(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<CredentialCheckQuery>,
) -> Result<Json<Value>, StatusCode> {
    let pid: uuid::Uuid = project_id.parse().map_err(|_| StatusCode::BAD_REQUEST)?;

    let rows = state.db.execute(&format!(
        "SELECT client_id FROM projects WHERE id = '{pid}'"
    )).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let client_id: uuid::Uuid = rows.first()
        .and_then(|r| r.get("client_id").and_then(Value::as_str))
        .and_then(|s| s.parse().ok())
        .ok_or(StatusCode::NOT_FOUND)?;

    let master_key = state.settings.credential_master_key.as_deref()
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;

    let all_credentials = crate::credentials::load_credentials_for_project(
        &state.db, master_key, pid, client_id,
    ).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let connected: Vec<String> = all_credentials.keys().cloned().collect();

    let mut probe_results_json = json!({});
    if query.verify.unwrap_or(false) {
        let probes = crate::preflight::probe_integrations(&all_credentials, Some(&state.settings)).await;
        for p in &probes {
            probe_results_json[&p.integration_slug] = json!({
                "status": p.status.as_str(),
                "ok": p.success(),
                "http_status": p.http_status,
                "error": if p.error.is_empty() { None } else { Some(&p.error) },
                "hint": if p.hint.is_empty() { None } else { Some(&p.hint) },
                "latency_ms": p.latency_ms,
            });
        }
    }

    // Identify which slugs are project-level overrides vs inherited
    let project_creds = crate::credentials::list_project_credentials(&state.db, pid)
        .await.unwrap_or_default();
    let project_slugs: Vec<String> = project_creds.iter()
        .filter_map(|c| c.get("integration_slug").and_then(Value::as_str).map(String::from))
        .collect();

    let mut scopes = json!({});
    for slug in &connected {
        scopes[slug] = if project_slugs.contains(slug) { json!("project") } else { json!("inherited") };
    }

    Ok(Json(json!({
        "connected": connected,
        "probe_results": probe_results_json,
        "scopes": scopes,
    })))
}

// ── Project Members Routes ──────────────────────────────────────────────────

/// GET /api/projects/:project_id/members
pub async fn project_members_list(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    let pid: uuid::Uuid = project_id.parse().map_err(|_| StatusCode::BAD_REQUEST)?;

    let sql = format!(
        "SELECT pm.id, pm.role, pm.created_at, \
                u.id as user_id, u.email, u.name, u.avatar_url \
         FROM project_members pm \
         JOIN users u ON pm.user_id = u.id \
         WHERE pm.project_id = '{pid}' \
         ORDER BY pm.created_at"
    );
    let rows = state.db.execute(&sql).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Also include client-level members (inherited)
    let client_rows = state.db.execute(&format!(
        "SELECT ucr.role, ucr.created_at, \
                u.id as user_id, u.email, u.name, u.avatar_url \
         FROM user_client_roles ucr \
         JOIN users u ON ucr.user_id = u.id \
         JOIN projects p ON p.client_id = ucr.client_id \
         WHERE p.id = '{pid}' \
         ORDER BY ucr.created_at"
    )).await.unwrap_or_default();

    let project_user_ids: Vec<String> = rows.iter()
        .filter_map(|r| r.get("user_id").and_then(Value::as_str).map(String::from))
        .collect();

    let mut members: Vec<Value> = rows.iter().map(|r| {
        let mut m = r.clone();
        m.as_object_mut().unwrap().insert("scope".into(), json!("project"));
        m
    }).collect();

    for r in &client_rows {
        let uid = r.get("user_id").and_then(Value::as_str).unwrap_or("");
        if !project_user_ids.contains(&uid.to_string()) {
            let mut m = r.clone();
            m.as_object_mut().unwrap().insert("scope".into(), json!("inherited"));
            members.push(m);
        }
    }

    Ok(Json(json!({ "members": members })))
}

#[derive(Deserialize)]
pub struct InviteMemberRequest {
    pub email: String,
    pub role: Option<String>,
}

/// POST /api/projects/:project_id/members — invite a user by email
pub async fn project_member_invite(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Json(body): Json<InviteMemberRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let pid: uuid::Uuid = project_id.parse()
        .map_err(|_| (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid project_id"}))))?;
    let role = body.role.as_deref().unwrap_or("member");
    let email_esc = body.email.trim().to_lowercase().replace('\'', "''");

    // Find or create user by email (they'll complete signup on first Google login)
    let user_rows = state.db.execute(&format!(
        "INSERT INTO users (email, name) VALUES ('{email_esc}', '{email_esc}') \
         ON CONFLICT (email) DO UPDATE SET updated_at = NOW() \
         RETURNING id"
    )).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    let user_id = user_rows.first()
        .and_then(|r| r.get("id").and_then(Value::as_str))
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "Failed to find/create user"}))))?;

    let role_esc = role.replace('\'', "''");
    state.db.execute(&format!(
        "INSERT INTO project_members (project_id, user_id, role) \
         VALUES ('{pid}', '{user_id}', '{role_esc}') \
         ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role"
    )).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({ "invited": true, "user_id": user_id, "email": body.email.trim() })))
}

/// DELETE /api/projects/:project_id/members/:user_id
pub async fn project_member_remove(
    State(state): State<Arc<AppState>>,
    Path((project_id, user_id)): Path<(String, String)>,
) -> Result<Json<Value>, StatusCode> {
    let pid: uuid::Uuid = project_id.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
    let uid: uuid::Uuid = user_id.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
    state.db.execute(&format!(
        "DELETE FROM project_members WHERE project_id = '{pid}' AND user_id = '{uid}'"
    )).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(json!({"removed": true})))
}

// ── Skills Routes ───────────────────────────────────────────────────────────

/// GET /api/skills — list all skills.
pub async fn skills_list(
    State(state): State<Arc<AppState>>,
) -> Json<Value> {
    let rows = state.db.execute(
        "SELECT id, slug, name, description, default_tools, max_iterations, model, skip_judge, expert_id, created_at          FROM skills ORDER BY slug"
    ).await.unwrap_or_default();
    Json(json!({"skills": rows}))
}
