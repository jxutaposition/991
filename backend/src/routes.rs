/// HTTP route handlers.
use std::collections::HashMap;
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
use crate::error::InternalError;
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
            {"id": "claude-haiku-4-5-20251001", "name": "Claude Haiku 4.5", "description": "Fastest, lowest cost. Good for most tasks.", "cost": "low", "provider": "anthropic"},
            {"id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6", "description": "Balanced speed and quality.", "cost": "high", "provider": "anthropic"},
            {"id": "claude-opus-4-6", "name": "Claude Opus 4.6", "description": "Highest quality. Best for complex planning.", "cost": "very_high", "provider": "anthropic"},
            {"id": "claude-opus-4-6-thinking", "name": "Claude Opus 4.6 Thinking", "description": "Highest quality with extended thinking. Best for the hardest tasks.", "cost": "very_high", "provider": "anthropic"},
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
                    "credential": crate::actions::action_credential(t),
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
                "automation_mode": a.automation_mode.as_deref().unwrap_or("full"),
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

    let integration_alternatives = crate::agent_catalog::AgentCatalog::integration_alternatives();

    let count = agents.len();
    Json(json!({"agents": agents, "count": count, "categories": categories, "integration_alternatives": integration_alternatives}))
}

pub async fn catalog_get(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<Json<Value>, InternalError> {
    let agent = state
        .catalog
        .get(&slug)
        .ok_or(StatusCode::NOT_FOUND)?;

    let tool_details: Vec<Value> = agent.tools.iter().map(|t| {
        let cred = crate::actions::action_credential(t);
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
        let rows = state.db.execute_with(
            "SELECT slug, name FROM experts WHERE id = $1",
            pg_args!(eid),
        ).await.unwrap_or_default();
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
) -> Result<Json<Value>, InternalError> {
    // Aggregate stats from execution_nodes
    let stats = state.db.execute_with(
        r#"SELECT
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
        WHERE agent_slug = $1
          AND status IN ('passed', 'failed', 'skipped')"#,
        pg_args!(slug.clone()),
    ).await.unwrap_or_default();

    // Recent runs (last 20)
    let runs = state.db.execute_with(
        r#"SELECT en.id, en.session_id, en.status, en.judge_score, en.judge_feedback,
               en.task_description, en.attempt_count, en.model,
               en.started_at, en.completed_at,
               es.request_text as session_request
        FROM execution_nodes en
        JOIN execution_sessions es ON en.session_id = es.id
        WHERE en.agent_slug = $1
          AND en.status IN ('passed', 'failed', 'skipped')
        ORDER BY en.completed_at DESC NULLS LAST
        LIMIT 20"#,
        pg_args!(slug.clone()),
    ).await.unwrap_or_default();

    // Feedback signals
    let feedback = state.db.execute_with(
        "SELECT * FROM feedback_signals WHERE agent_slug = $1 ORDER BY created_at DESC LIMIT 20",
        pg_args!(slug.clone()),
    ).await.unwrap_or_default();

    // PRs targeting this agent
    let prs = state.db.execute_with(
        r#"SELECT id, pr_type, gap_summary, confidence, status, created_at
        FROM agent_prs
        WHERE target_agent_slug = $1
        ORDER BY created_at DESC
        LIMIT 20"#,
        pg_args!(slug),
    ).await.unwrap_or_default();

    Ok(Json(json!({
        "stats": stats.first().cloned().unwrap_or(json!({})),
        "recent_runs": runs,
        "feedback": feedback,
        "prs": prs,
    })))
}

// ── Execution ─────────────────────────────────────────────────────────────────

/// Try to extract user_id from a JWT in the Authorization header without requiring auth middleware.
fn extract_user_id_from_jwt(
    headers: &axum::http::HeaderMap,
    settings: &crate::config::Settings,
) -> Option<Uuid> {
    let jwt_secret = settings.jwt_secret.as_deref()?;
    let auth = headers.get("authorization")?.to_str().ok()?;
    let token = auth.strip_prefix("Bearer ")?;
    let claims = jsonwebtoken::decode::<crate::auth::JwtClaims>(
        token,
        &jsonwebtoken::DecodingKey::from_secret(jwt_secret.as_bytes()),
        &jsonwebtoken::Validation::default(),
    ).ok()?;
    claims.claims.sub.parse::<Uuid>().ok()
}

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
        SELECT s.id, s.request_text, s.status, s.plan_approved_at, s.created_at, s.completed_at,
               c.slug as client_slug,
               (SELECT COUNT(*) FROM execution_nodes WHERE session_id = s.id) as node_count,
               (SELECT COUNT(*) FILTER (WHERE status = 'passed') FROM execution_nodes WHERE session_id = s.id) as passed_count
        FROM execution_sessions s
        LEFT JOIN clients c ON c.id = s.client_id
        ORDER BY s.created_at DESC
        LIMIT 50
    "#;
    let rows = state.db.execute_unparameterized(sql).await.unwrap_or_default();
    Json(json!({"sessions": rows}))
}

/// POST /api/execute — plan a new execution session.
pub async fn execution_create(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
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
    let mut client_id: Option<Uuid> = if let Some(ref slug) = body.client_slug {
        let rows = state.db.execute_with(
            "SELECT id FROM clients WHERE slug = $1 AND deleted_at IS NULL",
            pg_args!(slug.clone()),
        ).await.ok().unwrap_or_default();
        rows.first()
            .and_then(|r| r.get("id").and_then(Value::as_str))
            .and_then(|s| s.parse::<Uuid>().ok())
    } else {
        None
    };

    // Fallback: infer client from JWT user when client_slug was not provided
    if client_id.is_none() {
        if let Some(user_id) = extract_user_id_from_jwt(&headers, &state.settings) {
            let rows = state.db.execute_with(
                "SELECT c.id, c.slug FROM clients c \
                 JOIN user_client_roles ucr ON ucr.client_id = c.id \
                 WHERE ucr.user_id = $1 ORDER BY c.created_at LIMIT 1",
                pg_args!(user_id),
            ).await.ok().unwrap_or_default();
            if let Some(row) = rows.first() {
                client_id = row.get("id").and_then(Value::as_str).and_then(|s| s.parse::<Uuid>().ok());
                let slug = row.get("slug").and_then(Value::as_str).unwrap_or("?");
                info!(user_id = %user_id, client_slug = %slug, "inferred client from JWT (client_slug was missing)");
            }
        }
    }

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

        // Initial plan JSON: just the master node (preview children added async)
        let plan_json: Value = json!([{
            "uid": master_uid.to_string(),
            "agent_slug": MASTER_ORCHESTRATOR_SLUG,
            "task_description": &body.request_text,
            "requires": [],
        }]);

        // Persist session with 'planning' status — returned to frontend immediately
        let customer_uuid = body.customer_id.as_deref()
            .and_then(|id| id.parse::<Uuid>().ok());

        state.db.execute_with(
            r#"INSERT INTO execution_sessions (id, customer_id, client_id, project_id, request_text, plan, status, mode)
               VALUES ($1, $2, $3, $4, $5, $6, 'planning', 'orchestrated')"#,
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

        // Create SSE channel immediately so frontend can subscribe during planning
        state.event_bus.ensure_channel(&session_id.to_string()).await;

        info!(session_id = %session_id, mode = "orchestrated", "session created with 'planning' status — spawning async planner");

        // Spawn background task to generate the RICH preview plan
        let bg_state = state.clone();
        let bg_session_id = session_id;
        let bg_request_text = body.request_text.clone();
        let bg_model = model.to_string();
        let bg_master_uid = master_uid;
        let bg_node_model = node_model.clone();
        let bg_client_id = client_id;
        let bg_project_id = project_id;

        tokio::spawn(async move {
            bg_state.event_bus.send(
                &bg_session_id.to_string(),
                json!({"type": "planner_progress", "message": "Analyzing request and loading agent catalog..."}),
            ).await;

            let catalog_summary = bg_state.catalog.catalog_summary();

            bg_state.event_bus.send(
                &bg_session_id.to_string(),
                json!({"type": "planner_progress", "message": "Searching knowledge base for prior work and project context..."}),
            ).await;

            // Pre-gather context so the user sees progress during knowledge search
            let gathered_context = planner::gather_planner_context(
                &bg_state.db,
                &bg_request_text,
                bg_client_id,
                bg_project_id,
                bg_state.settings.openai_api_key.as_deref(),
            ).await;

            if !gathered_context.is_empty() {
                bg_state.event_bus.send(
                    &bg_session_id.to_string(),
                    json!({"type": "planner_progress", "message": "Found relevant context. Designing system architecture..."}),
                ).await;
            } else {
                bg_state.event_bus.send(
                    &bg_session_id.to_string(),
                    json!({"type": "planner_progress", "message": "Designing system architecture and component specifications..."}),
                ).await;
            }

            // Use the RICH planner to generate detailed component descriptions,
            // architecture, data flows, acceptance criteria — not just agent slugs.
            let rich_plan = match planner::plan_rich_description(
                &bg_request_text,
                &catalog_summary,
                &bg_state.settings.anthropic_api_key,
                &bg_model,
                &gathered_context,
            ).await {
                Ok(plan) => plan,
                Err(e) => {
                    error!(error = %e, session_id = %bg_session_id, "async rich planner failed");
                    let _ = bg_state.db.execute_with(
                        "UPDATE execution_sessions SET status = 'failed' WHERE id = $1",
                        pg_args!(bg_session_id),
                    ).await;
                    bg_state.event_bus.send(
                        &bg_session_id.to_string(),
                        json!({"type": "planner_error", "error": format!("Planning failed: {e}")}),
                    ).await;
                    return;
                }
            };

            // Create project description from the rich plan output
            let desc_id = if let Some(pid) = bg_project_id {
                match crate::system_description::create_project_description(
                    &bg_state.db,
                    pid,
                    &rich_plan.title,
                    Some(&rich_plan.summary),
                    &rich_plan.architecture,
                    &rich_plan.data_flows,
                    &json!({}),
                ).await {
                    Ok(id) => {
                        // Link description to session
                        let _ = bg_state.db.execute_with(
                            "UPDATE execution_sessions SET project_description_id = $1 WHERE id = $2",
                            pg_args!(id, bg_session_id),
                        ).await;
                        Some(id)
                    }
                    Err(e) => {
                        warn!(error = %e, "failed to create project description, continuing without");
                        None
                    }
                }
            } else {
                None
            };

            // Persist preview child nodes WITH rich descriptions
            let empty_uuids: Vec<Uuid> = vec![];
            let mut plan_entries = vec![json!({
                "uid": bg_master_uid.to_string(),
                "agent_slug": MASTER_ORCHESTRATOR_SLUG,
                "task_description": &bg_request_text,
                "requires": [],
            })];

            for (i, component) in rich_plan.components.iter().enumerate() {
                let child_uid = Uuid::new_v4();
                let agent_def = bg_state.catalog.get(&component.agent_slug);
                let child_jc_val = agent_def.as_ref()
                    .map(|a| serde_json::to_value(&a.judge_config).unwrap_or(json!({})))
                    .unwrap_or_else(|| json!({"threshold":7.0,"rubric":[],"need_to_know":[]}));

                let exec_mode = match agent_def.as_ref().and_then(|a| a.automation_mode.as_deref()) {
                    Some("guided") => "manual",
                    _ => "agent",
                };

                let description_json = &component.description;
                let acceptance_criteria = description_json
                    .get("acceptance_criteria")
                    .cloned()
                    .unwrap_or(json!([]));

                let _ = bg_state.db.execute_with(
                    r#"INSERT INTO execution_nodes
                        (id, session_id, agent_slug, agent_git_sha, task_description, status,
                         requires, attempt_count, parent_uid, judge_config, max_iterations,
                         model, skip_judge, client_id, depth, description, step_index,
                         acceptance_criteria, execution_mode, integration_overrides)
                       VALUES ($1, $2, $3, $4, $5, 'preview', $6, 0, $7, $8, 15, $9, true, $10, 1,
                               $11, $12, $13, $14, '{}'::jsonb)"#,
                    pg_args!(
                        child_uid, bg_session_id, component.agent_slug.clone(), "preview".to_string(),
                        component.task_description.clone(), &empty_uuids as &[Uuid], bg_master_uid,
                        child_jc_val, bg_node_model.clone(), bg_client_id,
                        description_json.clone(), (i as i32) + 1, acceptance_criteria,
                        exec_mode.to_string()
                    ),
                ).await;

                plan_entries.push(json!({
                    "uid": child_uid.to_string(),
                    "agent_slug": &component.agent_slug,
                    "task_description": &component.task_description,
                    "requires": [],
                    "parent_uid": bg_master_uid.to_string(),
                    "preview": true,
                    "description": description_json,
                    "execution_mode": exec_mode,
                }));
            }

            // Collect node UIDs before consuming plan_entries
            let node_uids: Vec<Uuid> = plan_entries[1..].iter()
                .filter_map(|e| e.get("uid").and_then(Value::as_str).and_then(|s| s.parse::<Uuid>().ok()))
                .collect();

            let plan_json: Value = plan_entries.into();

            // Update session: plan + status → awaiting_approval
            let _ = bg_state.db.execute_with(
                "UPDATE execution_sessions SET plan = $1, status = 'awaiting_approval' WHERE id = $2",
                pg_args!(plan_json.clone(), bg_session_id),
            ).await;

            // Run blocker identification on the rich plan
            if desc_id.is_some() {
                planner::identify_blockers(
                    &bg_state.db,
                    &rich_plan.components,
                    &node_uids,
                    bg_session_id,
                    bg_client_id,
                ).await;
            }

            bg_state.event_bus.send(
                &bg_session_id.to_string(),
                json!({
                    "type": "plan_ready",
                    "plan": plan_json,
                    "node_count": 1 + rich_plan.components.len(),
                    "title": rich_plan.title,
                    "summary": rich_plan.summary,
                }),
            ).await;

            info!(
                session_id = %bg_session_id,
                preview_children = rich_plan.components.len(),
                title = %rich_plan.title,
                "async rich planner completed — session moved to awaiting_approval"
            );
        });

        return Ok(Json(CreateExecutionResponse {
            session_id: session_id.to_string(),
            plan: plan_json,
            node_count: 1,
        }));
    }

    // Planned mode (existing behavior)
    let mut exec_nodes = planner::plan_to_execution_nodes(
        &plan,
        session_id,
        state.catalog.git_sha(),
        &state.catalog,
        Some(model),
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
) -> Result<Json<Value>, InternalError> {
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
                    }))).into());
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
    state.event_bus.ensure_channel(&session_id).await;

    // --- Start Slack notifier if project or client has a slack_channel_id ---
    #[cfg(feature = "slack")]
    {
        if let Some(ref slack) = state.slack {
            // Resolve slack_channel_id: project overrides client
            let slack_channel = resolve_slack_channel(&state.db, project_id, client_id).await;

            if let Some(channel_id) = slack_channel {
                // Fetch request_text for the initial message
                let req_text = state.db.execute_with(
                    "SELECT request_text FROM execution_sessions WHERE id = $1",
                    pg_args!(session_uuid),
                ).await.ok()
                    .and_then(|rows| rows.first().cloned())
                    .and_then(|r| r.get("request_text").and_then(Value::as_str).map(String::from))
                    .unwrap_or_else(|| "New execution".to_string());

                let frontend_url = std::env::var("FRONTEND_URL")
                    .unwrap_or_else(|_| "http://localhost:3000".to_string());

                let text = format!(
                    ":rocket: *Execution started*\n*Request:* {}\n<{}/execute/{}|View in dashboard>",
                    req_text, frontend_url, session_id
                );

                match slack.post_message(&channel_id, &[], &text, None).await {
                    Ok(resp) => {
                        // Start notifier to post updates as threaded replies
                        crate::slack_notifier::subscribe_to_session(
                            session_id.clone(),
                            state.event_bus.clone(),
                            slack.clone(),
                            state.db.clone(),
                            channel_id.clone(),
                            resp.ts.clone(),
                        );

                        // Insert mapping so clarification thread replies route back
                        let _ = state.db.execute_with(
                            "INSERT INTO slack_channel_mappings (slack_team_id, slack_channel_id, session_id, thread_ts) \
                             VALUES ('auto', $1, $2, $3)",
                            crate::pg_args!(channel_id.clone(), session_id.to_string(), resp.ts.clone()),
                        ).await;

                        info!(session = %session_id, channel = %channel_id, "Slack notifier started for project/client channel");
                    }
                    Err(e) => {
                        warn!(session = %session_id, error = %e, "failed to post Slack notification for project channel");
                    }
                }
            }
        }
    }

    info!(session = %session_id, "execution approved — work queue will pick up ready nodes");

    Ok(Json(json!({"status": "executing", "session_id": session_id})))
}

/// Resolve Slack channel ID: project-level overrides client-level.
#[cfg(feature = "slack")]
async fn resolve_slack_channel(
    db: &crate::pg::PgClient,
    project_id: Option<Uuid>,
    client_id: Option<Uuid>,
) -> Option<String> {
    // Check project first
    if let Some(pid) = project_id {
        let rows = db.execute_with(
            "SELECT slack_channel_id FROM projects WHERE id = $1",
            crate::pg_args!(pid),
        ).await.ok()?;
        if let Some(ch) = rows.first()
            .and_then(|r| r.get("slack_channel_id"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            return Some(ch.to_string());
        }
    }
    // Fall back to client
    if let Some(cid) = client_id {
        let rows = db.execute_with(
            "SELECT slack_channel_id FROM clients WHERE id = $1",
            crate::pg_args!(cid),
        ).await.ok()?;
        if let Some(ch) = rows.first()
            .and_then(|r| r.get("slack_channel_id"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            return Some(ch.to_string());
        }
    }
    None
}

/// POST /api/execute/:session_id/stop — cancel a running orchestration.
/// Sets session to 'cancelled' and all non-terminal nodes to 'cancelled'.
pub async fn execution_stop(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, InternalError> {
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
) -> Result<Json<Value>, InternalError> {
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| StatusCode::BAD_REQUEST)?;

    let rows = state.db.execute_with(
        "SELECT id, status, request_text, plan, plan_approved_at, created_at, completed_at, \
                project_id, project_description_id \
         FROM execution_sessions WHERE id = $1",
        pg_args!(session_uuid),
    ).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let session = rows.first().ok_or(StatusCode::NOT_FOUND)?.clone();

    let nodes = state.db.execute_with(
        "SELECT id, agent_slug, task_description, status, requires, \
               judge_score, judge_feedback, judge_config, output, input, \
               attempt_count, max_iterations, model, skip_judge, \
               parent_uid, variant_group, variant_label, variant_selected, \
               computed_tier, tier_override, breakpoint, \
               workflow_id, workflow_step_id, client_id, \
               depth, spawn_context, acceptance_criteria, \
               artifacts, step_index, error_category, description, \
               started_at, completed_at, execution_mode, integration_overrides \
         FROM execution_nodes WHERE session_id = $1 \
         ORDER BY created_at",
        pg_args!(session_uuid),
    ).await.unwrap_or_default();

    Ok(Json(json!({
        "session": session,
        "nodes": nodes,
    })))
}

/// GET /api/execute/:session_id/failures — aggregated failure view for the session.
pub async fn execution_failures(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, InternalError> {
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| StatusCode::BAD_REQUEST)?;

    let nodes = state.db.execute_with(
        "SELECT id, agent_slug, task_description, status, \
                error_category, judge_score, judge_feedback, output, \
                attempt_count, started_at, completed_at \
         FROM execution_nodes \
         WHERE session_id = $1 \
           AND (status = 'failed' OR status = 'skipped' OR attempt_count > 1) \
         ORDER BY completed_at DESC NULLS LAST",
        pg_args!(session_uuid),
    ).await.unwrap_or_default();
    Ok(Json(json!({ "failures": nodes })))
}

/// GET /api/execute/:session_id/nodes/:node_id/events — get execution events for a node.
pub async fn execution_node_events(
    State(state): State<Arc<AppState>>,
    Path((session_id, node_id)): Path<(String, String)>,
) -> Result<Json<Value>, InternalError> {
    let node_uuid = node_id.parse::<Uuid>().map_err(|_| StatusCode::BAD_REQUEST)?;
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| StatusCode::BAD_REQUEST)?;

    let events = state.db.execute_with(
        "SELECT id, node_id, event_type, payload, created_at \
         FROM execution_events \
         WHERE session_id = $1 AND node_id = $2 \
         ORDER BY created_at ASC",
        pg_args!(session_uuid, node_uuid),
    ).await.unwrap_or_default();
    Ok(Json(json!({ "events": events })))
}

/// GET /api/execute/:session_id/nodes/:node_id/thinking — thinking blocks for a node.
pub async fn execution_node_thinking(
    State(state): State<Arc<AppState>>,
    Path((session_id, node_id)): Path<(String, String)>,
) -> Result<Json<Value>, InternalError> {
    let node_uuid = node_id.parse::<Uuid>().map_err(|_| StatusCode::BAD_REQUEST)?;
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| StatusCode::BAD_REQUEST)?;

    let blocks = state.db.execute_with(
        "SELECT id, node_id, iteration, thinking_text, token_count, created_at \
         FROM thinking_blocks \
         WHERE session_id = $1 AND node_id = $2 \
         ORDER BY iteration ASC, created_at ASC",
        pg_args!(session_uuid, node_uuid),
    ).await.unwrap_or_default();
    Ok(Json(json!({ "thinking_blocks": blocks })))
}

/// GET /api/execute/:session_id/nodes/:node_id/stream — unified chronological stream
/// combining execution events, thinking blocks, and conversation messages.
pub async fn execution_node_stream(
    State(state): State<Arc<AppState>>,
    Path((session_id, node_id)): Path<(String, String)>,
) -> Result<Json<Value>, InternalError> {
    let node_uuid = node_id.parse::<Uuid>().map_err(|_| StatusCode::BAD_REQUEST)?;
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| StatusCode::BAD_REQUEST)?;

    let stream = state.db.execute_with(
        "SELECT id, node_id, 'event' AS stream_type, event_type AS sub_type, \
               payload::text AS content, NULL::text AS thinking_text, \
               NULL::int AS iteration, NULL::int AS token_count, \
               NULL::text AS role, NULL::jsonb AS metadata, \
               created_at \
         FROM execution_events \
         WHERE session_id = $1 AND node_id = $2 \
         UNION ALL \
         SELECT id, node_id, 'thinking' AS stream_type, 'thinking_block' AS sub_type, \
               NULL AS content, thinking_text, \
               iteration, token_count, \
               NULL AS role, NULL AS metadata, \
               created_at \
         FROM thinking_blocks \
         WHERE session_id = $1 AND node_id = $2 \
         UNION ALL \
         SELECT id, node_id, 'message' AS stream_type, role AS sub_type, \
               content, NULL AS thinking_text, \
               NULL AS iteration, NULL AS token_count, \
               role, metadata, \
               created_at \
         FROM node_messages \
         WHERE session_id = $1 AND node_id = $2 \
         ORDER BY created_at ASC",
        pg_args!(session_uuid, node_uuid),
    ).await.unwrap_or_default();
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
            let mut shutdown_rx = state.shutdown_rx.clone();
            let stream = async_stream::stream! {
                loop {
                    tokio::select! {
                        result = receiver.recv() => {
                            match result {
                                Ok(event) => {
                                    let mut sse_event = Event::default().data(event.to_string());
                                    if let Some(seq) = event.get("_seq").and_then(|v| v.as_u64()) {
                                        sse_event = sse_event.id(seq.to_string());
                                    }
                                    yield Ok::<Event, std::convert::Infallible>(sse_event);
                                }
                                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                                    tracing::warn!(lagged = n, "SSE receiver lagged, sending resync");
                                    yield Ok::<Event, std::convert::Infallible>(
                                        Event::default().data(serde_json::json!({
                                            "type": "resync_required",
                                            "reason": "lagged",
                                            "missed_count": n,
                                        }).to_string())
                                    );
                                }
                            }
                        }
                        _ = shutdown_rx.changed() => break,
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
               computed_tier, client_id, execution_mode, integration_overrides)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10, $11, $12, $13, $14, $15)"#,
            pg_args!(
                node.uid, session_id, node.agent_slug.clone(), node.agent_git_sha.clone(),
                node.task_description.clone(), node.status.as_str().to_string(),
                &node.requires as &[Uuid], judge_config_val,
                node.max_iterations as i32, node.model.clone(), node.skip_judge,
                computed_tier, node.client_id,
                node.execution_mode.clone(), node.integration_overrides.clone()
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
) -> Result<Json<Value>, InternalError> {
    let session_id = Uuid::new_v4();

    state.db.execute_with(
        "INSERT INTO observation_sessions (id, expert_id, started_at, status) \
         VALUES ($1, $2, NOW(), 'recording')",
        pg_args!(session_id, body.expert_id.clone()),
    ).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    // Create SSE channel for narrator stream
    state.event_bus.ensure_channel(&session_id.to_string()).await;

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
) -> Result<Json<Value>, InternalError> {
    if body.events.is_empty() && body.screenshots.as_ref().map_or(true, |s| s.is_empty()) {
        return Ok(Json(json!({"received": 0, "screenshots_stored": 0, "gaps_detected": []})));
    }

    let session_uuid = session_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid session ID"})))
    })?;

    let received = body.events.len();
    let screenshots_received = body.screenshots.as_ref().map_or(0, |s| s.len());

    // Persist events to DB
    for event in &body.events {
        let url = event.url.as_deref().unwrap_or("").to_string();
        let domain = event
            .url
            .as_deref()
            .and_then(|u| Url::parse(u).ok())
            .and_then(|u| u.host_str().map(|h| h.to_string()))
            .unwrap_or_default();
        let dom_ctx = event
            .dom_context
            .clone()
            .unwrap_or(json!(null));

        let _ = state.db.execute_with(
            "INSERT INTO action_events \
              (session_id, sequence_number, event_type, url, domain, dom_context, created_at) \
             VALUES ($1, $2, $3, $4, $5, $6, NOW()) \
             ON CONFLICT (session_id, sequence_number) DO NOTHING",
            pg_args!(session_uuid, event.sequence_number as i64, event.event_type.clone(), url, domain, dom_ctx),
        ).await;
    }

    // Update event count
    let _ = state.db.execute_with(
        "UPDATE observation_sessions SET event_count = (SELECT COUNT(*) FROM action_events WHERE session_id = $1) WHERE id = $1",
        pg_args!(session_uuid),
    ).await;

    // Persist screenshots to DB and grab the latest for vision narrator
    let latest_screenshot_b64: Option<String> = if let Some(screenshots) = &body.screenshots {
        let mut latest: Option<String> = None;
        for (i, ss) in screenshots.iter().enumerate() {
            // Decode base64 to raw bytes and store as BYTEA
            if let Ok(image_bytes) = {
                use base64::Engine;
                base64::engine::general_purpose::STANDARD.decode(&ss.base64)
            } {
                let _ = state.db.execute_with(
                    "INSERT INTO observation_screenshots (session_id, sequence_number, image_jpeg, captured_at) \
                     VALUES ($1, $2, $3, NOW()) ON CONFLICT DO NOTHING",
                    pg_args!(session_uuid, ss.timestamp, image_bytes),
                ).await;
            }
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
            let mut shutdown_rx = state.shutdown_rx.clone();
            let stream = async_stream::stream! {
                loop {
                    tokio::select! {
                        result = receiver.recv() => {
                            match result {
                                Ok(event) => {
                                    yield Ok::<Event, std::convert::Infallible>(
                                        Event::default().event("narration_chunk").data(event.to_string())
                                    );
                                }
                                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                            }
                        }
                        _ = shutdown_rx.changed() => break,
                    }
                }
            };
            Sse::new(stream)
                .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
                .into_response()
        }
        None => {
            // Poll DB for latest narrations
            let session_uuid = session_id.parse::<Uuid>().ok();
            let rows = if let Some(sid) = session_uuid {
                state.db.execute_with(
                    "SELECT id, sequence_ref, narrator_text, expert_correction, created_at \
                     FROM distillations WHERE session_id = $1 ORDER BY sequence_ref DESC LIMIT 20",
                    pg_args!(sid),
                ).await.unwrap_or_default()
            } else {
                vec![]
            };
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
) -> Result<Json<Value>, InternalError> {
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid session ID"})))
    })?;

    let rows = state.db.execute_with(
        "UPDATE distillations SET expert_correction = $1 \
         WHERE session_id = $2 AND sequence_ref = $3 \
         RETURNING narrator_text",
        pg_args!(body.correction.clone(), session_uuid, body.sequence_ref),
    ).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    let narrator_text = rows
        .first()
        .and_then(|r| r.get("narrator_text").and_then(Value::as_str))
        .unwrap_or("");

    // Record as ground_truth feedback signal (weight 5.0)
    // Try to find matching agent from prior abstracted_tasks for this session
    let agent_slug = state.db.execute_with(
        "SELECT matched_agent_slug FROM abstracted_tasks WHERE session_id = $1 AND matched_agent_slug IS NOT NULL LIMIT 1",
        pg_args!(session_uuid),
    ).await.ok()
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
) -> Result<Json<Value>, InternalError> {
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid session ID"})))
    })?;

    let coverage = narrator::compute_coverage_score(&state.db, &session_id).await;

    state.db.execute_with(
        "UPDATE observation_sessions SET status = 'completed', ended_at = NOW(), coverage_score = $1 WHERE id = $2",
        pg_args!(coverage, session_uuid),
    ).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    // Cleanup SSE channel
    state.event_bus.cleanup(&session_id).await;

    info!(session = %session_id, coverage = coverage, "observation session ended");

    // Look up expert_id from the observation session
    let expert_id_for_extraction = {
        let rows = state.db.execute_with(
            "SELECT expert_id FROM observation_sessions WHERE id = $1",
            crate::pg_args!(session_id.to_string()),
        ).await.unwrap_or_default();
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

            // After extraction + reasoning, run the full feedback pipeline
            match crate::feedback_pipeline::run_feedback_pipeline(&db, &api_key, &model, Some(&catalog)).await {
                Ok(result) => {
                    if !result.prs_created.is_empty() || result.signals_deduped > 0 || result.patterns_detected > 0 {
                        info!(
                            session = %session_id_clone,
                            prs = result.prs_created.len(),
                            deduped = result.signals_deduped,
                            patterns = result.patterns_detected,
                            "post-session feedback pipeline complete"
                        );
                    }
                }
                Err(e) => {
                    tracing::warn!(session = %session_id_clone, error = %e, "feedback pipeline failed");
                }
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
    let rows = state.db.execute_unparameterized(sql).await.unwrap_or_default();
    Json(json!({"sessions": rows}))
}

/// GET /api/observe/session/:session_id — get session detail with distillations.
pub async fn observe_session_get(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, InternalError> {
    let rows = state.db.execute_with(
        "SELECT id, expert_id, started_at, ended_at, status, coverage_score, event_count \
         FROM observation_sessions WHERE id = $1::uuid",
        pg_args!(session_id.clone()),
    ).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let session = rows.first().ok_or(StatusCode::NOT_FOUND)?.clone();

    let distillations = state.db.execute_with(
        "SELECT id, sequence_ref, narrator_text, expert_correction, created_at \
         FROM distillations WHERE session_id = $1::uuid ORDER BY sequence_ref",
        pg_args!(session_id.clone()),
    ).await.unwrap_or_default();

    let events = state.db.execute_with(
        "SELECT id, event_type, url, domain, dom_context, created_at \
         FROM action_events WHERE session_id = $1::uuid ORDER BY sequence_number LIMIT 100",
        pg_args!(session_id.clone()),
    ).await.unwrap_or_default();

    let tasks = state.db.execute_with(
        "SELECT id, description, matched_agent_slug, match_confidence, status \
         FROM abstracted_tasks WHERE session_id = $1::uuid \
         ORDER BY match_confidence DESC NULLS LAST",
        pg_args!(session_id.clone()),
    ).await.unwrap_or_default();

    let prs = state.db.execute_with(
        "SELECT id, pr_type, target_agent_slug, gap_summary, confidence, status \
         FROM agent_prs WHERE evidence_session_ids @> ARRAY[$1::uuid] \
         ORDER BY created_at DESC",
        pg_args!(session_id.clone()),
    ).await.unwrap_or_default();

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

    let rows = state.db.execute_with(
        "SELECT id, pr_type, target_agent_slug, proposed_slug, gap_summary, \
               confidence, evidence_count, status, created_at \
         FROM agent_prs \
         WHERE status = $1 \
         ORDER BY created_at DESC \
         LIMIT 100",
        crate::pg_args!(status_filter),
    ).await.unwrap_or_default();
    Json(json!({"prs": rows}))
}

/// GET /api/agent-prs/:pr_id — get a single PR with full details plus the
/// current agent definition so the reviewer can see before/after in context.
pub async fn agent_pr_get(
    State(state): State<Arc<AppState>>,
    Path(pr_id): Path<String>,
) -> Result<Json<Value>, InternalError> {
    let pr_uuid = pr_id.parse::<Uuid>().map_err(|_| StatusCode::BAD_REQUEST)?;

    let rows = state.db.execute_with(
        "SELECT id, pr_type, target_agent_slug, proposed_slug, file_diffs, \
               proposed_changes, reasoning, gap_summary, confidence, evidence_count, \
               status, created_at \
         FROM agent_prs \
         WHERE id = $1",
        crate::pg_args!(pr_uuid),
    ).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let pr = rows.first().ok_or(StatusCode::NOT_FOUND)?;

    let slug = pr.get("target_agent_slug").and_then(Value::as_str)
        .or_else(|| pr.get("proposed_slug").and_then(Value::as_str));

    let current_agent = if let Some(slug) = slug {
        state.catalog.get(slug).map(|agent| {
            let tool_details: Vec<Value> = agent.tools.iter().map(|t| {
                let cred = crate::actions::action_credential(t);
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
) -> Result<Json<Value>, InternalError> {
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
) -> Result<Json<Value>, InternalError> {
    let pr_uuid = pr_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid PR ID"})))
    })?;

    state.db.execute_with(
        "UPDATE agent_prs SET status = 'rejected', reviewed_at = NOW() \
         WHERE id = $1 AND status = 'open'",
        pg_args!(pr_uuid),
    ).await.map_err(|e| {
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
    let rows = state.db.execute_unparameterized(sql).await.unwrap_or_default();

    // Also list views
    let views_sql = r#"
        SELECT schemaname AS schema, viewname AS table_name, -1 AS row_count
        FROM pg_views
        WHERE schemaname = 'public'
        ORDER BY viewname
    "#;
    let views = state.db.execute_unparameterized(views_sql).await.unwrap_or_default();

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
) -> Result<Json<Value>, InternalError> {
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
        ).into());
    }

    let upper = trimmed.to_uppercase();
    let dml_keywords = ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE", "CREATE", "GRANT", "REVOKE", "COPY"];
    for keyword in &dml_keywords {
        // Check for keyword as a whole word (preceded by whitespace or start-of-string)
        if upper.split_whitespace().any(|w| w == *keyword) {
            return Err((
                StatusCode::FORBIDDEN,
                Json(json!({"error": format!("Query contains forbidden keyword: {keyword}")})),
            ).into());
        }
    }

    match state.db.execute_unparameterized(trimmed).await {
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
        Err(_e) => Ok(Json(json!({
            "columns": [],
            "rows": [],
            "row_count": 0,
            "sql": trimmed,
            "error": "Query execution failed",
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
) -> Result<Json<Value>, InternalError> {
    // Validate table name (alphanumeric + underscore only)
    if !table.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "Invalid table name"})),
        ).into());
    }

    let limit = query.limit.unwrap_or(100).min(10000);
    let offset = query.offset.unwrap_or(0);

    // Check if table has created_at for ordering
    let has_created_at = state.db.execute_with(
        "SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'created_at' LIMIT 1",
        crate::pg_args!(table.clone()),
    ).await.map(|r| !r.is_empty()).unwrap_or(false);

    let order = if has_created_at { "ORDER BY created_at DESC" } else { "" };

    // sql-format-ok: `table` is validated alphanumeric+underscore (line 1842), `order`
    // is a static string literal, `limit`/`offset` are u32. Postgres cannot parameterize
    // identifiers, so format! is the only option here.
    let sql = format!(
        "SELECT * FROM {table} {order} LIMIT {limit} OFFSET {offset}"
    );

    match state.db.execute_unparameterized(&sql).await {
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
        ).into()),
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
) -> Result<Json<Value>, InternalError> {
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
) -> Result<Json<Value>, InternalError> {
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
) -> Result<Json<Value>, InternalError> {
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
) -> Result<Json<Value>, InternalError> {
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
) -> Result<Json<Value>, InternalError> {
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
) -> Result<Json<Value>, InternalError> {
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
pub struct UpdateClientRequest {
    pub name: Option<String>,
    pub brief: Option<String>,
    pub industry: Option<String>,
    pub slack_channel_id: Option<String>,
}

/// PATCH /api/clients/:slug — update a client.
pub async fn client_update(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Json(body): Json<UpdateClientRequest>,
) -> Result<Json<Value>, InternalError> {
    let client = client_mod::get_client(&state.db, &slug)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, Json(json!({"error": "Client not found"}))))?;

    let client_id: Uuid = client.get("id").and_then(Value::as_str)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "Missing client id"}))))?;

    let mut sets = Vec::new();
    let mut param_idx = 1u32;
    let mut args = sqlx::postgres::PgArguments::default();
    use sqlx::Arguments as _;

    if let Some(ref name) = body.name {
        sets.push(format!("name = ${param_idx}"));
        param_idx += 1;
        args.add(name.clone()).expect("encode");
    }
    if let Some(ref brief) = body.brief {
        sets.push(format!("brief = ${param_idx}"));
        param_idx += 1;
        args.add(brief.clone()).expect("encode");
    }
    if let Some(ref industry) = body.industry {
        sets.push(format!("industry = ${param_idx}"));
        param_idx += 1;
        args.add(industry.clone()).expect("encode");
    }
    if body.slack_channel_id.is_some() {
        let val = body.slack_channel_id.as_deref()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        sets.push(format!("slack_channel_id = ${param_idx}"));
        param_idx += 1;
        args.add(val).expect("encode");
    }

    if sets.is_empty() {
        return Ok(Json(json!({"updated": false})));
    }

    sets.push("updated_at = NOW()".to_string());
    args.add(client_id).expect("encode");

    // sql-format-ok: dynamic UPDATE — `sets` contains hardcoded `column = $N` fragments
    // built above, all real values are bound via `args`. param_idx is an integer counter.
    let sql = format!(
        "UPDATE clients SET {} WHERE id = ${param_idx}",
        sets.join(", ")
    );
    state.db.execute_with(&sql, args).await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({"updated": true})))
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
) -> Result<Json<Value>, InternalError> {
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
    let rows = if let Some(slug) = &query.agent_slug {
        if query.unresolved_only.unwrap_or(false) {
            state.db.execute_with(
                "SELECT * FROM feedback_signals WHERE agent_slug = $1 AND resolution IS NULL ORDER BY created_at DESC LIMIT 100",
                pg_args!(slug.clone()),
            ).await.unwrap_or_default()
        } else {
            state.db.execute_with(
                "SELECT * FROM feedback_signals WHERE agent_slug = $1 ORDER BY created_at DESC LIMIT 100",
                pg_args!(slug.clone()),
            ).await.unwrap_or_default()
        }
    } else if query.unresolved_only.unwrap_or(false) {
        state.db.execute_unparameterized(
            "SELECT * FROM feedback_signals WHERE resolution IS NULL ORDER BY created_at DESC LIMIT 100",
        ).await.unwrap_or_default()
    } else {
        state.db.execute_unparameterized(
            "SELECT * FROM feedback_signals ORDER BY created_at DESC LIMIT 100",
        ).await.unwrap_or_default()
    };
    Json(json!({"signals": rows}))
}

/// GET /api/feedback/dashboard — aggregated feedback stats across all agents.
pub async fn feedback_dashboard(
    State(state): State<Arc<AppState>>,
) -> Json<Value> {
    let signal_stats_sql = r#"
        SELECT agent_slug,
               signal_type,
               authority,
               COUNT(*) as count,
               SUM(weight) as total_weight,
               COUNT(*) FILTER (WHERE resolution IS NULL) as unresolved
        FROM feedback_signals
        GROUP BY agent_slug, signal_type, authority
        ORDER BY agent_slug, total_weight DESC
    "#;
    let signal_stats = state.db.execute_unparameterized(signal_stats_sql).await.unwrap_or_default();

    let pending_prs_sql = r#"
        SELECT id, pr_type, target_agent_slug, gap_summary, confidence,
               evidence_count, status, auto_merge_eligible, created_at
        FROM agent_prs
        WHERE status = 'open'
        ORDER BY created_at DESC
        LIMIT 50
    "#;
    let pending_prs = state.db.execute_unparameterized(pending_prs_sql).await.unwrap_or_default();

    let overlays_sql = r#"
        SELECT o.id, o.primitive_type, o.primitive_id, o.scope, o.source,
               o.version, o.content, o.created_at,
               s.slug as skill_slug, s.name as skill_name
        FROM overlays o
        LEFT JOIN skills s ON o.primitive_id = s.id
        ORDER BY o.created_at DESC
        LIMIT 100
    "#;
    let overlays = state.db.execute_unparameterized(overlays_sql).await.unwrap_or_default();

    let patterns_sql = r#"
        SELECT id, agent_slug, pattern_type, description,
               session_count, severity, status, created_at
        FROM feedback_patterns
        WHERE status = 'active'
        ORDER BY session_count DESC, created_at DESC
        LIMIT 50
    "#;
    let patterns = state.db.execute_unparameterized(patterns_sql).await.unwrap_or_default();

    let weight_dist_sql = r#"
        SELECT agent_slug,
               SUM(weight) FILTER (WHERE authority = 'ground_truth') as ground_truth_weight,
               SUM(weight) FILTER (WHERE authority = 'inferred') as inferred_weight,
               SUM(weight) FILTER (WHERE authority = 'user') as user_weight,
               SUM(weight) FILTER (WHERE authority = 'automated') as automated_weight,
               SUM(weight) FILTER (WHERE authority = 'agent_self_report') as self_report_weight,
               SUM(weight) as total_weight,
               COUNT(*) as total_signals
        FROM feedback_signals
        GROUP BY agent_slug
        ORDER BY total_weight DESC
    "#;
    let weight_distribution = state.db.execute_unparameterized(weight_dist_sql).await.unwrap_or_default();

    Json(json!({
        "signal_stats": signal_stats,
        "pending_prs": pending_prs,
        "active_overlays": overlays,
        "active_patterns": patterns,
        "weight_distribution": weight_distribution,
    }))
}

// ── Experts ───────────────────────────────────────────────────────────────────

/// GET /api/experts
pub async fn experts_list(State(state): State<Arc<AppState>>) -> Json<Value> {
    let rows = state.db.execute_unparameterized("SELECT * FROM experts ORDER BY name").await.unwrap_or_default();
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
) -> Result<Json<Value>, InternalError> {
    let id = Uuid::new_v4();

    state.db.execute_with(
        "INSERT INTO experts (id, slug, name, identity, voice, methodology) VALUES ($1, $2, $3, $4, $5, $6)",
        crate::pg_args!(id, body.slug.clone(), body.name.clone(), body.identity.clone(), body.voice.clone(), body.methodology.clone()),
    ).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({"expert_id": id.to_string()})))
}

/// GET /api/experts/:slug
pub async fn expert_get(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<Json<Value>, InternalError> {
    let rows = state.db.execute_with(
        "SELECT * FROM experts WHERE slug = $1",
        crate::pg_args!(slug),
    ).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let expert = rows.into_iter().next().ok_or(StatusCode::NOT_FOUND)?;

    let expert_id: Uuid = expert.get("id").and_then(Value::as_str)
        .and_then(|s| s.parse().ok()).ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    let agents = state.db.execute_with(
        "SELECT slug, name, category, description FROM agent_definitions WHERE expert_id = $1 ORDER BY slug",
        crate::pg_args!(expert_id),
    ).await.unwrap_or_default();

    let engagements = state.db.execute_with(
        "SELECT e.*, c.name as client_name FROM engagements e JOIN clients c ON e.client_id = c.id WHERE e.expert_id = $1 ORDER BY e.created_at DESC",
        crate::pg_args!(expert_id),
    ).await.unwrap_or_default();

    Ok(Json(json!({
        "expert": expert,
        "agents": agents,
        "engagements": engagements,
    })))
}

// ── Engagements ──────────────────────────────────────────────────────────────

/// GET /api/engagements
pub async fn engagements_list(State(state): State<Arc<AppState>>) -> Json<Value> {
    let rows = state.db.execute_unparameterized(
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
) -> Result<Json<Value>, InternalError> {
    let expert_rows = state.db.execute_with(
        "SELECT id FROM experts WHERE slug = $1",
        crate::pg_args!(body.expert_slug.clone()),
    ).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;
    let expert_id: Uuid = expert_rows.first()
        .and_then(|r| r.get("id").and_then(Value::as_str))
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| (StatusCode::NOT_FOUND, Json(json!({"error": "Expert not found"}))))?;

    let client_rows = state.db.execute_with(
        "SELECT id FROM clients WHERE slug = $1 AND deleted_at IS NULL",
        crate::pg_args!(body.client_slug.clone()),
    ).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;
    let client_id: Uuid = client_rows.first()
        .and_then(|r| r.get("id").and_then(Value::as_str))
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| (StatusCode::NOT_FOUND, Json(json!({"error": "Client not found"}))))?;

    let id = Uuid::new_v4();
    let scope: Option<String> = body.scope.clone();

    state.db.execute_with(
        "INSERT INTO engagements (id, slug, name, expert_id, client_id, scope) VALUES ($1, $2, $3, $4, $5, $6)",
        crate::pg_args!(id, body.slug.clone(), body.name.clone(), expert_id, client_id, scope),
    ).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({"engagement_id": id.to_string()})))
}

#[derive(Deserialize)]
pub struct FeedbackQuery {
    pub agent_slug: Option<String>,
    pub unresolved_only: Option<bool>,
}

/// POST /api/feedback/synthesize — run the full feedback pipeline (cluster, detect, synthesize).
/// Ground truth PRs with sufficient weight are auto-applied to the agent definitions.
pub async fn feedback_synthesize(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, InternalError> {
    let result = crate::feedback_pipeline::run_feedback_pipeline(
        &state.db,
        &state.settings.anthropic_api_key,
        &state.settings.anthropic_model,
        Some(&state.catalog),
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({
        "created_prs": result.prs_created.iter().map(|id| id.to_string()).collect::<Vec<_>>(),
        "prs_count": result.prs_created.len(),
        "signals_deduped": result.signals_deduped,
        "patterns_detected": result.patterns_detected,
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
    pub execution_mode: Option<String>,
    pub integration_overrides: Option<Value>,
    pub requires: Option<Vec<String>>,
}

/// GET /api/nodes/:node_id — get a single node by ID (no session required).
/// Used by the dashboard renderer to load a node's output/artifacts.
pub async fn get_node_by_id(
    State(state): State<Arc<AppState>>,
    Path(node_id): Path<String>,
) -> Result<Json<Value>, InternalError> {
    let node_uuid = node_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid node ID"})))
    })?;

    let rows = state.db.execute_with(
        "SELECT id, session_id, agent_slug, status, output, artifacts, task_description, started_at, completed_at \
         FROM execution_nodes WHERE id = $1",
        pg_args!(node_uuid),
    ).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    let row = rows.first().ok_or_else(|| {
        (StatusCode::NOT_FOUND, Json(json!({"error": "Node not found"})))
    })?;

    Ok(Json(json!({"node": row})))
}

/// PATCH /api/execute/:session_id/nodes/:node_id — update a node (DAG editor).
pub async fn execution_node_update(
    State(state): State<Arc<AppState>>,
    Path((session_id, node_id)): Path<(String, String)>,
    Json(body): Json<UpdateNodeRequest>,
) -> Result<Json<Value>, InternalError> {
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
    if let Some(em) = &body.execution_mode {
        if em != "agent" && em != "manual" {
            return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "execution_mode must be 'agent' or 'manual'"}))).into());
        }
        set_clauses.push(format!("execution_mode = ${idx}"));
        args.add(em.clone()).expect("encode");
        idx += 1;
    }
    if let Some(io) = &body.integration_overrides {
        set_clauses.push(format!("integration_overrides = ${idx}"));
        args.add(io.clone()).expect("encode");
        idx += 1;
    }
    if let Some(ref req) = body.requires {
        let dep_uuids: Vec<Uuid> = req.iter()
            .filter_map(|u| u.parse::<Uuid>().ok())
            .collect();
        set_clauses.push(format!("requires = ${idx}"));
        args.add(&dep_uuids as &[Uuid]).expect("encode");
        idx += 1;
        let new_status = if dep_uuids.is_empty() { "pending" } else { "waiting" };
        set_clauses.push(format!("status = ${idx}"));
        args.add(new_status.to_string()).expect("encode");
        idx += 1;
    }

    if set_clauses.is_empty() {
        return Ok(Json(json!({"ok": true, "updated": false})));
    }

    // sql-format-ok: dynamic UPDATE — `set_clauses` are hardcoded `column = $N` fragments
    // built above, all real values bound via `args`. idx is an integer counter.
    let sql = format!(
        "UPDATE execution_nodes SET {} WHERE id = ${} AND session_id = ${} AND status IN ('pending', 'waiting', 'ready', 'preview')",
        set_clauses.join(", "), idx, idx + 1
    );
    args.add(node_uuid).expect("encode");
    args.add(session_uuid).expect("encode");

    state.db.execute_with(&sql, args).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    let mut changes = serde_json::Map::new();
    if let Some(ref v) = body.agent_slug { changes.insert("agent_slug".into(), json!(v)); }
    if let Some(ref v) = body.task_description { changes.insert("task_description".into(), json!(v)); }
    if let Some(ref v) = body.tier_override { changes.insert("tier_override".into(), json!(v)); }
    if let Some(v) = body.breakpoint { changes.insert("breakpoint".into(), json!(v)); }
    if let Some(ref v) = body.model { changes.insert("model".into(), json!(v)); }
    if let Some(v) = body.max_iterations { changes.insert("max_iterations".into(), json!(v)); }
    if let Some(v) = body.skip_judge { changes.insert("skip_judge".into(), json!(v)); }
    if let Some(ref v) = body.execution_mode { changes.insert("execution_mode".into(), json!(v)); }
    if let Some(ref v) = body.integration_overrides { changes.insert("integration_overrides".into(), json!(v.clone())); }
    if let Some(ref v) = body.requires { changes.insert("requires".into(), json!(v)); }

    if !changes.is_empty() {
        state.event_bus.send(&session_id, json!({
            "type": "node_updated",
            "node_id": node_id,
            "changes": Value::Object(changes),
        })).await;
    }

    Ok(Json(json!({"ok": true, "updated": true})))
}

#[derive(Deserialize)]
pub struct AddNodeRequest {
    pub agent_slug: String,
    pub task_description: String,
    pub requires: Option<Vec<String>>,
    pub tier_override: Option<String>,
    pub breakpoint: Option<bool>,
    pub execution_mode: Option<String>,
    pub model: Option<String>,
    pub max_iterations: Option<u32>,
    pub description: Option<Value>,
}

/// POST /api/execute/:session_id/nodes — add a new node to a session (DAG editor).
pub async fn execution_node_add(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(body): Json<AddNodeRequest>,
) -> Result<Json<Value>, InternalError> {
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid session ID"})))
    })?;

    // Validate agent exists in catalog
    if state.catalog.get(&body.agent_slug).is_none() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": format!("Unknown agent slug: {}", body.agent_slug)})),
        ).into());
    }

    let node_id = Uuid::new_v4();

    let requires: Vec<Uuid> = body.requires.unwrap_or_default()
        .iter()
        .filter_map(|u| u.parse::<Uuid>().ok())
        .collect();
    let status = if requires.is_empty() { "pending" } else { "waiting" };
    let breakpoint = body.breakpoint.unwrap_or(false);

    let agent = state.catalog.get(&body.agent_slug);
    let model = body.model.clone()
        .or_else(|| agent.as_ref().and_then(|a| a.model.clone()))
        .unwrap_or_else(|| "claude-haiku-4-5-20251001".to_string());
    let max_iter = body.max_iterations
        .unwrap_or_else(|| agent.as_ref().map(|a| a.max_iterations).unwrap_or(15)) as i32;
    let skip_judge = agent.as_ref().map(|a| a.skip_judge).unwrap_or(false);
    let judge_config_val = agent.as_ref()
        .map(|a| serde_json::to_value(&a.judge_config).unwrap_or(json!({})))
        .unwrap_or_else(|| json!({"threshold":7.0,"rubric":[],"need_to_know":[]}));
    let execution_mode = body.execution_mode.clone()
        .or_else(|| agent.as_ref().and_then(|a| match a.automation_mode.as_deref() {
            Some("guided") => Some("manual".to_string()),
            _ => None,
        }))
        .unwrap_or_else(|| "agent".to_string());
    let description = body.description.clone().unwrap_or(json!({}));

    state.db.execute_with(
        r#"INSERT INTO execution_nodes
            (id, session_id, agent_slug, agent_git_sha, task_description, status,
             requires, attempt_count, judge_config, max_iterations, model, skip_judge,
             tier_override, breakpoint, execution_mode, description)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10, $11, $12, $13, $14, $15)"#,
        pg_args!(
            node_id, session_uuid, body.agent_slug.clone(), "manual".to_string(),
            body.task_description.clone(), status.to_string(),
            &requires as &[Uuid], judge_config_val, max_iter, model, skip_judge,
            body.tier_override.clone(), breakpoint, execution_mode, description
        ),
    ).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    state.event_bus.send(&session_id, json!({
        "type": "node_added",
        "node_id": node_id.to_string(),
        "agent_slug": &body.agent_slug,
        "task_description": &body.task_description,
        "status": status,
    })).await;

    Ok(Json(json!({"node_id": node_id.to_string()})))
}

/// DELETE /api/execute/:session_id — delete an entire session and its nodes.
pub async fn execution_session_delete(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, InternalError> {
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
) -> Result<Json<Value>, InternalError> {
    let node_uuid = node_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid node ID"})))
    })?;
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid session ID"})))
    })?;

    state.db.execute_with(
        "DELETE FROM execution_nodes WHERE id = $1 AND session_id = $2 AND status IN ('pending', 'waiting', 'ready', 'preview')",
        pg_args!(node_uuid, session_uuid),
    ).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    state.event_bus.send(&session_id, json!({
        "type": "node_removed",
        "node_id": node_id,
    })).await;

    Ok(Json(json!({"ok": true})))
}

/// POST /api/execute/:session_id/nodes/:node_id/release — release a breakpoint node.
pub async fn execution_node_release(
    State(state): State<Arc<AppState>>,
    Path((session_id, node_id)): Path<(String, String)>,
) -> Result<Json<Value>, InternalError> {
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
) -> Result<Json<Value>, InternalError> {
    let node_uuid = node_id.parse::<Uuid>().map_err(|_| StatusCode::BAD_REQUEST)?;
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| StatusCode::BAD_REQUEST)?;

    let messages = state.db.execute_with(
        "SELECT id, node_id, role, content, metadata, created_at \
         FROM node_messages \
         WHERE session_id = $1 AND node_id = $2 \
         ORDER BY created_at ASC",
        pg_args!(session_uuid, node_uuid),
    ).await.unwrap_or_default();
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
) -> Result<Json<Value>, InternalError> {
    let node_uuid = node_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid node ID"})))
    })?;
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid session ID"})))
    })?;

    // Verify node has a conversation state before allowing a reply
    let check_rows = state.db.execute_with(
        "SELECT status, conversation_state IS NOT NULL AS has_conv FROM execution_nodes WHERE id = $1 AND session_id = $2",
        pg_args!(node_uuid, session_uuid),
    ).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;
    let check_row = check_rows.first().ok_or_else(|| {
        (StatusCode::NOT_FOUND, Json(json!({"error": "Node not found"})))
    })?;
    let node_status = check_row.get("status").and_then(|v| v.as_str()).unwrap_or("");
    let has_conv = check_row.get("has_conv").and_then(|v| v.as_bool()).unwrap_or(false);
    if !has_conv && (node_status == "pending" || node_status == "ready" || node_status == "preview") {
        return Err((StatusCode::CONFLICT, Json(json!({
            "error": "Cannot send a message to a node that has not started executing yet. Use the session chat instead."
        }))).into());
    }

    // If this node is awaiting_reply because a child is, route the reply to
    // the actual child that needs it. This happens when the user replies from
    // the master orchestrator's conversation.
    let (target_node_uuid, target_node_id) = if node_status == "awaiting_reply" {
        let child_rows = state.db.execute_with(
            "SELECT id FROM execution_nodes \
             WHERE parent_uid = $1 AND session_id = $2 AND status = 'awaiting_reply' \
               AND conversation_state IS NOT NULL \
             ORDER BY created_at DESC LIMIT 1",
            pg_args!(node_uuid, session_uuid),
        ).await.unwrap_or_default();
        if let Some(child_row) = child_rows.first() {
            if let Some(child_id_str) = child_row.get("id").and_then(|v| v.as_str()) {
                if let Ok(child_uuid) = child_id_str.parse::<Uuid>() {
                    tracing::info!(
                        parent = %node_id, child = %child_id_str,
                        "routing reply from parent to awaiting child node"
                    );
                    (child_uuid, child_id_str.to_string())
                } else {
                    (node_uuid, node_id.clone())
                }
            } else {
                (node_uuid, node_id.clone())
            }
        } else {
            (node_uuid, node_id.clone())
        }
    } else {
        (node_uuid, node_id.clone())
    };

    // Mark target node as running
    state.db.execute_with(
        "UPDATE execution_nodes SET status = 'running' WHERE id = $1 AND session_id = $2",
        pg_args!(target_node_uuid, session_uuid),
    ).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    // Broadcast status change
    state.event_bus.send(
        &session_id,
        serde_json::json!({
            "type": "node_resumed",
            "node_uid": target_node_id,
        }),
    ).await;

    // Spawn async task to run the reply conversation
    let runner = crate::agent_runner::AgentRunner::new(
        state.settings.clone(),
        state.db.clone(),
        state.catalog.clone(),
        state.skill_catalog.clone(),
        state.tool_catalog.clone(),
        state.event_bus.clone(),
    );
    let sid = session_id.clone();
    let target_nid = target_node_id.clone();
    let parent_nid = node_id.clone();
    let reply_text = body.message.clone();

    tokio::spawn(async move {
        let result = runner.resume_with_reply(&sid, &target_nid, &reply_text).await;

        // Extract artifacts from write_output (if any) and persist them
        let status = result.status.as_str().to_string();
        let new_artifacts: Option<serde_json::Value> = result.output.as_ref()
            .and_then(|o| o.get("artifacts").or_else(|| o.get("result").and_then(|r| r.get("artifacts"))))
            .filter(|a| a.as_array().map_or(false, |arr| !arr.is_empty()))
            .cloned();

        if let Some(ref artifacts) = new_artifacts {
            let _ = runner.db().execute_with(
                r#"UPDATE execution_nodes
                   SET status = $1, output = $2, artifacts = $5,
                       completed_at = CASE WHEN $1 NOT IN ('running', 'awaiting_reply') THEN NOW() ELSE completed_at END
                   WHERE id = $3 AND session_id = $4"#,
                crate::pg_args!(status.clone(), result.output.clone(), target_node_uuid, session_uuid, artifacts.clone()),
            ).await;
        } else {
            let _ = runner.db().execute_with(
                r#"UPDATE execution_nodes
                   SET status = $1, output = $2,
                       completed_at = CASE WHEN $1 NOT IN ('running', 'awaiting_reply') THEN NOW() ELSE completed_at END
                   WHERE id = $3 AND session_id = $4"#,
                crate::pg_args!(status.clone(), result.output.clone(), target_node_uuid, session_uuid),
            ).await;
        }

        // Broadcast completion for the target node
        runner.event_bus().send(
            &sid,
            serde_json::json!({
                "type": if result.status.is_terminal() { "node_completed" } else { "node_awaiting_reply" },
                "node_uid": target_nid,
                "status": status,
            }),
        ).await;

        // If we routed to a child and it completed, update the parent orchestrator
        if target_node_uuid != node_uuid && result.status.is_terminal() {
            // Check if the parent still has other children awaiting reply
            let remaining = runner.db().execute_with(
                "SELECT COUNT(*) as cnt FROM execution_nodes \
                 WHERE parent_uid = $1 AND session_id = $2 AND status = 'awaiting_reply'",
                crate::pg_args!(node_uuid, session_uuid),
            ).await.unwrap_or_default();
            let still_awaiting = remaining.first()
                .and_then(|r| r.get("cnt").and_then(serde_json::Value::as_i64))
                .unwrap_or(0);

            if still_awaiting == 0 {
                // All children done — mark parent as passed
                let parent_status = if result.status == crate::agent_catalog::NodeStatus::Passed {
                    "passed"
                } else {
                    "failed"
                };
                let _ = runner.db().execute_with(
                    "UPDATE execution_nodes SET status = $1, completed_at = NOW() WHERE id = $2 AND session_id = $3",
                    crate::pg_args!(parent_status.to_string(), node_uuid, session_uuid),
                ).await;
                runner.event_bus().send(
                    &sid,
                    serde_json::json!({
                        "type": "node_completed",
                        "node_uid": parent_nid,
                        "status": parent_status,
                    }),
                ).await;
            }
        }

        // Unblock downstream nodes or skip them on failure, then check session completion
        if result.status == crate::agent_catalog::NodeStatus::Passed {
            let _ = crate::work_queue::unblock_downstream(runner.db(), &target_node_uuid, &session_uuid, runner.event_bus()).await;
            crate::work_queue::check_session_completion(runner.db(), &session_uuid, runner.event_bus()).await;
        } else if result.status == crate::agent_catalog::NodeStatus::Failed {
            let _ = crate::work_queue::skip_downstream(runner.db(), &target_node_uuid, &session_uuid, runner.event_bus()).await;
            crate::work_queue::check_session_completion(runner.db(), &session_uuid, runner.event_bus()).await;
        }
    });

    Ok(Json(json!({
        "ok": true,
        "status": "running",
        "message": "Reply sent, agent is processing...",
        "target_node_id": target_node_id,
    })))
}

// ── Session Chat (pre-execution) ─────────────────────────────────────────────

#[derive(Deserialize)]
pub struct SessionChatRequest {
    pub message: String,
}

/// POST /api/execute/:session_id/chat — pre-execution chat for asking questions,
/// giving specs, or requesting plan modifications while the session is awaiting approval.
pub async fn execution_session_chat(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(body): Json<SessionChatRequest>,
) -> Result<Json<Value>, InternalError> {
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid session ID"})))
    })?;

    // Load session
    let session_rows = state.db.execute_with(
        "SELECT status, request_text, client_id, project_id FROM execution_sessions WHERE id = $1",
        pg_args!(session_uuid),
    ).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;
    let session_row = session_rows.first().ok_or_else(|| {
        (StatusCode::NOT_FOUND, Json(json!({"error": "Session not found"})))
    })?;
    let session_status = session_row.get("status").and_then(Value::as_str).unwrap_or("");
    let request_text = session_row.get("request_text").and_then(Value::as_str).unwrap_or("").to_string();
    let client_id = session_row.get("client_id").and_then(Value::as_str)
        .and_then(|s| s.parse::<Uuid>().ok());
    let project_id = session_row.get("project_id").and_then(Value::as_str)
        .and_then(|s| s.parse::<Uuid>().ok());

    let is_pre_execution = session_status == "awaiting_approval" || session_status == "planning";
    let is_post_execution = session_status == "completed" || session_status == "executing" || session_status == "failed" || session_status == "stopped";

    if !is_pre_execution && !is_post_execution {
        return Err((StatusCode::CONFLICT, Json(json!({
            "error": format!("Chat is not available in session status '{}'", session_status)
        }))).into());
    }

    // Find master node (no parent_uid)
    let master_rows = state.db.execute_with(
        "SELECT id FROM execution_nodes WHERE session_id = $1 AND parent_uid IS NULL LIMIT 1",
        pg_args!(session_uuid),
    ).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;
    let master_row = master_rows.first().ok_or_else(|| {
        (StatusCode::NOT_FOUND, Json(json!({"error": "Master node not found"})))
    })?;
    let master_node_id = master_row.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let master_uuid = master_node_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "Invalid master node ID"})))
    })?;

    // Load current preview children for plan context
    let child_rows = state.db.execute_with(
        "SELECT agent_slug, task_description FROM execution_nodes WHERE session_id = $1 AND parent_uid = $2 ORDER BY created_at ASC",
        pg_args!(session_uuid, master_uuid),
    ).await.unwrap_or_default();
    let plan_summary: Vec<String> = child_rows.iter().map(|r| {
        let slug = r.get("agent_slug").and_then(Value::as_str).unwrap_or("?");
        let desc = r.get("task_description").and_then(Value::as_str).unwrap_or("?");
        format!("- {slug}: {desc}")
    }).collect();

    let phase = if is_post_execution { "post_execution" } else { "pre_execution" };
    let user_meta = json!({"source": "human_reply", "phase": phase});
    state.db.execute_with(
        "INSERT INTO node_messages (session_id, node_id, role, content, metadata) VALUES ($1, $2, 'user', $3, $4)",
        pg_args!(session_uuid, master_uuid, body.message.clone(), user_meta.clone()),
    ).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    // Broadcast user message via SSE
    state.event_bus.send(
        &session_id,
        json!({
            "type": "stream_entry",
            "node_uid": master_node_id,
            "stream_entry": {
                "stream_type": "message",
                "sub_type": "user",
                "content": body.message,
                "role": "user",
                "metadata": user_meta,
                "created_at": chrono::Utc::now().to_rfc3339(),
            }
        }),
    ).await;

    // ── Post-execution chat: full agent tool loop ────────────────────────────
    if is_post_execution {
        // Check for child nodes still awaiting reply — route there first
        let awaiting_rows = state.db.execute_with(
            "SELECT id FROM execution_nodes \
             WHERE parent_uid = $1 AND session_id = $2 AND status = 'awaiting_reply' \
               AND conversation_state IS NOT NULL \
             ORDER BY created_at DESC LIMIT 1",
            pg_args!(master_uuid, session_uuid),
        ).await.unwrap_or_default();

        if let Some(child_row) = awaiting_rows.first() {
            if let Some(child_id_str) = child_row.get("id").and_then(|v| v.as_str()) {
                if let Ok(child_uuid) = child_id_str.parse::<Uuid>() {
                    tracing::info!(
                        parent = %master_node_id, child = %child_id_str,
                        "post-exec chat routing reply to awaiting child node"
                    );

                    let _ = state.db.execute_with(
                        "UPDATE execution_nodes SET status = 'running' WHERE id = $1 AND session_id = $2",
                        pg_args!(child_uuid, session_uuid),
                    ).await;
                    state.event_bus.send(&session_id, json!({
                        "type": "node_resumed", "node_uid": child_id_str,
                    })).await;

                    let runner = crate::agent_runner::AgentRunner::new(
                        state.settings.clone(),
                        state.db.clone(),
                        state.catalog.clone(),
                        state.skill_catalog.clone(),
                        state.tool_catalog.clone(),
                        state.event_bus.clone(),
                    );
                    let sid = session_id.clone();
                    let child_nid = child_id_str.to_string();
                    let reply_text = body.message.clone();
                    let parent_nid = master_node_id.clone();

                    tokio::spawn(async move {
                        let result = runner.resume_with_reply(&sid, &child_nid, &reply_text).await;
                        let status = result.status.as_str().to_string();

                        let new_artifacts: Option<serde_json::Value> = result.output.as_ref()
                            .and_then(|o| o.get("artifacts").or_else(|| o.get("result").and_then(|r| r.get("artifacts"))))
                            .filter(|a| a.as_array().map_or(false, |arr| !arr.is_empty()))
                            .cloned();

                        if let Some(ref artifacts) = new_artifacts {
                            let _ = runner.db().execute_with(
                                r#"UPDATE execution_nodes
                                   SET status = $1, output = $2, artifacts = $5,
                                       completed_at = CASE WHEN $1 NOT IN ('running', 'awaiting_reply') THEN NOW() ELSE completed_at END
                                   WHERE id = $3 AND session_id = $4"#,
                                crate::pg_args!(status.clone(), result.output.clone(), child_uuid, session_uuid, artifacts.clone()),
                            ).await;
                        } else {
                            let _ = runner.db().execute_with(
                                r#"UPDATE execution_nodes
                                   SET status = $1, output = $2,
                                       completed_at = CASE WHEN $1 NOT IN ('running', 'awaiting_reply') THEN NOW() ELSE completed_at END
                                   WHERE id = $3 AND session_id = $4"#,
                                crate::pg_args!(status.clone(), result.output.clone(), child_uuid, session_uuid),
                            ).await;
                        }

                        runner.event_bus().send(&sid, json!({
                            "type": if result.status.is_terminal() { "node_completed" } else { "node_awaiting_reply" },
                            "node_uid": child_nid, "status": status,
                        })).await;

                        // Check if parent has more awaiting children
                        if result.status.is_terminal() {
                            let remaining = runner.db().execute_with(
                                "SELECT COUNT(*) as cnt FROM execution_nodes \
                                 WHERE parent_uid = $1 AND session_id = $2 AND status = 'awaiting_reply'",
                                crate::pg_args!(master_uuid, session_uuid),
                            ).await.unwrap_or_default();
                            let still_awaiting = remaining.first()
                                .and_then(|r| r.get("cnt").and_then(serde_json::Value::as_i64))
                                .unwrap_or(0);
                            if still_awaiting == 0 {
                                runner.event_bus().send(&sid, json!({
                                    "type": "all_children_resolved", "node_uid": parent_nid,
                                })).await;
                            }
                        }
                    });

                    return Ok(Json(json!({"ok": true, "routed_to_child": child_id_str})));
                }
            }
        }

        let child_outputs = state.db.execute_with(
            "SELECT agent_slug, task_description, status, output, artifacts \
             FROM execution_nodes WHERE session_id = $1 AND parent_uid = $2 \
             ORDER BY created_at ASC",
            pg_args!(session_uuid, master_uuid),
        ).await.unwrap_or_default();

        let mut system_context = String::from(
            "## Built System Summary\nThese are the components that were built during execution. \
             You have full access to inspect, modify, or troubleshoot any of them.\n\n"
        );
        for row in &child_outputs {
            let slug = row.get("agent_slug").and_then(Value::as_str).unwrap_or("?");
            let desc = row.get("task_description").and_then(Value::as_str).unwrap_or("?");
            let status = row.get("status").and_then(Value::as_str).unwrap_or("?");
            let output_summary = row.get("output")
                .and_then(Value::as_object)
                .and_then(|o| o.get("summary").and_then(Value::as_str))
                .unwrap_or("(no summary)");
            let artifacts_json = row.get("artifacts").cloned().unwrap_or(json!([]));
            system_context.push_str(&format!(
                "### {slug} [{status}]\n**Task**: {desc}\n**Output**: {output_summary}\n**Artifacts**: {artifacts_json}\n\n"
            ));
        }

        let history_rows = state.db.execute_with(
            "SELECT role, content FROM node_messages WHERE session_id = $1 AND node_id = $2 ORDER BY created_at ASC",
            pg_args!(session_uuid, master_uuid),
        ).await.unwrap_or_default();

        let mut messages: Vec<Value> = history_rows.iter().filter_map(|r| {
            let role = r.get("role").and_then(Value::as_str).unwrap_or("user");
            if role == "system" {
                return None;
            }
            let content = r.get("content").and_then(Value::as_str).unwrap_or("");
            Some(json!({"role": role, "content": content}))
        }).collect();

        let mut deduped: Vec<Value> = Vec::new();
        for msg in messages.drain(..) {
            let role = msg.get("role").and_then(Value::as_str).unwrap_or("user");
            if let Some(last) = deduped.last_mut() {
                let last_role = last.get("role").and_then(Value::as_str).unwrap_or("");
                if last_role == role {
                    let prev = last.get("content").and_then(Value::as_str).unwrap_or("").to_string();
                    let curr = msg.get("content").and_then(Value::as_str).unwrap_or("");
                    last["content"] = json!(format!("{prev}\n\n{curr}"));
                    continue;
                }
            }
            deduped.push(msg);
        }
        messages = deduped;

        // Ensure messages start with user role (Anthropic requirement)
        if messages.first().and_then(|m| m.get("role")).and_then(Value::as_str) == Some("assistant") {
            messages.insert(0, json!({"role": "user", "content": "(conversation resumed)"}));
        }

        let catalog_summary = state.catalog.catalog_summary();
        let orchestrator_prompt = state.catalog.get(MASTER_ORCHESTRATOR_SLUG)
            .map(|a| a.system_prompt.clone())
            .unwrap_or_else(|| "You are a helpful orchestrator.".to_string());

        let system_prompt = format!(
            "{orchestrator_prompt}\n\n\
            ## Current Mode: Post-Execution Operations\n\
            The system has been built and is live. You are now the ongoing operator of this system. \
            The user can ask you questions, request status reports, troubleshoot issues, or ask for modifications.\n\n\
            {system_context}\n\
            ## Original Request\n{request_text}\n\n\
            ## Available Agents\n{catalog_summary}\n\n\
            ## Guidelines\n\
            - For questions about the system, answer directly using the context above.\n\
            - For status checks, use your tools (http_request, clay_* tools) to query live system state.\n\
            - For modifications, spawn the appropriate subagent(s) with full context.\n\
            - For troubleshooting, investigate first (query APIs, check status) then fix.\n\
            - Always reference specific artifact IDs/URLs from the built system context above.\n\n\
            ## Troubleshooting Procedure\n\
            When the user reports something is broken or not working:\n\
            1. **Investigate** — use `clay_get_table_schema` on relevant tables to check column structure, \
            `clay_read_rows` to verify data flow, and `http_request` to test any n8n/API endpoints.\n\
            2. **Diagnose** — compare what you find against the original build output. Identify missing columns, \
            broken enrichments, disconnected sources, or data gaps.\n\
            3. **Fix** — use `clay_create_field` to recreate missing columns, `clay_trigger_enrichment` to re-run \
            stalled enrichments, or spawn a subagent for larger repairs.\n\
            4. **Verify** — after fixing, re-read the schema/data to confirm the fix worked.\n\
            Always explain what you found and what you fixed."
        );

        let bg_state = state.clone();
        let bg_session_id = session_id.clone();
        let bg_master_node_id = master_node_id.clone();
        let bg_master_uuid = master_uuid;
        let bg_session_uuid = session_uuid;

        tokio::spawn(async move {
            let runner = crate::agent_runner::AgentRunner::new(
                bg_state.settings.clone(),
                bg_state.db.clone(),
                bg_state.catalog.clone(),
                bg_state.skill_catalog.clone(),
                bg_state.tool_catalog.clone(),
                bg_state.event_bus.clone(),
            );

            let client = crate::anthropic::AnthropicClient::new(
                bg_state.settings.anthropic_api_key.clone(),
                bg_state.settings.anthropic_model.clone(),
            );

            let all_tools = crate::actions::all_action_defs();
            let max_tool_rounds = 15;
            let mut response_text = String::new();

            for round in 0..=max_tool_rounds {
                let (mut delta_rx, response_handle) = client.messages_stream(
                    &system_prompt,
                    &messages,
                    &all_tools,
                    8192,
                    Some(&bg_state.settings.anthropic_model),
                    None,
                );

                while let Some(event) = delta_rx.recv().await {
                    if matches!(event, crate::anthropic::StreamEvent::MessageStop) {
                        continue;
                    }
                    crate::agent_runner::forward_stream_delta_pub(
                        &bg_state.event_bus,
                        &bg_session_id,
                        &bg_master_node_id,
                        round,
                        &event,
                    ).await;
                }

                let response = match response_handle.await {
                    Ok(Ok(r)) => r,
                    Ok(Err(e)) => {
                        warn!(error = %e, "post-execution chat LLM call failed");
                        let error_msg = format!("Sorry, I encountered an error: {e}");
                        let _ = bg_state.db.execute_with(
                            "INSERT INTO node_messages (session_id, node_id, role, content, metadata) VALUES ($1, $2, 'assistant', $3, $4)",
                            pg_args!(bg_session_uuid, bg_master_uuid, error_msg.clone(), json!({"phase": "post_execution"})),
                        ).await;
                        bg_state.event_bus.send(&bg_session_id, json!({
                            "type": "stream_entry", "node_uid": bg_master_node_id,
                            "stream_entry": {"stream_type": "message", "sub_type": "assistant", "content": error_msg, "role": "assistant", "created_at": chrono::Utc::now().to_rfc3339()}
                        })).await;
                        bg_state.event_bus.send(&bg_session_id, json!({
                            "type": "stream_entry", "node_uid": bg_master_node_id,
                            "stream_entry": {"stream_type": "message_stop", "sub_type": "message_stop", "created_at": chrono::Utc::now().to_rfc3339()}
                        })).await;
                        return;
                    }
                    Err(e) => {
                        warn!(error = %e, "post-execution chat task join failed");
                        bg_state.event_bus.send(&bg_session_id, json!({
                            "type": "stream_entry", "node_uid": bg_master_node_id,
                            "stream_entry": {"stream_type": "message_stop", "sub_type": "message_stop", "created_at": chrono::Utc::now().to_rfc3339()}
                        })).await;
                        return;
                    }
                };

                response_text = response.text();

                let tool_uses: Vec<(String, String, Value)> = response.content.iter().filter_map(|block| {
                    if block.get("type")?.as_str()? == "tool_use" {
                        Some((
                            block.get("id")?.as_str()?.to_string(),
                            block.get("name")?.as_str()?.to_string(),
                            block.get("input").cloned().unwrap_or(json!({})),
                        ))
                    } else {
                        None
                    }
                }).collect();

                if tool_uses.is_empty() || round == max_tool_rounds {
                    break;
                }

                messages.push(crate::anthropic::assistant_message_from_response(&response.content));

                let mut tool_results: Vec<(String, String)> = Vec::new();
                for (tool_use_id, tool_name, tool_input) in &tool_uses {
                    let result = runner.execute_tool_pub(
                        &bg_session_id, &bg_master_node_id, tool_name, tool_input, client_id, project_id,
                    ).await;
                    info!(tool = %tool_name, "post-execution chat tool executed");
                    tool_results.push((tool_use_id.clone(), result));
                }

                messages.push(crate::anthropic::tool_results_message(&tool_results));
            }

            let _ = bg_state.db.execute_with(
                "INSERT INTO node_messages (session_id, node_id, role, content, metadata) VALUES ($1, $2, 'assistant', $3, $4)",
                pg_args!(bg_session_uuid, bg_master_uuid, response_text.clone(), json!({"phase": "post_execution"})),
            ).await;

            bg_state.event_bus.send(&bg_session_id, json!({
                "type": "stream_entry", "node_uid": bg_master_node_id,
                "stream_entry": {
                    "stream_type": "message", "sub_type": "assistant", "content": response_text,
                    "role": "assistant", "metadata": {"phase": "post_execution"},
                    "created_at": chrono::Utc::now().to_rfc3339(),
                }
            })).await;
            bg_state.event_bus.send(&bg_session_id, json!({
                "type": "stream_entry", "node_uid": bg_master_node_id,
                "stream_entry": {
                    "stream_type": "message_stop", "sub_type": "message_stop",
                    "created_at": chrono::Utc::now().to_rfc3339(),
                }
            })).await;
        });

        return Ok(Json(json!({
            "ok": true,
            "message": "Processing your message...",
        })));
    }

    // ── Pre-execution chat (existing behavior) ───────────────────────────────

    // Load full conversation history for this node
    let history_rows = state.db.execute_with(
        "SELECT role, content FROM node_messages WHERE session_id = $1 AND node_id = $2 ORDER BY created_at ASC",
        pg_args!(session_uuid, master_uuid),
    ).await.unwrap_or_default();

    let mut messages: Vec<Value> = history_rows.iter().map(|r| {
        let role = r.get("role").and_then(Value::as_str).unwrap_or("user");
        let content = r.get("content").and_then(Value::as_str).unwrap_or("");
        json!({"role": role, "content": content})
    }).collect();

    // Merge consecutive same-role messages (Anthropic requires alternation)
    let mut deduped: Vec<Value> = Vec::new();
    for msg in messages.drain(..) {
        let role = msg.get("role").and_then(Value::as_str).unwrap_or("user");
        if let Some(last) = deduped.last_mut() {
            let last_role = last.get("role").and_then(Value::as_str).unwrap_or("");
            if last_role == role {
                let prev = last.get("content").and_then(Value::as_str).unwrap_or("").to_string();
                let curr = msg.get("content").and_then(Value::as_str).unwrap_or("");
                last["content"] = json!(format!("{prev}\n\n{curr}"));
                continue;
            }
        }
        deduped.push(msg);
    }
    messages = deduped;

    let catalog_summary = state.catalog.catalog_summary();
    let plan_text = if plan_summary.is_empty() {
        "No plan generated yet.".to_string()
    } else {
        plan_summary.join("\n")
    };

    // Build knowledge tool definitions for the LLM
    let knowledge_tools: Vec<crate::anthropic::ToolDef> = crate::actions::all_action_defs()
        .into_iter()
        .filter(|t| t.name == "search_knowledge" || t.name == "read_knowledge")
        .collect();

    // Query available knowledge scope so the LLM knows what's indexed
    let mut knowledge_scope_desc = String::new();
    if let Some(cid) = client_id {
        let rows_result = if let Some(pid) = project_id {
            state.db.execute_with(
                "SELECT source_folder, COUNT(*) AS doc_count, \
                        SUM(chunk_count) AS total_chunks, \
                        ARRAY_AGG(DISTINCT source_filename) FILTER (WHERE source_filename IS NOT NULL) AS filenames \
                 FROM knowledge_documents \
                 WHERE tenant_id = $1 AND status = 'ready' \
                       AND (project_id IS NULL OR project_id = $2) \
                 GROUP BY source_folder \
                 ORDER BY doc_count DESC",
                pg_args!(cid, pid),
            ).await
        } else {
            state.db.execute_with(
                "SELECT source_folder, COUNT(*) AS doc_count, \
                        SUM(chunk_count) AS total_chunks, \
                        ARRAY_AGG(DISTINCT source_filename) FILTER (WHERE source_filename IS NOT NULL) AS filenames \
                 FROM knowledge_documents \
                 WHERE tenant_id = $1 AND status = 'ready' \
                 GROUP BY source_folder \
                 ORDER BY doc_count DESC",
                pg_args!(cid),
            ).await
        };
        if let Ok(rows) = rows_result {
            if !rows.is_empty() {
                knowledge_scope_desc.push_str("\n\n## Indexed Knowledge Corpus\n\
Your search_knowledge and read_knowledge tools search this client's indexed data. \
The following sources are available:\n");
                for row in &rows {
                    let folder = row.get("source_folder").and_then(Value::as_str).unwrap_or("(root)");
                    let folder_label = if folder.is_empty() { "(root)" } else { folder };
                    let doc_count = row.get("doc_count").and_then(Value::as_i64).unwrap_or(0);
                    let total_chunks = row.get("total_chunks").and_then(Value::as_i64).unwrap_or(0);
                    let filenames = row.get("filenames").and_then(Value::as_array)
                        .map(|arr| arr.iter().filter_map(Value::as_str).collect::<Vec<_>>())
                        .unwrap_or_default();
                    let preview: Vec<&str> = filenames.iter().take(5).copied().collect();
                    let more = if filenames.len() > 5 { format!(", +{} more", filenames.len() - 5) } else { String::new() };

                    knowledge_scope_desc.push_str(&format!(
                        "- **{folder_label}**: {doc_count} docs, ~{total_chunks} chunks [{}{more}]\n",
                        preview.join(", ")
                    ));
                }
                knowledge_scope_desc.push_str("\nUse search_knowledge(query) to find relevant information. \
Results are automatically scoped to this client's data.\n");
            }
        }
    }

    let system_prompt = format!(
        "You are a helpful GTM workflow planning assistant. The user is reviewing an execution plan \
before approving it. Help them understand, refine, or modify the plan.\n\n\
## Original Request\n{request_text}\n\n\
## Current Plan\n{plan_text}\n\n\
## Available Agents\n{catalog_summary}{knowledge_scope_desc}\n\n\
## How to Modify the Plan\n\
You have DIRECT control over the execution plan. When the user asks to change, swap, add, or remove \
agents, you MUST include a ```replan block in your response. The system automatically detects this \
block and applies the changes immediately — it deletes the old plan nodes and creates new ones. \
This is NOT a suggestion or proposal — it is an actual edit that takes effect as soon as you respond.\n\n\
Format: include a fenced JSON block tagged ```replan containing the COMPLETE updated plan as an array.\n\
depends_on uses 0-based indices (e.g. [0] means depends on the first node), OR agent slug strings (e.g. [\"clay_operator\"]).\n\
```replan\n\
[{{\"agent_slug\": \"notion_operator\", \"task_description\": \"...\", \"depends_on\": []}}, \
{{\"agent_slug\": \"dashboard_builder\", \"task_description\": \"...\", \"depends_on\": [0]}}]\n\
```\n\
After including the block, confirm to the user that the plan has been updated. Do NOT say you \"cannot\" \
modify the plan or that it's \"just a suggestion\" — the replan block IS the modification mechanism.\n\n\
## Agent Selection Rules\n\
- **dashboard_builder** is the DEFAULT for any dashboard, analytics view, React dashboard, data visualization, \
leaderboard, funnel chart, or metrics display. It renders natively in the platform.\n\
- **lovable_operator** is ONLY for maintaining existing Lovable-hosted projects (lovable.dev). Do NOT use it \
to build new dashboards or React UIs.\n\
- NEVER use both together for the same dashboard. They are separate paths.\n\n\
## Guidelines\n\
- Answer questions about the plan, agents, and what each step does.\n\
- You have access to search_knowledge and read_knowledge tools. Use them to look up historical \
project data, prior work, user logs, bugs, and configurations when the user asks about existing \
data or project history — or when you need context to give a better answer.\n\
- Keep answers concise and actionable.\n\
- Be encouraging and help the user feel confident about approving the plan or guide them to the changes they need."
    );

    // Spawn background task with tool loop
    let bg_state = state.clone();
    let bg_session_id = session_id.clone();
    let bg_master_node_id = master_node_id.clone();
    let bg_master_uuid = master_uuid;
    let bg_session_uuid = session_uuid;
    let bg_request_text = request_text.clone();

    tokio::spawn(async move {
        let runner = crate::agent_runner::AgentRunner::new(
            bg_state.settings.clone(),
            bg_state.db.clone(),
            bg_state.catalog.clone(),
            bg_state.skill_catalog.clone(),
            bg_state.tool_catalog.clone(),
            bg_state.event_bus.clone(),
        );

        let client = crate::anthropic::AnthropicClient::new(
            bg_state.settings.anthropic_api_key.clone(),
            bg_state.settings.anthropic_model.clone(),
        );

        let max_tool_rounds = 3;
        let mut response_text = String::new();
        let mut all_text_across_rounds = String::new();

        for round in 0..=max_tool_rounds {
            let (mut delta_rx, response_handle) = client.messages_stream(
                &system_prompt,
                &messages,
                &knowledge_tools,
                4096,
                Some(&bg_state.settings.anthropic_model),
                None,
            );

            while let Some(event) = delta_rx.recv().await {
                // Skip MessageStop from the Anthropic stream — we send our own
                // message_stop AFTER persisting the assistant message to the DB.
                // Forwarding the Anthropic one causes a race: the frontend clears
                // live text and fetches from DB before the message is persisted.
                if matches!(event, crate::anthropic::StreamEvent::MessageStop) {
                    continue;
                }
                crate::agent_runner::forward_stream_delta_pub(
                    &bg_state.event_bus,
                    &bg_session_id,
                    &bg_master_node_id,
                    round,
                    &event,
                ).await;
            }

            let response = match response_handle.await {
                Ok(Ok(r)) => r,
                Ok(Err(e)) => {
                    warn!(error = %e, "session chat LLM call failed");
                    let error_msg = format!("Sorry, I encountered an error: {e}");
                    let _ = bg_state.db.execute_with(
                        "INSERT INTO node_messages (session_id, node_id, role, content, metadata) VALUES ($1, $2, 'assistant', $3, $4)",
                        pg_args!(bg_session_uuid, bg_master_uuid, error_msg.clone(), json!({"phase": "pre_execution"})),
                    ).await;
                    bg_state.event_bus.send(&bg_session_id, json!({
                        "type": "stream_entry",
                        "node_uid": bg_master_node_id,
                        "stream_entry": {
                            "stream_type": "message",
                            "sub_type": "assistant",
                            "content": error_msg,
                            "role": "assistant",
                            "created_at": chrono::Utc::now().to_rfc3339(),
                        }
                    })).await;
                    bg_state.event_bus.send(&bg_session_id, json!({
                        "type": "stream_entry",
                        "node_uid": bg_master_node_id,
                        "stream_entry": {
                            "stream_type": "message_stop",
                            "sub_type": "message_stop",
                            "created_at": chrono::Utc::now().to_rfc3339(),
                        }
                    })).await;
                    return;
                }
                Err(e) => {
                    warn!(error = %e, "session chat task join failed");
                    bg_state.event_bus.send(&bg_session_id, json!({
                        "type": "stream_entry",
                        "node_uid": bg_master_node_id,
                        "stream_entry": {
                            "stream_type": "message",
                            "sub_type": "assistant",
                            "content": "Sorry, something went wrong while processing your message.",
                            "role": "assistant",
                            "created_at": chrono::Utc::now().to_rfc3339(),
                        }
                    })).await;
                    bg_state.event_bus.send(&bg_session_id, json!({
                        "type": "stream_entry",
                        "node_uid": bg_master_node_id,
                        "stream_entry": {
                            "stream_type": "message_stop",
                            "sub_type": "message_stop",
                            "created_at": chrono::Utc::now().to_rfc3339(),
                        }
                    })).await;
                    return;
                }
            };

            response_text = response.text();
            if !response_text.is_empty() {
                if !all_text_across_rounds.is_empty() {
                    all_text_across_rounds.push_str("\n\n");
                }
                all_text_across_rounds.push_str(&response_text);
            }

            // Check if the LLM wants to use tools
            let tool_uses: Vec<(String, String, Value)> = response.content.iter().filter_map(|block| {
                if block.get("type")?.as_str()? == "tool_use" {
                    Some((
                        block.get("id")?.as_str()?.to_string(),
                        block.get("name")?.as_str()?.to_string(),
                        block.get("input").cloned().unwrap_or(json!({})),
                    ))
                } else {
                    None
                }
            }).collect();

            if tool_uses.is_empty() || round == max_tool_rounds {
                break;
            }

            // Append assistant message (with tool_use blocks) to conversation
            messages.push(crate::anthropic::assistant_message_from_response(&response.content));

            // Execute each tool and collect results
            let mut tool_results: Vec<(String, String)> = Vec::new();
            for (tool_use_id, tool_name, tool_input) in &tool_uses {
                let result = if tool_name == "search_knowledge" {
                    let query_text = tool_input.get("query").and_then(Value::as_str).unwrap_or("");
                    let limit = tool_input.get("limit").and_then(Value::as_u64).unwrap_or(5).min(10);
                    runner.execute_search_knowledge_pub(query_text, limit, client_id, project_id).await
                } else if tool_name == "read_knowledge" {
                    let doc_id = tool_input.get("document_id").and_then(Value::as_str).unwrap_or("");
                    let chunk_idx = tool_input.get("chunk_index").and_then(Value::as_i64).unwrap_or(0);
                    let range = tool_input.get("range").and_then(Value::as_i64).unwrap_or(5).min(20);
                    runner.execute_read_knowledge_pub(doc_id, chunk_idx, range, client_id).await
                } else {
                    json!({"error": "Unknown tool"}).to_string()
                };
                info!(tool = %tool_name, "session chat tool call executed");
                tool_results.push((tool_use_id.clone(), result));
            }

            // Append tool results to conversation and loop
            messages.push(crate::anthropic::tool_results_message(&tool_results));
        }

        // response_text now has the final text (after any tool rounds)
        info!(
            session_id = %bg_session_id,
            text_len = response_text.len(),
            "session chat completed — persisting assistant response"
        );

        // Persist assistant message
        let _ = bg_state.db.execute_with(
            "INSERT INTO node_messages (session_id, node_id, role, content, metadata) VALUES ($1, $2, 'assistant', $3, $4)",
            pg_args!(bg_session_uuid, bg_master_uuid, response_text.clone(), json!({"phase": "pre_execution"})),
        ).await;

        // Broadcast the finalized assistant message so it appears immediately
        // (the streaming text_deltas may have been shown live, but this ensures
        // the complete message is present even if SSE was briefly interrupted)
        bg_state.event_bus.send(&bg_session_id, json!({
            "type": "stream_entry",
            "node_uid": bg_master_node_id,
            "stream_entry": {
                "stream_type": "message",
                "sub_type": "assistant",
                "content": response_text,
                "role": "assistant",
                "metadata": {"phase": "pre_execution"},
                "created_at": chrono::Utc::now().to_rfc3339(),
            }
        })).await;

        // Broadcast message_stop so frontend finalizes the streamed message
        let delivered = bg_state.event_bus.send(&bg_session_id, json!({
            "type": "stream_entry",
            "node_uid": bg_master_node_id,
            "stream_entry": {
                "stream_type": "message_stop",
                "sub_type": "message_stop",
                "created_at": chrono::Utc::now().to_rfc3339(),
            }
        })).await;
        info!(
            session_id = %bg_session_id,
            delivered,
            "session chat message_stop sent"
        );

        // Detect ```replan block and apply plan changes.
        // Search all_text_across_rounds (not just the final round) in case the
        // model emitted the replan in a round that also used tool calls.
        let replan_source = if all_text_across_rounds.contains("```replan") {
            &all_text_across_rounds
        } else if response_text.contains("```replan") {
            &response_text
        } else {
            ""
        };

        if !replan_source.is_empty() {
            if let Some(extracted) = extract_replan_json(replan_source) {
                match parse_replan_nodes(&extracted) {
                    Ok(new_plan) if !new_plan.is_empty() => {
                        info!(session_id = %bg_session_id, nodes = new_plan.len(), "replanning from chat — applying");

                        let _ = bg_state.db.execute_with(
                            "DELETE FROM execution_nodes WHERE session_id = $1 AND parent_uid = $2",
                            pg_args!(bg_session_uuid, bg_master_uuid),
                        ).await;

                        let empty_uuids: Vec<Uuid> = vec![];
                        let model = bg_state.settings.anthropic_model.clone();
                        let mut plan_entries = vec![json!({
                            "uid": bg_master_node_id,
                            "agent_slug": MASTER_ORCHESTRATOR_SLUG,
                            "task_description": bg_request_text,
                            "requires": [],
                        })];

                        for pn in &new_plan {
                            let child_uid = Uuid::new_v4();
                            let child_jc_val = bg_state.catalog.get(&pn.agent_slug)
                                .map(|a| serde_json::to_value(&a.judge_config).unwrap_or(json!({})))
                                .unwrap_or_else(|| json!({"threshold":7.0,"rubric":[],"need_to_know":[]}));

                            let _ = bg_state.db.execute_with(
                                r#"INSERT INTO execution_nodes
                                    (id, session_id, agent_slug, agent_git_sha, task_description, status,
                                     requires, attempt_count, parent_uid, judge_config, max_iterations,
                                     model, skip_judge, depth)
                                   VALUES ($1, $2, $3, $4, $5, 'preview', $6, 0, $7, $8, 15, $9, true, 1)"#,
                                pg_args!(
                                    child_uid, bg_session_uuid, pn.agent_slug.clone(), "preview".to_string(),
                                    pn.task_description.clone(), &empty_uuids as &[Uuid], bg_master_uuid,
                                    child_jc_val, model.clone()
                                ),
                            ).await;

                            plan_entries.push(json!({
                                "uid": child_uid.to_string(),
                                "agent_slug": &pn.agent_slug,
                                "task_description": &pn.task_description,
                                "requires": [],
                                "parent_uid": bg_master_node_id,
                                "preview": true,
                            }));
                        }

                        let plan_json: Value = plan_entries.into();
                        let _ = bg_state.db.execute_with(
                            "UPDATE execution_sessions SET plan = $1 WHERE id = $2",
                            pg_args!(plan_json.clone(), bg_session_uuid),
                        ).await;

                        bg_state.event_bus.send(&bg_session_id, json!({
                            "type": "plan_ready",
                            "plan": plan_json,
                            "node_count": 1 + new_plan.len(),
                        })).await;

                        info!(session_id = %bg_session_id, "replan applied and plan_ready sent");
                    }
                    Ok(_) => {
                        warn!(session_id = %bg_session_id, "replan block parsed but produced empty plan");
                    }
                    Err(e) => {
                        warn!(
                            session_id = %bg_session_id,
                            error = %e,
                            json_preview = %extracted.chars().take(200).collect::<String>(),
                            "replan block found but JSON parse failed"
                        );
                    }
                }
            } else {
                warn!(
                    session_id = %bg_session_id,
                    "found ```replan tag but could not extract JSON block"
                );
            }
        } else if all_text_across_rounds.contains("replan") || all_text_across_rounds.contains("updated plan") {
            info!(
                session_id = %bg_session_id,
                "response mentions replan but no ```replan block detected"
            );
        }
    });

    Ok(Json(json!({
        "ok": true,
        "message": "Processing your message...",
    })))
}

/// Parse a replan JSON array into PlannedNodes, handling the common case where
/// the LLM uses agent slug strings in depends_on instead of numeric indices.
fn parse_replan_nodes(json_str: &str) -> Result<Vec<planner::PlannedNode>, String> {
    // First try direct parsing (numeric depends_on)
    if let Ok(nodes) = serde_json::from_str::<Vec<planner::PlannedNode>>(json_str) {
        return Ok(nodes);
    }

    // Fallback: parse with flexible depends_on (strings or numbers)
    #[derive(serde::Deserialize)]
    struct FlexNode {
        agent_slug: String,
        task_description: String,
        #[serde(default)]
        depends_on: Vec<serde_json::Value>,
    }

    let flex_nodes: Vec<FlexNode> = serde_json::from_str(json_str)
        .map_err(|e| format!("{e}"))?;

    let slug_to_idx: std::collections::HashMap<String, usize> = flex_nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (n.agent_slug.clone(), i))
        .collect();

    let nodes = flex_nodes
        .into_iter()
        .map(|n| {
            let depends_on = n.depends_on.iter().filter_map(|dep| {
                match dep {
                    serde_json::Value::Number(num) => num.as_u64().map(|v| v as usize),
                    serde_json::Value::String(slug) => slug_to_idx.get(slug.as_str()).copied(),
                    _ => None,
                }
            }).collect();
            planner::PlannedNode {
                agent_slug: n.agent_slug,
                task_description: n.task_description,
                depends_on,
            }
        })
        .collect();

    Ok(nodes)
}

/// Extract JSON from a ```replan fenced block, handling common LLM formatting
/// variations: ```replan, ```replan\n, ```replan json, etc.
fn extract_replan_json(text: &str) -> Option<String> {
    // Find the ```replan tag (case-insensitive for the tag part)
    let lower = text.to_lowercase();
    let tag_pos = lower.find("```replan")?;
    let after_tag = tag_pos + "```replan".len();

    // Skip past the tag line (everything up to the first newline after the tag)
    let rest = &text[after_tag..];
    let json_start_offset = if let Some(nl) = rest.find('\n') {
        nl + 1
    } else {
        0
    };
    let json_region = &rest[json_start_offset..];

    // Find closing ``` fence
    let json_end = json_region.find("```")?;
    let raw = json_region[..json_end].trim();

    if raw.is_empty() {
        return None;
    }

    // If it starts with '[', it's the JSON array directly
    if raw.starts_with('[') {
        return Some(raw.to_string());
    }

    // Sometimes the LLM wraps it in another object; try to find the array inside
    if let Some(arr_start) = raw.find('[') {
        if let Some(arr_end) = raw.rfind(']') {
            if arr_end > arr_start {
                return Some(raw[arr_start..=arr_end].to_string());
            }
        }
    }

    // Fall back to the raw content
    Some(raw.to_string())
}

// ── Agent Version Routes ─────────────────────────────────────────────────────

/// GET /api/catalog/:slug/versions — list agent versions.
pub async fn catalog_versions(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<Json<Value>, InternalError> {
    let rows = state.db.execute_with(
        r#"SELECT av.id, av.version, av.change_summary, av.change_source, av.created_at
           FROM agent_versions av
           JOIN agent_definitions ad ON av.agent_id = ad.id
           WHERE ad.slug = $1
           ORDER BY av.version DESC"#,
        pg_args!(slug),
    ).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(json!({"versions": rows})))
}

// ── Credentials ─────────────────────────────────────────────────────────────

/// GET /api/clients/:slug/credentials
pub async fn client_credentials_list(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<Json<Value>, InternalError> {
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
    Failed,
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
        Some(result) if result.success() => ValidationResult::Validated,
        Some(_) => ValidationResult::Failed,
        None => ValidationResult::Skipped,
    }
}

/// POST /api/clients/:slug/credentials
pub async fn client_credential_set(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Json(body): Json<SetCredentialRequest>,
) -> Result<Json<Value>, InternalError> {
    let client = client_mod::get_client(&state.db, &slug)
        .await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, Json(json!({"error": "Client not found"}))))?;

    let client_id: uuid::Uuid = client.get("id").and_then(Value::as_str)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "Bad client id"}))))?;

    let master_key = state.settings.credential_master_key.as_deref()
        .ok_or_else(|| (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "Credential encryption not configured (CREDENTIAL_MASTER_KEY missing)"}))))?;

    let encrypted = crate::credentials::encrypt(master_key, &body.value)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("Encryption failed: {e}")}))))?;

    let cred_type = body.credential_type.as_deref().unwrap_or("api_key");
    crate::credentials::upsert_credential(&state.db, client_id, &body.integration_slug, cred_type, &encrypted, body.metadata.as_ref())
        .await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    // Probe is informational — never blocks saving the credential.
    let validation = validate_credential(&body.integration_slug, &body.value).await;
    let validated = match validation {
        ValidationResult::Validated => Some(true),
        ValidationResult::Failed => Some(false),
        ValidationResult::Skipped => None,
    };

    Ok(Json(json!({"ok": true, "integration_slug": body.integration_slug, "validated": validated})))
}

/// DELETE /api/clients/:slug/credentials/:integration_slug
pub async fn client_credential_delete(
    State(state): State<Arc<AppState>>,
    Path((slug, integration_slug)): Path<(String, String)>,
) -> Result<Json<Value>, InternalError> {
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
) -> Result<Json<Value>, InternalError> {
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
) -> Result<Json<Value>, InternalError> {
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
) -> Result<Json<Value>, InternalError> {
    let user = request.extensions().get::<crate::auth::AuthenticatedUser>()
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let rows = state.db.execute_with(
        "SELECT u.id, u.email, u.name, u.avatar_url FROM users u WHERE u.id = $1",
        crate::pg_args!(user.user_id),
    ).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let user_data = rows.first().cloned().unwrap_or(json!({}));

    let clients = state.db.execute_with(
        "SELECT c.slug, c.name, ucr.role FROM user_client_roles ucr JOIN clients c ON ucr.client_id = c.id WHERE ucr.user_id = $1 AND c.deleted_at IS NULL",
        crate::pg_args!(user.user_id),
    ).await.unwrap_or_default();

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
) -> Result<Json<Value>, InternalError> {
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

    state.db.execute_with(
        "INSERT INTO user_client_roles (user_id, client_id, role) \
         VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING",
        pg_args!(user.user_id, client_id),
    ).await.map_err(|e| {
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

// ── Workspace deletion (authenticated, admin-only, soft-delete) ──────────────

#[derive(Deserialize)]
pub struct DeleteWorkspaceRequest {
    pub confirmation: String,
}

/// DELETE /api/auth/workspaces/:slug — soft-delete a workspace (admin only).
pub async fn auth_delete_workspace(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    request: axum::extract::Request,
) -> Result<Json<Value>, InternalError> {
    let user = request.extensions().get::<crate::auth::AuthenticatedUser>()
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, Json(json!({"error": "Not authenticated"}))))?
        .clone();

    let body: DeleteWorkspaceRequest = {
        let bytes = axum::body::to_bytes(request.into_body(), 1024 * 64)
            .await
            .map_err(|_| (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid body"}))))?;
        serde_json::from_slice(&bytes)
            .map_err(|_| (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid JSON"}))))?
    };

    if body.confirmation.trim().to_lowercase() != "delete workspace" {
        return Err(crate::error::ApiError::bad_request("Confirmation text must be exactly \"delete workspace\"").into());
    }

    // Verify the user is an admin on this workspace
    let role_rows = state.db.execute_with(
        "SELECT ucr.role FROM user_client_roles ucr \
         JOIN clients c ON ucr.client_id = c.id \
         WHERE ucr.user_id = $1 AND c.slug = $2",
        crate::pg_args!(user.user_id, slug.clone()),
    ).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    let role = role_rows.first()
        .and_then(|r| r.get("role").and_then(|v| v.as_str().map(String::from)))
        .ok_or_else(|| (StatusCode::NOT_FOUND, Json(json!({"error": "Workspace not found or you don't have access"}))))?;

    if role != "admin" {
        return Err(crate::error::ApiError::forbidden("Only workspace admins can delete a workspace").into());
    }

    // Soft-delete: set deleted_at and deleted_by
    state.db.execute_with(
        "UPDATE clients SET deleted_at = NOW(), deleted_by = $1 WHERE slug = $2 AND deleted_at IS NULL",
        crate::pg_args!(user.user_id, slug.clone()),
    ).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    info!(user = %user.email, workspace = %slug, "workspace soft-deleted");

    Ok(Json(json!({"ok": true, "slug": slug})))
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
        json!({"slug": "clay",       "name": "Clay",        "auth_type": "api_key", "icon": "clay",
               "description": "Data enrichment — table creation, schema management, row operations, and enrichment triggers",
               "key_url": "https://app.clay.com/settings",   "key_help": "Find your API key under Settings → API Keys at app.clay.com/settings",
               "extra_fields": ["session_cookie", "workspace_id"],
               "setup_steps": [
                   {"label": "Get session cookie (enables full table & column automation)", "help": "In Chrome, open app.clay.com (logged in) → press F12 → go to Application tab → Cookies in the left sidebar → click on https://api.clay.com (NOT app.clay.com) → find the cookie named 'claysession' → copy its Value (starts with s%3A…). Paste just the raw value — do NOT include 'claysession=' as a prefix. The cookie lasts ~7 days before you need to refresh it.", "required": false},
                   {"label": "Get workspace ID", "help": "Your workspace ID is the number in the Clay URL: app.clay.com/workspaces/<ID>/… You can find it by navigating to any page inside your Clay workspace.", "required": false}
               ]}),
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
            item.as_object_mut().expect("DB row is always a JSON object").insert("oauth_configured".to_string(), json!(configured));
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
) -> Result<Json<Value>, InternalError> {
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
            if let Some(cred) = crate::actions::action_credential(tool_name) {
                if !all_required.contains(&cred) {
                    all_required.push(cred);
                }
            }
        }

        // Determine which are missing
        let missing: Vec<String> = all_required.iter()
            .filter(|req| {
                if *req == "tavily" && has_global_tavily { return false; }
                !connected.contains(req)
            })
            .cloned()
            .collect();

        let tool_details: Vec<Value> = agent.tools.iter().map(|t| {
            let cred = crate::actions::action_credential(t);
            let cred_status = match &cred {
                Some(c) => {
                    if connected.contains(c) || (c == "tavily" && has_global_tavily) {
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
                detail.as_object_mut().expect("DB row is always a JSON object").insert("setup_steps".to_string(), steps);
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
                        // Credential exists but no probe is defined — trust the stored key
                        probe_results_json[slug] = json!({ "status": "skipped", "ok": true });
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
) -> Result<Json<Value>, InternalError> {
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
    // Build parameterized query based on which filters are provided
    let rows = match (&query.scope, &query.scope_id, &query.primitive_type) {
        (Some(scope), Some(scope_id), Some(ptype)) => {
            state.db.execute_with(
                "SELECT * FROM overlays WHERE scope = $1 AND scope_id = $2 AND primitive_type = $3 ORDER BY created_at DESC LIMIT 100",
                pg_args!(scope.clone(), scope_id.clone(), ptype.clone()),
            ).await.unwrap_or_default()
        }
        (Some(scope), Some(scope_id), None) => {
            state.db.execute_with(
                "SELECT * FROM overlays WHERE scope = $1 AND scope_id = $2 ORDER BY created_at DESC LIMIT 100",
                pg_args!(scope.clone(), scope_id.clone()),
            ).await.unwrap_or_default()
        }
        (Some(scope), None, Some(ptype)) => {
            state.db.execute_with(
                "SELECT * FROM overlays WHERE scope = $1 AND primitive_type = $2 ORDER BY created_at DESC LIMIT 100",
                pg_args!(scope.clone(), ptype.clone()),
            ).await.unwrap_or_default()
        }
        (None, Some(scope_id), Some(ptype)) => {
            state.db.execute_with(
                "SELECT * FROM overlays WHERE scope_id = $1 AND primitive_type = $2 ORDER BY created_at DESC LIMIT 100",
                pg_args!(scope_id.clone(), ptype.clone()),
            ).await.unwrap_or_default()
        }
        (Some(scope), None, None) => {
            state.db.execute_with(
                "SELECT * FROM overlays WHERE scope = $1 ORDER BY created_at DESC LIMIT 100",
                pg_args!(scope.clone()),
            ).await.unwrap_or_default()
        }
        (None, Some(scope_id), None) => {
            state.db.execute_with(
                "SELECT * FROM overlays WHERE scope_id = $1 ORDER BY created_at DESC LIMIT 100",
                pg_args!(scope_id.clone()),
            ).await.unwrap_or_default()
        }
        (None, None, Some(ptype)) => {
            state.db.execute_with(
                "SELECT * FROM overlays WHERE primitive_type = $1 ORDER BY created_at DESC LIMIT 100",
                pg_args!(ptype.clone()),
            ).await.unwrap_or_default()
        }
        (None, None, None) => {
            state.db.execute_unparameterized(
                "SELECT * FROM overlays ORDER BY created_at DESC LIMIT 100",
            ).await.unwrap_or_default()
        }
    };
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
) -> Result<Json<Value>, InternalError> {
    let count = crate::pattern_promoter::run_promotion_scan(
        &state.db,
        &state.settings.anthropic_api_key,
        &state.settings.anthropic_model,
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({"promoted": count})))
}

/// GET /api/overlays/:id/history — version history chain for an overlay.
pub async fn overlay_history(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(overlay_id): axum::extract::Path<String>,
) -> Json<Value> {
    let overlay_uuid = match overlay_id.parse::<Uuid>() {
        Ok(id) => id,
        Err(_) => return Json(json!({"history": [], "count": 0})),
    };

    let rows = state.db.execute_with(
        r#"WITH RECURSIVE chain AS (
            SELECT id, primitive_type, primitive_id, scope, scope_id, content,
                   source, version, supersedes, metadata, created_at, updated_at
            FROM overlays WHERE id = $1
            UNION ALL
            SELECT o.id, o.primitive_type, o.primitive_id, o.scope, o.scope_id, o.content,
                   o.source, o.version, o.supersedes, o.metadata, o.created_at, o.updated_at
            FROM overlays o
            INNER JOIN chain c ON o.id = c.supersedes
        )
        SELECT * FROM chain ORDER BY version DESC"#,
        pg_args!(overlay_uuid),
    ).await.unwrap_or_default();

    let count = rows.len();
    Json(json!({"history": rows, "count": count}))
}

// ── Projects Routes ─────────────────────────────────────────────────────────

/// GET /api/projects — list projects.
pub async fn projects_list(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<ProjectsQuery>,
) -> Json<Value> {
    let mut clauses = vec!["1=1".to_string()];
    let mut args = sqlx::postgres::PgArguments::default();
    use sqlx::Arguments as _;
    let mut pi = 1u32;
    if let Some(ref client_id) = query.client_id {
        clauses.push(format!("p.client_id = ${pi}::uuid"));
        pi += 1;
        args.add(client_id.clone()).expect("encode");
    }
    if let Some(ref client_slug) = query.client_slug {
        clauses.push(format!("c.slug = ${pi}"));
        pi += 1;
        args.add(client_slug.clone()).expect("encode");
    }

    // sql-format-ok: dynamic WHERE — `clauses` are hardcoded `column = $N` fragments
    // built above, all real values bound via `args`.
    let sql = format!(
        "SELECT p.*, c.name as client_name FROM projects p \
         JOIN clients c ON p.client_id = c.id \
         WHERE {} ORDER BY p.created_at DESC LIMIT 100",
        clauses.join(" AND ")
    );
    let _ = pi; // suppress unused warning
    let rows = state.db.execute_with(&sql, args).await.unwrap_or_default();
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
    pub slack_channel_id: Option<String>,
}

/// POST /api/projects — create a project.
pub async fn project_create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateProjectRequest>,
) -> Result<Json<Value>, InternalError> {
    let client_rows = state.db.execute_with(
        "SELECT id FROM clients WHERE slug = $1 AND deleted_at IS NULL",
        crate::pg_args!(body.client_slug.clone()),
    ).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;
    let client_id: Uuid = client_rows.first()
        .and_then(|r| r.get("id").and_then(Value::as_str))
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| (StatusCode::NOT_FOUND, Json(json!({"error": "Client not found"}))))?;

    let expert_id: Option<Uuid> = if let Some(ref es) = body.expert_slug {
        let rows = state.db.execute_with(
            "SELECT id FROM experts WHERE slug = $1",
            crate::pg_args!(es.clone()),
        ).await.unwrap_or_default();
        rows.first()
            .and_then(|r| r.get("id").and_then(Value::as_str))
            .and_then(|id| id.parse().ok())
    } else {
        None
    };

    let id = Uuid::new_v4();

    state.db.execute_with(
        "INSERT INTO projects (id, slug, name, client_id, expert_id, description, slack_channel_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
        crate::pg_args!(id, body.slug.clone(), body.name.clone(), client_id, expert_id, body.description.clone(), body.slack_channel_id.clone()),
    ).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({"project_id": id.to_string()})))
}

#[derive(Deserialize)]
pub struct UpdateProjectRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub slack_channel_id: Option<String>,
}

/// PATCH /api/projects/:project_id — update a project.
pub async fn project_update(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Json(body): Json<UpdateProjectRequest>,
) -> Result<Json<Value>, InternalError> {
    let pid: Uuid = project_id.parse().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid project ID"})))
    })?;

    // Build SET clauses and corresponding parameters dynamically
    let mut sets = Vec::new();
    let mut param_idx = 1u32;
    let mut args = sqlx::postgres::PgArguments::default();
    use sqlx::Arguments as _;

    if let Some(ref name) = body.name {
        sets.push(format!("name = ${param_idx}"));
        param_idx += 1;
        args.add(name.clone()).expect("pg_args: encode failed");
    }
    if let Some(ref desc) = body.description {
        sets.push(format!("description = ${param_idx}"));
        param_idx += 1;
        args.add(desc.clone()).expect("pg_args: encode failed");
    }
    // Allow explicit null to clear slack_channel_id
    if body.slack_channel_id.is_some() {
        let val = body.slack_channel_id.as_deref()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        sets.push(format!("slack_channel_id = ${param_idx}"));
        param_idx += 1;
        args.add(val).expect("pg_args: encode failed");
    }

    if sets.is_empty() {
        return Ok(Json(json!({"updated": false})));
    }

    sets.push("updated_at = NOW()".to_string());
    args.add(pid).expect("pg_args: encode failed");

    // sql-format-ok: dynamic UPDATE — `sets` are hardcoded `column = $N` fragments
    // built above, all real values bound via `args`.
    let sql = format!(
        "UPDATE projects SET {} WHERE id = ${param_idx}",
        sets.join(", ")
    );
    state.db.execute_with(&sql, args).await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({"updated": true})))
}

// ── Project Resources Routes (SD-008) ───────────────────────────────────────

/// GET /api/projects/:project_id/resources — list linked resources for a project.
pub async fn project_resources_list(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
) -> Result<Json<Value>, InternalError> {
    let pid: Uuid = project_id.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
    let rows = state.db.execute_with(
        "SELECT id, project_id, integration_slug, resource_type, external_id, \
                external_url, display_name, discovered_metadata, last_synced_at, created_at \
         FROM project_resources WHERE project_id = $1 ORDER BY integration_slug, display_name",
        pg_args!(pid),
    ).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(json!({"resources": rows})))
}

#[derive(Deserialize)]
pub struct LinkResourceRequest {
    pub integration_slug: String,
    pub resource_type: String,
    pub external_id: String,
    pub external_url: Option<String>,
    pub display_name: String,
    pub discovered_metadata: Option<Value>,
}

/// POST /api/projects/:project_id/resources — link a resource to a project.
pub async fn project_resource_create(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Json(body): Json<LinkResourceRequest>,
) -> Result<Json<Value>, InternalError> {
    let pid: Uuid = project_id.parse().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid project_id"})))
    })?;
    let metadata = body.discovered_metadata.unwrap_or(json!({}));
    let rows = state.db.execute_with(
        "INSERT INTO project_resources \
            (project_id, integration_slug, resource_type, external_id, external_url, display_name, discovered_metadata, last_synced_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) \
         ON CONFLICT (project_id, integration_slug, external_id) DO UPDATE SET \
            display_name = EXCLUDED.display_name, \
            discovered_metadata = EXCLUDED.discovered_metadata, \
            last_synced_at = NOW() \
         RETURNING id",
        pg_args!(pid, body.integration_slug, body.resource_type, body.external_id,
                 body.external_url, body.display_name, metadata),
    ).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    let resource_id = rows.first()
        .and_then(|r| r.get("id").and_then(Value::as_str))
        .unwrap_or("unknown");

    Ok(Json(json!({"ok": true, "resource_id": resource_id})))
}

/// DELETE /api/projects/:project_id/resources/:resource_id — unlink a resource.
pub async fn project_resource_delete(
    State(state): State<Arc<AppState>>,
    Path((project_id, resource_id)): Path<(String, String)>,
) -> Result<Json<Value>, InternalError> {
    let pid: Uuid = project_id.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
    let rid: Uuid = resource_id.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
    state.db.execute_with(
        "DELETE FROM project_resources WHERE id = $1 AND project_id = $2",
        pg_args!(rid, pid),
    ).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(json!({"ok": true})))
}

/// POST /api/projects/:project_id/resources/:resource_id/sync — re-sync resource metadata.
pub async fn project_resource_sync(
    State(state): State<Arc<AppState>>,
    Path((project_id, resource_id)): Path<(String, String)>,
) -> Result<Json<Value>, InternalError> {
    let pid: Uuid = project_id.parse().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid project_id"})))
    })?;
    let rid: Uuid = resource_id.parse().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid resource_id"})))
    })?;

    let rows = state.db.execute_with(
        "SELECT pr.integration_slug, pr.external_id, p.client_id \
         FROM project_resources pr JOIN projects p ON pr.project_id = p.id \
         WHERE pr.id = $1 AND pr.project_id = $2",
        pg_args!(rid, pid),
    ).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    let row = rows.first().ok_or_else(|| {
        (StatusCode::NOT_FOUND, Json(json!({"error": "Resource not found"})))
    })?;
    let integration_slug = row.get("integration_slug").and_then(Value::as_str).unwrap_or("");
    let client_id: Uuid = row.get("client_id").and_then(Value::as_str)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "Missing client_id"}))))?;

    let master_key = state.settings.credential_master_key.as_deref()
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "CREDENTIAL_MASTER_KEY not set"}))))?;

    let credentials = crate::credentials::load_credentials_for_project(&state.db, master_key, pid, client_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    let discovered = crate::discovery::discover_resources(integration_slug, &credentials)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("Discovery failed: {e}")}))))?;

    let external_id = row.get("external_id").and_then(Value::as_str).unwrap_or("");
    if let Some(updated) = discovered.iter().find(|r| r.external_id == external_id) {
        state.db.execute_with(
            "UPDATE project_resources SET discovered_metadata = $1, last_synced_at = NOW() \
             WHERE id = $2",
            pg_args!(updated.metadata.clone(), rid),
        ).await.map_err(|e| {
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
        })?;
        return Ok(Json(json!({"ok": true, "synced": true, "metadata": updated.metadata})));
    }

    Ok(Json(json!({"ok": true, "synced": false, "message": "Resource not found in external system"})))
}

#[derive(Deserialize)]
pub struct DiscoverQuery {
    pub client_slug: Option<String>,
    pub project_id: Option<String>,
}

/// GET /api/integrations/:slug/discover — auto-discover resources from a connected integration.
pub async fn integration_discover(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    axum::extract::Query(query): axum::extract::Query<DiscoverQuery>,
) -> Result<Json<Value>, InternalError> {
    let project_id: Option<Uuid> = query.project_id.as_deref()
        .and_then(|s| s.parse().ok());

    let (client_id, pid) = if let Some(pid) = project_id {
        let rows = state.db.execute_with(
            "SELECT client_id FROM projects WHERE id = $1", pg_args!(pid),
        ).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let cid: Uuid = rows.first()
            .and_then(|r| r.get("client_id").and_then(Value::as_str))
            .and_then(|s| s.parse().ok())
            .ok_or(StatusCode::NOT_FOUND)?;
        (cid, Some(pid))
    } else if let Some(ref cs) = query.client_slug {
        let rows = state.db.execute_with(
            "SELECT id FROM clients WHERE slug = $1", pg_args!(cs.clone()),
        ).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let cid: Uuid = rows.first()
            .and_then(|r| r.get("id").and_then(Value::as_str))
            .and_then(|s| s.parse().ok())
            .ok_or(StatusCode::NOT_FOUND)?;
        (cid, None)
    } else {
        return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "Provide client_slug or project_id"}))).into());
    };

    let master_key = state.settings.credential_master_key.as_deref()
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "CREDENTIAL_MASTER_KEY not set"}))))?;

    let credentials = if let Some(pid) = pid {
        crate::credentials::load_credentials_for_project(&state.db, master_key, pid, client_id).await
    } else {
        crate::credentials::load_credentials_for_client(&state.db, master_key, client_id).await
    }.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    let resources = crate::discovery::discover_resources(&slug, &credentials)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({"error": format!("Discovery failed: {e}")}))))?;

    let already_linked: Vec<String> = if let Some(pid) = pid {
        let rows = state.db.execute_with(
            "SELECT external_id FROM project_resources WHERE project_id = $1 AND integration_slug = $2",
            pg_args!(pid, slug.clone()),
        ).await.unwrap_or_default();
        rows.iter()
            .filter_map(|r| r.get("external_id").and_then(Value::as_str).map(String::from))
            .collect()
    } else {
        vec![]
    };

    let results: Vec<Value> = resources.iter().map(|r| {
        let linked = already_linked.contains(&r.external_id);
        json!({
            "external_id": r.external_id,
            "resource_type": r.resource_type,
            "display_name": r.display_name,
            "external_url": r.external_url,
            "metadata": r.metadata,
            "already_linked": linked,
        })
    }).collect();

    Ok(Json(json!({"integration": slug, "resources": results})))
}

// ── Project Credentials Routes ──────────────────────────────────────────────

/// GET /api/projects/:project_id/credentials — list project-level overrides + inherited
pub async fn project_credentials_list(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
) -> Result<Json<Value>, InternalError> {
    let pid: uuid::Uuid = project_id.parse().map_err(|_| StatusCode::BAD_REQUEST)?;

    // Get client_id for this project
    let rows = state.db.execute_with(
        "SELECT client_id FROM projects WHERE id = $1",
        crate::pg_args!(pid),
    ).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
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
        entry.as_object_mut().expect("DB row is always a JSON object").insert("scope".into(), json!("project"));
        entry
    }).collect();

    for c in &client_creds {
        let slug = c.get("integration_slug").and_then(Value::as_str).unwrap_or("");
        if !project_slugs.contains(&slug.to_string()) {
            let mut entry = c.clone();
            entry.as_object_mut().expect("DB row is always a JSON object").insert("scope".into(), json!("inherited"));
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
) -> Result<Json<Value>, InternalError> {
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
) -> Result<Json<Value>, InternalError> {
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
) -> Result<Json<Value>, InternalError> {
    let pid: uuid::Uuid = project_id.parse().map_err(|_| StatusCode::BAD_REQUEST)?;

    let rows = state.db.execute_with(
        "SELECT client_id FROM projects WHERE id = $1",
        crate::pg_args!(pid),
    ).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
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
) -> Result<Json<Value>, InternalError> {
    let pid: uuid::Uuid = project_id.parse().map_err(|_| StatusCode::BAD_REQUEST)?;

    let rows = state.db.execute_with(
        "SELECT pm.id, pm.role, pm.created_at, \
                u.id as user_id, u.email, u.name, u.avatar_url \
         FROM project_members pm \
         JOIN users u ON pm.user_id = u.id \
         WHERE pm.project_id = $1 \
         ORDER BY pm.created_at",
        crate::pg_args!(pid),
    ).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Also include client-level members (inherited)
    let client_rows = state.db.execute_with(
        "SELECT ucr.role, ucr.created_at, \
                u.id as user_id, u.email, u.name, u.avatar_url \
         FROM user_client_roles ucr \
         JOIN users u ON ucr.user_id = u.id \
         JOIN projects p ON p.client_id = ucr.client_id \
         WHERE p.id = $1 \
         ORDER BY ucr.created_at",
        crate::pg_args!(pid),
    ).await.unwrap_or_default();

    let project_user_ids: Vec<String> = rows.iter()
        .filter_map(|r| r.get("user_id").and_then(Value::as_str).map(String::from))
        .collect();

    let mut members: Vec<Value> = rows.iter().map(|r| {
        let mut m = r.clone();
        m.as_object_mut().expect("DB row is always a JSON object").insert("scope".into(), json!("project"));
        m
    }).collect();

    for r in &client_rows {
        let uid = r.get("user_id").and_then(Value::as_str).unwrap_or("");
        if !project_user_ids.contains(&uid.to_string()) {
            let mut m = r.clone();
            m.as_object_mut().expect("DB row is always a JSON object").insert("scope".into(), json!("inherited"));
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
) -> Result<Json<Value>, InternalError> {
    let pid: uuid::Uuid = project_id.parse()
        .map_err(|_| (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid project_id"}))))?;
    let role = body.role.as_deref().unwrap_or("member");
    let email = body.email.trim().to_lowercase();

    // Find or create user by email (they'll complete signup on first Google login)
    let user_rows = state.db.execute_with(
        "INSERT INTO users (email, name) VALUES ($1, $1) \
         ON CONFLICT (email) DO UPDATE SET updated_at = NOW() \
         RETURNING id",
        crate::pg_args!(email.clone()),
    ).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    let user_id: Uuid = user_rows.first()
        .and_then(|r| r.get("id").and_then(Value::as_str))
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "Failed to find/create user"}))))?;

    state.db.execute_with(
        "INSERT INTO project_members (project_id, user_id, role) \
         VALUES ($1, $2, $3) \
         ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role",
        crate::pg_args!(pid, user_id, role.to_string()),
    ).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({ "invited": true, "user_id": user_id, "email": body.email.trim() })))
}

/// DELETE /api/projects/:project_id/members/:user_id
pub async fn project_member_remove(
    State(state): State<Arc<AppState>>,
    Path((project_id, user_id)): Path<(String, String)>,
) -> Result<Json<Value>, InternalError> {
    let pid: uuid::Uuid = project_id.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
    let uid: uuid::Uuid = user_id.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
    state.db.execute_with(
        "DELETE FROM project_members WHERE project_id = $1 AND user_id = $2",
        crate::pg_args!(pid, uid),
    ).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(json!({"removed": true})))
}

// ── Skills Routes ───────────────────────────────────────────────────────────

/// GET /api/skills — list all skills.
pub async fn skills_list(
    State(state): State<Arc<AppState>>,
) -> Json<Value> {
    let rows = state.db.execute_unparameterized(
        "SELECT id, slug, name, description, default_tools, max_iterations, model, skip_judge, expert_id, created_at          FROM skills ORDER BY slug"
    ).await.unwrap_or_default();
    Json(json!({"skills": rows}))
}

// ── Platform Tools (SD-004) ──────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ToolsQuery {
    pub category: Option<String>,
}

pub async fn tools_list(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<ToolsQuery>,
) -> Json<Value> {
    let tools: Vec<Value> = if let Some(ref cat) = query.category {
        state
            .tool_catalog
            .tools_by_category(cat)
            .into_iter()
            .map(|t| tool_to_json(&t))
            .collect()
    } else {
        state
            .tool_catalog
            .all_tools()
            .into_iter()
            .map(|t| tool_to_json(&t))
            .collect()
    };
    Json(json!({"tools": tools}))
}

pub async fn tools_get(
    State(state): State<Arc<AppState>>,
    Path(tool_id): Path<String>,
) -> impl IntoResponse {
    match state.tool_catalog.get_tool(&tool_id) {
        Some(tool) => Json(json!(tool_to_json(&tool))).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({"error": "tool not found"}))).into_response(),
    }
}

pub async fn tool_categories_list(
    State(state): State<Arc<AppState>>,
) -> Json<Value> {
    let categories: Vec<Value> = state
        .tool_catalog
        .all_categories()
        .into_iter()
        .map(|c| {
            json!({
                "id": c.id,
                "name": c.name,
                "description": c.description,
                "tools": state.tool_catalog.tools_by_category(&c.id)
                    .into_iter()
                    .map(|t| json!({"id": t.id, "name": t.name, "description": t.description, "enabled": t.enabled}))
                    .collect::<Vec<_>>(),
            })
        })
        .collect();
    Json(json!({"categories": categories}))
}

// ── Knowledge Corpus ──────────────────────────────────────────────────────────

async fn resolve_tenant_id(raw: &str, db: &crate::pg::PgClient) -> Result<Uuid, (StatusCode, Json<Value>)> {
    if let Ok(u) = raw.parse::<Uuid>() {
        return Ok(u);
    }
    match db.execute_with(
        "SELECT id FROM clients WHERE slug = $1 AND deleted_at IS NULL",
        pg_args!(raw.to_string()),
    ).await {
        Ok(rows) if !rows.is_empty() => {
            let id_str = rows[0].get("id").and_then(|v| v.as_str()).unwrap_or("");
            id_str.parse::<Uuid>().map_err(|_| {
                (StatusCode::BAD_REQUEST, Json(json!({"error": "Could not resolve tenant"})))
            })
        }
        _ => Err((StatusCode::BAD_REQUEST, Json(json!({"error": format!("Unknown workspace: {raw}")}))).into()),
    }
}

#[derive(Deserialize)]
pub struct KnowledgeQuery {
    pub tenant_id: Option<String>,
    pub project_id: Option<String>,
    pub folder: Option<String>,
    pub status: Option<String>,
}

pub async fn knowledge_documents_list(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<KnowledgeQuery>,
) -> impl IntoResponse {
    use sqlx::Arguments as _;
    let mut clauses: Vec<String> = vec!["1=1".to_string()];
    let mut args = sqlx::postgres::PgArguments::default();
    let mut pi: u32 = 1;

    if let Some(ref tid) = query.tenant_id {
        match resolve_tenant_id(tid, &state.db).await {
            Ok(t) => {
                clauses.push(format!("tenant_id = ${pi}"));
                pi += 1;
                args.add(t).expect("encode");
            }
            Err(e) => return e.into_response(),
        }
    }
    if let Some(ref folder) = query.folder {
        clauses.push(format!("source_folder LIKE ${pi}"));
        pi += 1;
        args.add(format!("{folder}%")).expect("encode");
    }
    if let Some(ref status) = query.status {
        let valid = ["pending", "processing", "ready", "error"];
        if valid.contains(&status.as_str()) {
            clauses.push(format!("status = ${pi}"));
            pi += 1;
            args.add(status.clone()).expect("encode");
        }
    }
    let _ = pi;

    // sql-format-ok: dynamic WHERE — `clauses` are hardcoded `column op $N` fragments
    // built above, all real values bound via `args`.
    let sql = format!(
        "SELECT id, tenant_id, project_id, expert_id, source_filename, \
                source_path, source_folder, mime_type, file_hash, status, \
                error_message, chunk_count, inferred_scope, inferred_scope_id, \
                created_at, updated_at \
         FROM knowledge_documents WHERE {} ORDER BY source_path ASC",
        clauses.join(" AND ")
    );

    match state.db.execute_with(&sql, args).await {
        Ok(rows) => Json(json!({"documents": rows})).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))).into_response(),
    }
}

pub async fn knowledge_document_get(
    State(state): State<Arc<AppState>>,
    Path(doc_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<KnowledgeQuery>,
) -> impl IntoResponse {
    let doc_uuid = match doc_id.parse::<Uuid>() {
        Ok(u) => u,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(json!({"error": "invalid document id"}))).into_response(),
    };
    let result = if let Some(ref tid) = query.tenant_id {
        match resolve_tenant_id(tid, &state.db).await {
            Ok(t) => state.db.execute_with(
                "SELECT id, tenant_id, project_id, expert_id, source_filename, \
                        source_path, source_folder, mime_type, file_hash, normalized_markdown, \
                        status, error_message, chunk_count, inferred_scope, inferred_scope_id, \
                        file_size_bytes, (raw_content IS NOT NULL) as has_raw_content, \
                        created_at, updated_at \
                 FROM knowledge_documents WHERE id = $1 AND tenant_id = $2",
                pg_args!(doc_uuid, t),
            ).await,
            Err(_) => Ok(vec![]),
        }
    } else {
        state.db.execute_with(
            "SELECT id, tenant_id, project_id, expert_id, source_filename, \
                    source_path, source_folder, mime_type, file_hash, normalized_markdown, \
                    status, error_message, chunk_count, inferred_scope, inferred_scope_id, \
                    file_size_bytes, (raw_content IS NOT NULL) as has_raw_content, \
                    created_at, updated_at \
             FROM knowledge_documents WHERE id = $1",
            pg_args!(doc_uuid),
        ).await
    };
    match result {
        Ok(rows) if !rows.is_empty() => Json(json!(rows[0])).into_response(),
        _ => (StatusCode::NOT_FOUND, Json(json!({"error": "document not found"}))).into_response(),
    }
}

pub async fn knowledge_document_chunks(
    State(state): State<Arc<AppState>>,
    Path(doc_id): Path<String>,
) -> impl IntoResponse {
    let doc_uuid = match doc_id.parse::<Uuid>() {
        Ok(u) => u,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(json!({"error": "invalid document id"}))).into_response(),
    };
    match state.db.execute_with(
        "SELECT id, chunk_index, section_title, content, token_count, metadata, created_at \
         FROM knowledge_chunks WHERE document_id = $1 ORDER BY chunk_index",
        pg_args!(doc_uuid),
    ).await {
        Ok(rows) => Json(json!({"chunks": rows})).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))).into_response(),
    }
}

pub async fn knowledge_document_raw(
    State(state): State<Arc<AppState>>,
    Path(doc_id): Path<String>,
) -> impl IntoResponse {
    let doc_uuid = match doc_id.parse::<Uuid>() {
        Ok(u) => u,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(json!({"error": "invalid document id"}))).into_response(),
    };
    match state.db.execute_with(
        "SELECT raw_content, source_filename, mime_type \
         FROM knowledge_documents WHERE id = $1",
        pg_args!(doc_uuid),
    ).await {
        Ok(rows) if !rows.is_empty() => {
            let raw = rows[0].get("raw_content").and_then(|v| v.as_str());
            match raw {
                Some(b64) => Json(json!({
                    "raw_content": b64,
                    "source_filename": rows[0].get("source_filename"),
                    "mime_type": rows[0].get("mime_type"),
                })).into_response(),
                None => (StatusCode::NOT_FOUND, Json(json!({"error": "no raw content available"}))).into_response(),
            }
        }
        _ => (StatusCode::NOT_FOUND, Json(json!({"error": "document not found"}))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct KnowledgeUploadBody {
    pub tenant_id: String,
    pub source_path: String,
    /// Text content for text files, or base64-encoded content for binary files.
    pub content: String,
    pub mime_type: Option<String>,
    pub project_id: Option<String>,
    pub expert_id: Option<String>,
    /// Set to true when content is base64-encoded binary data.
    #[serde(default)]
    pub is_binary: bool,
    /// Original file size in bytes (for display).
    pub file_size_bytes: Option<i64>,
}

pub async fn knowledge_document_upload(
    State(state): State<Arc<AppState>>,
    Json(body): Json<KnowledgeUploadBody>,
) -> impl IntoResponse {
    let tenant_uuid = match resolve_tenant_id(&body.tenant_id, &state.db).await {
        Ok(u) => u,
        Err(e) => return e.into_response(),
    };

    let mime = body.mime_type.as_deref().unwrap_or("text/markdown");
    let text_mimes = ["text/markdown", "text/plain", "text/csv", "text/html", "application/json"];
    let is_text = text_mimes.iter().any(|m| mime.starts_with(m)) || body.source_path.ends_with(".md");
    let is_binary = body.is_binary || !is_text;

    // Supported binary formats for Docling conversion
    let binary_mimes = [
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // docx
        "application/vnd.openxmlformats-officedocument.presentationml.presentation", // pptx
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // xlsx
        "application/vnd.ms-excel",
        "application/vnd.ms-powerpoint",
        "application/msword",
        "application/zip",
        "application/x-zip-compressed",
    ];
    if is_binary && !binary_mimes.iter().any(|m| mime.starts_with(m)) {
        return (StatusCode::BAD_REQUEST, Json(json!({
            "error": format!("Unsupported file type: {}. Supported: text, markdown, PDF, DOCX, PPTX, XLSX, ZIP.", mime)
        }))).into_response();
    }

    let id = Uuid::new_v4();
    let source_path = body.source_path.trim_start_matches('/');
    let source_folder = source_path
        .rsplit_once('/')
        .map(|(folder, _)| folder)
        .unwrap_or("");
    let source_filename = source_path
        .rsplit_once('/')
        .map(|(_, name)| name)
        .unwrap_or(source_path);
    use sha2::{Sha256, Digest};
    let file_hash = format!("{:x}", Sha256::digest(body.content.as_bytes()));

    let storage_key = format!("knowledge/{id}");

    let (inferred_scope, inferred_scope_id) = infer_scope_from_path(
        source_path, &body.tenant_id, &state.db
    ).await;

    let project_uuid = body.project_id.as_deref()
        .or(if inferred_scope == "project" { inferred_scope_id.as_deref() } else { None })
        .and_then(|p| p.parse::<Uuid>().ok());
    let expert_uuid = body.expert_id.as_deref()
        .and_then(|e| e.parse::<Uuid>().ok());
    let scope_uuid = inferred_scope_id.as_deref()
        .and_then(|s| s.parse::<Uuid>().ok());

    // For text files: store as normalized_markdown directly
    // For binary files: store base64 in raw_content, worker will convert via Docling
    let normalized_md: Option<String> = if is_text { Some(body.content.clone()) } else { None };
    let raw_content: Option<String> = if is_binary { Some(body.content.clone()) } else { None };

    let result = state.db.execute_with(
        r#"INSERT INTO knowledge_documents
           (id, tenant_id, project_id, expert_id, source_filename, source_path,
            source_folder, mime_type, storage_key, file_hash, normalized_markdown,
            raw_content, file_size_bytes,
            inferred_scope, inferred_scope_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'pending')"#,
        pg_args!(
            id, tenant_uuid, project_uuid, expert_uuid,
            source_filename.to_string(), source_path.to_string(),
            source_folder.to_string(), mime.to_string(),
            storage_key, file_hash,
            normalized_md, raw_content, body.file_size_bytes,
            inferred_scope, scope_uuid
        ),
    ).await;

    match result {
        Ok(_) => {
            info!(id = %id, path = %source_path, mime = %mime, binary = is_binary, "knowledge document created");
            (StatusCode::CREATED, Json(json!({
                "id": id, "status": "pending", "source_path": source_path, "is_binary": is_binary
            }))).into_response()
        }
        Err(e) => {
            error!(error = %e, "failed to create knowledge document");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))).into_response()
        }
    }
}

pub async fn knowledge_document_upload_multipart(
    State(state): State<Arc<AppState>>,
    mut multipart: axum::extract::Multipart,
) -> impl IntoResponse {
    let mut tenant_id: Option<String> = None;
    let mut source_path: Option<String> = None;
    let mut mime_type: Option<String> = None;
    let mut project_id: Option<String> = None;
    let mut expert_id: Option<String> = None;
    let mut file_bytes: Option<Vec<u8>> = None;
    let mut file_size: Option<i64> = None;
    let mut original_filename: Option<String> = None;

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "tenant_id" => tenant_id = field.text().await.ok(),
            "source_path" => source_path = field.text().await.ok(),
            "mime_type" => mime_type = field.text().await.ok(),
            "project_id" => { let v = field.text().await.ok(); if v.as_deref() != Some("") { project_id = v; } }
            "expert_id" => { let v = field.text().await.ok(); if v.as_deref() != Some("") { expert_id = v; } }
            "file" => {
                original_filename = field.file_name().map(|s| s.to_string());
                match field.bytes().await {
                    Ok(b) => {
                        file_size = Some(b.len() as i64);
                        file_bytes = Some(b.to_vec());
                    }
                    Err(e) => {
                        return (StatusCode::BAD_REQUEST, Json(json!({"error": format!("Failed to read file: {e}")})))
                            .into_response();
                    }
                }
            }
            _ => {}
        }
    }

    let tenant_str = match tenant_id {
        Some(t) => t,
        None => return (StatusCode::BAD_REQUEST, Json(json!({"error": "tenant_id is required"}))).into_response(),
    };
    let tenant_uuid = match resolve_tenant_id(&tenant_str, &state.db).await {
        Ok(u) => u,
        Err(e) => return e.into_response(),
    };
    let raw_path = match source_path {
        Some(p) if !p.is_empty() => p,
        _ => original_filename.clone().unwrap_or_else(|| "upload".to_string()),
    };
    let bytes = match file_bytes {
        Some(b) => b,
        None => return (StatusCode::BAD_REQUEST, Json(json!({"error": "file field is required"}))).into_response(),
    };

    // Sanitize path: remove leading slashes, block path traversal sequences
    let source_path_str = raw_path.trim_start_matches('/');
    if source_path_str.contains("..") {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid path: directory traversal not allowed"}))).into_response();
    }
    let source_folder = source_path_str.rsplit_once('/').map(|(f, _)| f).unwrap_or("");
    let source_filename = source_path_str.rsplit_once('/').map(|(_, n)| n).unwrap_or(source_path_str);

    let fallback_mime = if source_filename.ends_with(".md") { "text/markdown" }
        else if source_filename.ends_with(".txt") { "text/plain" }
        else if source_filename.ends_with(".csv") { "text/csv" }
        else if source_filename.ends_with(".json") { "application/json" }
        else if source_filename.ends_with(".html") || source_filename.ends_with(".htm") { "text/html" }
        else if source_filename.ends_with(".pdf") { "application/pdf" }
        else if source_filename.ends_with(".zip") { "application/zip" }
        else if source_filename.ends_with(".docx") { "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }
        else if source_filename.ends_with(".pptx") { "application/vnd.openxmlformats-officedocument.presentationml.presentation" }
        else if source_filename.ends_with(".xlsx") { "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }
        else { "application/octet-stream" };
    let mime = mime_type.as_deref().unwrap_or(fallback_mime);

    let text_mimes = ["text/markdown", "text/plain", "text/csv", "text/html", "application/json"];
    let is_text = text_mimes.iter().any(|m| mime.starts_with(m)) || source_filename.ends_with(".md");

    let binary_mimes = [
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-excel", "application/vnd.ms-powerpoint", "application/msword",
        "application/zip", "application/x-zip-compressed",
    ];
    if !is_text && !binary_mimes.iter().any(|m| mime.starts_with(m)) {
        return (StatusCode::BAD_REQUEST, Json(json!({
            "error": format!("Unsupported file type: {}. Supported: text, markdown, PDF, DOCX, PPTX, XLSX, ZIP.", mime)
        }))).into_response();
    }

    let id = Uuid::new_v4();
    use sha2::{Sha256, Digest};
    let file_hash = format!("{:x}", Sha256::digest(&bytes));
    let storage_key = format!("knowledge/{id}");

    let (inferred_scope, inferred_scope_id) = infer_scope_from_path(
        source_path_str, &tenant_str, &state.db
    ).await;

    let project_uuid = project_id.as_deref()
        .or(if inferred_scope == "project" { inferred_scope_id.as_deref() } else { None })
        .and_then(|p| p.parse::<Uuid>().ok());
    let expert_uuid = expert_id.as_deref()
        .and_then(|e| e.parse::<Uuid>().ok());
    let scope_uuid = inferred_scope_id.as_deref()
        .and_then(|s| s.parse::<Uuid>().ok());

    let (normalized_md, raw_content): (Option<String>, Option<String>) = if is_text {
        (Some(String::from_utf8_lossy(&bytes).into_owned()), None)
    } else {
        use base64::Engine;
        (None, Some(base64::engine::general_purpose::STANDARD.encode(&bytes)))
    };

    let result = state.db.execute_with(
        r#"INSERT INTO knowledge_documents
           (id, tenant_id, project_id, expert_id, source_filename, source_path,
            source_folder, mime_type, storage_key, file_hash, normalized_markdown,
            raw_content, file_size_bytes,
            inferred_scope, inferred_scope_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'pending')"#,
        pg_args!(
            id, tenant_uuid, project_uuid, expert_uuid,
            source_filename.to_string(), source_path_str.to_string(),
            source_folder.to_string(), mime.to_string(),
            storage_key, file_hash,
            normalized_md, raw_content, file_size,
            inferred_scope, scope_uuid
        ),
    ).await;

    match result {
        Ok(_) => {
            info!(id = %id, path = %source_path_str, mime = %mime, size = ?file_size, "knowledge document uploaded (multipart)");
            (StatusCode::CREATED, Json(json!({
                "id": id, "status": "pending", "source_path": source_path_str, "is_binary": !is_text
            }))).into_response()
        }
        Err(e) => {
            error!(error = %e, "failed to create knowledge document");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))).into_response()
        }
    }
}

pub async fn knowledge_document_progress(
    State(state): State<Arc<AppState>>,
    Path(doc_id): Path<String>,
) -> impl IntoResponse {
    let doc_uuid = match doc_id.parse::<Uuid>() {
        Ok(u) => u,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(json!({"error": "invalid document id"}))).into_response(),
    };

    let parent = match state.db.execute_with(
        "SELECT id, status, source_filename, chunk_count, error_message \
         FROM knowledge_documents WHERE id = $1",
        pg_args!(doc_uuid),
    ).await {
        Ok(rows) if !rows.is_empty() => rows[0].clone(),
        _ => return (StatusCode::NOT_FOUND, Json(json!({"error": "document not found"}))).into_response(),
    };

    let children_rows = state.db.execute_with(
        "SELECT status, COUNT(*) as count \
         FROM knowledge_documents \
         WHERE parent_document_id = $1 \
         GROUP BY status",
        pg_args!(doc_uuid),
    ).await.unwrap_or_default();

    let mut total: i64 = 0;
    let mut ready: i64 = 0;
    let mut processing: i64 = 0;
    let mut pending: i64 = 0;
    let mut errors: i64 = 0;
    for row in &children_rows {
        let status = row.get("status").and_then(|v| v.as_str()).unwrap_or("");
        let count = row.get("count").and_then(|v| v.as_i64()).unwrap_or(0);
        total += count;
        match status {
            "ready" => ready += count,
            "processing" => processing += count,
            "pending" => pending += count,
            "error" => errors += count,
            _ => {}
        }
    }

    Json(json!({
        "parent_status": parent.get("status"),
        "parent_filename": parent.get("source_filename"),
        "parent_error": parent.get("error_message"),
        "children": {
            "total": total,
            "ready": ready,
            "processing": processing,
            "pending": pending,
            "errors": errors
        }
    })).into_response()
}

pub async fn knowledge_document_delete(
    State(state): State<Arc<AppState>>,
    Path(doc_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<KnowledgeQuery>,
) -> impl IntoResponse {
    let doc_uuid = match doc_id.parse::<Uuid>() {
        Ok(u) => u,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(json!({"error": "invalid document id"}))).into_response(),
    };
    let result = if let Some(ref tid) = query.tenant_id {
        if let Ok(t) = resolve_tenant_id(tid, &state.db).await {
            state.db.execute_with(
                "DELETE FROM knowledge_documents WHERE id = $1 AND tenant_id = $2 RETURNING id",
                pg_args!(doc_uuid, t),
            ).await
        } else {
            state.db.execute_with(
                "DELETE FROM knowledge_documents WHERE id = $1 RETURNING id",
                pg_args!(doc_uuid),
            ).await
        }
    } else {
        state.db.execute_with(
            "DELETE FROM knowledge_documents WHERE id = $1 RETURNING id",
            pg_args!(doc_uuid),
        ).await
    };
    match result {
        Ok(rows) if !rows.is_empty() => (StatusCode::OK, Json(json!({"deleted": doc_id}))).into_response(),
        Ok(_) => (StatusCode::NOT_FOUND, Json(json!({"error": "document not found"}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))).into_response(),
    }
}

/// POST /api/knowledge/documents/:doc_id/reprocess — reset a document to pending
/// so the ingestion worker re-processes it with current converters and embeddings.
pub async fn knowledge_document_reprocess(
    State(state): State<Arc<AppState>>,
    Path(doc_id): Path<String>,
) -> impl IntoResponse {
    let doc_uuid = match doc_id.parse::<Uuid>() {
        Ok(u) => u,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(json!({"error": "invalid document id"}))).into_response(),
    };

    // Delete existing chunks so they get regenerated
    if let Err(e) = state.db.execute_with(
        "DELETE FROM knowledge_chunks WHERE document_id = $1",
        pg_args!(doc_uuid),
    ).await {
        error!(error = %e, "failed to delete chunks for reprocess");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))).into_response();
    }

    // Reset status to pending so the worker picks it up
    match state.db.execute_with(
        "UPDATE knowledge_documents SET status = 'pending', chunk_count = 0, \
         error_message = NULL, analyzed_at = NULL, updated_at = NOW() \
         WHERE id = $1 AND status IN ('ready', 'error') \
         RETURNING id, source_filename, status",
        pg_args!(doc_uuid),
    ).await {
        Ok(rows) if !rows.is_empty() => {
            info!(id = %doc_uuid, "knowledge document queued for reprocessing");
            (StatusCode::OK, Json(json!({
                "id": doc_id,
                "status": "pending",
                "message": "Document queued for reprocessing. Existing chunks have been deleted."
            }))).into_response()
        }
        Ok(_) => (StatusCode::NOT_FOUND, Json(json!({
            "error": "Document not found or not in a reprocessable state (must be 'ready' or 'error')"
        }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct KnowledgeReprocessBulkBody {
    pub extensions: Option<Vec<String>>,
    pub tenant_id: Option<String>,
}

/// POST /api/knowledge/reprocess-bulk — reprocess all documents matching criteria.
/// If extensions is provided, only reprocesses documents with those file extensions.
pub async fn knowledge_reprocess_bulk(
    State(state): State<Arc<AppState>>,
    Json(body): Json<KnowledgeReprocessBulkBody>,
) -> impl IntoResponse {
    use sqlx::Arguments as _;
    let mut where_clauses: Vec<String> = vec!["status IN ('ready', 'error')".to_string()];
    // We build args twice (once per query) so they're independent.
    let mut tenant_uuid: Option<Uuid> = None;
    if let Some(ref tid) = body.tenant_id {
        match resolve_tenant_id(tid, &state.db).await {
            Ok(t) => {
                tenant_uuid = Some(t);
                where_clauses.push("tenant_id = $1".to_string());
            }
            Err(e) => return e.into_response(),
        }
    }

    let mut ext_patterns: Vec<String> = vec![];
    if let Some(ref exts) = body.extensions {
        for e in exts {
            // ILIKE pattern; sanitize % and _ defensively even though we wrap.
            let cleaned: String = e.chars()
                .filter(|c| c.is_alphanumeric() || *c == '.' || *c == '-')
                .collect();
            if !cleaned.is_empty() {
                ext_patterns.push(format!("%.{cleaned}"));
            }
        }
    }

    // Build placeholders for the ext patterns starting after tenant_id (if present).
    let base_idx = if tenant_uuid.is_some() { 2 } else { 1 };
    if !ext_patterns.is_empty() {
        let placeholders: Vec<String> = (0..ext_patterns.len())
            .map(|i| format!("source_filename ILIKE ${}", base_idx + i))
            .collect();
        where_clauses.push(format!("({})", placeholders.join(" OR ")));
    }

    let where_str = where_clauses.join(" AND ");

    let build_args = || {
        let mut a = sqlx::postgres::PgArguments::default();
        if let Some(t) = tenant_uuid { a.add(t).expect("encode"); }
        for p in &ext_patterns { a.add(p.clone()).expect("encode"); }
        a
    };

    // sql-format-ok: `where_str` is built from hardcoded fragments + $N placeholders
    // above; all real values bound via PgArguments.
    let delete_sql = format!(
        "DELETE FROM knowledge_chunks WHERE document_id IN \
         (SELECT id FROM knowledge_documents WHERE {where_str})"
    );
    let _ = state.db.execute_with(&delete_sql, build_args()).await;

    // sql-format-ok: same as above.
    let reset_sql = format!(
        "UPDATE knowledge_documents SET status = 'pending', chunk_count = 0, \
         error_message = NULL, analyzed_at = NULL, updated_at = NOW() \
         WHERE {where_str} RETURNING id"
    );
    match state.db.execute_with(&reset_sql, build_args()).await {
        Ok(rows) => {
            info!(count = rows.len(), "knowledge documents queued for bulk reprocessing");
            (StatusCode::OK, Json(json!({
                "queued": rows.len(),
                "message": format!("{} documents queued for reprocessing", rows.len())
            }))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct KnowledgeFolderDeleteBody {
    pub tenant_id: String,
    pub folder: String,
}

pub async fn knowledge_folder_delete(
    State(state): State<Arc<AppState>>,
    Json(body): Json<KnowledgeFolderDeleteBody>,
) -> impl IntoResponse {
    let tenant_uuid = match resolve_tenant_id(&body.tenant_id, &state.db).await {
        Ok(u) => u,
        Err(e) => return e.into_response(),
    };
    let folder_pattern = format!("{}%", body.folder);

    let _ = state.db.execute_with(
        "DELETE FROM knowledge_chunks WHERE document_id IN \
         (SELECT id FROM knowledge_documents WHERE tenant_id = $1 AND source_folder LIKE $2)",
        pg_args!(tenant_uuid, folder_pattern.clone()),
    ).await;

    match state.db.execute_with(
        "DELETE FROM knowledge_documents WHERE tenant_id = $1 AND source_folder LIKE $2 RETURNING id",
        pg_args!(tenant_uuid, folder_pattern),
    ).await {
        Ok(rows) => {
            info!(folder = %body.folder, count = rows.len(), "deleted knowledge folder");
            Json(json!({"deleted": rows.len(), "folder": body.folder})).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))).into_response(),
    }
}

pub async fn knowledge_folders(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<KnowledgeQuery>,
) -> impl IntoResponse {
    let result = if let Some(ref tid) = query.tenant_id {
        match resolve_tenant_id(tid, &state.db).await {
            Ok(t) => state.db.execute_with(
                "SELECT source_folder, COUNT(*) as file_count, MAX(created_at) as last_updated \
                 FROM knowledge_documents WHERE tenant_id = $1 \
                 GROUP BY source_folder ORDER BY source_folder",
                pg_args!(t),
            ).await,
            Err(e) => return e.into_response(),
        }
    } else {
        state.db.execute_unparameterized(
            "SELECT source_folder, COUNT(*) as file_count, MAX(created_at) as last_updated \
             FROM knowledge_documents \
             GROUP BY source_folder ORDER BY source_folder",
        ).await
    };
    match result {
        Ok(rows) => Json(json!({"folders": rows})).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct KnowledgeSearchBody {
    pub query: String,
    pub tenant_id: String,
    pub project_id: Option<String>,
    pub limit: Option<u32>,
}

pub async fn knowledge_search(
    State(state): State<Arc<AppState>>,
    Json(body): Json<KnowledgeSearchBody>,
) -> impl IntoResponse {
    let tenant_uuid = match resolve_tenant_id(&body.tenant_id, &state.db).await {
        Ok(u) => u,
        Err(e) => return e.into_response(),
    };

    let api_key = match &state.settings.openai_api_key {
        Some(k) => k.clone(),
        None => return (StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "No OPENAI_API_KEY configured"}))).into_response(),
    };

    let embedding = match crate::embeddings::embed_text(&api_key, &body.query).await {
        Ok(e) => e,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("Embedding failed: {e}")}))).into_response(),
    };

    let embedding_str = format!(
        "[{}]",
        embedding.iter().map(|f| f.to_string()).collect::<Vec<_>>().join(",")
    );
    let limit = body.limit.unwrap_or(5).min(10);

    let project_uuid: Option<Uuid> = body.project_id
        .as_deref()
        .and_then(|p| p.parse::<Uuid>().ok());

    // limit is u32 capped at 10 above; format!() of an integer is safe.
    let result = if let Some(pid) = project_uuid {
        // sql-format-ok: only `limit` (u32, capped) is interpolated;
        // all real values bound via pg_args.
        let sql = format!(
            "SELECT c.content, c.section_title, c.metadata, c.chunk_index, \
                    d.source_path, d.source_filename, \
                    1 - (c.embedding <=> $1::vector) AS similarity \
             FROM knowledge_chunks c \
             JOIN knowledge_documents d ON c.document_id = d.id \
             WHERE c.tenant_id = $2 \
               AND (c.project_id IS NULL OR c.project_id = $3) \
               AND d.status = 'ready' \
             ORDER BY c.embedding <=> $1::vector \
             LIMIT {limit}"
        );
        state.db.execute_with(&sql, pg_args!(embedding_str.clone(), tenant_uuid, pid)).await
    } else {
        // sql-format-ok: only `limit` (u32, capped) is interpolated.
        let sql = format!(
            "SELECT c.content, c.section_title, c.metadata, c.chunk_index, \
                    d.source_path, d.source_filename, \
                    1 - (c.embedding <=> $1::vector) AS similarity \
             FROM knowledge_chunks c \
             JOIN knowledge_documents d ON c.document_id = d.id \
             WHERE c.tenant_id = $2 \
               AND d.status = 'ready' \
             ORDER BY c.embedding <=> $1::vector \
             LIMIT {limit}"
        );
        state.db.execute_with(&sql, pg_args!(embedding_str.clone(), tenant_uuid)).await
    };

    match result {
        Ok(rows) => Json(json!({"results": rows, "query": body.query})).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("Knowledge search failed: {e}")}))).into_response(),
    }
}

async fn infer_scope_from_path(
    source_path: &str,
    tenant_id: &str,
    db: &crate::pg::PgClient,
) -> (String, Option<String>) {
    if let Some(rest) = source_path.strip_prefix("client/") {
        let parts: Vec<&str> = rest.splitn(3, '/').collect();
        if let Some(&client_slug) = parts.first() {
            if let Ok(rows) = db.execute_with(
                "SELECT id::text FROM clients WHERE slug = $1",
                pg_args!(client_slug.to_string()),
            ).await {
                if let Some(client_id) = rows.first().and_then(|r| r.get("id")).and_then(|v| v.as_str()) {
                    if parts.len() >= 2 {
                        let project_slug = parts[1];
                        if let Ok(prows) = db.execute_with(
                            "SELECT id::text FROM projects WHERE slug = $1 AND client_id = $2::uuid",
                            pg_args!(project_slug.to_string(), client_id.to_string()),
                        ).await {
                            if let Some(project_id) = prows.first().and_then(|r| r.get("id")).and_then(|v| v.as_str()) {
                                return ("project".to_string(), Some(project_id.to_string()));
                            }
                        }
                    }
                    return ("client".to_string(), Some(client_id.to_string()));
                }
            }
        }
    }
    let _ = tenant_id;
    ("expert".to_string(), None)
}

fn tool_to_json(t: &crate::tool_catalog::PlatformTool) -> Value {
    json!({
        "id": t.id,
        "name": t.name,
        "category": t.category,
        "description": t.description,
        "actions": t.actions,
        "required_credentials": t.required_credentials,
        "tradeoffs": t.tradeoffs,
        "enabled": t.enabled,
        "version": t.version,
    })
}

// ── Living System Descriptions ───────────────────────────────────────────────

use crate::system_description;

/// POST /api/projects/:project_id/descriptions — create or update project description
pub async fn project_description_create(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, InternalError> {
    let project_uuid = project_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid project ID"})))
    })?;

    let title = body.get("title").and_then(|v| v.as_str()).unwrap_or("Untitled");
    let summary = body.get("summary").and_then(|v| v.as_str());
    let default_obj = json!({});
    let default_arr = json!([]);
    let architecture = body.get("architecture").unwrap_or(&default_obj);
    let data_flows = body.get("data_flows").unwrap_or(&default_arr);
    let integration_map = body.get("integration_map").unwrap_or(&default_obj);

    let id = system_description::create_project_description(
        &state.db, project_uuid, title, summary, architecture, data_flows, integration_map,
    ).await.map_err(|e| {
        error!(error = %e, "failed to create project description");
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    Ok(Json(json!({ "id": id.to_string(), "project_id": project_id })))
}

/// GET /api/projects/:project_id/descriptions — get current project description + version history
pub async fn project_description_get(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
) -> Result<Json<Value>, InternalError> {
    let project_uuid = project_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid project ID"})))
    })?;

    let desc = system_description::get_for_project(&state.db, project_uuid)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    match desc {
        Some(d) => {
            let desc_id = d.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let versions = if let Ok(uuid) = desc_id.parse::<Uuid>() {
                system_description::get_project_description_versions(&state.db, uuid)
                    .await
                    .unwrap_or_default()
            } else {
                vec![]
            };
            Ok(Json(json!({ "description": d, "versions": versions })))
        }
        None => Ok(Json(json!({ "description": null, "versions": [] }))),
    }
}

/// PATCH /api/projects/:project_id/descriptions — update project description
pub async fn project_description_update(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, InternalError> {
    let project_uuid = project_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid project ID"})))
    })?;

    // Get current description
    let current = system_description::get_for_project(&state.db, project_uuid)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, Json(json!({"error": "No description found for project"}))))?;

    let desc_id = current.get("id").and_then(|v| v.as_str())
        .and_then(|s| s.parse::<Uuid>().ok())
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "Invalid description ID"}))))?;

    let title = body.get("title").and_then(|v| v.as_str());
    let summary = body.get("summary").and_then(|v| v.as_str());
    let architecture = body.get("architecture");
    let data_flows = body.get("data_flows");
    let integration_map = body.get("integration_map");
    let change_source = body.get("change_source").and_then(|v| v.as_str()).unwrap_or("user_edit");

    let new_version = system_description::update_project_description(
        &state.db, desc_id, title, summary, architecture, data_flows, integration_map,
        change_source, None,
    ).await.map_err(|e| {
        error!(error = %e, "failed to update project description");
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    Ok(Json(json!({ "version": new_version })))
}

/// POST /api/projects/:project_id/execute — generate rich plan + create session
pub async fn project_execute_rich(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, InternalError> {
    let project_uuid = project_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid project ID"})))
    })?;

    let request_text = body.get("request_text").and_then(|v| v.as_str())
        .ok_or_else(|| (StatusCode::BAD_REQUEST, Json(json!({"error": "request_text is required"}))))?;
    let model = body.get("model").and_then(|v| v.as_str()).unwrap_or(&state.settings.anthropic_model);

    let catalog_summary = state.catalog.catalog_summary();

    // Resolve client_id from project for knowledge search
    let client_id: Option<Uuid> = {
        let rows = state.db.execute_with(
            "SELECT client_id FROM projects WHERE id = $1",
            pg_args!(project_uuid),
        ).await.ok().unwrap_or_default();
        rows.first()
            .and_then(|r| r.get("client_id").and_then(Value::as_str))
            .and_then(|s| s.parse::<Uuid>().ok())
    };

    // Gather context from knowledge corpus + client data
    let gathered_context = planner::gather_planner_context(
        &state.db,
        request_text,
        client_id,
        Some(project_uuid),
        state.settings.openai_api_key.as_deref(),
    ).await;

    // Run rich description planner with gathered context
    let rich_plan = planner::plan_rich_description(
        request_text,
        &catalog_summary,
        &state.settings.anthropic_api_key,
        model,
        &gathered_context,
    ).await.map_err(|e| {
        error!(error = %e, "rich planner failed");
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("Planning failed: {e}")})))
    })?;

    // Create or update project description
    let desc_id = system_description::create_project_description(
        &state.db,
        project_uuid,
        &rich_plan.title,
        Some(&rich_plan.summary),
        &rich_plan.architecture,
        &rich_plan.data_flows,
        &json!({}), // integration_map derived from components
    ).await.map_err(|e| {
        error!(error = %e, "failed to create project description");
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    let session_id = Uuid::new_v4();

    // Convert to execution nodes
    let exec_nodes = planner::rich_plan_to_execution_nodes(
        &rich_plan.components,
        session_id,
        state.catalog.git_sha(),
        &state.catalog,
        None,
    ).map_err(|e| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": format!("Plan validation failed: {e}")})))
    })?;

    // Resolve client_id from project
    let client_id: Option<Uuid> = {
        let rows = state.db.execute_with(
            "SELECT client_id FROM projects WHERE id = $1",
            pg_args!(project_uuid),
        ).await.ok().unwrap_or_default();
        rows.first()
            .and_then(|r| r.get("client_id").and_then(Value::as_str))
            .and_then(|s| s.parse::<Uuid>().ok())
    };

    // Build plan JSON
    let plan_json = planner::plan_to_json(&exec_nodes);

    // Persist session + execution nodes in a single transaction to prevent partial plans
    let mut tx = state.db.begin().await.map_err(|e| {
        error!(error = %e, "failed to begin transaction");
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "Failed to create session"})))
    })?;

    tx.execute_with(
        r#"INSERT INTO execution_sessions
            (id, client_id, project_id, project_description_id, request_text, plan, status, mode)
           VALUES ($1, $2, $3, $4, $5, $6, 'awaiting_approval', 'planned')"#,
        pg_args!(session_id, client_id, project_uuid, desc_id, request_text.to_string(), plan_json.clone()),
    ).await.map_err(|e| {
        error!(error = %e, "failed to persist session");
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "Failed to create session"})))
    })?;

    // Persist execution nodes with description JSONB + acceptance_criteria
    for (i, node) in exec_nodes.iter().enumerate() {
        let jc_val = serde_json::to_value(&node.judge_config).unwrap_or(json!({}));
        let description_json = &rich_plan.components[i].description;

        // Extract acceptance_criteria from description for the dedicated column
        let acceptance_criteria = description_json
            .get("acceptance_criteria")
            .cloned()
            .unwrap_or(json!([]));

        tx.execute_with(
            r#"INSERT INTO execution_nodes
                (id, session_id, agent_slug, agent_git_sha, task_description, status,
                 requires, attempt_count, judge_config, max_iterations, model, skip_judge,
                 client_id, description, step_index, acceptance_criteria)
               VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10, $11, $12, $13, $14, $15)"#,
            pg_args!(
                node.uid, session_id, node.agent_slug.clone(), node.agent_git_sha.clone(),
                node.task_description.clone(), node.status.as_str().to_string(),
                &node.requires as &[Uuid], jc_val,
                node.max_iterations as i32, node.model.clone(), node.skip_judge,
                client_id, description_json.clone(), (i as i32) + 1, acceptance_criteria
            ),
        ).await.map_err(|e| {
            error!(error = %e, node_uid = %node.uid, "failed to persist execution node");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "Failed to create node"})))
        })?;
    }

    tx.commit().await.map_err(|e| {
        error!(error = %e, "failed to commit session transaction");
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "Failed to create session"})))
    })?;

    let node_count = exec_nodes.len();

    // Proactive blocker identification: check credentials and LLM-flagged blockers
    let node_uids: Vec<Uuid> = exec_nodes.iter().map(|n| n.uid).collect();
    planner::identify_blockers(
        &state.db,
        &rich_plan.components,
        &node_uids,
        session_id,
        client_id,
    ).await;

    info!(
        session_id = %session_id,
        project_id = %project_id,
        node_count = node_count,
        "rich execution session created"
    );

    Ok(Json(json!({
        "session_id": session_id.to_string(),
        "project_description_id": desc_id.to_string(),
        "plan": plan_json,
        "node_count": node_count,
        "title": rich_plan.title,
        "summary": rich_plan.summary,
    })))
}

/// PATCH /api/execute/:session_id/nodes/:node_id/description — update a node's description JSONB
pub async fn execution_node_description_update(
    State(state): State<Arc<AppState>>,
    Path((session_id, node_id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, InternalError> {
    let _session_uuid = session_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid session ID"})))
    })?;
    let node_uuid = node_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid node ID"})))
    })?;

    let description = body.get("description").ok_or_else(|| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "description field is required"})))
    })?;

    system_description::update_node_description(&state.db, node_uuid, description)
        .await
        .map_err(|e| {
            error!(error = %e, "failed to update node description");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
        })?;

    Ok(Json(json!({ "ok": true })))
}

// ── Node Issues ──────��───────────────────────────────────────────────────────

/// GET /api/execute/:session_id/issues — list all issues for a session
pub async fn execution_session_issues(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, InternalError> {
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid session ID"})))
    })?;

    let issues = system_description::list_issues_for_session(&state.db, session_uuid)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({ "issues": issues })))
}

/// POST /api/execute/:session_id/nodes/:node_id/issues — create an issue on a node
pub async fn execution_node_issue_create(
    State(state): State<Arc<AppState>>,
    Path((session_id, node_id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, InternalError> {
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid session ID"})))
    })?;
    let node_uuid = node_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid node ID"})))
    })?;

    let issue_type = body.get("issue_type").and_then(|v| v.as_str())
        .ok_or_else(|| (StatusCode::BAD_REQUEST, Json(json!({"error": "issue_type is required"}))))?;
    let description = body.get("description").and_then(|v| v.as_str())
        .ok_or_else(|| (StatusCode::BAD_REQUEST, Json(json!({"error": "description is required"}))))?;
    let source = body.get("source").and_then(|v| v.as_str()).unwrap_or("user");

    let id = system_description::create_issue(
        &state.db, node_uuid, session_uuid, issue_type, description, source,
    ).await.map_err(|e| {
        error!(error = %e, "failed to create node issue");
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    Ok(Json(json!({ "id": id.to_string() })))
}

/// PATCH /api/execute/:session_id/issues/:issue_id — resolve or dismiss an issue
pub async fn execution_issue_update(
    State(state): State<Arc<AppState>>,
    Path((_session_id, issue_id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, InternalError> {
    let issue_uuid = issue_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid issue ID"})))
    })?;

    let action = body.get("action").and_then(|v| v.as_str()).unwrap_or("resolve");

    match action {
        "resolve" => {
            let resolved_by = body.get("resolved_by").and_then(|v| v.as_str());
            system_description::resolve_issue(&state.db, issue_uuid, resolved_by)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;
        }
        "dismiss" => {
            system_description::dismiss_issue(&state.db, issue_uuid)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;
        }
        _ => {
            return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "action must be 'resolve' or 'dismiss'"}))).into());
        }
    }

    Ok(Json(json!({ "ok": true })))
}

// ── Description Threads (Conversational Editing) ─────────────────────────────

/// POST /api/execute/:session_id/threads — create a new thread
pub async fn thread_create(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, InternalError> {
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid session ID"})))
    })?;

    let node_id = body.get("node_id").and_then(|v| v.as_str())
        .and_then(|s| s.parse::<Uuid>().ok());
    let section_path = body.get("section_path").and_then(|v| v.as_str())
        .ok_or_else(|| (StatusCode::BAD_REQUEST, Json(json!({"error": "section_path is required"}))))?;
    let highlighted_text = body.get("highlighted_text").and_then(|v| v.as_str());
    let message = body.get("message").and_then(|v| v.as_str())
        .ok_or_else(|| (StatusCode::BAD_REQUEST, Json(json!({"error": "message is required"}))))?;

    let thread_id = system_description::create_thread(
        &state.db, Some(session_uuid), node_id, section_path,
        highlighted_text, message, None,
    ).await.map_err(|e| {
        error!(error = %e, "failed to create thread");
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    Ok(Json(json!({ "id": thread_id.to_string() })))
}

/// GET /api/execute/:session_id/threads — list threads for a session
pub async fn thread_list(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, InternalError> {
    let session_uuid = session_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid session ID"})))
    })?;

    let threads = system_description::list_threads(&state.db, session_uuid)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({ "threads": threads })))
}

/// POST /api/execute/:session_id/threads/:thread_id/messages — post a message (triggers agent response)
pub async fn thread_message_create(
    State(state): State<Arc<AppState>>,
    Path((session_id, thread_id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, InternalError> {
    let _session_uuid = session_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid session ID"})))
    })?;
    let thread_uuid = thread_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid thread ID"})))
    })?;

    let message = body.get("message").and_then(|v| v.as_str())
        .ok_or_else(|| (StatusCode::BAD_REQUEST, Json(json!({"error": "message is required"}))))?;

    // Record user message
    system_description::add_thread_message(
        &state.db, thread_uuid, "user", message, None,
    ).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    // Build context and call Claude for a response
    let thread_data = system_description::get_thread_with_messages(&state.db, thread_uuid)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, Json(json!({"error": "Thread not found"}))))?;

    let thread_info = thread_data.get("thread").cloned().unwrap_or(json!({}));
    let messages = thread_data.get("messages").cloned().unwrap_or(json!([]));

    let section_path = thread_info.get("section_path").and_then(|v| v.as_str()).unwrap_or("");
    let highlighted = thread_info.get("highlighted_text").and_then(|v| v.as_str()).unwrap_or("");

    // Load node description for context
    let node_context = if let Some(nid) = thread_info.get("node_id").and_then(|v| v.as_str())
        .and_then(|s| s.parse::<Uuid>().ok())
    {
        system_description::get_node_description(&state.db, nid).await.ok().flatten()
    } else {
        None
    };

    let system_prompt = format!(
        "You are editing a living system description. \
         The user is discussing section '{}' of a component.\n\
         {}\n\
         Component description: {}\n\n\
         Conversation history: {}\n\n\
         Respond helpfully. If you recommend changing the description, include a 'patch' field \
         in your response with the updated content for this section.",
        section_path,
        if highlighted.is_empty() { String::new() } else { format!("Highlighted text: \"{highlighted}\"") },
        node_context.as_ref().map(|v| v.to_string()).unwrap_or_else(|| "N/A".to_string()),
        messages.to_string(),
    );

    let client = crate::anthropic::AnthropicClient::new(
        state.settings.anthropic_api_key.clone(),
        state.settings.anthropic_model.clone(),
    );
    let llm_messages = vec![crate::anthropic::user_message(message.to_string())];

    let response = client
        .messages(&system_prompt, &llm_messages, &[], 2048, None)
        .await
        .map_err(|e| {
            error!(error = %e, "thread agent call failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("Agent call failed: {e}")})))
        })?;

    let assistant_text = response.text();

    // Record assistant response
    let msg_id = system_description::add_thread_message(
        &state.db, thread_uuid, "assistant", &assistant_text, None,
    ).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    Ok(Json(json!({
        "message_id": msg_id.to_string(),
        "content": assistant_text,
    })))
}

/// GET /api/execute/:session_id/threads/:thread_id — get a thread with all messages
pub async fn thread_get(
    State(state): State<Arc<AppState>>,
    Path((_session_id, thread_id)): Path<(String, String)>,
) -> Result<Json<Value>, InternalError> {
    let thread_uuid = thread_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid thread ID"})))
    })?;

    let data = system_description::get_thread_with_messages(&state.db, thread_uuid)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, Json(json!({"error": "Thread not found"}))))?;

    Ok(Json(data))
}

/// PATCH /api/execute/:session_id/threads/:thread_id — resolve/archive a thread
pub async fn thread_update(
    State(state): State<Arc<AppState>>,
    Path((_session_id, thread_id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, InternalError> {
    let thread_uuid = thread_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid thread ID"})))
    })?;

    let status = body.get("status").and_then(|v| v.as_str()).unwrap_or("resolved");

    system_description::update_thread_status(&state.db, thread_uuid, status)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({ "ok": true })))
}

// ── Chat Learnings ───────────────────────────────────────────────────────────

/// GET /api/chat-learnings/:session_id — list learnings for a session
pub async fn chat_learnings_list(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, InternalError> {
    let sid = session_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid session ID"})))
    })?;

    let rows = state.db.execute_with(
        "SELECT id, learning_text, suggested_scope, suggested_primitive_slug, \
         confidence, evidence, status, conflicting_overlay_id, overlay_id, \
         source_node_id, created_at \
         FROM chat_learnings WHERE session_id = $1 ORDER BY created_at ASC",
        pg_args!(sid),
    ).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({ "learnings": rows })))
}

/// POST /api/chat-learnings/:id/reject — manually reject a learning
pub async fn chat_learning_reject(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, InternalError> {
    let lid = id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid learning ID"})))
    })?;

    state.db.execute_with(
        "UPDATE chat_learnings SET status = 'rejected' WHERE id = $1",
        pg_args!(lid),
    ).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({ "ok": true })))
}

/// POST /api/chat-learnings/:id/resolve-conflict — resolve a contradiction
pub async fn chat_learning_resolve_conflict(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, InternalError> {
    let lid = id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid learning ID"})))
    })?;

    let action = body.get("action").and_then(Value::as_str).unwrap_or("keep_old");

    let learning_row = state.db.execute_with(
        "SELECT session_id, learning_text, suggested_scope, suggested_primitive_slug, \
         conflicting_overlay_id FROM chat_learnings WHERE id = $1 AND status = 'conflict'",
        pg_args!(lid),
    ).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    let row = learning_row.first().ok_or_else(|| {
        (StatusCode::NOT_FOUND, Json(json!({"error": "Learning not found or not in conflict status"})))
    })?;

    match action {
        "accept_new" => {
            // Retire the conflicting overlay
            if let Some(old_id) = row.get("conflicting_overlay_id").and_then(Value::as_str).and_then(|s| s.parse::<Uuid>().ok()) {
                let _ = state.db.execute_with(
                    "UPDATE overlays SET retired_at = NOW() WHERE id = $1",
                    pg_args!(old_id),
                ).await;
            }
            // Write the new learning as an overlay (simplified — uses the learning text directly)
            let _ = state.db.execute_with(
                "UPDATE chat_learnings SET status = 'distilled' WHERE id = $1",
                pg_args!(lid),
            ).await;
        }
        "keep_both" => {
            let _ = state.db.execute_with(
                "UPDATE chat_learnings SET status = 'distilled' WHERE id = $1",
                pg_args!(lid),
            ).await;
        }
        _ => {
            // keep_old — reject the learning
            let _ = state.db.execute_with(
                "UPDATE chat_learnings SET status = 'rejected' WHERE id = $1",
                pg_args!(lid),
            ).await;
        }
    }

    Ok(Json(json!({ "ok": true, "action": action })))
}

/// POST /api/chat-learnings/analyze/:session_id — trigger on-demand analysis
pub async fn chat_learnings_analyze(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, InternalError> {
    let sid = session_id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid session ID"})))
    })?;

    let session_rows = state.db.execute_with(
        "SELECT es.id, es.request_text, es.project_id, es.client_id, \
                p.expert_id, p.slug as project_slug \
         FROM execution_sessions es \
         LEFT JOIN projects p ON es.project_id = p.id \
         WHERE es.id = $1",
        pg_args!(sid),
    ).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    let session_row = session_rows.first().ok_or_else(|| {
        (StatusCode::NOT_FOUND, Json(json!({"error": "Session not found"})))
    })?;

    // Reset watermark + analysis state so the full transcript gets re-analyzed
    let _ = state.db.execute_with(
        "UPDATE execution_sessions \
         SET learning_scanned_up_to = NULL, learning_analyzed_at = NULL, \
             analysis_skip = FALSE, analysis_failure_count = 0 \
         WHERE id = $1",
        pg_args!(sid),
    ).await;

    let mut narratives_regenerated = std::collections::HashSet::new();
    let result = crate::chat_analyzer::analyze_session(
        &state.db,
        &state.settings.anthropic_api_key,
        &state.settings.anthropic_model,
        sid,
        session_row,
        &mut narratives_regenerated,
    ).await;

    match result {
        Ok(_) => {
            // Set watermark to current max message time
            let _ = state.db.execute_with(
                "UPDATE execution_sessions \
                 SET learning_scanned_up_to = (SELECT MAX(created_at) FROM node_messages WHERE session_id = $1), \
                     learning_analyzed_at = NOW() \
                 WHERE id = $1",
                pg_args!(sid),
            ).await;
            Ok(Json(json!({ "ok": true, "session_id": sid.to_string() })))
        }
        Err(e) => {
            Err((StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))).into())
        }
    }
}

/// POST /api/chat-learnings/analyze-recent — batch analyze unanalyzed sessions
pub async fn chat_learnings_analyze_recent(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, InternalError> {
    let tenant_id = body
        .get("tenant_id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "tenant_id required"})),
            )
        })?;
    let tid = resolve_tenant_id(tenant_id, &state.db).await?;

    let project_id = body
        .get("project_id")
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<Uuid>().ok());

    let force = body.get("force").and_then(Value::as_bool).unwrap_or(false);
    if force {
        // Reset watermark and skip flag so all sessions get re-scanned
        let _ = state.db.execute_with(
            "UPDATE execution_sessions \
             SET learning_scanned_up_to = NULL, learning_analyzed_at = NULL, \
                 analysis_skip = FALSE, analysis_failure_count = 0 \
             WHERE client_id = $1 \
               AND (analysis_skip = TRUE \
                    OR (learning_scanned_up_to IS NOT NULL \
                        AND id NOT IN (SELECT DISTINCT session_id FROM chat_learnings))) \
               AND created_at > NOW() - INTERVAL '90 days'",
            pg_args!(tid),
        ).await;
    }

    let (query, args) = if let Some(pid) = project_id {
        (
            "SELECT es.id, es.request_text, es.project_id, es.client_id, \
                    p.expert_id, p.slug as project_slug \
             FROM execution_sessions es \
             LEFT JOIN projects p ON es.project_id = p.id \
             WHERE es.analysis_skip = FALSE \
               AND es.client_id = $1 \
               AND es.project_id = $2 \
               AND es.created_at > NOW() - INTERVAL '90 days' \
               AND EXISTS (SELECT 1 FROM node_messages nm WHERE nm.session_id = es.id AND nm.role = 'user') \
               AND (es.learning_scanned_up_to IS NULL \
                    OR EXISTS (SELECT 1 FROM node_messages nm2 \
                               WHERE nm2.session_id = es.id AND nm2.created_at > es.learning_scanned_up_to)) \
             ORDER BY es.created_at DESC \
             LIMIT 20",
            pg_args!(tid, pid),
        )
    } else {
        (
            "SELECT es.id, es.request_text, es.project_id, es.client_id, \
                    p.expert_id, p.slug as project_slug \
             FROM execution_sessions es \
             LEFT JOIN projects p ON es.project_id = p.id \
             WHERE es.analysis_skip = FALSE \
               AND es.client_id = $1 \
               AND es.created_at > NOW() - INTERVAL '90 days' \
               AND EXISTS (SELECT 1 FROM node_messages nm WHERE nm.session_id = es.id AND nm.role = 'user') \
               AND (es.learning_scanned_up_to IS NULL \
                    OR EXISTS (SELECT 1 FROM node_messages nm2 \
                               WHERE nm2.session_id = es.id AND nm2.created_at > es.learning_scanned_up_to)) \
             ORDER BY es.created_at DESC \
             LIMIT 20",
            pg_args!(tid),
        )
    };

    let sessions = state
        .db
        .execute_with(query, args)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": format!("{e}")})),
            )
        })?;

    let total = sessions.len();
    if total == 0 {
        return Ok(Json(
            json!({ "ok": true, "sessions_analyzed": 0, "learnings_extracted": 0 }),
        ));
    }

    let mut narratives_regenerated = std::collections::HashSet::new();
    let mut analyzed = 0usize;
    let mut learnings_count = 0i64;

    for session_row in &sessions {
        let session_id = match session_row
            .get("id")
            .and_then(Value::as_str)
            .and_then(|s| s.parse::<Uuid>().ok())
        {
            Some(id) => id,
            None => continue,
        };

        match crate::chat_analyzer::analyze_session(
            &state.db,
            &state.settings.anthropic_api_key,
            &state.settings.anthropic_model,
            session_id,
            session_row,
            &mut narratives_regenerated,
        )
        .await
        {
            Ok(_) => {
                // Advance watermark to current max message time on success
                let _ = state
                    .db
                    .execute_with(
                        "UPDATE execution_sessions \
                         SET learning_scanned_up_to = (SELECT MAX(created_at) FROM node_messages WHERE session_id = $1), \
                             learning_analyzed_at = NOW() \
                         WHERE id = $1",
                        pg_args!(session_id),
                    )
                    .await;
                analyzed += 1;
                let count_rows = state
                    .db
                    .execute_with(
                        "SELECT COUNT(*) as cnt FROM chat_learnings WHERE session_id = $1",
                        pg_args!(session_id),
                    )
                    .await
                    .unwrap_or_default();
                learnings_count += count_rows
                    .first()
                    .and_then(|r| r.get("cnt").and_then(Value::as_i64))
                    .unwrap_or(0);
            }
            Err(e) => {
                tracing::warn!(session = %session_id, error = %e, "batch analysis failed");
                let _ = state
                    .db
                    .execute_with(
                        "UPDATE execution_sessions \
                         SET analysis_failure_count = analysis_failure_count + 1, \
                             analysis_skip = CASE WHEN analysis_failure_count + 1 >= 3 \
                                             THEN TRUE ELSE FALSE END \
                         WHERE id = $1",
                        pg_args!(session_id),
                    )
                    .await;
            }
        }
    }

    Ok(Json(json!({
        "ok": true,
        "sessions_found": total,
        "sessions_analyzed": analyzed,
        "learnings_extracted": learnings_count,
    })))
}

/// GET /api/chat-learnings/stats — dashboard statistics
pub async fn chat_learnings_stats(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, InternalError> {
    let stats = state.db.execute_unparameterized(
        "SELECT \
           (SELECT COUNT(*) FROM execution_sessions WHERE learning_scanned_up_to IS NOT NULL) as sessions_analyzed, \
           (SELECT COUNT(*) FROM chat_learnings) as total_learnings, \
           (SELECT COUNT(*) FROM chat_learnings WHERE status = 'distilled') as distilled, \
           (SELECT COUNT(*) FROM chat_learnings WHERE status = 'duplicate') as duplicates, \
           (SELECT COUNT(*) FROM chat_learnings WHERE status = 'conflict') as pending_conflicts, \
           (SELECT COUNT(*) FROM chat_learnings WHERE status = 'rejected') as rejected, \
           (SELECT COUNT(*) FROM overlays WHERE source = 'transcript' AND retired_at IS NULL) as transcript_overlays, \
           (SELECT COUNT(*) FROM scope_narratives) as narratives"
    ).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    let row = stats.first().cloned().unwrap_or(json!({}));
    Ok(Json(row))
}

/// GET /api/chat-learnings/sessions?tenant_id=... — list recent sessions with analysis status
pub async fn chat_learnings_sessions(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<HashMap<String, String>>,
) -> Result<Json<Value>, InternalError> {
    let raw_tenant = params.get("tenant_id").map(|s| s.as_str()).unwrap_or("");
    if raw_tenant.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "tenant_id required"}))).into());
    }
    let tid = resolve_tenant_id(raw_tenant, &state.db).await?;

    let rows = state.db.execute_with(
        "SELECT es.id, es.request_text, es.status, es.created_at, es.completed_at, \
                es.learning_scanned_up_to, es.analysis_skip, \
                COALESCE(es.analysis_failure_count, 0) as analysis_failure_count, \
                p.slug as project_slug, \
                (SELECT COUNT(*) FROM chat_learnings cl WHERE cl.session_id = es.id) as learning_count, \
                (SELECT COUNT(*) FROM node_messages nm WHERE nm.session_id = es.id AND nm.role = 'user') as user_message_count, \
                (es.learning_scanned_up_to IS NULL \
                 OR EXISTS (SELECT 1 FROM node_messages nm \
                            WHERE nm.session_id = es.id AND nm.role = 'user' \
                            AND nm.created_at > es.learning_scanned_up_to)) as has_new_messages \
         FROM execution_sessions es \
         LEFT JOIN projects p ON es.project_id = p.id \
         WHERE es.client_id = $1 \
           AND es.created_at > NOW() - INTERVAL '90 days' \
           AND EXISTS (SELECT 1 FROM node_messages nm WHERE nm.session_id = es.id AND nm.role = 'user') \
         ORDER BY es.created_at DESC \
         LIMIT 50",
        pg_args!(tid),
    ).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    Ok(Json(json!({ "sessions": rows })))
}

/// GET /api/overlays/memories — list transcript-derived overlays
pub async fn overlays_memories(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<HashMap<String, String>>,
) -> Result<Json<Value>, InternalError> {
    let scope_filter = params.get("scope").map(|s| s.as_str());
    let source_filter = params.get("source").map(|s| s.as_str());

    use sqlx::Arguments as _;
    let mut conditions: Vec<String> = vec!["retired_at IS NULL".to_string()];
    let mut args = sqlx::postgres::PgArguments::default();
    let mut pi: u32 = 1;
    if let Some(scope) = scope_filter {
        conditions.push(format!("scope = ${pi}"));
        pi += 1;
        args.add(scope.to_string()).expect("encode");
    }
    if let Some(source) = source_filter {
        conditions.push(format!("source = ${pi}"));
        pi += 1;
        args.add(source.to_string()).expect("encode");
    } else {
        conditions.push("source IN ('transcript', 'feedback', 'corpus')".to_string());
    }
    let _ = pi;

    // sql-format-ok: `conditions` are hardcoded `column = $N` fragments built above,
    // all real values bound via `args`.
    let sql = format!(
        "SELECT id, primitive_type, primitive_id, scope, scope_id, content, source, \
         reinforced_at, reinforcement_count, metadata, created_at \
         FROM overlays WHERE {} ORDER BY created_at DESC LIMIT 200",
        conditions.join(" AND ")
    );

    let rows = state.db.execute_with(&sql, args).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    Ok(Json(json!({ "overlays": rows })))
}

/// GET /api/scope-narratives — list generated holistic narratives
pub async fn scope_narratives_list(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, InternalError> {
    let rows = state.db.execute_unparameterized(
        "SELECT id, scope, scope_id, narrative_text, narrative_text_user, \
         source_overlay_count, generated_at \
         FROM scope_narratives ORDER BY scope, scope_id"
    ).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
    })?;

    Ok(Json(json!({ "narratives": rows })))
}

// ── Knowledge Observatory (SD-006 Part 8) ───────────────────────────────────

#[derive(Deserialize)]
pub struct ObservatoryQuery {
    pub tenant_id: Option<String>,
}

/// GET /api/knowledge/observatory — aggregated counts for the knowledge tree
pub async fn knowledge_observatory(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<ObservatoryQuery>,
) -> Result<Json<Value>, InternalError> {
    let tenant_id = match &query.tenant_id {
        Some(tid) => resolve_tenant_id(tid, &state.db).await?,
        None => return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "tenant_id required"}))).into()),
    };

    let chat_sql = "SELECT \
         (SELECT COUNT(*) FROM execution_sessions WHERE learning_scanned_up_to IS NOT NULL AND client_id = $1) as sessions_analyzed, \
         (SELECT COUNT(*) FROM chat_learnings cl INNER JOIN execution_sessions es ON cl.session_id = es.id \
            WHERE es.client_id = $1 AND cl.status IN ('applied', 'distilled')) as applied, \
         (SELECT COUNT(*) FROM chat_learnings cl INNER JOIN execution_sessions es ON cl.session_id = es.id \
            WHERE es.client_id = $1 AND cl.status = 'conflict') as conflicts, \
         (SELECT COUNT(*) FROM chat_learnings cl INNER JOIN execution_sessions es ON cl.session_id = es.id \
            WHERE es.client_id = $1 AND cl.status = 'pending') as pending, \
         (SELECT COUNT(*) FROM chat_learnings cl INNER JOIN execution_sessions es ON cl.session_id = es.id \
            WHERE es.client_id = $1 AND cl.status = 'rejected') as rejected";

    // Run all counts in parallel
    let (
        corpus_stats,
        chunk_count,
        chat_stats,
        feedback_stats,
        pattern_count,
        pr_stats,
        overlay_stats,
        narrative_count,
        observation_stats,
        retrieval_stats,
        project_stats,
        agent_knowledge,
    ) = tokio::join!(
        state.db.execute_with(
            "SELECT status, COUNT(*) as count FROM knowledge_documents WHERE tenant_id = $1 GROUP BY status",
            pg_args!(tenant_id),
        ),
        state.db.execute_with(
            "SELECT COUNT(*) as count FROM knowledge_chunks WHERE tenant_id = $1",
            pg_args!(tenant_id),
        ),
        state.db.execute_with(chat_sql, pg_args!(tenant_id)),
        state.db.execute_unparameterized(
            "SELECT signal_type, COUNT(*) as count FROM feedback_signals GROUP BY signal_type",
        ),
        state.db.execute_unparameterized(
            "SELECT COUNT(*) as count FROM feedback_patterns WHERE status = 'active'",
        ),
        state.db.execute_unparameterized(
            "SELECT status, COUNT(*) as count FROM agent_prs GROUP BY status",
        ),
        state.db.execute_unparameterized(
            "SELECT source, scope, COUNT(*) as count FROM overlays WHERE retired_at IS NULL GROUP BY source, scope",
        ),
        state.db.execute_unparameterized(
            "SELECT COUNT(*) as count FROM scope_narratives",
        ),
        state.db.execute_unparameterized(
            "SELECT \
             (SELECT COUNT(*) FROM observation_sessions) as sessions, \
             (SELECT COUNT(*) FROM distillations) as distillations",
        ),
        state.db.execute_with(
            "SELECT COUNT(*)::bigint as total, \
                    l.resource_id, \
                    MAX(l.accessed_at) as last_accessed \
             FROM knowledge_access_log l \
             INNER JOIN knowledge_chunks c ON l.resource_id = c.id \
             WHERE l.access_type = 'chunk_retrieval' \
               AND l.accessed_at > NOW() - INTERVAL '7 days' \
               AND c.tenant_id = $1 \
             GROUP BY l.resource_id ORDER BY COUNT(*) DESC LIMIT 10",
            pg_args!(tenant_id),
        ),
        state.db.execute_with(
            "SELECT p.id, p.name, \
                    (SELECT COUNT(*) FROM knowledge_documents WHERE project_id = p.id AND tenant_id = $1) as corpus_docs, \
                    (SELECT COUNT(*) FROM knowledge_chunks WHERE project_id = p.id AND tenant_id = $1) as corpus_chunks, \
                    (SELECT COUNT(*) FROM overlays WHERE scope = 'project' AND scope_id = p.id::text AND retired_at IS NULL) as overlays \
             FROM projects p WHERE p.client_id = $1 ORDER BY p.name",
            pg_args!(tenant_id),
        ),
        state.db.execute_unparameterized(
            "SELECT slug, name, array_length(knowledge_docs, 1) as doc_count FROM agent_definitions WHERE knowledge_docs IS NOT NULL AND array_length(knowledge_docs, 1) > 0 ORDER BY slug",
        ),
    );

    // Assemble corpus
    let mut by_status: HashMap<String, i64> = HashMap::new();
    let mut total_docs: i64 = 0;
    if let Ok(rows) = &corpus_stats {
        for row in rows {
            let s = row.get("status").and_then(Value::as_str).unwrap_or("unknown").to_string();
            let c = row.get("count").and_then(Value::as_i64).unwrap_or(0);
            total_docs += c;
            by_status.insert(s, c);
        }
    }
    let chunks = chunk_count.ok().and_then(|r| r.first().and_then(|r| r.get("count").and_then(Value::as_i64))).unwrap_or(0);

    // Chat learning
    let chat = chat_stats.ok().and_then(|r| r.into_iter().next()).unwrap_or(json!({}));

    // Feedback
    let mut feedback_by_type: HashMap<String, i64> = HashMap::new();
    let mut total_signals: i64 = 0;
    if let Ok(rows) = &feedback_stats {
        for row in rows {
            let t = row.get("signal_type").and_then(Value::as_str).unwrap_or("unknown").to_string();
            let c = row.get("count").and_then(Value::as_i64).unwrap_or(0);
            total_signals += c;
            feedback_by_type.insert(t, c);
        }
    }
    let patterns = pattern_count.ok().and_then(|r| r.first().and_then(|r| r.get("count").and_then(Value::as_i64))).unwrap_or(0);
    let mut prs_by_status: HashMap<String, i64> = HashMap::new();
    if let Ok(rows) = &pr_stats {
        for row in rows {
            let s = row.get("status").and_then(Value::as_str).unwrap_or("unknown").to_string();
            let c = row.get("count").and_then(Value::as_i64).unwrap_or(0);
            prs_by_status.insert(s, c);
        }
    }

    // Overlays
    let mut by_source: HashMap<String, i64> = HashMap::new();
    let mut by_scope: HashMap<String, i64> = HashMap::new();
    let mut total_overlays: i64 = 0;
    if let Ok(rows) = &overlay_stats {
        for row in rows {
            let src = row.get("source").and_then(Value::as_str).unwrap_or("unknown").to_string();
            let scp = row.get("scope").and_then(Value::as_str).unwrap_or("unknown").to_string();
            let c = row.get("count").and_then(Value::as_i64).unwrap_or(0);
            total_overlays += c;
            *by_source.entry(src).or_default() += c;
            *by_scope.entry(scp).or_default() += c;
        }
    }
    let narratives = narrative_count.ok().and_then(|r| r.first().and_then(|r| r.get("count").and_then(Value::as_i64))).unwrap_or(0);

    // Observations
    let obs = observation_stats.ok().and_then(|r| r.into_iter().next()).unwrap_or(json!({}));

    // Retrieval
    let retrieval_total: i64 = retrieval_stats.as_ref().ok().map(|rows| rows.iter().filter_map(|r| r.get("total").and_then(Value::as_i64)).sum()).unwrap_or(0);
    let top_chunks: Vec<Value> = retrieval_stats.ok().unwrap_or_default();

    Ok(Json(json!({
        "expert": {
            "agents_with_knowledge": agent_knowledge.ok().unwrap_or_default(),
        },
        "workspace": {
            "corpus": {
                "total_documents": total_docs,
                "total_chunks": chunks,
                "by_status": by_status,
            },
            "chat_learning": {
                "sessions_analyzed": chat.get("sessions_analyzed"),
                "by_status": {
                    "applied": chat.get("applied"),
                    "conflict": chat.get("conflicts"),
                    "pending": chat.get("pending"),
                    "rejected": chat.get("rejected"),
                },
                "narratives": narratives,
            },
            "feedback": {
                "total_signals": total_signals,
                "by_type": feedback_by_type,
                "active_patterns": patterns,
                "agent_prs": prs_by_status,
            },
            "observations": {
                "sessions": obs.get("sessions"),
                "distillations": obs.get("distillations"),
            },
            "overlays": {
                "total_active": total_overlays,
                "by_source": by_source,
                "by_scope": by_scope,
            },
            "retrieval_activity": {
                "total_7d": retrieval_total,
                "top_chunks": top_chunks,
            },
            "projects": project_stats.ok().unwrap_or_default(),
        },
    })))
}

#[derive(Deserialize)]
pub struct ObservatoryDetailQuery {
    pub tenant_id: Option<String>,
    pub page: Option<u64>,
    pub limit: Option<u64>,
    pub scope: Option<String>,
    pub source: Option<String>,
    pub status: Option<String>,
}

/// GET /api/knowledge/observatory/:section — paginated drill-down rows
pub async fn knowledge_observatory_detail(
    State(state): State<Arc<AppState>>,
    Path(section): Path<String>,
    axum::extract::Query(query): axum::extract::Query<ObservatoryDetailQuery>,
) -> Result<Json<Value>, InternalError> {
    let tenant_id = match &query.tenant_id {
        Some(tid) => resolve_tenant_id(tid, &state.db).await?,
        None => return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "tenant_id required"}))).into()),
    };
    let page = query.page.unwrap_or(1).max(1);
    let limit = query.limit.unwrap_or(20).min(100);
    let offset = (page - 1) * limit;

    match section.as_str() {
        "corpus_documents" => {
            let rows = state.db.execute_with(
                &format!(
                    "SELECT id, source_filename, source_path, source_folder, mime_type, status, \
                            chunk_count, inferred_scope, created_at, updated_at \
                     FROM knowledge_documents WHERE tenant_id = $1 \
                     ORDER BY source_path ASC LIMIT {} OFFSET {}", limit, offset
                ),
                pg_args!(tenant_id),
            ).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;
            let total = state.db.execute_with(
                "SELECT COUNT(*) as count FROM knowledge_documents WHERE tenant_id = $1",
                pg_args!(tenant_id),
            ).await.ok().and_then(|r| r.first().and_then(|r| r.get("count").and_then(Value::as_i64))).unwrap_or(0);
            Ok(Json(json!({"rows": rows, "total": total})))
        }
        "corpus_chunks" => {
            let rows = state.db.execute_with(
                &format!(
                    "SELECT c.id, LEFT(c.content, 200) as content_preview, c.section_title, \
                            c.chunk_index, c.token_count, d.source_filename \
                     FROM knowledge_chunks c \
                     JOIN knowledge_documents d ON c.document_id = d.id \
                     WHERE c.tenant_id = $1 \
                     ORDER BY d.source_filename, c.chunk_index LIMIT {} OFFSET {}", limit, offset
                ),
                pg_args!(tenant_id),
            ).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;
            let total = state.db.execute_with(
                "SELECT COUNT(*) as count FROM knowledge_chunks WHERE tenant_id = $1",
                pg_args!(tenant_id),
            ).await.ok().and_then(|r| r.first().and_then(|r| r.get("count").and_then(Value::as_i64))).unwrap_or(0);
            Ok(Json(json!({"rows": rows, "total": total})))
        }
        "chat_learnings" => {
            let status_filter = query.status.as_deref()
                .filter(|s| ["applied", "conflict", "pending", "rejected", "distilled"].contains(s))
                .map(|s| format!(" AND cl.status = '{s}'"))
                .unwrap_or_default();
            let rows = state.db.execute_with(
                &format!(
                    "SELECT cl.id, cl.session_id, cl.learning_text, cl.status, \
                            cl.suggested_scope as scope, cl.created_at \
                     FROM chat_learnings cl \
                     INNER JOIN execution_sessions es ON cl.session_id = es.id \
                     WHERE es.client_id = $1 {status_filter} \
                     ORDER BY cl.created_at DESC LIMIT {limit} OFFSET {offset}"
                ),
                pg_args!(tenant_id),
            ).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;
            let total = state.db.execute_with(
                &format!(
                    "SELECT COUNT(*) as count FROM chat_learnings cl \
                     INNER JOIN execution_sessions es ON cl.session_id = es.id \
                     WHERE es.client_id = $1 {status_filter}"
                ),
                pg_args!(tenant_id),
            ).await.ok().and_then(|r| r.first().and_then(|r| r.get("count").and_then(Value::as_i64))).unwrap_or(0);
            Ok(Json(json!({"rows": rows, "total": total})))
        }
        "feedback_signals" => {
            let rows = state.db.execute_unparameterized(
                &format!(
                    "SELECT id, signal_type, authority, weight, agent_slug, description, created_at \
                     FROM feedback_signals \
                     ORDER BY created_at DESC LIMIT {limit} OFFSET {offset}"
                ),
            ).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;
            let total = state.db.execute_unparameterized(
                "SELECT COUNT(*) as count FROM feedback_signals",
            ).await.ok().and_then(|r| r.first().and_then(|r| r.get("count").and_then(Value::as_i64))).unwrap_or(0);
            Ok(Json(json!({"rows": rows, "total": total})))
        }
        "feedback_patterns" => {
            let rows = state.db.execute_unparameterized(
                &format!(
                    "SELECT id, agent_slug, pattern_type, description, session_count, severity, status, created_at \
                     FROM feedback_patterns WHERE status = 'active' \
                     ORDER BY session_count DESC LIMIT {limit} OFFSET {offset}"
                ),
            ).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;
            let total = state.db.execute_unparameterized(
                "SELECT COUNT(*) as count FROM feedback_patterns WHERE status = 'active'",
            ).await.ok().and_then(|r| r.first().and_then(|r| r.get("count").and_then(Value::as_i64))).unwrap_or(0);
            Ok(Json(json!({"rows": rows, "total": total})))
        }
        "agent_prs" => {
            let rows = state.db.execute_unparameterized(
                &format!(
                    "SELECT id, pr_type, target_agent_slug, gap_summary, confidence, \
                            evidence_count, status, auto_merge_eligible, created_at \
                     FROM agent_prs \
                     ORDER BY created_at DESC LIMIT {limit} OFFSET {offset}"
                ),
            ).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;
            let total = state.db.execute_unparameterized(
                "SELECT COUNT(*) as count FROM agent_prs",
            ).await.ok().and_then(|r| r.first().and_then(|r| r.get("count").and_then(Value::as_i64))).unwrap_or(0);
            Ok(Json(json!({"rows": rows, "total": total})))
        }
        "overlays" => {
            let mut filters = String::from("retired_at IS NULL");
            if let Some(ref src) = query.source {
                let escaped = src.replace('\'', "''");
                filters.push_str(&format!(" AND source = '{escaped}'"));
            }
            if let Some(ref scp) = query.scope {
                let escaped = scp.replace('\'', "''");
                filters.push_str(&format!(" AND scope = '{escaped}'"));
            }
            let rows = state.db.execute_unparameterized(
                &format!(
                    "SELECT o.id, o.primitive_type, o.scope, o.source, o.content, o.created_at, \
                            s.slug as skill_slug, s.name as skill_name \
                     FROM overlays o \
                     LEFT JOIN skills s ON o.primitive_id = s.id \
                     WHERE {filters} \
                     ORDER BY o.created_at DESC LIMIT {limit} OFFSET {offset}"
                ),
            ).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;
            let total = state.db.execute_unparameterized(
                &format!("SELECT COUNT(*) as count FROM overlays WHERE {filters}"),
            ).await.ok().and_then(|r| r.first().and_then(|r| r.get("count").and_then(Value::as_i64))).unwrap_or(0);
            Ok(Json(json!({"rows": rows, "total": total})))
        }
        "scope_narratives" => {
            let rows = state.db.execute_unparameterized(
                &format!(
                    "SELECT id, scope, scope_id, narrative_text, source_overlay_count, generated_at \
                     FROM scope_narratives \
                     ORDER BY scope, generated_at DESC LIMIT {limit} OFFSET {offset}"
                ),
            ).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;
            let total = state.db.execute_unparameterized(
                "SELECT COUNT(*) as count FROM scope_narratives",
            ).await.ok().and_then(|r| r.first().and_then(|r| r.get("count").and_then(Value::as_i64))).unwrap_or(0);
            Ok(Json(json!({"rows": rows, "total": total})))
        }
        "retrieval_hits" => {
            let rows = state.db.execute_with(
                &format!(
                    "SELECT l.resource_id as chunk_id, COUNT(*) as hit_count, \
                            MAX(l.accessed_at) as last_accessed, \
                            AVG(l.similarity_score) as avg_similarity, \
                            LEFT(c.content, 200) as content_preview, \
                            d.source_filename \
                     FROM knowledge_access_log l \
                     JOIN knowledge_chunks c ON l.resource_id = c.id \
                     JOIN knowledge_documents d ON c.document_id = d.id \
                     WHERE l.access_type = 'chunk_retrieval' \
                       AND l.accessed_at > NOW() - INTERVAL '30 days' \
                       AND d.tenant_id = $1 \
                     GROUP BY l.resource_id, c.content, d.source_filename \
                     ORDER BY hit_count DESC \
                     LIMIT {limit} OFFSET {offset}"
                ),
                pg_args!(tenant_id),
            ).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;
            Ok(Json(json!({"rows": rows, "total": rows.len()})))
        }
        "agent_knowledge" => {
            let rows = state.db.execute_unparameterized(
                "SELECT slug, name, array_length(knowledge_docs, 1) as doc_count \
                 FROM agent_definitions \
                 WHERE knowledge_docs IS NOT NULL AND array_length(knowledge_docs, 1) > 0 \
                 ORDER BY slug",
            ).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;
            Ok(Json(json!({"rows": rows, "total": rows.len()})))
        }
        _ => Err((StatusCode::BAD_REQUEST, Json(json!({"error": format!("Unknown section: {section}")}))).into()),
    }
}

/// POST /api/scope-narratives/:id/regenerate — force regeneration
pub async fn scope_narrative_regenerate(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, InternalError> {
    let nid = id.parse::<Uuid>().map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid narrative ID"})))
    })?;

    let rows = state.db.execute_with(
        "SELECT scope, scope_id FROM scope_narratives WHERE id = $1",
        pg_args!(nid),
    ).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    let row = rows.first().ok_or_else(|| {
        (StatusCode::NOT_FOUND, Json(json!({"error": "Narrative not found"})))
    })?;

    let scope = row.get("scope").and_then(Value::as_str).unwrap_or("base").to_string();
    let scope_id = row.get("scope_id").and_then(Value::as_str).and_then(|s| s.parse::<Uuid>().ok());

    // Force regeneration by using an empty HashSet (no cycle dedup)
    let mut empty = std::collections::HashSet::new();
    crate::chat_analyzer::maybe_regenerate_narrative(
        &state.db,
        &state.settings.anthropic_api_key,
        &state.settings.anthropic_model,
        &scope,
        scope_id,
        &mut empty,
    ).await;

    Ok(Json(json!({ "ok": true })))
}

// ── Integration Resource Listings (for smart pickers) ────────────────────────

/// Helper: resolve client_id from slug and load decrypted credentials.
async fn load_client_credentials(
    state: &AppState,
    slug: &str,
) -> Result<crate::credentials::CredentialMap, InternalError> {
    let client = client_mod::get_client(&state.db, slug)
        .await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    let client_id: Uuid = client.get("id").and_then(Value::as_str)
        .and_then(|s| s.parse().ok()).ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    let master_key = state.settings.credential_master_key.as_deref()
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "CREDENTIAL_MASTER_KEY not set"}))))?;
    crate::credentials::load_credentials_for_client(&state.db, master_key, client_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")})))
        .into())
}

/// GET /api/clients/:slug/integrations/slack/channels
pub async fn integration_slack_channels(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<Json<Value>, InternalError> {
    let credentials = load_client_credentials(&state, &slug).await?;
    let cred = credentials.get("slack").ok_or_else(|| {
        (StatusCode::FORBIDDEN, Json(json!({"error": "No Slack credential configured"})))
    })?;

    let client = reqwest::Client::new();
    let mut channels: Vec<Value> = Vec::new();
    let mut cursor = String::new();

    loop {
        let mut query: Vec<(&str, &str)> = vec![
            ("types", "public_channel,private_channel"),
            ("exclude_archived", "true"),
            ("limit", "200"),
        ];
        if !cursor.is_empty() {
            query.push(("cursor", &cursor));
        }

        let resp = client.get("https://slack.com/api/conversations.list")
            .query(&query)
            .header("Authorization", format!("Bearer {}", cred.value))
            .send()
            .await
            .map_err(|e| (StatusCode::BAD_GATEWAY, Json(json!({"error": format!("Slack API error: {e}")}))))?;

        let data: Value = resp.json().await
            .map_err(|e| (StatusCode::BAD_GATEWAY, Json(json!({"error": format!("Invalid Slack response: {e}")}))))?;

        if data.get("ok").and_then(Value::as_bool) != Some(true) {
            let err = data.get("error").and_then(Value::as_str).unwrap_or("unknown");
            return Err((StatusCode::BAD_GATEWAY, Json(json!({"error": format!("Slack error: {err}")}))).into());
        }

        if let Some(chs) = data.get("channels").and_then(Value::as_array) {
            for ch in chs {
                channels.push(json!({
                    "id": ch.get("id").and_then(Value::as_str).unwrap_or(""),
                    "name": ch.get("name").and_then(Value::as_str).unwrap_or(""),
                    "is_private": ch.get("is_private").and_then(Value::as_bool).unwrap_or(false),
                    "num_members": ch.get("num_members").and_then(Value::as_u64).unwrap_or(0),
                    "topic": ch.pointer("/topic/value").and_then(Value::as_str).unwrap_or(""),
                }));
            }
        }

        let next = data.pointer("/response_metadata/next_cursor")
            .and_then(Value::as_str)
            .unwrap_or("");
        if next.is_empty() { break; }
        cursor = next.to_string();
    }

    Ok(Json(json!({ "channels": channels })))
}

/// GET /api/clients/:slug/integrations/notion/databases
pub async fn integration_notion_databases(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<Json<Value>, InternalError> {
    let credentials = load_client_credentials(&state, &slug).await?;
    let cred = credentials.get("notion").ok_or_else(|| {
        (StatusCode::FORBIDDEN, Json(json!({"error": "No Notion credential configured"})))
    })?;

    let client = reqwest::Client::new();
    let mut databases: Vec<Value> = Vec::new();
    let mut start_cursor: Option<String> = None;

    loop {
        let mut body = json!({
            "filter": {"value": "database", "property": "object"},
            "page_size": 100
        });
        if let Some(ref cursor) = start_cursor {
            if let Some(obj) = body.as_object_mut() {
                obj.insert("start_cursor".to_string(), json!(cursor));
            }
        }

        let resp = client.post("https://api.notion.com/v1/search")
            .header("Authorization", format!("Bearer {}", cred.value))
            .header("Notion-Version", "2022-06-28")
            .json(&body)
            .send()
            .await
            .map_err(|e| (StatusCode::BAD_GATEWAY, Json(json!({"error": format!("Notion API error: {e}")}))))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err((StatusCode::BAD_GATEWAY, Json(json!({"error": format!("Notion returned {status}: {body}")}))).into());
        }

        let data: Value = resp.json().await
            .map_err(|e| (StatusCode::BAD_GATEWAY, Json(json!({"error": format!("Invalid Notion response: {e}")}))))?;

        if let Some(results) = data.get("results").and_then(Value::as_array) {
            for db in results {
                if let Some(id) = db.get("id").and_then(Value::as_str) {
                    let title = crate::discovery::extract_notion_title(db);
                    databases.push(json!({
                        "id": id,
                        "title": title,
                        "url": db.get("url").and_then(Value::as_str).unwrap_or(""),
                    }));
                }
            }
        }

        let has_more = data.get("has_more").and_then(Value::as_bool).unwrap_or(false);
        if !has_more { break; }
        start_cursor = data.get("next_cursor").and_then(Value::as_str).map(String::from);
        if start_cursor.is_none() { break; }
    }

    Ok(Json(json!({ "databases": databases })))
}

/// GET /api/clients/:slug/integrations/notion/pages
pub async fn integration_notion_pages(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<Json<Value>, InternalError> {
    let credentials = load_client_credentials(&state, &slug).await?;
    let cred = credentials.get("notion").ok_or_else(|| {
        (StatusCode::FORBIDDEN, Json(json!({"error": "No Notion credential configured"})))
    })?;

    let client = reqwest::Client::new();
    let mut pages: Vec<Value> = Vec::new();
    let mut start_cursor: Option<String> = None;

    loop {
        let mut body = json!({
            "filter": {"value": "page", "property": "object"},
            "page_size": 100
        });
        if let Some(ref cursor) = start_cursor {
            if let Some(obj) = body.as_object_mut() {
                obj.insert("start_cursor".to_string(), json!(cursor));
            }
        }

        let resp = client.post("https://api.notion.com/v1/search")
            .header("Authorization", format!("Bearer {}", cred.value))
            .header("Notion-Version", "2022-06-28")
            .json(&body)
            .send()
            .await
            .map_err(|e| (StatusCode::BAD_GATEWAY, Json(json!({"error": format!("Notion API error: {e}")}))))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err((StatusCode::BAD_GATEWAY, Json(json!({"error": format!("Notion returned {status}: {body}")}))).into());
        }

        let data: Value = resp.json().await
            .map_err(|e| (StatusCode::BAD_GATEWAY, Json(json!({"error": format!("Invalid Notion response: {e}")}))))?;

        if let Some(results) = data.get("results").and_then(Value::as_array) {
            for p in results {
                if let Some(id) = p.get("id").and_then(Value::as_str) {
                    let title = crate::discovery::extract_notion_title(p);
                    pages.push(json!({
                        "id": id,
                        "title": title,
                        "url": p.get("url").and_then(Value::as_str).unwrap_or(""),
                    }));
                }
            }
        }

        let has_more = data.get("has_more").and_then(Value::as_bool).unwrap_or(false);
        if !has_more { break; }
        start_cursor = data.get("next_cursor").and_then(Value::as_str).map(String::from);
        if start_cursor.is_none() { break; }
    }

    Ok(Json(json!({ "pages": pages })))
}

