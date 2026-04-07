/// AgentRunner — Executor → Judge loop for a single agent node.
///
/// Two-stage pattern: Executor runs tool loop, Judge scores against
/// rubric + need_to_know and decides pass/fail/retry.
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use serde_json::{json, Value};
use tracing::{debug, info, trace, warn};

use crate::agent_catalog::{AgentCatalog, ExecutionPlanNode, JudgeConfig, NodeStatus, MASTER_ORCHESTRATOR_SLUG};
use crate::pg_args;
use crate::anthropic::{
    assistant_message_from_response, tool_results_message, user_message, AnthropicClient,
    ContentBlockType, DeltaPayload, StreamEvent, ToolDef,
};
use crate::config::Settings;
use crate::pg::PgClient;
use crate::session::EventBus;
use crate::actions;

const MAX_JUDGE_RETRIES: u32 = 2;

/// Persist a conversation message for a node and broadcast as a stream entry.
async fn persist_message(
    db: &PgClient,
    event_bus: &EventBus,
    session_id: &str,
    node_id: &str,
    role: &str,
    content: &str,
    metadata: &Value,
) {
    trace!(node_id = %node_id, role = %role, "persisting message");
    if let (Ok(sid), Ok(nid)) = (
        session_id.parse::<uuid::Uuid>(),
        node_id.parse::<uuid::Uuid>(),
    ) {
        let _ = db.execute_with(
            "INSERT INTO node_messages (session_id, node_id, role, content, metadata) VALUES ($1, $2, $3, $4, $5)",
            pg_args!(sid, nid, role.to_string(), content.to_string(), metadata.clone()),
        ).await;
    }
    event_bus.send(session_id, json!({
        "type": "stream_entry",
        "node_uid": node_id,
        "stream_entry": {
            "stream_type": "message",
            "sub_type": role,
            "content": content,
            "role": role,
            "metadata": metadata,
            "created_at": chrono::Utc::now().to_rfc3339(),
        }
    })).await;
}

/// Persist an execution event to the DB and broadcast it via SSE.
async fn emit_event(
    db: &PgClient,
    event_bus: &EventBus,
    session_id: &str,
    node_id: &str,
    event_type: &str,
    payload: &Value,
) {
    if let (Ok(sid), Ok(nid)) = (
        session_id.parse::<uuid::Uuid>(),
        node_id.parse::<uuid::Uuid>(),
    ) {
        let _ = db.execute_with(
            "INSERT INTO execution_events (session_id, node_id, event_type, payload) VALUES ($1, $2, $3, $4)",
            pg_args!(sid, nid, event_type.to_string(), payload.clone()),
        ).await;
    }

    let mut event = payload.clone();
    if let Some(obj) = event.as_object_mut() {
        obj.insert("type".to_string(), json!(event_type));
        obj.insert("node_uid".to_string(), json!(node_id));
        obj.insert("stream_entry".to_string(), json!({
            "stream_type": "event",
            "sub_type": event_type,
            "content": payload.to_string(),
            "created_at": chrono::Utc::now().to_rfc3339(),
        }));
    }
    event_bus.send(session_id, event).await;
}

/// After a creation tool completes, immediately persist an artifact link
/// on the execution node so the frontend can show it while the agent is still running.
/// Supports Clay, Notion, n8n, and Supabase artifact detection.
async fn maybe_emit_early_artifact(
    db: &PgClient,
    event_bus: &EventBus,
    session_id: &str,
    node_id: &str,
    tool_name: &str,
    result: &str,
) {
    let artifact = match extract_artifact(tool_name, result) {
        Some(a) => a,
        None => return,
    };

    if let Ok(nid) = node_id.parse::<uuid::Uuid>() {
        let _ = db.execute_with(
            "UPDATE execution_nodes SET artifacts = COALESCE(artifacts, '[]'::jsonb) || $1::jsonb WHERE id = $2",
            pg_args!(json!([artifact]), nid),
        ).await;
    }

    emit_event(db, event_bus, session_id, node_id, "artifacts_updated", &json!({
        "artifact": artifact,
    })).await;
}

fn extract_artifact(tool_name: &str, result: &str) -> Option<Value> {
    let result_json: Value = serde_json::from_str(result).ok()?;

    // Clay workbook/table creation
    if tool_name == "clay_create_workbook" || tool_name == "clay_create_table" {
        let data = result_json.get("data")?;
        let resource_id = data.get("id").and_then(Value::as_str).filter(|s| !s.is_empty())?;
        let ws_id = data.get("workspaceId").and_then(Value::as_u64).filter(|&id| id != 0)?;
        let name = data.get("name").and_then(Value::as_str).unwrap_or("Untitled");

        let (artifact_type, url) = if tool_name == "clay_create_workbook" {
            ("clay_workbook", format!("https://app.clay.com/workspaces/{}/workbooks/{}", ws_id, resource_id))
        } else {
            let wb_id = data.get("workbookId").and_then(Value::as_str).unwrap_or("");
            if !wb_id.is_empty() {
                ("clay_table", format!("https://app.clay.com/workspaces/{}/workbooks/{}/tables/{}", ws_id, wb_id, resource_id))
            } else {
                ("clay_table", format!("https://app.clay.com/workspaces/{}/tables/{}", ws_id, resource_id))
            }
        };
        return Some(json!({"type": artifact_type, "url": url, "title": name}));
    }

    // Notion page creation (http_request to api.notion.com/v1/pages)
    if tool_name == "http_request" {
        if let Some(page_id) = result_json.get("id").and_then(Value::as_str) {
            if result_json.get("object").and_then(Value::as_str) == Some("page") {
                let title = result_json.get("properties")
                    .and_then(|p| p.get("title").or(p.get("Name")))
                    .and_then(|t| t.get("title"))
                    .and_then(Value::as_array)
                    .and_then(|arr| arr.first())
                    .and_then(|rt| rt.get("plain_text").or(rt.get("text").and_then(|t| t.get("content"))))
                    .and_then(Value::as_str)
                    .unwrap_or("Notion Page");
                let clean_id = page_id.replace('-', "");
                let url = format!("https://notion.so/{}", clean_id);
                return Some(json!({"type": "notion_page", "url": url, "title": title}));
            }
            if result_json.get("object").and_then(Value::as_str) == Some("database") {
                let title = result_json.get("title")
                    .and_then(Value::as_array)
                    .and_then(|arr| arr.first())
                    .and_then(|rt| rt.get("plain_text").or(rt.get("text").and_then(|t| t.get("content"))))
                    .and_then(Value::as_str)
                    .unwrap_or("Notion Database");
                let clean_id = page_id.replace('-', "");
                let url = format!("https://notion.so/{}", clean_id);
                return Some(json!({"type": "notion_database", "url": url, "title": title}));
            }
        }

        // n8n workflow creation (response has "id" + "name" + "nodes" fields)
        if result_json.get("nodes").is_some() && result_json.get("name").is_some() {
            if let Some(wf_id) = result_json.get("id").and_then(|v| v.as_str().or(v.as_i64().map(|_| "").or(Some("")))) {
                let wf_id_str = result_json.get("id").map(|v| match v {
                    Value::String(s) => s.clone(),
                    Value::Number(n) => n.to_string(),
                    _ => String::new(),
                }).unwrap_or_default();
                if !wf_id_str.is_empty() {
                    let name = result_json.get("name").and_then(Value::as_str).unwrap_or("n8n Workflow");
                    let _ = wf_id;
                    return Some(json!({"type": "n8n_workflow", "id": wf_id_str, "title": name}));
                }
            }
        }

        // Supabase table/row creation — detect PostgREST responses
        // PostgREST returns arrays or objects; we can't reliably detect table creation
        // but we can detect when the URL contains "supabase.co"
    }

    None
}

/// Forward a streaming delta from Anthropic to the EventBus as an SSE event.
async fn forward_stream_delta(
    event_bus: &EventBus,
    session_id: &str,
    node_id: &str,
    iteration: usize,
    event: &StreamEvent,
) {
    trace!(node_id = %node_id, iteration = iteration, "forwarding stream delta");
    let payload = match event {
        StreamEvent::ContentBlockDelta { index, delta } => {
            match delta {
                DeltaPayload::ThinkingDelta(text) => json!({
                    "type": "stream_entry",
                    "node_uid": node_id,
                    "stream_entry": {
                        "stream_type": "thinking_delta",
                        "sub_type": "thinking_delta",
                        "content": text,
                        "block_index": index,
                        "iteration": iteration,
                        "created_at": chrono::Utc::now().to_rfc3339(),
                    }
                }),
                DeltaPayload::TextDelta(text) => json!({
                    "type": "stream_entry",
                    "node_uid": node_id,
                    "stream_entry": {
                        "stream_type": "text_delta",
                        "sub_type": "text_delta",
                        "content": text,
                        "block_index": index,
                        "iteration": iteration,
                        "created_at": chrono::Utc::now().to_rfc3339(),
                    }
                }),
                DeltaPayload::SignatureDelta(_) | DeltaPayload::InputJsonDelta(_) => return, // not forwarded
            }
        }
        StreamEvent::ContentBlockStart { index, block_type } => {
            let sub_type = match block_type {
                ContentBlockType::Text => "text",
                ContentBlockType::Thinking => "thinking",
                ContentBlockType::ToolUse { .. } => "tool_use",
            };
            let mut entry = json!({
                "stream_type": "content_block_start",
                "sub_type": sub_type,
                "block_index": index,
                "iteration": iteration,
                "created_at": chrono::Utc::now().to_rfc3339(),
            });
            if let ContentBlockType::ToolUse { id, name } = block_type {
                entry["tool_use_id"] = json!(id);
                entry["tool_name"] = json!(name);
            }
            json!({
                "type": "stream_entry",
                "node_uid": node_id,
                "stream_entry": entry,
            })
        }
        StreamEvent::ContentBlockStop { index } => json!({
            "type": "stream_entry",
            "node_uid": node_id,
            "stream_entry": {
                "stream_type": "content_block_stop",
                "sub_type": "content_block_stop",
                "block_index": index,
                "iteration": iteration,
                "created_at": chrono::Utc::now().to_rfc3339(),
            }
        }),
        StreamEvent::MessageStop => json!({
            "type": "stream_entry",
            "node_uid": node_id,
            "stream_entry": {
                "stream_type": "message_stop",
                "sub_type": "message_stop",
                "created_at": chrono::Utc::now().to_rfc3339(),
            }
        }),
        _ => return, // MessageStart, MessageDelta — not forwarded
    };

    event_bus.send(session_id, payload).await;
}

/// Public wrapper so routes.rs can stream deltas for pre-execution chat.
pub async fn forward_stream_delta_pub(
    event_bus: &EventBus,
    session_id: &str,
    node_id: &str,
    iteration: usize,
    event: &StreamEvent,
) {
    forward_stream_delta(event_bus, session_id, node_id, iteration, event).await;
}

#[derive(Debug, Clone)]
pub struct AgentResult {
    pub node_uid: String,
    pub status: NodeStatus,
    pub judge_score: Option<f64>,
    pub judge_feedback: Option<String>,
    pub final_summary: Option<String>,
    pub output: Option<Value>,
    pub error: Option<String>,
    pub duration_ms: u64,
}

#[derive(Clone)]
pub struct AgentRunner {
    settings: Arc<Settings>,
    db: PgClient,
    catalog: Arc<AgentCatalog>,
    skill_catalog: Arc<crate::skills::SkillCatalog>,
    tool_catalog: Arc<crate::tool_catalog::ToolCatalog>,
    event_bus: EventBus,
    http_client: reqwest::Client,
}

impl AgentRunner {
    pub fn new(
        settings: Arc<Settings>,
        db: PgClient,
        catalog: Arc<AgentCatalog>,
        skill_catalog: Arc<crate::skills::SkillCatalog>,
        tool_catalog: Arc<crate::tool_catalog::ToolCatalog>,
        event_bus: EventBus,
    ) -> Self {
        let http_client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { settings, db, catalog, skill_catalog, tool_catalog, event_bus, http_client }
    }

    pub fn db(&self) -> &PgClient {
        &self.db
    }

    pub fn event_bus(&self) -> &EventBus {
        &self.event_bus
    }

    #[tracing::instrument(
        skip(self, plan_node, upstream_outputs),
        fields(session_id = %plan_node.session_id, node_uid = %plan_node.uid, agent = %plan_node.agent_slug)
    )]
    pub async fn run(
        &self,
        plan_node: &ExecutionPlanNode,
        upstream_outputs: &HashMap<String, Value>,
    ) -> AgentResult {
        let uid_str = plan_node.uid.to_string();

        info!(
            uid = %uid_str,
            agent = %plan_node.agent_slug,
            "agent runner starting"
        );

        // Load agent definition
        let agent = match self.catalog.get(&plan_node.agent_slug) {
            Some(a) => a,
            None => {
                let err = format!("agent not found in catalog: {}", plan_node.agent_slug);
                warn!(%err);
                return AgentResult {
                    node_uid: uid_str,
                    status: NodeStatus::Failed,
                    judge_score: None,
                    judge_feedback: None,
                    final_summary: None,
                    output: None,
                    error: Some(err),
                    duration_ms: 0,
                };
            }
        };

        // Build system prompt with upstream context and client context injected
        let upstream_context = build_upstream_context(upstream_outputs);

        // Parallelize independent DB loads: client_context, project_id, spawn_fields
        let client_context_fut = async {
            if let Some(client_id) = plan_node.client_id {
                crate::client::build_client_context(&self.db, client_id, None)
                    .await
                    .unwrap_or_default()
            } else {
                String::new()
            }
        };
        let project_id_fut = load_project_id(&self.db, plan_node.session_id);
        let spawn_fields_fut = load_spawn_fields(&self.db, plan_node.uid);

        let (client_context, project_id, (node_spawn_context, node_criteria, node_examples, node_description)) =
            tokio::join!(client_context_fut, project_id_fut, spawn_fields_fut);

        // Load credentials: project-level overrides → client-level → global env
        let mut credentials = if let Some(client_id) = plan_node.client_id {
            if let Some(ref master_key) = self.settings.credential_master_key {
                let creds = if let Some(pid) = project_id {
                    crate::credentials::load_credentials_for_project(&self.db, master_key, pid, client_id)
                        .await
                        .unwrap_or_default()
                } else {
                    crate::credentials::load_credentials_for_client(&self.db, master_key, client_id)
                        .await
                        .unwrap_or_default()
                };
                let slugs: Vec<&str> = creds.keys().map(|s| s.as_str()).collect();
                debug!(
                    agent = %plan_node.agent_slug,
                    %client_id,
                    project_id = ?project_id,
                    credentials = ?slugs,
                    "loaded credentials"
                );
                creds
            } else {
                tracing::warn!(agent = %plan_node.agent_slug, "CREDENTIAL_MASTER_KEY not set — skipping credential load");
                Default::default()
            }
        } else {
            tracing::debug!(agent = %plan_node.agent_slug, "no client_id on node — no credentials to load");
            Default::default()
        };

        // Auto-refresh expired OAuth tokens
        if let Some(client_id) = plan_node.client_id {
            let slugs: Vec<String> = credentials.keys().cloned().collect();
            for slug in slugs {
                if let Some(cred) = credentials.get(&slug) {
                    if cred.credential_type == "oauth2" {
                        match crate::oauth::refresh_if_needed(
                            &self.db, &self.settings, client_id, &slug, cred,
                        ).await {
                            Ok(Some(refreshed)) => {
                                credentials.insert(slug.clone(), refreshed);
                                tracing::info!(slug = %slug, "Refreshed expired OAuth token before agent run");
                            }
                            Ok(None) => {} // Token still valid
                            Err(e) => {
                                tracing::warn!(slug = %slug, error = %e, "Failed to refresh OAuth token");
                            }
                        }
                    }
                }
            }
        }

        // Preflight: verify required integrations have working credentials before LLM invocation
        {
            let required = crate::preflight::required_slugs_for_agent(
                &agent.required_integrations,
                &agent.tools,
            );
            if !required.is_empty() {
                let needed = crate::preflight::filter_required_credentials(
                    &credentials,
                    &required,
                    &self.settings,
                );

                // Check for completely missing credentials first
                let missing: Vec<&String> = required.iter()
                    .filter(|s| !needed.contains_key(s.as_str()))
                    .collect();
                if !missing.is_empty() {
                    let msg = format!(
                        "BLOCKED: Missing credentials for {}. Configure them in Settings > Integrations.",
                        missing.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
                    );
                    tracing::error!(agent = %plan_node.agent_slug, missing = ?missing, "preflight: missing credentials");
                    return AgentResult {
                        node_uid: uid_str,
                        status: NodeStatus::Failed,
                        judge_score: None,
                        judge_feedback: None,
                        final_summary: Some(msg.clone()),
                        output: Some(json!({"status": "blocked", "reason": msg})),
                        error: Some(msg),
                        duration_ms: 0,
                    };
                }

                let probes = crate::preflight::probe_integrations(&needed, Some(&self.settings)).await;

                let mut issues: Vec<String> = Vec::new();

                for f in probes.iter().filter(|p| !p.success()) {
                    let status_label = f.status.as_str();
                    let detail = if f.error.is_empty() { "unknown error".to_string() } else { f.error.clone() };
                    issues.push(format!("{} [{}]: {}", f.integration_slug, status_label, detail));
                }

                if !issues.is_empty() {
                    let msg = format!(
                        "BLOCKED: Credential verification failed — {}. Re-configure in Settings > Integrations.",
                        issues.join("; ")
                    );
                    tracing::error!(agent = %plan_node.agent_slug, issues = ?issues, "preflight: credential checks failed");
                    return AgentResult {
                        node_uid: uid_str,
                        status: NodeStatus::Failed,
                        judge_score: None,
                        judge_feedback: None,
                        final_summary: Some(msg.clone()),
                        output: Some(json!({"status": "blocked", "reason": msg})),
                        error: Some(msg),
                        duration_ms: 0,
                    };
                }

                tracing::info!(
                    agent = %plan_node.agent_slug,
                    probes = probes.len(),
                    "preflight credential checks passed"
                );
            }
        }

        let expert_context = if let Some(expert_id) = agent.expert_id {
            crate::client::build_expert_context(&self.db, expert_id)
                .await
                .unwrap_or_default()
        } else {
            String::new()
        };

        // node_spawn_context, node_criteria, node_examples, node_description already loaded above via tokio::join!

        // Resolve skill overlays if we have a skill match
        let skill_overlays = if let Some(skill) = self.skill_catalog.get(&plan_node.agent_slug) {
            crate::skills::resolve_overlays(
                &self.db,
                skill.id,
                agent.expert_id,
                plan_node.client_id,
                project_id,
            ).await
        } else {
            String::new()
        };

        let system_prompt = if node_spawn_context.is_some() || node_criteria.is_some() || node_examples.is_some() {
            let mut prompt = build_system_prompt_with_spawn_context(
                &agent.system_prompt,
                &upstream_context,
                &client_context,
                &expert_context,
                &agent,
                node_spawn_context.as_deref(),
                node_criteria.as_ref(),
                node_examples.as_deref(),
            );
            if !skill_overlays.is_empty() {
                tracing::debug!(agent = %plan_node.agent_slug, overlay_chars = skill_overlays.len(), "injecting skill overlays into prompt");
                prompt.push_str("\n\n## Contextual Lessons & Preferences\n");
                prompt.push_str(&skill_overlays);
            }
            prompt
        } else {
            let mut prompt = build_system_prompt(
                &agent.system_prompt,
                &upstream_context,
                &client_context,
                &expert_context,
                &agent,
            );
            if !skill_overlays.is_empty() {
                tracing::debug!(agent = %plan_node.agent_slug, overlay_chars = skill_overlays.len(), "injecting skill overlays into prompt");
                prompt.push_str("\n\n## Contextual Lessons & Preferences\n");
                prompt.push_str(&skill_overlays);
            }
            prompt
        };

        // Inject rich description context if the node has a populated description JSONB
        let system_prompt = if let Some(ref desc) = node_description {
            if let Some(obj) = desc.as_object() {
                if !obj.is_empty() {
                    let mut p = system_prompt;
                    p.push_str("\n\n## Component Description\n");
                    p.push_str("This is a living system description for the component you are building. ");
                    p.push_str("Use this context to understand the architecture, technical approach, and I/O contracts.\n\n");
                    if let Some(arch) = obj.get("architecture") {
                        if let Some(purpose) = arch.get("purpose").and_then(|v| v.as_str()) {
                            p.push_str(&format!("**Purpose**: {}\n", purpose));
                        }
                        if let Some(flow) = arch.get("data_flow").and_then(|v| v.as_str()) {
                            p.push_str(&format!("**Data Flow**: {}\n", flow));
                        }
                    }
                    if let Some(spec) = obj.get("technical_spec") {
                        if let Some(approach) = spec.get("approach").and_then(|v| v.as_str()) {
                            p.push_str(&format!("**Technical Approach**: {}\n", approach));
                        }
                    }
                    if let Some(io) = obj.get("io_contract") {
                        p.push_str(&format!("\n**I/O Contract**:\n```json\n{}\n```\n", serde_json::to_string_pretty(io).unwrap_or_default()));
                    }
                    if let Some(opts) = obj.get("optionality").and_then(|v| v.as_array()) {
                        if !opts.is_empty() {
                            p.push_str("\n**Implementation Options**:\n");
                            for opt in opts {
                                if let Some(decision) = opt.get("decision").and_then(|v| v.as_str()) {
                                    let tradeoffs = opt.get("tradeoffs").and_then(|v| v.as_str()).unwrap_or("");
                                    p.push_str(&format!("- {}: {}\n", decision, tradeoffs));
                                }
                            }
                        }
                    }
                    tracing::debug!(agent = %plan_node.agent_slug, desc_keys = ?obj.keys().collect::<Vec<_>>(), "injected rich description context");
                    p
                } else {
                    system_prompt
                }
            } else {
                system_prompt
            }
        } else {
            system_prompt
        };

        // SD-004: Inject platform tool knowledge if this node has a tool_id
        let system_prompt = if let Some(ref tool_id) = plan_node.tool_id {
            if let Some(tool) = self.tool_catalog.get_tool(tool_id) {
                let mut p = system_prompt;
                p.push_str("\n\n## Platform: ");
                p.push_str(&tool.name);
                p.push_str("\n\n");
                if !tool.knowledge.is_empty() {
                    p.push_str(&tool.knowledge);
                }
                if let Some(ref gotchas) = tool.gotchas {
                    if !gotchas.is_empty() {
                        p.push_str("\n\n");
                        p.push_str(gotchas);
                    }
                }
                debug!(agent = %plan_node.agent_slug, tool = %tool_id, "injected tool knowledge into prompt");
                p
            } else {
                tracing::warn!(agent = %plan_node.agent_slug, tool = %tool_id, "tool_id set but tool not found in catalog");
                system_prompt
            }
        } else {
            system_prompt
        };

        // Inject project-level architecture so agents understand the broader system they're building within
        let system_prompt = {
            let project_desc = load_project_description(&self.db, plan_node.session_id).await;
            if !project_desc.is_empty() {
                let mut p = system_prompt;
                p.push_str("\n\n<project_context>\n## Project Architecture\n");
                p.push_str(&project_desc);
                p.push_str("\n</project_context>");
                p
            } else {
                system_prompt
            }
        };

        // If this is a master_orchestrator, load preview plan children and inject into prompt
        let (system_prompt, orchestrator_plan) = if plan_node.agent_slug == MASTER_ORCHESTRATOR_SLUG {
            let preview_plan = load_preview_plan(&self.db, plan_node.uid).await;
            if !preview_plan.is_empty() {
                let mut p = system_prompt;
                p.push_str("\n\n## Execution Plan\n\n");
                p.push_str("The following decomposition was generated during planning. ");
                p.push_str("You will be asked to prepare rich execution context for each step.\n\n");
                for (i, (_uid, slug, task)) in preview_plan.iter().enumerate() {
                    p.push_str(&format!("{}. **{}**: {}\n", i + 1, slug, task));
                }
                p.push_str("\nThe agent catalog summary below shows available agents and their capabilities.\n");
                p.push_str(&self.catalog.catalog_summary());
                p.push_str("\n\n## Available Platform Tools\n\n");
                p.push_str(&self.tool_catalog.tools_summary());
                (p, preview_plan)
            } else {
                let mut p = system_prompt;
                p.push_str("\n\n## Agent Catalog\n\n");
                p.push_str(&self.catalog.catalog_summary());
                p.push_str("\n\n## Available Platform Tools\n\n");
                p.push_str(&self.tool_catalog.tools_summary());
                (p, vec![])
            }
        } else {
            (system_prompt, vec![])
        };

        debug!(
            uid = %uid_str,
            prompt_chars = system_prompt.len(),
            "system prompt assembled"
        );

        // Build tool list for this agent
        let agent_tools = actions::actions_for_agent(
            &agent.tools,
            plan_node.parent_uid.is_none(), // allow spawn_agent only for top-level nodes
        );

        debug!(
            uid = %uid_str,
            tool_count = agent_tools.len(),
            "agent tools resolved"
        );

        // Plan-driven execution: if we have a pre-built plan, the system follows it
        // directly instead of letting the LLM decide what to spawn on the fly.
        if !orchestrator_plan.is_empty() {
            info!(
                uid = %uid_str,
                steps = orchestrator_plan.len(),
                "entering plan-driven execution"
            );
            return self.run_orchestrated_plan(
                plan_node,
                &system_prompt,
                &plan_node.model,
                &credentials,
                &orchestrator_plan,
            ).await;
        }

        // Merge dynamic acceptance_criteria (from orchestrator enrichment) into the
        // judge rubric so it can validate against task-specific criteria,
        // not just the agent's static rubric from agent.toml.
        let mut effective_judge_config = plan_node.judge_config.clone();
        if let Some(ref criteria_json) = node_criteria {
            if let Some(arr) = criteria_json.as_array() {
                for c in arr {
                    if let Some(s) = c.as_str() {
                        effective_judge_config.rubric.push(s.to_string());
                    }
                }
            }
        }

        // ── Stage 1: Executor ────────────────────────────────────────────────
        info!(uid = %uid_str, agent = %plan_node.agent_slug, "entering executor stage");

        // Upstream context is already in the system prompt — don't duplicate in user message.
        let executor_question = format!("Task: {}", plan_node.task_description);

        let model = &plan_node.model;
        let mut executor_output: Option<Value>;
        let mut executor_summary: String;
        let mut judge_feedback_for_retry = String::new();

        let sid = plan_node.session_id.to_string();
        let nid = uid_str.clone();
        let node_started_at = Instant::now();

        for attempt in 0..=MAX_JUDGE_RETRIES {
            if attempt > 0 {
                emit_event(&self.db, &self.event_bus, &sid, &nid, "node_retry", &json!({
                    "attempt": attempt,
                    "feedback": &judge_feedback_for_retry,
                })).await;
            }

            let question_with_feedback = if judge_feedback_for_retry.is_empty() {
                executor_question.clone()
            } else {
                format!(
                    "<previous_attempt_feedback>\nYour previous attempt was rejected. Feedback from quality review:\n{}\nRevise your work to address this feedback.\n</previous_attempt_feedback>\n\n{}",
                    judge_feedback_for_retry, executor_question
                )
            };

            info!(attempt = attempt, "running executor");
            let result = self
                .executor_run(
                    &question_with_feedback,
                    &system_prompt,
                    &agent_tools,
                    model,
                    plan_node.max_iterations as usize,
                    &sid,
                    upstream_outputs,
                    &credentials,
                    &nid,
                    plan_node.client_id,
                    project_id,
                )
                .await;

            executor_output = result.get("output").cloned();
            executor_summary = result
                .get("summary")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();

            // Always extract the tool_log so the judge can see what was executed.
            let tool_log = result.get("tool_log")
                .and_then(Value::as_array)
                .map(|arr| arr.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "))
                .unwrap_or_default();

            if executor_summary.is_empty() {
                let last_text = result.get("last_llm_text")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if !tool_log.is_empty() || !last_text.is_empty() {
                    let last_preview: String = last_text.chars().take(2000).collect();
                    executor_summary = format!(
                        "[Executor did not call write_output — max iterations reached]\n\nTool calls: {}\n\nLast agent response:\n{}",
                        if tool_log.is_empty() { "none".to_string() } else { tool_log },
                        last_preview,
                    );
                }
            } else if !tool_log.is_empty() {
                executor_summary = format!(
                    "{}\n\n---\n[Platform-verified tool calls: {}]",
                    executor_summary, tool_log
                );
            }

            let paused_for_user = result
                .get("paused")
                .and_then(Value::as_bool)
                .unwrap_or(false);

            if paused_for_user {
                info!("executor paused for user action — returning AwaitingReply");
                return AgentResult {
                    node_uid: uid_str,
                    status: NodeStatus::AwaitingReply,
                    judge_score: None,
                    judge_feedback: None,
                    final_summary: Some(executor_summary),
                    output: executor_output,
                    error: None,
                    duration_ms: node_started_at.elapsed().as_millis() as u64,
                };
            }

            if plan_node.skip_judge || self.settings.skip_judge {
                // Only pass if executor actually produced output
                let has_output = executor_output.as_ref()
                    .map(|o| !o.is_null() && o != &json!({}))
                    .unwrap_or(false);
                if has_output {
                    info!("judge skipped (skip_judge=true)");
                    return AgentResult {
                        node_uid: uid_str,
                        status: NodeStatus::Passed,
                        judge_score: None,
                        judge_feedback: None,
                        final_summary: Some(executor_summary),
                        output: executor_output,
                        error: None,
                        duration_ms: node_started_at.elapsed().as_millis() as u64,
                    };
                } else {
                    warn!("judge skipped but executor produced no output — marking failed");
                    return AgentResult {
                        node_uid: uid_str,
                        status: NodeStatus::Failed,
                        judge_score: None,
                        judge_feedback: Some("No output produced".to_string()),
                        final_summary: Some(executor_summary),
                        output: executor_output,
                        error: Some("Executor produced no output (max iterations or no write_output call)".to_string()),
                        duration_ms: node_started_at.elapsed().as_millis() as u64,
                    };
                }
            }

            // ── Stage 2: Judge ────────────────────────────────────────────────
            info!(uid = %uid_str, attempt = attempt, threshold = effective_judge_config.threshold, "entering judge stage");
            emit_event(&self.db, &self.event_bus, &sid, &nid, "judge_start", &json!({
                "attempt": attempt,
            })).await;

            let judge_result = self
                .judge_run(&executor_question, &executor_summary, &effective_judge_config, model)
                .await;

            let llm_verdict = judge_result
                .get("verdict")
                .and_then(Value::as_str)
                .unwrap_or("fail");
            let score = judge_result
                .get("score")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let feedback = judge_result
                .get("feedback")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();

            // Enforce threshold: override LLM verdict if score doesn't match
            let verdict = if llm_verdict == "pass" && score < effective_judge_config.threshold {
                warn!(
                    score,
                    threshold = effective_judge_config.threshold,
                    "judge said pass but score below threshold — overriding to fail"
                );
                "fail"
            } else if llm_verdict == "reject" {
                "reject"
            } else {
                llm_verdict
            };

            // Emit judge_done + specific verdict event
            emit_event(&self.db, &self.event_bus, &sid, &nid, "judge_done", &json!({
                "verdict": verdict,
                "score": score,
                "feedback": &feedback,
            })).await;

            let verdict_event = match verdict {
                "pass" => "judge_pass",
                "reject" => "judge_reject",
                _ => "judge_fail",
            };
            emit_event(&self.db, &self.event_bus, &sid, &nid, verdict_event, &json!({
                "score": score,
                "feedback": &feedback,
            })).await;

            info!(verdict, score, attempt, "judge verdict");

            match verdict {
                "pass" => {
                    return AgentResult {
                        node_uid: uid_str,
                        status: NodeStatus::Passed,
                        judge_score: Some(score),
                        judge_feedback: Some(feedback),
                        final_summary: Some(executor_summary),
                        output: executor_output,
                        error: None,
                        duration_ms: node_started_at.elapsed().as_millis() as u64,
                    };
                }
                "reject" => {
                    return AgentResult {
                        node_uid: uid_str,
                        status: NodeStatus::Failed,
                        judge_score: Some(score),
                        judge_feedback: Some(feedback.clone()),
                        final_summary: Some(executor_summary),
                        output: executor_output,
                        error: Some(format!("Judge hard-rejected: {feedback}")),
                        duration_ms: node_started_at.elapsed().as_millis() as u64,
                    };
                }
                _ => {
                    judge_feedback_for_retry = feedback;
                    if attempt == MAX_JUDGE_RETRIES {
                        return AgentResult {
                            node_uid: uid_str,
                            status: NodeStatus::Failed,
                            judge_score: Some(score),
                            judge_feedback: Some(judge_feedback_for_retry),
                            final_summary: Some(executor_summary),
                            output: executor_output,
                            error: Some("Max retries exceeded".to_string()),
                            duration_ms: node_started_at.elapsed().as_millis() as u64,
                        };
                    }
                    warn!(attempt, "judge failed — retrying");
                }
            }
        }

        // Should not reach here (loop always returns)
        AgentResult {
            node_uid: uid_str,
            status: NodeStatus::Failed,
            judge_score: None,
            judge_feedback: None,
            final_summary: None,
            output: None,
            error: Some("Unexpected loop exit".to_string()),
            duration_ms: node_started_at.elapsed().as_millis() as u64,
        }
    }

    /// Run the executor: LLM tool loop until write_output is called or max_iterations reached.
    #[tracing::instrument(skip(self, question, system_prompt, tool_defs, upstream_outputs, credentials), fields(node_id = %node_id, model = %model))]
    async fn executor_run(
        &self,
        question: &str,
        system_prompt: &str,
        tool_defs: &[ToolDef],
        model: &str,
        max_iterations: usize,
        session_id: &str,
        upstream_outputs: &HashMap<String, Value>,
        credentials: &crate::credentials::CredentialMap,
        node_id: &str,
        client_id: Option<uuid::Uuid>,
        project_id: Option<uuid::Uuid>,
    ) -> Value {
        let client = AnthropicClient::new(
            self.settings.anthropic_api_key.clone(),
            model.to_string(),
        );

        // Extended thinking: only for models that support it, and only when budget > 0.
        let thinking_budget = if self.settings.thinking_budget_tokens > 0
            && (model.contains("sonnet") || model.contains("opus"))
            && !model.contains("haiku")
        {
            Some(self.settings.thinking_budget_tokens)
        } else {
            None
        };

        emit_event(&self.db, &self.event_bus, session_id, node_id, "executor_start", &json!({
            "model": model,
            "thinking_enabled": thinking_budget.is_some(),
            "thinking_budget": thinking_budget,
        })).await;

        let mut messages = vec![user_message(question.to_string())];
        let mut final_output: Option<Value> = None;
        let mut final_summary = String::new();
        let mut tool_call_log: Vec<String> = Vec::new();
        let mut last_llm_text = String::new();
        let mut consecutive_no_tool_calls: usize = 0;
        const STALL_THRESHOLD: usize = 3;

        // Persist initial user message
        persist_message(&self.db, &self.event_bus, session_id, node_id, "user", question, &json!({})).await;

        for iteration in 0..max_iterations {
            emit_event(&self.db, &self.event_bus, session_id, node_id, "executor_llm_send", &json!({
                "iteration": iteration + 1,
                "model": model,
            })).await;

            let llm_started_at = Instant::now();

            // Stream from Anthropic API — deltas forwarded to EventBus in real-time
            let (mut delta_rx, response_handle) = client.messages_stream(
                system_prompt,
                &messages,
                tool_defs,
                8192,
                Some(model),
                thinking_budget,
            );
            while let Some(event) = delta_rx.recv().await {
                forward_stream_delta(&self.event_bus, session_id, node_id, iteration + 1, &event).await;
            }
            let response = match response_handle.await {
                Ok(Ok(r)) => r,
                Ok(Err(e)) => {
                    warn!(iteration, error = %e, "executor LLM call failed");
                    last_llm_text = format!("[LLM call failed on iteration {}: {}]", iteration + 1, e);
                    break;
                }
                Err(e) => {
                    warn!(iteration, error = %e, "executor LLM task panicked");
                    last_llm_text = format!("[LLM task panicked on iteration {}: {}]", iteration + 1, e);
                    break;
                }
            };
            let llm_duration_ms = llm_started_at.elapsed().as_millis() as u64;

            // ── Extract and persist thinking blocks ─────────────────────────
            let thinking_blocks = response.thinking();
            if !thinking_blocks.is_empty() {
                let full_thinking = thinking_blocks.join("\n\n");
                let thinking_tokens = response.thinking_tokens().unwrap_or(0);

                // Persist to thinking_blocks table
                if let (Ok(sid), Ok(nid)) = (
                    session_id.parse::<uuid::Uuid>(),
                    node_id.parse::<uuid::Uuid>(),
                ) {
                    let _ = self.db.execute_with(
                        "INSERT INTO thinking_blocks (session_id, node_id, iteration, thinking_text, token_count) VALUES ($1, $2, $3, $4, $5)",
                        pg_args!(sid, nid, (iteration + 1) as i32, full_thinking.clone(), thinking_tokens as i64),
                    ).await;
                }

                // Broadcast thinking as a stream entry (full text for unified view)
                self.event_bus.send(session_id, json!({
                    "type": "stream_entry",
                    "node_uid": node_id,
                    "stream_entry": {
                        "stream_type": "thinking",
                        "sub_type": "thinking_block",
                        "thinking_text": full_thinking.clone(),
                        "iteration": iteration + 1,
                        "token_count": thinking_tokens,
                        "created_at": chrono::Utc::now().to_rfc3339(),
                    }
                })).await;

                // Emit thinking event with preview (full text in DB, preview via SSE)
                let preview: String = full_thinking.chars().take(500).collect();
                emit_event(&self.db, &self.event_bus, session_id, node_id, "executor_thinking", &json!({
                    "iteration": iteration + 1,
                    "thinking_preview": if full_thinking.len() > 500 { format!("{preview}...") } else { preview },
                    "thinking_length": full_thinking.len(),
                    "thinking_tokens": thinking_tokens,
                })).await;
            }

            let stop_reason = response.stop_reason.as_deref().unwrap_or("end_turn");
            let llm_text = response.text();
            if !llm_text.is_empty() {
                last_llm_text = llm_text.clone();
            }
            let tool_call_names: Vec<String> = response
                .tool_uses()
                .iter()
                .map(|(_, name, _)| name.to_string())
                .collect();
            for name in &tool_call_names {
                tool_call_log.push(format!("iter {}: {}", iteration + 1, name));
            }

            if tool_call_names.is_empty() {
                consecutive_no_tool_calls += 1;
                if consecutive_no_tool_calls >= STALL_THRESHOLD {
                    warn!(node_id = %node_id, iteration = iteration + 1, "executor stalled — {STALL_THRESHOLD} consecutive iterations with no tool calls");
                    emit_event(&self.db, &self.event_bus, session_id, node_id, "executor_stall", &json!({
                        "iteration": iteration + 1,
                        "consecutive_no_tool_calls": consecutive_no_tool_calls,
                    })).await;
                    break;
                }
            } else {
                consecutive_no_tool_calls = 0;
            }

            emit_event(&self.db, &self.event_bus, session_id, node_id, "executor_llm_receive", &json!({
                "iteration": iteration + 1,
                "stop_reason": stop_reason,
                "duration_ms": llm_duration_ms,
                "input_tokens": response.input_tokens(),
                "output_tokens": response.output_tokens(),
                "cache_creation_tokens": response.cache_creation_input_tokens(),
                "cache_read_tokens": response.cache_read_input_tokens(),
                "thinking_tokens": response.thinking_tokens(),
                "has_thinking": !thinking_blocks.is_empty(),
                "llm_text": if llm_text.len() > 5000 { format!("{}...", &llm_text[..5000]) } else { llm_text.clone() },
                "tool_calls": tool_call_names,
            })).await;

            // Append assistant message to history
            messages.push(assistant_message_from_response(&response.content));

            // Persist assistant message (text portion)
            if !llm_text.is_empty() {
                persist_message(&self.db, &self.event_bus, session_id, node_id, "assistant", &llm_text, &json!({
                    "iteration": iteration + 1,
                    "tool_calls": tool_call_names,
                })).await;
            }

            // Persist tool_use entries
            for (id, name, input) in response.tool_uses() {
                persist_message(&self.db, &self.event_bus, session_id, node_id, "tool_use", &name, &json!({
                    "tool_use_id": id,
                    "tool_name": name,
                    "tool_input": input,
                })).await;
            }

            if response.is_end_turn() {
                info!(node_id = %node_id, iterations = iteration + 1, "executor finished (end_turn)");
                final_summary = response.text();
                break;
            }

            if !response.is_tool_use() {
                info!(node_id = %node_id, iterations = iteration + 1, "executor finished (no tool use)");
                final_summary = response.text();
                break;
            }

            // Execute tool calls
            let tool_uses: Vec<(String, String, Value)> = response
                .tool_uses()
                .iter()
                .map(|(id, name, input)| (id.to_string(), name.to_string(), (*input).clone()))
                .collect();

            let mut tool_results: Vec<(String, String)> = Vec::new();

            for (tool_use_id, tool_name, tool_input) in &tool_uses {
                // Handle spawn_agent synchronously within the executor loop
                if tool_name == "spawn_agent" {
                    let agent_slug = tool_input.get("agent_slug").and_then(Value::as_str).unwrap_or("");
                    let task_desc = tool_input.get("task_description").and_then(Value::as_str).unwrap_or("");
                    let context = tool_input.get("context").and_then(Value::as_str);
                    let criteria: Option<Vec<String>> = tool_input.get("acceptance_criteria")
                        .and_then(Value::as_array)
                        .map(|arr| arr.iter().filter_map(Value::as_str).map(String::from).collect());
                    let examples = tool_input.get("examples").and_then(Value::as_str);
                    let skill_slugs: Vec<String> = tool_input.get("skill_slugs")
                        .and_then(Value::as_array)
                        .map(|arr| arr.iter().filter_map(Value::as_str).map(String::from).collect())
                        .unwrap_or_default();

                    // Build a minimal parent node reference for run_child
                    let parent_node = crate::agent_catalog::ExecutionPlanNode {
                        uid: node_id.parse::<uuid::Uuid>().unwrap_or_default(),
                        session_id: session_id.parse::<uuid::Uuid>().unwrap_or_default(),
                        agent_slug: String::new(),
                        agent_git_sha: String::new(),
                        task_description: String::new(),
                        status: crate::agent_catalog::NodeStatus::Running,
                        requires: vec![],
                        attempt_count: 0,
                        parent_uid: None,
                        input: None,
                        output: None,
                        judge_score: None,
                        judge_feedback: None,
                        judge_config: crate::agent_catalog::JudgeConfig::default(),
                        max_iterations: 0,
                        model: model.to_string(),
                        skip_judge: false,
                        variant_group: None,
                        variant_label: None,
                        variant_selected: None,
                        client_id: None,
                        tool_id: None,
                        execution_mode: "agent".to_string(),
                        integration_overrides: serde_json::json!({}),
                    };

                    // Look up client_id from the parent node in DB
                    let parent_client_id = {
                        let nid_uuid = node_id.parse::<uuid::Uuid>().unwrap_or_default();
                        let rows = self.db.execute_with(
                            "SELECT client_id FROM execution_nodes WHERE id = $1",
                            pg_args!(nid_uuid),
                        ).await.unwrap_or_default();
                        rows.first()
                            .and_then(|r| r.get("client_id").and_then(Value::as_str))
                            .and_then(|s| s.parse::<uuid::Uuid>().ok())
                    };
                    let mut parent_node = parent_node;
                    parent_node.client_id = parent_client_id;

                    // Resolve skill overlays and prepend to context
                    let enriched_context = if !skill_slugs.is_empty() {
                        let mut overlay_parts = Vec::new();
                        for ss in &skill_slugs {
                            if let Some(skill) = self.skill_catalog.get(ss) {
                                let overlays = crate::skills::resolve_overlays(
                                    &self.db,
                                    skill.id,
                                    None,
                                    parent_node.client_id,
                                    load_project_id(&self.db, parent_node.session_id).await,
                                ).await;
                                if !overlays.is_empty() {
                                    overlay_parts.push(overlays);
                                }
                            }
                        }
                        if overlay_parts.is_empty() {
                            context.map(|c| c.to_string())
                        } else {
                            let overlay_block = format!(
                                "## Skill Overlays\n{}\n\n{}",
                                overlay_parts.join("\n\n---\n\n"),
                                context.unwrap_or("")
                            );
                            Some(overlay_block)
                        }
                    } else {
                        context.map(|c| c.to_string())
                    };

                    let spawn_result = self.run_child(
                        &parent_node,
                        agent_slug,
                        task_desc,
                        enriched_context.as_deref().or(context),
                        criteria,
                        examples,
                    ).await;

                    tool_results.push((tool_use_id.clone(), spawn_result.to_string()));
                    continue;
                }

                if tool_name == "request_user_action" {
                    let action_title = tool_input
                        .get("action_title")
                        .and_then(Value::as_str)
                        .unwrap_or("Manual action required")
                        .to_string();
                    final_summary = action_title.clone();

                    tool_results.push((
                        tool_use_id.clone(),
                        json!({"status": "paused", "message": "Waiting for user to complete manual action"}).to_string(),
                    ));

                    persist_message(&self.db, &self.event_bus, session_id, node_id, "tool_result", &json!({"status": "paused"}).to_string(), &json!({
                        "tool_use_id": tool_use_id,
                        "tool_name": "request_user_action",
                    })).await;

                    final_output = Some(json!({
                        "action_title": action_title,
                        "paused_for_user_action": true,
                    }));
                    break;
                }

                if tool_name == "write_output" {
                    final_output = tool_input.get("result").cloned();
                    final_summary = tool_input
                        .get("summary")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();

                    // Merge top-level artifacts into the output so work_queue can extract them.
                    // Resolve "self" references in artifact URLs to the actual node_id.
                    if let Some(artifacts) = tool_input.get("artifacts") {
                        let mut resolved = artifacts.clone();
                        if let Some(arr) = resolved.as_array_mut() {
                            for item in arr.iter_mut() {
                                if let Some(url) = item.get("url").and_then(Value::as_str) {
                                    if url.contains("/self") || url.contains("{node_id}") {
                                        let fixed = url.replace("/self", &format!("/{}", node_id))
                                            .replace("{node_id}", node_id);
                                        item.as_object_mut().map(|o| o.insert("url".to_string(), Value::String(fixed)));
                                    }
                                }
                            }
                        }
                        if let Some(ref mut output) = final_output {
                            if let Some(obj) = output.as_object_mut() {
                                obj.entry("artifacts").or_insert_with(|| resolved);
                            }
                        } else {
                            final_output = Some(json!({"artifacts": resolved}));
                        }
                    }

                    tool_results.push((tool_use_id.clone(), json!({"stored": true}).to_string()));
                    break;
                }

                info!(node_id = %node_id, tool = %tool_name, iteration = iteration + 1, "executing tool");
                let tool_started_at = Instant::now();
                let result = if tool_name == "search_knowledge" {
                    let query_text = tool_input.get("query").and_then(Value::as_str).unwrap_or("");
                    let limit = tool_input.get("limit").and_then(Value::as_u64).unwrap_or(5).min(10);
                    self.execute_search_knowledge(query_text, limit, client_id, project_id).await
                } else if tool_name == "read_knowledge" {
                    let doc_id = tool_input.get("document_id").and_then(Value::as_str).unwrap_or("");
                    let chunk_idx = tool_input.get("chunk_index").and_then(Value::as_i64).unwrap_or(0);
                    let range = tool_input.get("range").and_then(Value::as_i64).unwrap_or(5).min(20);
                    self.execute_read_knowledge(doc_id, chunk_idx, range, client_id).await
                } else {
                    actions::execute_action(tool_name, tool_input, session_id, upstream_outputs, credentials, &self.settings, &self.http_client).await
                };
                let tool_duration_ms = tool_started_at.elapsed().as_millis() as u64;
                info!(node_id = %node_id, tool = %tool_name, duration_ms = tool_duration_ms, result_chars = result.len(), "tool complete");

                emit_event(&self.db, &self.event_bus, session_id, node_id, "tool_call", &json!({
                    "tool": tool_name,
                    "iteration": iteration + 1,
                    "duration_ms": tool_duration_ms,
                })).await;

                let result_preview: String = result.chars().take(2000).collect();
                persist_message(&self.db, &self.event_bus, session_id, node_id, "tool_result", &result_preview, &json!({
                    "tool_use_id": tool_use_id,
                    "tool_name": tool_name,
                })).await;

                maybe_emit_early_artifact(&self.db, &self.event_bus, session_id, node_id, tool_name, &result).await;

                tool_results.push((tool_use_id.clone(), result));
            }

            // Always push accumulated tool_results before breaking so the
            // saved conversation_state has valid tool_result messages for every
            // tool_use — this prevents Anthropic API errors on resume.
            if !tool_results.is_empty() {
                messages.push(tool_results_message(&tool_results));
            }

            if final_output.is_some() {
                break;
            }

            // Truncate old messages to prevent context window overflow.
            // Keep first message (task question) and last 8 messages in full;
            // compress older tool_result contents to short previews.
            if messages.len() > 20 {
                truncate_old_messages(&mut messages, 8);
            }
        }

        // Persist conversation state for potential resume
        if let (Ok(sid), Ok(nid)) = (
            session_id.parse::<uuid::Uuid>(),
            node_id.parse::<uuid::Uuid>(),
        ) {
            let conv_state = json!({
                "messages": messages,
                "system_prompt": system_prompt,
                "model": model,
            });
            let _ = self.db.execute_with(
                "UPDATE execution_nodes SET conversation_state = $1 WHERE id = $2 AND session_id = $3",
                pg_args!(conv_state, nid, sid),
            ).await;
        }

        let paused = final_output
            .as_ref()
            .and_then(|o| o.get("paused_for_user_action"))
            .and_then(Value::as_bool)
            .unwrap_or(false);

        json!({
            "output": final_output,
            "summary": final_summary,
            "paused": paused,
            "tool_log": tool_call_log,
            "last_llm_text": last_llm_text,
        })
    }

    /// Judge: score the output 0-10 against the rubric + need_to_know and decide pass/fail/reject.
    #[tracing::instrument(skip(self, question, narrative, judge_config), fields(stage = "judge"))]
    async fn judge_run(
        &self,
        question: &str,
        narrative: &str,
        judge_config: &JudgeConfig,
        model: &str,
    ) -> Value {
        info!(threshold = judge_config.threshold, rubric_items = judge_config.rubric.len(), "running judge");
        let client = AnthropicClient::new(
            self.settings.anthropic_api_key.clone(),
            model.to_string(),
        );

        let rubric_section = if judge_config.rubric.is_empty() {
            String::new()
        } else {
            let items = judge_config
                .rubric
                .iter()
                .enumerate()
                .map(|(i, item)| format!("{}. {}", i + 1, item))
                .collect::<Vec<_>>()
                .join("\n");
            format!(
                "\n\n## Quality Checklist\nEvaluate each item. Items that are not applicable to the specific task count as met.\n{items}"
            )
        };

        let need_to_know = if judge_config.need_to_know.is_empty() {
            String::new()
        } else {
            format!(
                "\n\n## Hard Requirements (REJECT if not answered)\n{}",
                judge_config
                    .need_to_know
                    .iter()
                    .map(|q| format!("- {}", q))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        };

        let system = "You are a quality judge evaluating an AI agent's output.\n\nScoring guide:\n- 9-10: All applicable criteria met, work completed with referenced resource IDs or confirmed results\n- 7-8: Core deliverable exists, minor gaps or cosmetic issues\n- 5-6: Deliverable partially exists, significant items missing or wrong\n- 3-4: Mostly planning or aspirational — no tool calls were actually made\n- 1-2: No real work done\n\nIMPORTANT: The agent's tool calls are executed by the platform and results are system-verified. When the output references resource IDs (e.g. table IDs, workflow IDs) or states that operations succeeded, treat this as real execution evidence. Do NOT penalize for summarizing results instead of including raw API response bodies.\n\nChecklist items that are not relevant to the specific task should not reduce the score.";
        let prompt = format!(
            "Score this agent output from 0-10 based on quality, completeness, and accuracy.\n\nThreshold to pass: {threshold:.1}\n{rubric_section}{need_to_know}\n\n## Question / Task\n{question}\n\n## Agent Output\n{narrative}\n\nRespond with JSON: {{\"verdict\": \"pass\"|\"fail\"|\"reject\", \"score\": number, \"feedback\": \"string\"}}",
            threshold = judge_config.threshold,
        );

        let response = match client
            .messages(system, &[user_message(prompt)], &[], 1024, Some(model))
            .await
        {
            Ok(r) => r,
            Err(e) => {
                warn!(error = %e, "judge LLM call failed — defaulting to fail");
                return json!({"verdict": "fail", "score": 0.0, "feedback": "judge unavailable — LLM call failed"});
            }
        };

        let text = response.text();
        let cleaned = text
            .trim()
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();

        serde_json::from_str(cleaned).unwrap_or_else(|_| {
            warn!("judge returned unparseable JSON — treating as fail");
            json!({"verdict": "fail", "score": 0.0, "feedback": "judge parse error — could not evaluate output"})
        })
    }


    /// Plan-driven execution for master_orchestrator with preview children.
    ///
    /// Instead of an open-ended LLM tool loop where the model decides which agents
    /// to spawn, the system iterates through the planned steps in order. The
    /// orchestrator LLM is used only to enrich each step with detailed context,
    /// acceptance criteria, and examples before execution.
    #[tracing::instrument(skip(self, plan_node, system_prompt, _credentials, preview_children), fields(session_id = %plan_node.session_id, node_uid = %plan_node.uid))]
    async fn run_orchestrated_plan(
        &self,
        plan_node: &ExecutionPlanNode,
        system_prompt: &str,
        model: &str,
        _credentials: &crate::credentials::CredentialMap,
        preview_children: &[(uuid::Uuid, String, String)],
    ) -> AgentResult {
        info!(model = %model, steps = preview_children.len(), "entering orchestrated plan execution");
        let sid = plan_node.session_id.to_string();
        let nid = plan_node.uid.to_string();
        let started_at = Instant::now();

        let client = AnthropicClient::new(
            self.settings.anthropic_api_key.clone(),
            model.to_string(),
        );

        let thinking_budget = if self.settings.thinking_budget_tokens > 0
            && (model.contains("sonnet") || model.contains("opus"))
            && !model.contains("haiku")
        {
            Some(self.settings.thinking_budget_tokens)
        } else {
            None
        };

        emit_event(&self.db, &self.event_bus, &sid, &nid, "plan_execution_start", &json!({
            "model": model,
            "total_steps": preview_children.len(),
            "steps": preview_children.iter().map(|(_, slug, task)| json!({
                "agent_slug": slug, "task_description": task
            })).collect::<Vec<_>>(),
        })).await;

        persist_message(&self.db, &self.event_bus, &sid, &nid, "system", "Plan-driven execution started", &json!({
            "total_steps": preview_children.len(),
        })).await;

        let plan_summary: String = preview_children.iter().enumerate()
            .map(|(i, (_, slug, task))| format!("{}. **{}**: {}", i + 1, slug, task))
            .collect::<Vec<_>>()
            .join("\n");

        let mut messages: Vec<Value> = Vec::new();
        let mut child_outputs: HashMap<String, Value> = HashMap::new();
        let mut all_passed = true;
        let mut has_awaiting_reply = false;
        let mut step_results: Vec<Value> = Vec::new();
        let mut blockers: Vec<String> = Vec::new();

        for (i, (_child_uid, agent_slug, task_desc)) in preview_children.iter().enumerate() {
            let upstream_summary = if child_outputs.is_empty() {
                "No upstream results yet.".to_string()
            } else {
                child_outputs.iter()
                    .map(|(k, v)| {
                        let json_str = serde_json::to_string(v).unwrap_or_default();
                        let preview = smart_truncate(&json_str, 4000);
                        format!("### {}\n{}", k, preview)
                    })
                    .collect::<Vec<_>>()
                    .join("\n\n")
            };

            let project_desc_for_enrichment = load_project_description(&self.db, plan_node.session_id).await;
            let project_section = if project_desc_for_enrichment.is_empty() {
                String::new()
            } else {
                format!("\n## Project Architecture\n{}\n", project_desc_for_enrichment)
            };

            let enrichment_prompt = format!(
                r#"Prepare execution context for step {step} of {total}.

## Step
**Agent**: {agent_slug}
**Task**: {task_desc}

## Original User Request
{request}

## Plan
{plan}
{project_arch}
## Results from Prior Steps
{upstream}

Provide a JSON object with:
- `context`: Rich context for this agent — include all relevant details, system identifiers (database IDs, page IDs, workspace URLs), API notes, data schemas, and relevant outputs from prior steps. Be thorough — the agent only knows what you tell it.
- `acceptance_criteria`: Array of specific, verifiable conditions the output must meet.
- `examples`: Optional reference material or examples (empty string if none).

Respond with ONLY the JSON object:
{{"context": "...", "acceptance_criteria": ["...", "..."], "examples": "..."}}"#,
                step = i + 1,
                total = preview_children.len(),
                agent_slug = agent_slug,
                task_desc = task_desc,
                request = plan_node.task_description,
                plan = plan_summary,
                project_arch = project_section,
                upstream = upstream_summary,
            );

            messages.push(user_message(enrichment_prompt.clone()));

            emit_event(&self.db, &self.event_bus, &sid, &nid, "plan_step_enriching", &json!({
                "step": i + 1,
                "agent_slug": agent_slug,
                "task_description": task_desc,
            })).await;

            persist_message(&self.db, &self.event_bus, &sid, &nid, "user", &enrichment_prompt, &json!({
                "step": i + 1,
                "phase": "enrichment_request",
                "hidden": true,
            })).await;

            // LLM enrichment call — no tools, just context preparation
            let enrichment_response = if let Some(budget) = thinking_budget {
                client
                    .messages_with_thinking(system_prompt, &messages, &[], 4096, Some(model), budget)
                    .await
            } else {
                client
                    .messages(system_prompt, &messages, &[], 4096, Some(model))
                    .await
            };

            let enrichment_text = match enrichment_response {
                Ok(ref r) => {
                    messages.push(assistant_message_from_response(&r.content));
                    r.text()
                }
                Err(e) => {
                    warn!(error = %e, step = i + 1, "enrichment LLM call failed, using basic task description as context");
                    let fallback = json!({"context": task_desc, "acceptance_criteria": [], "examples": ""}).to_string();
                    messages.push(json!({"role": "assistant", "content": fallback.clone()}));
                    fallback
                }
            };

            persist_message(&self.db, &self.event_bus, &sid, &nid, "assistant", &enrichment_text, &json!({
                "step": i + 1,
                "phase": "enrichment_response",
                "hidden": true,
            })).await;

            let (context, criteria, examples) = parse_enrichment_json(&enrichment_text);
            let effective_context = if context.is_empty() { None } else { Some(context.as_str()) };
            let effective_examples = if examples.is_empty() { None } else { Some(examples.as_str()) };

            // Execute the planned child agent
            emit_event(&self.db, &self.event_bus, &sid, &nid, "plan_step_executing", &json!({
                "step": i + 1,
                "agent_slug": agent_slug,
            })).await;

            let criteria_for_retry = criteria.clone();
            let mut result = self.run_child(
                plan_node,
                agent_slug,
                task_desc,
                effective_context,
                criteria,
                effective_examples,
            ).await;

            let mut status = result.get("status").and_then(Value::as_str).unwrap_or("unknown").to_string();

            // If passed, verify artifact URLs actually exist
            if status == "passed" {
                let artifacts_to_check = result.get("output")
                    .and_then(|o| o.get("artifacts").or_else(|| o.get("result").and_then(|r| r.get("artifacts"))))
                    .cloned()
                    .unwrap_or(json!([]));

                let verification_failures = verify_artifact_urls(&artifacts_to_check).await;
                if !verification_failures.is_empty() {
                    let failed_urls: Vec<String> = verification_failures.iter()
                        .map(|(url, reason)| format!("{} ({})", url, reason))
                        .collect();
                    let error_msg = format!("Artifact verification failed: {}", failed_urls.join(", "));

                    warn!(step = i + 1, agent = %agent_slug, error = %error_msg, "artifact URLs unreachable");

                    emit_event(&self.db, &self.event_bus, &sid, &nid, "verification_failed", &json!({
                        "step": i + 1,
                        "agent_slug": agent_slug,
                        "failed_urls": verification_failures.iter().map(|(u, r)| json!({"url": u, "reason": r})).collect::<Vec<_>>(),
                    })).await;

                    result.as_object_mut().map(|obj| {
                        obj.insert("error".to_string(), json!(error_msg));
                    });
                    status = "failed".to_string();
                }
            }

            // If the child failed (or artifact verification failed), retry once
            let result = if status == "failed" || status == "error" {
                let error_info = result.get("error")
                    .or_else(|| result.get("judge_feedback"))
                    .and_then(Value::as_str)
                    .unwrap_or("Unknown error");

                warn!(step = i + 1, agent = %agent_slug, error = %error_info, "plan step failed, retrying once");

                emit_event(&self.db, &self.event_bus, &sid, &nid, "plan_step_retry", &json!({
                    "step": i + 1,
                    "agent_slug": agent_slug,
                    "error": error_info,
                })).await;

                // Reset the failed child node back to 'preview' so run_child reclaims
                // the same DB row instead of inserting a duplicate.
                if let Some(failed_uid) = result.get("node_id")
                    .and_then(Value::as_str)
                    .and_then(|s| s.parse::<uuid::Uuid>().ok())
                {
                    let _ = self.db.execute_with(
                        "UPDATE execution_nodes SET status = 'preview', output = NULL, judge_score = NULL, judge_feedback = NULL, started_at = NULL, completed_at = NULL WHERE id = $1 AND session_id = $2",
                        pg_args!(failed_uid, plan_node.session_id),
                    ).await;
                }

                let retry_context = format!(
                    "{}\n\n## Previous Attempt Failed\n{}\nPlease address this issue in your retry.",
                    context, error_info
                );

                self.run_child(
                    plan_node,
                    agent_slug,
                    task_desc,
                    Some(&retry_context),
                    criteria_for_retry,
                    effective_examples,
                ).await
            } else {
                result
            };

            let final_status = result.get("status").and_then(Value::as_str).unwrap_or("unknown").to_string();
            if final_status == "awaiting_reply" {
                has_awaiting_reply = true;
            } else if final_status != "passed" {
                all_passed = false;
                blockers.push(format!("Step {} ({}) ended with status: {}", i + 1, agent_slug, final_status));
            }

            // Extract and persist artifacts + step_index on the child node
            let child_node_uid = result.get("node_id")
                .and_then(Value::as_str)
                .and_then(|s| s.parse::<uuid::Uuid>().ok())
                .unwrap_or(*_child_uid);
            let artifacts = result.get("output")
                .and_then(|o| o.get("artifacts").or_else(|| o.get("result").and_then(|r| r.get("artifacts"))))
                .cloned()
                .unwrap_or(json!([]));
            let _ = self.db.execute_with(
                "UPDATE execution_nodes SET artifacts = $1, step_index = $2 WHERE id = $3",
                pg_args!(artifacts, (i + 1) as i32, child_node_uid),
            ).await;

            child_outputs.insert(agent_slug.clone(), result.clone());
            step_results.push(result.clone());

            // Feed result back to the conversation for subsequent enrichment calls
            let result_preview = smart_truncate(
                &serde_json::to_string_pretty(&result).unwrap_or_default(),
                4000,
            );
            let result_msg = format!(
                "Step {} ({}) completed with status: {}.\n\nResult:\n{}",
                i + 1, agent_slug, final_status, result_preview
            );
            messages.push(user_message(result_msg.clone()));

            let child_summary = result.get("summary")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let human_readable = format!(
                "Step {} ({}) completed with status: {}.{}",
                i + 1,
                agent_slug,
                final_status,
                if child_summary.is_empty() { String::new() } else { format!(" {}", child_summary) }
            );

            persist_message(&self.db, &self.event_bus, &sid, &nid, "user", &human_readable, &json!({
                "step": i + 1,
                "phase": "step_result",
                "status": &final_status,
                "agent_slug": agent_slug,
                "raw_output": result,
            })).await;

            emit_event(&self.db, &self.event_bus, &sid, &nid, "plan_step_completed", &json!({
                "step": i + 1,
                "agent_slug": agent_slug,
                "status": &final_status,
            })).await;
        }

        // Final synthesis — ask orchestrator to summarize all results
        let synthesis_prompt = format!(
            "All {} steps of the plan are complete. Synthesize the final combined deliverable.\n\n\
             Provide a JSON response:\n\
             {{\"result\": {{...combined outputs organized by deliverable...}}, \
             \"summary\": \"human-readable summary of everything produced\", \
             \"blockers\": [\"any items that could not be completed\"]}}",
            preview_children.len()
        );
        messages.push(user_message(synthesis_prompt));

        emit_event(&self.db, &self.event_bus, &sid, &nid, "plan_synthesis_start", &json!({
            "total_steps": preview_children.len(),
            "all_passed": all_passed,
        })).await;

        let synthesis_response = if let Some(budget) = thinking_budget {
            client
                .messages_with_thinking(system_prompt, &messages, &[], 8192, Some(model), budget)
                .await
        } else {
            client
                .messages(system_prompt, &messages, &[], 8192, Some(model))
                .await
        };

        let (final_output, final_summary) = match synthesis_response {
            Ok(r) => {
                let text = r.text();
                let (parsed_output, parsed_summary) = parse_synthesis_json(&text, &step_results);
                persist_message(&self.db, &self.event_bus, &sid, &nid, "assistant", &parsed_summary, &json!({
                    "phase": "synthesis",
                    "summary": &parsed_summary,
                    "raw_output": &parsed_output,
                })).await;
                (parsed_output, parsed_summary)
            }
            Err(e) => {
                warn!(error = %e, "synthesis LLM call failed, building output from step results");
                let summary = format!(
                    "Plan completed with {} steps. {}.",
                    preview_children.len(),
                    if all_passed { "All passed" } else { "Some steps failed" }
                );
                (json!({"steps": step_results}), summary)
            }
        };

        // Persist conversation state for potential resume
        if let (Ok(sid_uuid), Ok(nid_uuid)) = (
            sid.parse::<uuid::Uuid>(),
            nid.parse::<uuid::Uuid>(),
        ) {
            let conv_state = json!({
                "messages": messages,
                "system_prompt": system_prompt,
                "model": model,
            });
            let _ = self.db.execute_with(
                "UPDATE execution_nodes SET conversation_state = $1 WHERE id = $2 AND session_id = $3",
                pg_args!(conv_state, nid_uuid, sid_uuid),
            ).await;
        }

        emit_event(&self.db, &self.event_bus, &sid, &nid, "plan_execution_complete", &json!({
            "all_passed": all_passed,
            "total_steps": preview_children.len(),
            "blockers": &blockers,
        })).await;

        let final_status = if !all_passed {
            NodeStatus::Failed
        } else if has_awaiting_reply {
            NodeStatus::AwaitingReply
        } else {
            NodeStatus::Passed
        };

        AgentResult {
            node_uid: nid,
            status: final_status,
            judge_score: None,
            judge_feedback: None,
            final_summary: Some(final_summary),
            output: Some(final_output),
            error: if all_passed { None } else { Some(blockers.join("; ")) },
            duration_ms: started_at.elapsed().as_millis() as u64,
        }
    }

    /// Execute a search_knowledge tool call with hybrid search (vector + BM25),
    /// neighbor chunk expansion, and Claude reranking.
    async fn execute_search_knowledge(
        &self,
        query: &str,
        limit: u64,
        client_id: Option<uuid::Uuid>,
        project_id: Option<uuid::Uuid>,
    ) -> String {
        if query.is_empty() {
            return json!({"error": "query parameter is required"}).to_string();
        }
        let api_key = match &self.settings.openai_api_key {
            Some(k) => k.clone(),
            None => return json!({"error": "No OPENAI_API_KEY configured for knowledge search"}).to_string(),
        };
        let tenant_id = match client_id {
            Some(id) => id,
            None => return json!({"error": "No client_id on this execution node — cannot scope knowledge search"}).to_string(),
        };

        // Step 1: Embed the query
        let embedding = match crate::embeddings::embed_text(&api_key, query).await {
            Ok(e) => e,
            Err(e) => return json!({"error": format!("Embedding failed: {e}")}).to_string(),
        };

        let embedding_str = format!(
            "[{}]",
            embedding.iter().map(|f| f.to_string()).collect::<Vec<_>>().join(",")
        );

        // project_clause uses a parameter ($3) when project_id is present
        let project_clause = if project_id.is_some() {
            "AND (c.project_id IS NULL OR c.project_id = $3)"
        } else {
            ""
        };

        // Step 2: Hybrid search — vector + BM25 merged via Reciprocal Rank Fusion
        // Note: embedding_str is generated from API float values, not user input,
        // and pgvector literals can't be parameterized easily, so they stay as format.
        let sql = format!(
            "WITH vector_results AS ( \
                SELECT c.id, c.content, c.context_prefix, c.section_title, \
                       c.chunk_index, c.document_id, c.metadata, \
                       d.source_path, d.source_filename, \
                       1 - (c.embedding <=> '{embedding_str}'::vector) AS similarity, \
                       ROW_NUMBER() OVER (ORDER BY c.embedding <=> '{embedding_str}'::vector) AS rank_v \
                FROM knowledge_chunks c \
                JOIN knowledge_documents d ON c.document_id = d.id \
                WHERE c.tenant_id = $1 \
                  AND d.status = 'ready' \
                  {project_clause} \
                  AND 1 - (c.embedding <=> '{embedding_str}'::vector) > 0.25 \
                ORDER BY c.embedding <=> '{embedding_str}'::vector \
                LIMIT 20 \
            ), \
            bm25_results AS ( \
                SELECT c.id, c.content, c.context_prefix, c.section_title, \
                       c.chunk_index, c.document_id, c.metadata, \
                       d.source_path, d.source_filename, \
                       ts_rank_cd(c.search_vector, websearch_to_tsquery('english', $2)) AS bm25_score, \
                       ROW_NUMBER() OVER (ORDER BY ts_rank_cd(c.search_vector, websearch_to_tsquery('english', $2)) DESC) AS rank_b \
                FROM knowledge_chunks c \
                JOIN knowledge_documents d ON c.document_id = d.id \
                WHERE c.tenant_id = $1 \
                  AND d.status = 'ready' \
                  {project_clause} \
                  AND c.search_vector @@ websearch_to_tsquery('english', $2) \
                ORDER BY bm25_score DESC \
                LIMIT 20 \
            ) \
            SELECT COALESCE(v.id, b.id) AS id, \
                   COALESCE(v.content, b.content) AS content, \
                   COALESCE(v.context_prefix, b.context_prefix) AS context_prefix, \
                   COALESCE(v.section_title, b.section_title) AS section_title, \
                   COALESCE(v.chunk_index, b.chunk_index) AS chunk_index, \
                   COALESCE(v.document_id, b.document_id) AS document_id, \
                   COALESCE(v.source_path, b.source_path) AS source_path, \
                   COALESCE(v.source_filename, b.source_filename) AS source_filename, \
                   COALESCE(v.similarity, 0) AS similarity, \
                   (1.0 / (60 + COALESCE(v.rank_v, 1000)) + 1.0 / (60 + COALESCE(b.rank_b, 1000))) AS rrf_score \
            FROM vector_results v \
            FULL OUTER JOIN bm25_results b ON v.id = b.id \
            ORDER BY rrf_score DESC \
            LIMIT 20",
        );

        let args = if let Some(pid) = project_id {
            crate::pg_args!(tenant_id, query.to_string(), pid)
        } else {
            crate::pg_args!(tenant_id, query.to_string())
        };

        let candidates = match self.db.execute_with(&sql, args).await {
            Ok(rows) => rows,
            Err(e) => {
                warn!(error = %e, "search_knowledge hybrid query failed");
                return json!({"error": format!("Knowledge search failed: {e}")}).to_string();
            }
        };

        if candidates.is_empty() {
            return json!({"results": [], "query": query, "note": "No relevant results found in the knowledge corpus."}).to_string();
        }

        // Step 3: Neighbor chunk expansion — fetch chunk_index +/- 1 for each match
        // Build parameterized conditions for neighbor lookup
        let mut neighbor_doc_ids: Vec<uuid::Uuid> = Vec::new();
        let mut neighbor_chunk_indices: Vec<i64> = Vec::new();
        let mut neighbor_exclude_ids: Vec<uuid::Uuid> = Vec::new();

        for row in &candidates {
            if let (Some(doc_id), Some(idx), Some(id)) = (
                row.get("document_id").and_then(Value::as_str).and_then(|s| s.parse::<uuid::Uuid>().ok()),
                row.get("chunk_index").and_then(Value::as_i64),
                row.get("id").and_then(Value::as_str).and_then(|s| s.parse::<uuid::Uuid>().ok()),
            ) {
                neighbor_doc_ids.push(doc_id);
                neighbor_chunk_indices.push(idx - 1);
                neighbor_doc_ids.push(doc_id);
                neighbor_chunk_indices.push(idx + 1);
                neighbor_exclude_ids.push(id);
            }
        }

        let mut neighbor_map: HashMap<String, Vec<Value>> = HashMap::new();
        if !neighbor_doc_ids.is_empty() {
            // Build parameterized OR conditions
            let mut conditions = Vec::new();
            let mut args = sqlx::postgres::PgArguments::default();
            use sqlx::Arguments as _;
            let mut pi = 1u32;
            for row in &candidates {
                if let (Some(doc_id), Some(idx), Some(id)) = (
                    row.get("document_id").and_then(Value::as_str).and_then(|s| s.parse::<uuid::Uuid>().ok()),
                    row.get("chunk_index").and_then(Value::as_i64),
                    row.get("id").and_then(Value::as_str).and_then(|s| s.parse::<uuid::Uuid>().ok()),
                ) {
                    conditions.push(format!(
                        "(c.document_id = ${} AND c.chunk_index IN (${}, ${}) AND c.id != ${})",
                        pi, pi + 1, pi + 2, pi + 3
                    ));
                    args.add(doc_id).expect("encode");
                    args.add((idx - 1) as i32).expect("encode");
                    args.add((idx + 1) as i32).expect("encode");
                    args.add(id).expect("encode");
                    pi += 4;
                }
            }
            let neighbor_sql = format!(
                "SELECT c.id, c.content, c.context_prefix, c.section_title, \
                        c.chunk_index, c.document_id::text \
                 FROM knowledge_chunks c \
                 WHERE ({})",
                conditions.join(" OR ")
            );
            if let Ok(neighbor_rows) = self.db.execute_with(&neighbor_sql, args).await {
                for nr in &neighbor_rows {
                    let doc_id = nr.get("document_id").and_then(Value::as_str).unwrap_or("");
                    neighbor_map.entry(doc_id.to_string()).or_default().push(nr.clone());
                }
            }
        }

        // Step 4: Claude reranking — send top candidates to Claude for relevance scoring
        let final_results = self.rerank_with_claude(query, &candidates, limit).await;

        // Step 5: Build compact results with location pointers (not full text).
        // Agents use read_knowledge(document_id, chunk_index) for full context.
        let compact: Vec<Value> = final_results.iter().map(|row| {
            let content = row.get("content").and_then(Value::as_str).unwrap_or("");
            let snippet: String = content.chars().take(200).collect();
            let snippet = if content.len() > 200 {
                format!("{snippet}...")
            } else {
                snippet
            };

            let doc_id = row.get("document_id").and_then(Value::as_str).unwrap_or("");
            let chunk_idx = row.get("chunk_index").and_then(Value::as_i64).unwrap_or(0);

            // Include neighbor context_before/after as brief previews
            let neighbors = neighbor_map.get(doc_id).cloned().unwrap_or_default();
            let has_before = neighbors.iter()
                .any(|n| n.get("chunk_index").and_then(Value::as_i64) == Some(chunk_idx - 1));
            let has_after = neighbors.iter()
                .any(|n| n.get("chunk_index").and_then(Value::as_i64) == Some(chunk_idx + 1));

            json!({
                "document_id": doc_id,
                "source_filename": row.get("source_filename").and_then(Value::as_str).unwrap_or(""),
                "source_path": row.get("source_path").and_then(Value::as_str).unwrap_or(""),
                "section_title": row.get("section_title").and_then(Value::as_str).unwrap_or(""),
                "chunk_index": chunk_idx,
                "context_prefix": row.get("context_prefix").and_then(Value::as_str).unwrap_or(""),
                "snippet": snippet,
                "similarity": row.get("similarity"),
                "rrf_score": row.get("rrf_score"),
                "has_surrounding_chunks": has_before || has_after,
            })
        }).collect();

        // Fire-and-forget: log chunk retrievals for observatory analytics
        {
            let db = self.db.clone();
            let chunk_ids: Vec<(String, f64)> = final_results.iter().filter_map(|row| {
                let id = row.get("id").and_then(Value::as_str)?.to_string();
                let sim = row.get("similarity").and_then(Value::as_f64).unwrap_or(0.0);
                Some((id, sim))
            }).collect();
            let query_text = query.to_string();
            tokio::spawn(async move {
                for (chunk_id, sim) in chunk_ids {
                    if let Ok(rid) = chunk_id.parse::<uuid::Uuid>() {
                        let _ = db.execute_with(
                            "INSERT INTO knowledge_access_log (access_type, resource_id, query_text, similarity_score) \
                             VALUES ('chunk_retrieval', $1, $2, $3)",
                            crate::pg_args!(rid, query_text.clone(), sim as f32),
                        ).await;
                    }
                }
            });
        }

        json!({
            "results": compact,
            "query": query,
            "hint": "Use read_knowledge(document_id, chunk_index) to fetch full text around any result."
        }).to_string()
    }

    /// Rerank search candidates using Claude for relevance scoring.
    /// Returns the top `limit` results ordered by relevance.
    async fn rerank_with_claude(
        &self,
        query: &str,
        candidates: &[Value],
        limit: u64,
    ) -> Vec<Value> {
        if candidates.len() <= limit as usize {
            return candidates.to_vec();
        }

        let mut candidate_text = String::new();
        for (i, row) in candidates.iter().enumerate() {
            let prefix = row.get("context_prefix").and_then(Value::as_str).unwrap_or("");
            let content = row.get("content").and_then(Value::as_str).unwrap_or("");
            let source = row.get("source_path").and_then(Value::as_str).unwrap_or("");
            let preview: String = content.chars().take(400).collect();
            candidate_text.push_str(&format!(
                "[{i}] {prefix} {preview} (source: {source})\n\n"
            ));
        }

        let rerank_prompt = format!(
            "Query: \"{query}\"\n\n\
             Candidates:\n{candidate_text}\n\
             Return the IDs of the {limit} most relevant candidates as a JSON array of integers, \
             most relevant first. Example: [3, 0, 7, 1, 5]\n\n\
             Output ONLY the JSON array, nothing else."
        );

        let rerank_client = AnthropicClient::new(
            self.settings.anthropic_api_key.clone(),
            self.settings.anthropic_model.clone(),
        );

        match rerank_client
            .messages(
                "You rank search results by relevance. Output only a JSON array of candidate IDs.",
                &[crate::anthropic::user_message(rerank_prompt)],
                &[],
                256,
                None,
            )
            .await
        {
            Ok(response) => {
                let text = response.text();
                let cleaned = text.trim()
                    .trim_start_matches("```json")
                    .trim_start_matches("```")
                    .trim_end_matches("```")
                    .trim();

                if let Ok(indices) = serde_json::from_str::<Vec<usize>>(cleaned) {
                    return indices.iter()
                        .filter(|&&i| i < candidates.len())
                        .take(limit as usize)
                        .map(|&i| candidates[i].clone())
                        .collect();
                }
                warn!("Claude reranking returned unparseable response: {cleaned}");
                candidates.iter().take(limit as usize).cloned().collect()
            }
            Err(e) => {
                warn!(error = %e, "Claude reranking failed — falling back to RRF ordering");
                candidates.iter().take(limit as usize).cloned().collect()
            }
        }
    }

    /// Read a section of a knowledge document by chunk range.
    /// Returns concatenated chunk content centered on the requested chunk_index.
    async fn execute_read_knowledge(
        &self,
        document_id: &str,
        chunk_index: i64,
        range: i64,
        client_id: Option<uuid::Uuid>,
    ) -> String {
        let tenant_id = match client_id {
            Some(id) => id,
            None => return json!({"error": "No client_id — cannot scope knowledge read"}).to_string(),
        };

        let doc_uuid = match uuid::Uuid::parse_str(document_id) {
            Ok(u) => u,
            Err(_) => return json!({"error": "Invalid document_id format"}).to_string(),
        };

        let half = range / 2;
        let start = (chunk_index - half).max(0);
        let end_idx = chunk_index + half;

        match self.db.execute_with(
            "SELECT c.content, c.section_title, c.chunk_index, c.context_prefix, \
                    d.source_filename, d.source_path \
             FROM knowledge_chunks c \
             JOIN knowledge_documents d ON c.document_id = d.id \
             WHERE c.document_id = $1 \
               AND c.tenant_id = $2 \
               AND c.chunk_index >= $3 \
               AND c.chunk_index <= $4 \
             ORDER BY c.chunk_index",
            crate::pg_args!(doc_uuid, tenant_id, start as i32, end_idx as i32),
        ).await {
            Ok(rows) if rows.is_empty() => {
                json!({
                    "error": "No chunks found for the given document_id and chunk range",
                    "document_id": document_id,
                    "chunk_index": chunk_index,
                    "range": range,
                }).to_string()
            }
            Ok(rows) => {
                let source_filename = rows[0].get("source_filename")
                    .and_then(Value::as_str).unwrap_or("");
                let source_path = rows[0].get("source_path")
                    .and_then(Value::as_str).unwrap_or("");

                let mut full_text = String::new();
                let mut first_chunk = i64::MAX;
                let mut last_chunk: i64 = 0;

                for row in &rows {
                    let idx = row.get("chunk_index").and_then(Value::as_i64).unwrap_or(0);
                    let content = row.get("content").and_then(Value::as_str).unwrap_or("");
                    let section = row.get("section_title").and_then(Value::as_str).unwrap_or("");

                    if idx < first_chunk { first_chunk = idx; }
                    if idx > last_chunk { last_chunk = idx; }

                    if !section.is_empty() && !full_text.contains(&format!("## {section}")) {
                        full_text.push_str(&format!("\n## {section}\n\n"));
                    }
                    full_text.push_str(content);
                    full_text.push_str("\n\n");
                }

                // Check if there are more chunks available in this document
                let max_chunk = self.db.execute_with(
                    "SELECT MAX(chunk_index) as max_idx FROM knowledge_chunks WHERE document_id = $1",
                    crate::pg_args!(doc_uuid),
                ).await.ok()
                    .and_then(|r| r.first().cloned())
                    .and_then(|r| r.get("max_idx").and_then(Value::as_i64))
                    .unwrap_or(last_chunk);

                json!({
                    "document_id": document_id,
                    "source_filename": source_filename,
                    "source_path": source_path,
                    "chunk_range": format!("{first_chunk}-{last_chunk}"),
                    "total_chunks_in_document": max_chunk + 1,
                    "content": full_text.trim(),
                    "hint": if last_chunk < max_chunk {
                        format!("More content available. Use read_knowledge with chunk_index={} to continue reading.", last_chunk + 1)
                    } else {
                        "End of document reached.".to_string()
                    }
                }).to_string()
            }
            Err(e) => {
                warn!(error = %e, "read_knowledge query failed");
                json!({"error": format!("Knowledge read failed: {e}")}).to_string()
            }
        }
    }

    /// Public wrappers for knowledge tools — used by session chat route.
    pub async fn execute_search_knowledge_pub(
        &self, query: &str, limit: u64, client_id: Option<uuid::Uuid>, project_id: Option<uuid::Uuid>,
    ) -> String {
        self.execute_search_knowledge(query, limit, client_id, project_id).await
    }

    pub async fn execute_read_knowledge_pub(
        &self, document_id: &str, chunk_index: i64, range: i64, client_id: Option<uuid::Uuid>,
    ) -> String {
        self.execute_read_knowledge(document_id, chunk_index, range, client_id).await
    }

    /// Public tool executor for post-execution chat — loads credentials and runs any tool.
    pub async fn execute_tool_pub(
        &self,
        session_id: &str,
        node_id: &str,
        tool_name: &str,
        tool_input: &Value,
        client_id: Option<uuid::Uuid>,
        project_id: Option<uuid::Uuid>,
    ) -> String {
        if tool_name == "search_knowledge" {
            let query = tool_input.get("query").and_then(Value::as_str).unwrap_or("");
            let limit = tool_input.get("limit").and_then(Value::as_u64).unwrap_or(5).min(10);
            return self.execute_search_knowledge(query, limit, client_id, project_id).await;
        }
        if tool_name == "read_knowledge" {
            let doc_id = tool_input.get("document_id").and_then(Value::as_str).unwrap_or("");
            let chunk_idx = tool_input.get("chunk_index").and_then(Value::as_i64).unwrap_or(0);
            let range = tool_input.get("range").and_then(Value::as_i64).unwrap_or(5).min(20);
            return self.execute_read_knowledge(doc_id, chunk_idx, range, client_id).await;
        }

        let credentials = if let Some(cid) = client_id {
            if let Some(ref master_key) = self.settings.credential_master_key {
                if let Some(pid) = project_id {
                    crate::credentials::load_credentials_for_project(&self.db, master_key, pid, cid)
                        .await
                        .unwrap_or_default()
                } else {
                    crate::credentials::load_credentials_for_client(&self.db, master_key, cid)
                        .await
                        .unwrap_or_default()
                }
            } else {
                Default::default()
            }
        } else {
            Default::default()
        };

        let upstream_outputs: HashMap<String, Value> = HashMap::new();
        let result = actions::execute_action(
            tool_name, tool_input, session_id, &upstream_outputs, &credentials, &self.settings, &self.http_client,
        ).await;

        maybe_emit_early_artifact(&self.db, &self.event_bus, session_id, node_id, tool_name, &result).await;

        result
    }

    /// Run a child agent synchronously within the parent's executor loop.
    /// Creates a child ExecutionPlanNode, runs it, persists results, returns output.
    #[tracing::instrument(skip(self, parent_node, task_description, spawn_context, acceptance_criteria, spawn_examples), fields(parent_uid = %parent_node.uid, child_agent = %agent_slug))]
    pub async fn run_child(
        &self,
        parent_node: &ExecutionPlanNode,
        agent_slug: &str,
        task_description: &str,
        spawn_context: Option<&str>,
        acceptance_criteria: Option<Vec<String>>,
        spawn_examples: Option<&str>,
    ) -> Value {
        info!(parent_uid = %parent_node.uid, child_agent = %agent_slug, "spawning child agent");
        const MAX_DEPTH: i32 = 3;

        // Check depth from DB
        let parent_depth = match self.db.execute_with(
            "SELECT depth FROM execution_nodes WHERE id = $1",
            pg_args!(parent_node.uid),
        ).await {
            Ok(rows) => rows.first()
                .and_then(|r| r.get("depth").and_then(Value::as_i64))
                .unwrap_or(0) as i32,
            Err(_) => 0,
        };

        let child_depth = parent_depth + 1;
        if child_depth > MAX_DEPTH {
            return json!({
                "error": format!("Maximum spawn depth ({}) exceeded", MAX_DEPTH),
                "depth": child_depth,
            });
        }

        // Look up the agent definition
        let agent = match self.catalog.get(agent_slug) {
            Some(a) => a,
            None => {
                return json!({
                    "error": format!("Agent/skill not found: {}", agent_slug),
                });
            }
        };

        let sid = parent_node.session_id;

        let model = agent.model.as_deref()
            .unwrap_or(&parent_node.model);
        let judge_config_val = serde_json::to_value(&agent.judge_config)
            .unwrap_or_else(|_| json!({"threshold":7.0,"rubric":[],"need_to_know":[]}));
        let criteria_val: Value = acceptance_criteria
            .as_ref()
            .map(|c| serde_json::to_value(c).unwrap_or(Value::Null))
            .unwrap_or(Value::Null);
        let empty_uuids: Vec<uuid::Uuid> = vec![];

        // Try to claim an existing preview node for this agent_slug under this parent.
        // Preview nodes are created during the planning phase so the UI can show the
        // intended structure. At runtime we reuse them instead of creating duplicates.
        let claimed_preview_uid = match self.db.execute_with(
            r#"UPDATE execution_nodes
               SET status = 'running',
                   task_description = $1,
                   agent_git_sha = 'spawned',
                   judge_config = $2,
                   max_iterations = $3,
                   model = $4,
                   skip_judge = $12,
                   depth = $5,
                   spawn_context = $6,
                   acceptance_criteria = $7,
                   spawn_examples = $8,
                   started_at = NOW()
               WHERE id = (
                   SELECT id FROM execution_nodes
                   WHERE parent_uid = $9
                     AND agent_slug = $10
                     AND session_id = $11
                     AND status = 'preview'
                   ORDER BY created_at
                   LIMIT 1
                   FOR UPDATE SKIP LOCKED
               )
               RETURNING id"#,
            pg_args!(
                task_description.to_string(),
                judge_config_val.clone(),
                agent.max_iterations as i32,
                model.to_string(),
                child_depth,
                spawn_context.unwrap_or("").to_string(),
                criteria_val.clone(),
                spawn_examples.unwrap_or("").to_string(),
                parent_node.uid,
                agent_slug.to_string(),
                sid,
                agent.skip_judge
            ),
        ).await {
            Ok(rows) => rows.first()
                .and_then(|r| r.get("id").and_then(Value::as_str))
                .and_then(|s| s.parse::<uuid::Uuid>().ok()),
            Err(e) => {
                warn!(error = %e, "failed to claim preview node, will create new one");
                None
            }
        };

        let child_uid = if let Some(uid) = claimed_preview_uid {
            info!(uid = %uid, agent = %agent_slug, "claimed existing preview node");
            uid
        } else {
            let uid = uuid::Uuid::new_v4();
            // No preview node found — insert a new child node
            if let Err(e) = self.db.execute_with(
                r#"INSERT INTO execution_nodes
                    (id, session_id, agent_slug, agent_git_sha, task_description, status,
                     requires, attempt_count, parent_uid, judge_config, max_iterations,
                     model, skip_judge, client_id, depth, spawn_context, acceptance_criteria,
                     spawn_examples)
                   VALUES
                    ($1, $2, $3, $4, $5, 'running',
                     $6, 0, $7, $8, $9,
                     $10, $11, $12, $13, $14,
                     $15, $16)"#,
                pg_args!(
                    uid,
                    sid,
                    agent_slug.to_string(),
                    "spawned".to_string(),
                    task_description.to_string(),
                    &empty_uuids as &[uuid::Uuid],
                    parent_node.uid,
                    judge_config_val,
                    agent.max_iterations as i32,
                    model.to_string(),
                    agent.skip_judge,
                    parent_node.client_id,
                    child_depth,
                    spawn_context.unwrap_or("").to_string(),
                    criteria_val,
                    spawn_examples.unwrap_or("").to_string()
                ),
            ).await {
                warn!(error = %e, "failed to persist child node");
                return json!({"error": format!("Failed to create child node: {e}")});
            }
            uid
        };

        // Emit node_started event
        emit_event(
            &self.db, &self.event_bus, &sid.to_string(), &child_uid.to_string(),
            "node_started",
            &json!({"agent_slug": agent_slug, "parent_uid": parent_node.uid.to_string(), "depth": child_depth}),
        ).await;

        // Build child ExecutionPlanNode — use the agent's own judge settings so that
        // operator agents (n8n, notion, etc.) go through judge validation.
        let mut child_judge_config = agent.judge_config.clone();
        if let Some(criteria) = &acceptance_criteria {
            for c in criteria {
                child_judge_config.rubric.push(c.clone());
            }
        }
        let child_node = ExecutionPlanNode {
            uid: child_uid,
            session_id: sid,
            agent_slug: agent_slug.to_string(),
            agent_git_sha: "spawned".to_string(),
            task_description: task_description.to_string(),
            status: NodeStatus::Running,
            requires: vec![],
            attempt_count: 0,
            parent_uid: Some(parent_node.uid),
            input: None,
            output: None,
            judge_score: None,
            judge_feedback: None,
            judge_config: child_judge_config,
            max_iterations: agent.max_iterations,
            model: model.to_string(),
            skip_judge: agent.skip_judge,
            variant_group: None,
            variant_label: None,
            variant_selected: None,
            client_id: parent_node.client_id,
            tool_id: None,
            execution_mode: "agent".to_string(),
            integration_overrides: serde_json::json!({}),
        };

        // Pass the orchestrator's context as upstream output so child can reference it
        let mut upstream = std::collections::HashMap::new();
        if let Some(ctx) = spawn_context {
            upstream.insert("orchestrator_context".to_string(), json!(ctx));
        }

        // Run child agent synchronously
        let result = Box::pin(self.run(&child_node, &upstream)).await;

        // Persist child result
        let status = result.status.as_str().to_string();
        let _ = self.db.execute_with(
            r#"UPDATE execution_nodes
               SET status = $1, output = $2, judge_score = $3, judge_feedback = $4, completed_at = NOW()
               WHERE id = $5"#,
            pg_args!(status.clone(), result.output.clone(), result.judge_score, result.judge_feedback.clone(), child_uid),
        ).await;

        // Emit node_completed event
        emit_event(
            &self.db, &self.event_bus, &sid.to_string(), &child_uid.to_string(),
            "node_completed",
            &json!({
                "status": status,
                "duration_ms": result.duration_ms,
                "score": result.judge_score,
            }),
        ).await;

        // Return the full output to the parent, including error/feedback details
        // so the orchestrator can diagnose failures and retry intelligently.
        let child_output = result.output.unwrap_or_else(|| {
            json!({
                "summary": result.final_summary.clone().unwrap_or_default(),
                "status": &status,
            })
        });

        let mut response = json!({
            "status": status,
            "agent_slug": agent_slug,
            "node_id": child_uid.to_string(),
            "output": child_output,
            "duration_ms": result.duration_ms,
        });

        // Surface error and judge feedback so orchestrator can diagnose failures
        if let Some(ref err) = result.error {
            response["error"] = json!(err);
        }
        if let Some(ref feedback) = result.judge_feedback {
            response["judge_feedback"] = json!(feedback);
        }
        if let Some(ref summary) = result.final_summary {
            response["summary"] = json!(summary);
        }
        if let Some(score) = result.judge_score {
            response["judge_score"] = json!(score);
        }

        // Truncate the output field if it's very large to prevent parent context pollution.
        // Keep status, summary, score, error, and judge_feedback in full — only compress the output payload.
        if let Some(output) = response.get("output") {
            let output_str = output.to_string();
            if output_str.len() > 6000 {
                response["output"] = json!(smart_truncate(&output_str, 5000));
                response["output_truncated"] = json!(true);
            }
        }

        response
    }

    /// Resume a node's conversation with a user reply.
    /// Loads the saved conversation_state, appends the user message,
    /// and continues the executor loop.
    #[tracing::instrument(skip(self, user_reply), fields(session_id = %session_id, node_id = %node_id))]
    pub async fn resume_with_reply(
        &self,
        session_id: &str,
        node_id: &str,
        user_reply: &str,
    ) -> AgentResult {
        info!(session_id = %session_id, node_id = %node_id, "resuming node with user reply");
        let nid = node_id.parse::<uuid::Uuid>().unwrap_or_default();
        let sid = session_id.parse::<uuid::Uuid>().unwrap_or_default();

        // Load conversation state from DB
        let rows = self.db.execute_with(
            "SELECT conversation_state, agent_slug, model, max_iterations, task_description FROM execution_nodes WHERE id = $1 AND session_id = $2",
            pg_args!(nid, sid),
        ).await.unwrap_or_default();

        let row = match rows.first() {
            Some(r) => r,
            None => return AgentResult {
                node_uid: node_id.to_string(),
                status: NodeStatus::Failed,
                judge_score: None,
                judge_feedback: None,
                final_summary: None,
                output: None,
                error: Some("Node not found".to_string()),
                duration_ms: 0,
            },
        };

        let conv_state = row.get("conversation_state").cloned().unwrap_or(json!(null));
        let agent_slug = row.get("agent_slug").and_then(Value::as_str).unwrap_or("");
        let model = row.get("model").and_then(Value::as_str).unwrap_or("claude-haiku-4-5-20251001");
        let max_iterations = row.get("max_iterations").and_then(Value::as_i64).unwrap_or(100) as usize;

        if conv_state.is_null() {
            return AgentResult {
                node_uid: node_id.to_string(),
                status: NodeStatus::Failed,
                judge_score: None,
                judge_feedback: None,
                final_summary: None,
                output: None,
                error: Some("No conversation state to resume".to_string()),
                duration_ms: 0,
            };
        }

        let mut messages: Vec<Value> = conv_state.get("messages")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let system_prompt = conv_state.get("system_prompt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        // Append user reply — sanitize message history first so we don't send
        // tool_use blocks without matching tool_results to the Anthropic API.
        if !prepare_resume_messages(&mut messages, user_reply) {
            messages.push(user_message(user_reply.to_string()));
        }
        persist_message(&self.db, &self.event_bus, session_id, node_id, "user", user_reply, &json!({"source": "human_reply"})).await;

        // Emit event
        emit_event(&self.db, &self.event_bus, session_id, node_id, "user_reply", &json!({
            "message": user_reply,
        })).await;

        // Load agent tools
        let agent = self.catalog.get(agent_slug);
        let tool_defs = if let Some(ref a) = agent {
            actions::actions_for_agent(&a.tools, false)
        } else {
            vec![]
        };

        // Load credentials (project-aware)
        let node_ctx_rows = self.db.execute_with(
            "SELECT n.client_id, n.session_id FROM execution_nodes n WHERE n.id = $1",
            pg_args!(nid),
        ).await.unwrap_or_default();
        let client_id = node_ctx_rows.first()
            .and_then(|r| r.get("client_id").and_then(Value::as_str))
            .and_then(|s| s.parse::<uuid::Uuid>().ok());
        let session_id_for_creds = node_ctx_rows.first()
            .and_then(|r| r.get("session_id").and_then(Value::as_str))
            .and_then(|s| s.parse::<uuid::Uuid>().ok());

        let credentials = if let Some(cid) = client_id {
            if let Some(ref master_key) = self.settings.credential_master_key {
                if let Some(sid) = session_id_for_creds {
                    if let Some(pid) = load_project_id(&self.db, sid).await {
                        crate::credentials::load_credentials_for_project(&self.db, master_key, pid, cid)
                            .await
                            .unwrap_or_default()
                    } else {
                        crate::credentials::load_credentials_for_client(&self.db, master_key, cid)
                            .await
                            .unwrap_or_default()
                    }
                } else {
                    crate::credentials::load_credentials_for_client(&self.db, master_key, cid)
                        .await
                        .unwrap_or_default()
                }
            } else {
                Default::default()
            }
        } else {
            Default::default()
        };

        // Load upstream outputs from the node's requires (so tools can reference them)
        let upstream_outputs = {
            let req_rows = self.db.execute_with(
                "SELECT requires FROM execution_nodes WHERE id = $1",
                pg_args!(nid),
            ).await.unwrap_or_default();
            let requires: Vec<uuid::Uuid> = req_rows.first()
                .and_then(|r| r.get("requires"))
                .and_then(Value::as_array)
                .map(|arr| arr.iter().filter_map(|v| v.as_str()?.parse().ok()).collect())
                .unwrap_or_default();
            if requires.is_empty() {
                std::collections::HashMap::new()
            } else {
                let ups_rows = self.db.execute_with(
                    "SELECT agent_slug, output FROM execution_nodes \
                     WHERE id = ANY($1) AND status = 'passed' AND output IS NOT NULL",
                    pg_args!(requires.clone()),
                ).await.unwrap_or_default();
                let mut map = std::collections::HashMap::new();
                for r in ups_rows {
                    if let (Some(slug), Some(output)) = (
                        r.get("agent_slug").and_then(Value::as_str),
                        r.get("output"),
                    ) {
                        map.insert(slug.to_string(), output.clone());
                    }
                }
                map
            }
        };

        let client = AnthropicClient::new(
            self.settings.anthropic_api_key.clone(),
            model.to_string(),
        );

        // Determine thinking budget using same logic as the executor
        let thinking_budget = if self.settings.thinking_budget_tokens > 0
            && (model.contains("sonnet") || model.contains("opus"))
            && !model.contains("haiku")
        {
            Some(self.settings.thinking_budget_tokens)
        } else {
            None
        };

        // Strip thinking blocks from saved messages when thinking is not enabled,
        // otherwise the Anthropic API rejects messages containing thinking content.
        if thinking_budget.is_none() {
            strip_thinking_blocks(&mut messages);
        }

        let started_at = Instant::now();
        let mut final_output: Option<Value> = None;
        let mut final_summary = String::new();
        let mut consecutive_no_tool_calls: usize = 0;
        let mut paused_for_user = false;
        const STALL_THRESHOLD: usize = 3;

        // Resume executor loop
        for iteration in 0..max_iterations {
            emit_event(&self.db, &self.event_bus, session_id, node_id, "executor_llm_send", &json!({
                "iteration": iteration + 1,
                "model": model,
                "resumed": true,
            })).await;

            // Stream from Anthropic API — deltas forwarded in real-time
            let (mut delta_rx, response_handle) = client.messages_stream(
                &system_prompt,
                &messages,
                &tool_defs,
                8192,
                Some(model),
                thinking_budget,
            );
            while let Some(event) = delta_rx.recv().await {
                forward_stream_delta(&self.event_bus, session_id, node_id, iteration + 1, &event).await;
            }
            let response = match response_handle.await {
                Ok(Ok(r)) => r,
                Ok(Err(e)) => {
                    warn!(error = %e, "resume LLM call failed");
                    break;
                }
                Err(e) => {
                    warn!(error = %e, "resume LLM task panicked");
                    break;
                }
            };

            let llm_text = response.text();
            let tool_call_names: Vec<String> = response
                .tool_uses()
                .iter()
                .map(|(_, name, _)| name.to_string())
                .collect();

            if tool_call_names.is_empty() {
                consecutive_no_tool_calls += 1;
                if consecutive_no_tool_calls >= STALL_THRESHOLD {
                    warn!(node_id = %node_id, iteration = iteration + 1, "resumed executor stalled — {STALL_THRESHOLD} consecutive iterations with no tool calls");
                    break;
                }
            } else {
                consecutive_no_tool_calls = 0;
            }

            emit_event(&self.db, &self.event_bus, session_id, node_id, "executor_llm_receive", &json!({
                "iteration": iteration + 1,
                "stop_reason": response.stop_reason.as_deref().unwrap_or("end_turn"),
                "llm_text": if llm_text.len() > 5000 { format!("{}...", &llm_text[..5000]) } else { llm_text.clone() },
                "tool_calls": tool_call_names,
                "resumed": true,
            })).await;

            messages.push(assistant_message_from_response(&response.content));

            if !llm_text.is_empty() {
                persist_message(&self.db, &self.event_bus, session_id, node_id, "assistant", &llm_text, &json!({
                    "iteration": iteration + 1,
                    "tool_calls": tool_call_names,
                })).await;
            }

            for (id, name, input) in response.tool_uses() {
                persist_message(&self.db, &self.event_bus, session_id, node_id, "tool_use", &name, &json!({
                    "tool_use_id": id,
                    "tool_name": name,
                    "tool_input": input,
                })).await;
            }

            if response.is_end_turn() {
                info!(node_id = %node_id, iterations = iteration + 1, "resume executor finished (end_turn)");
                final_summary = response.text();
                break;
            }

            if !response.is_tool_use() {
                info!(node_id = %node_id, iterations = iteration + 1, "resume executor finished (no tool use)");
                final_summary = response.text();
                break;
            }

            // Execute tool calls
            let tool_uses: Vec<(String, String, Value)> = response
                .tool_uses()
                .iter()
                .map(|(id, name, input)| (id.to_string(), name.to_string(), (*input).clone()))
                .collect();

            let mut tool_results: Vec<(String, String)> = Vec::new();

            for (tool_use_id, tool_name, tool_input) in &tool_uses {
                if tool_name == "write_output" {
                    final_output = tool_input.get("result").cloned();
                    final_summary = tool_input
                        .get("summary")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();

                    if let Some(artifacts) = tool_input.get("artifacts") {
                        let mut resolved = artifacts.clone();
                        if let Some(arr) = resolved.as_array_mut() {
                            for item in arr.iter_mut() {
                                if let Some(url) = item.get("url").and_then(Value::as_str) {
                                    if url.contains("/self") || url.contains("{node_id}") {
                                        let fixed = url.replace("/self", &format!("/{}", node_id))
                                            .replace("{node_id}", node_id);
                                        item.as_object_mut().map(|o| o.insert("url".to_string(), Value::String(fixed)));
                                    }
                                }
                            }
                        }
                        if let Some(ref mut output) = final_output {
                            if let Some(obj) = output.as_object_mut() {
                                obj.entry("artifacts").or_insert_with(|| resolved);
                            }
                        } else {
                            final_output = Some(json!({"artifacts": resolved}));
                        }
                    }

                    tool_results.push((tool_use_id.clone(), json!({"stored": true}).to_string()));
                    messages.push(tool_results_message(&tool_results));
                    break;
                }

                if tool_name == "request_user_action" {
                    let action_title = tool_input
                        .get("action_title")
                        .and_then(Value::as_str)
                        .unwrap_or("Manual action required")
                        .to_string();
                    tool_results.push((
                        tool_use_id.clone(),
                        json!({"status": "paused", "message": "Waiting for user to complete manual action"}).to_string(),
                    ));
                    final_output = Some(json!({
                        "action_title": action_title,
                        "paused_for_user_action": true,
                    }));
                    paused_for_user = true;
                    messages.push(tool_results_message(&tool_results));
                    break;
                }

                info!(node_id = %node_id, tool = %tool_name, iteration = iteration + 1, "executing tool (resume)");
                let tool_started_at = Instant::now();
                let result = if tool_name == "search_knowledge" {
                    let query_text = tool_input.get("query").and_then(Value::as_str).unwrap_or("");
                    let limit = tool_input.get("limit").and_then(Value::as_u64).unwrap_or(5).min(10);
                    let reply_project_id = if let Some(sid) = session_id_for_creds {
                        load_project_id(&self.db, sid).await
                    } else {
                        None
                    };
                    self.execute_search_knowledge(query_text, limit, client_id, reply_project_id).await
                } else if tool_name == "read_knowledge" {
                    let doc_id = tool_input.get("document_id").and_then(Value::as_str).unwrap_or("");
                    let chunk_idx = tool_input.get("chunk_index").and_then(Value::as_i64).unwrap_or(0);
                    let range = tool_input.get("range").and_then(Value::as_i64).unwrap_or(5).min(20);
                    self.execute_read_knowledge(doc_id, chunk_idx, range, client_id).await
                } else {
                    actions::execute_action(tool_name, tool_input, session_id, &upstream_outputs, &credentials, &self.settings, &self.http_client).await
                };
                let tool_duration_ms = tool_started_at.elapsed().as_millis() as u64;
                info!(node_id = %node_id, tool = %tool_name, duration_ms = tool_duration_ms, "tool complete (resume)");

                emit_event(&self.db, &self.event_bus, session_id, node_id, "tool_call", &json!({
                    "tool": tool_name,
                    "iteration": iteration + 1,
                })).await;

                let result_preview: String = result.chars().take(2000).collect();
                persist_message(&self.db, &self.event_bus, session_id, node_id, "tool_result", &result_preview, &json!({
                    "tool_use_id": tool_use_id,
                    "tool_name": tool_name,
                })).await;

                maybe_emit_early_artifact(&self.db, &self.event_bus, session_id, node_id, tool_name, &result).await;

                tool_results.push((tool_use_id.clone(), result));
            }

            if final_output.is_some() {
                break;
            }

            if !tool_results.is_empty() {
                messages.push(tool_results_message(&tool_results));
            }
        }

        // Save updated conversation state
        let conv_state = json!({
            "messages": messages,
            "system_prompt": system_prompt,
            "model": model,
        });
        let _ = self.db.execute_with(
            "UPDATE execution_nodes SET conversation_state = $1 WHERE id = $2 AND session_id = $3",
            pg_args!(conv_state, nid, sid),
        ).await;

        let status = if paused_for_user {
            NodeStatus::AwaitingReply
        } else if final_output.is_some() {
            NodeStatus::Passed
        } else {
            NodeStatus::Passed
        };

        AgentResult {
            node_uid: node_id.to_string(),
            status,
            judge_score: None,
            judge_feedback: None,
            final_summary: Some(final_summary),
            output: final_output,
            error: None,
            duration_ms: started_at.elapsed().as_millis() as u64,
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Base operating instructions shared by all agents.
/// Loaded once from agents/base_prompt.md and cached.
fn base_agent_instructions() -> &'static str {
    static INSTRUCTIONS: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    INSTRUCTIONS.get_or_init(|| {
        let path = std::path::Path::new("agents/base_prompt.md");
        std::fs::read_to_string(path).unwrap_or_default()
    })
}

fn build_system_prompt(
    base_prompt: &str,
    upstream_context: &str,
    client_context: &str,
    expert_context: &str,
    agent: &crate::agent_catalog::AgentDefinition,
) -> String {
    // Start with base operating instructions, then the agent-specific prompt
    let base_instructions = base_agent_instructions();
    let mut prompt = if base_instructions.is_empty() {
        base_prompt.to_string()
    } else {
        format!("{base_instructions}\n\n---\n\n{base_prompt}")
    };

    if !expert_context.is_empty() {
        prompt.push_str("\n\n");
        prompt.push_str(expert_context);
    }

    if !client_context.is_empty() {
        prompt.push_str("\n\n");
        prompt.push_str(client_context);
    }

    if !agent.knowledge_docs.is_empty() {
        prompt.push_str("\n\n<reference_knowledge>\n## Reference Knowledge\n");
        for doc in &agent.knowledge_docs {
            prompt.push_str(doc);
            prompt.push('\n');
        }
        prompt.push_str("</reference_knowledge>");
    }

    if !agent.examples.is_empty() {
        prompt.push_str("\n\n## Examples\n");
        for (i, ex) in agent.examples.iter().enumerate() {
            prompt.push_str(&format!(
                "\n### Example {}\nInput: {}\nOutput: {}\n",
                i + 1,
                serde_json::to_string(&ex.input).unwrap_or_default(),
                ex.output
            ));
        }
    }

    // Inject the quality criteria so the agent knows its own evaluation bar
    if !agent.judge_config.rubric.is_empty() || !agent.judge_config.need_to_know.is_empty() {
        prompt.push_str("\n\n<quality_criteria>\n## Quality Criteria (your work will be evaluated against these)\n");

        if !agent.judge_config.need_to_know.is_empty() {
            prompt.push_str("\n### Hard Requirements\nYour output will be REJECTED if these are not addressed:\n");
            for item in &agent.judge_config.need_to_know {
                prompt.push_str(&format!("- {item}\n"));
            }
        }

        if !agent.judge_config.rubric.is_empty() {
            prompt.push_str("\n### Quality Rubric\nBefore calling write_output, verify each of these:\n");
            for item in &agent.judge_config.rubric {
                prompt.push_str(&format!("- [ ] {item}\n"));
            }
        }

        prompt.push_str("</quality_criteria>");
    }

    if !upstream_context.is_empty() {
        prompt.push_str("\n\n<upstream_context>\n");
        prompt.push_str(upstream_context);
        prompt.push_str("\n</upstream_context>");
    }

    prompt
}

/// Extended system prompt builder that includes spawn context and acceptance criteria.
fn build_system_prompt_with_spawn_context(
    base_prompt: &str,
    upstream_context: &str,
    client_context: &str,
    expert_context: &str,
    agent: &crate::agent_catalog::AgentDefinition,
    spawn_context: Option<&str>,
    acceptance_criteria: Option<&Value>,
    spawn_examples: Option<&str>,
) -> String {
    let mut prompt = build_system_prompt(base_prompt, upstream_context, client_context, expert_context, agent);

    if let Some(ctx) = spawn_context {
        if !ctx.is_empty() {
            prompt.push_str("\n\n<task_context>\n## Task Context\n");
            prompt.push_str(ctx);
            prompt.push_str("\n</task_context>");
        }
    }

    if let Some(criteria) = acceptance_criteria {
        if let Some(arr) = criteria.as_array() {
            if !arr.is_empty() {
                prompt.push_str("\n\n<acceptance_criteria>\n## Acceptance Criteria (ALL must be met before calling write_output)\n");
                prompt.push_str("Do NOT call write_output until every criterion below is satisfied and verified:\n");
                for (i, c) in arr.iter().enumerate() {
                    if let Some(s) = c.as_str() {
                        prompt.push_str(&format!("- [ ] {}. {}\n", i + 1, s));
                    }
                }
                prompt.push_str("</acceptance_criteria>");
            }
        }
    }

    if let Some(examples) = spawn_examples {
        if !examples.is_empty() {
            prompt.push_str("\n\n<examples>\n## Examples & References\n");
            prompt.push_str(examples);
            prompt.push_str("\n</examples>");
        }
    }

    prompt
}

/// Truncate `text` to at most `limit` chars while preserving lines that contain
/// URLs, resource IDs, artifact references, or blocker/criteria keywords.
fn smart_truncate(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }

    let lines: Vec<&str> = text.lines().collect();
    let is_important = |line: &str| -> bool {
        line.contains("http")
            || line.contains("_id\"")
            || line.contains("_uid\"")
            || line.contains("_url\"")
            || line.contains("\"artifacts\"")
            || line.contains("\"url\"")
            || line.contains("\"blocker")
            || line.contains("\"error")
    };

    let mut important_lines: Vec<(usize, &str)> = Vec::new();
    let mut leading_lines: Vec<(usize, &str)> = Vec::new();

    for (i, line) in lines.iter().enumerate() {
        if is_important(line) {
            important_lines.push((i, line));
        } else {
            leading_lines.push((i, line));
        }
    }

    let important_budget: usize = important_lines.iter().map(|(_, l)| l.len() + 1).sum();
    let remaining = if important_budget >= limit.saturating_sub(20) {
        // Important lines alone exceed budget — truncate them too
        let mut out = String::with_capacity(limit);
        for (_, line) in &important_lines {
            if out.len() + line.len() + 1 > limit.saturating_sub(20) {
                break;
            }
            out.push_str(line);
            out.push('\n');
        }
        out.push_str("... (truncated)");
        return out;
    } else {
        limit.saturating_sub(20) - important_budget
    };

    let mut selected: Vec<(usize, &str)> = Vec::new();
    selected.extend_from_slice(&important_lines);
    let mut budget_used = 0;
    for (i, line) in &leading_lines {
        if budget_used + line.len() + 1 > remaining {
            break;
        }
        selected.push((*i, line));
        budget_used += line.len() + 1;
    }

    selected.sort_by_key(|(i, _)| *i);
    let mut out: String = selected.iter().map(|(_, l)| *l).collect::<Vec<_>>().join("\n");
    out.push_str("\n... (truncated)");
    out
}

/// Prepare a saved message history for resume by fixing Anthropic API invariants.
///
/// After a node completes (e.g. write_output) the saved conversation may end with
/// an assistant message containing tool_use blocks that have no corresponding
/// tool_result.  The Anthropic API rejects such sequences.
///
/// This function:
///  1. Finds any tool_use IDs in the last assistant message that lack a tool_result.
///  2. Generates synthetic tool_result blocks for them.
///  3. Packs those results together with the user's reply text into a single user
///     message so the API sees a valid alternating sequence.
///  4. If the last message is already a user message with tool_results (e.g. from
///     request_user_action), the reply text is merged into that message instead of
///     creating a second consecutive user message.
///
/// Returns `true` if the user reply was already appended by this function.
fn prepare_resume_messages(messages: &mut Vec<Value>, user_reply: &str) -> bool {
    let pending = extract_pending_tool_use_ids(messages);

    if !pending.is_empty() {
        // Build a single user message: synthetic tool_results + user text
        let mut blocks: Vec<Value> = pending
            .iter()
            .map(|id| {
                json!({
                    "type": "tool_result",
                    "tool_use_id": id,
                    "content": "[Conversation resumed by user]"
                })
            })
            .collect();
        blocks.push(json!({"type": "text", "text": user_reply}));
        messages.push(json!({"role": "user", "content": blocks}));
        return true;
    }

    // If the last message is a user message with tool_results, merge the reply
    // text into it to avoid two consecutive user messages.
    if let Some(last) = messages.last_mut() {
        if last.get("role").and_then(Value::as_str) == Some("user") {
            if let Some(arr) = last.get_mut("content").and_then(Value::as_array_mut) {
                let has_tool_results = arr
                    .iter()
                    .any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"));
                if has_tool_results {
                    arr.push(json!({"type": "text", "text": user_reply}));
                    return true;
                }
            }
        }
    }

    false
}

/// Remove thinking content blocks from assistant messages so the conversation
/// can be sent to the API without extended thinking enabled.
fn strip_thinking_blocks(messages: &mut [Value]) {
    for msg in messages.iter_mut() {
        if msg.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        if let Some(blocks) = msg.get_mut("content").and_then(Value::as_array_mut) {
            blocks.retain(|b| {
                b.get("type").and_then(Value::as_str) != Some("thinking")
            });
        }
    }
}

/// Extract tool_use IDs from the last assistant message that have no matching
/// tool_result in any subsequent user message.
fn extract_pending_tool_use_ids(messages: &[Value]) -> Vec<String> {
    let mut last_assistant_idx = None;
    for (i, msg) in messages.iter().enumerate().rev() {
        if msg.get("role").and_then(Value::as_str) == Some("assistant") {
            last_assistant_idx = Some(i);
            break;
        }
    }

    let Some(idx) = last_assistant_idx else {
        return vec![];
    };

    let tool_use_ids: Vec<String> = messages[idx]
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
                .filter_map(|b| b.get("id").and_then(Value::as_str).map(String::from))
                .collect()
        })
        .unwrap_or_default();

    if tool_use_ids.is_empty() {
        return vec![];
    }

    let mut satisfied: std::collections::HashSet<String> = std::collections::HashSet::new();
    for msg in &messages[idx + 1..] {
        if let Some(content) = msg.get("content").and_then(Value::as_array) {
            for block in content {
                if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                    if let Some(id) = block.get("tool_use_id").and_then(Value::as_str) {
                        satisfied.insert(id.to_string());
                    }
                }
            }
        }
    }

    tool_use_ids
        .into_iter()
        .filter(|id| !satisfied.contains(id))
        .collect()
}

/// Truncate old messages to prevent context window overflow.
/// Keeps the first message (task question) and the last `keep_recent` messages intact.
/// Middle messages with tool_result content are compressed to short previews.
fn truncate_old_messages(messages: &mut Vec<Value>, keep_recent: usize) {
    if messages.len() <= keep_recent + 1 {
        return;
    }
    let cutoff = messages.len() - keep_recent;
    for msg in messages[1..cutoff].iter_mut() {
        if let Some(content) = msg.get_mut("content") {
            if let Some(arr) = content.as_array_mut() {
                for block in arr.iter_mut() {
                    if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                        if let Some(c) = block.get("content").and_then(Value::as_str) {
                            if c.len() > 500 {
                                let preview: String = c.chars().take(400).collect();
                                block["content"] = Value::String(format!("{preview}... [truncated]"));
                            }
                        }
                    }
                }
            } else if let Some(text) = content.as_str() {
                if text.len() > 2000 {
                    let preview: String = text.chars().take(1500).collect();
                    *content = Value::String(format!("{preview}... [truncated]"));
                }
            }
        }
    }
}

/// Recursively extract all string values that look like URLs from a JSON Value.
fn extract_urls_from_value(value: &Value) -> Vec<String> {
    let mut urls = Vec::new();
    match value {
        Value::String(s) if s.starts_with("http") => {
            urls.push(s.clone());
        }
        Value::Array(arr) => {
            for item in arr {
                urls.extend(extract_urls_from_value(item));
            }
        }
        Value::Object(map) => {
            for (_, v) in map {
                urls.extend(extract_urls_from_value(v));
            }
        }
        _ => {}
    }
    urls
}

/// Verify that artifact URLs are reachable via HTTP HEAD.
/// Returns a list of (url, reason) for each URL that failed verification.
async fn verify_artifact_urls(artifacts: &Value) -> Vec<(String, String)> {
    let urls = extract_urls_from_value(artifacts);
    if urls.is_empty() {
        return Vec::new();
    }

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
    {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let mut failures = Vec::new();
    for url in &urls {
        match client.head(url.as_str()).send().await {
            Ok(resp) if resp.status().is_success() || resp.status().is_redirection() => {}
            Ok(resp) => {
                failures.push((url.clone(), format!("HTTP {}", resp.status())));
            }
            Err(e) => {
                failures.push((url.clone(), format!("{}", e)));
            }
        }
    }
    failures
}

fn build_upstream_context(upstream_outputs: &HashMap<String, Value>) -> String {
    if upstream_outputs.is_empty() {
        return String::new();
    }

    let mut parts = vec![
        "## Upstream Agent Outputs\nFull outputs are included below. Use read_upstream_output tool only if you need to re-read a specific agent's output.\n".to_string()
    ];
    for (slug, output) in upstream_outputs {
        let full_json = serde_json::to_string_pretty(output).unwrap_or_default();
        let display = smart_truncate(&full_json, 6000);
        parts.push(format!("### {}\n```json\n{}\n```", slug, display));
    }
    parts.join("\n\n")
}


/// Load preview plan children for a master_orchestrator node.
/// Returns Vec of (uid, agent_slug, task_description) for preview nodes.
async fn load_preview_plan(
    db: &crate::pg::PgClient,
    parent_uid: uuid::Uuid,
) -> Vec<(uuid::Uuid, String, String)> {
    match db.execute_with(
        "SELECT id, agent_slug, task_description FROM execution_nodes WHERE parent_uid = $1 AND status = 'preview' ORDER BY created_at",
        pg_args!(parent_uid),
    ).await {
        Ok(rows) => rows.iter().filter_map(|row| {
            let uid = row.get("id").and_then(Value::as_str)?.parse::<uuid::Uuid>().ok()?;
            let slug = row.get("agent_slug").and_then(Value::as_str)?.to_string();
            let task = row.get("task_description").and_then(Value::as_str)?.to_string();
            Some((uid, slug, task))
        }).collect(),
        Err(_) => Vec::new(),
    }
}

/// Load project_id from the session associated with a node.
async fn load_project_id(
    db: &crate::pg::PgClient,
    session_id: uuid::Uuid,
) -> Option<uuid::Uuid> {
    match db.execute_with(
        "SELECT project_id FROM execution_sessions WHERE id = $1",
        pg_args!(session_id),
    ).await {
        Ok(rows) => rows.first()
            .and_then(|r| r.get("project_id").and_then(Value::as_str))
            .and_then(|s| s.parse::<uuid::Uuid>().ok()),
        Err(_) => None,
    }
}

/// Load the project-level description (architecture, data flows, integration map)
/// from the session's linked project_description_id.
async fn load_project_description(
    db: &crate::pg::PgClient,
    session_id: uuid::Uuid,
) -> String {
    // Get the project_description_id from the session
    let desc_id = match db.execute_with(
        "SELECT project_description_id FROM execution_sessions WHERE id = $1",
        pg_args!(session_id),
    ).await {
        Ok(rows) => rows.first()
            .and_then(|r| r.get("project_description_id").and_then(Value::as_str))
            .and_then(|s| s.parse::<uuid::Uuid>().ok()),
        Err(_) => None,
    };

    let desc_id = match desc_id {
        Some(id) => id,
        None => return String::new(),
    };

    // Load the project description
    let rows = match db.execute_with(
        "SELECT title, summary, architecture, data_flows, integration_map FROM project_descriptions WHERE id = $1",
        pg_args!(desc_id),
    ).await {
        Ok(r) => r,
        Err(_) => return String::new(),
    };

    let row = match rows.first() {
        Some(r) => r,
        None => return String::new(),
    };

    let mut parts = Vec::new();

    if let Some(title) = row.get("title").and_then(Value::as_str) {
        parts.push(format!("**Project**: {}", title));
    }
    if let Some(summary) = row.get("summary").and_then(Value::as_str) {
        parts.push(summary.to_string());
    }
    if let Some(arch) = row.get("architecture").and_then(Value::as_str) {
        if !arch.is_empty() {
            parts.push(format!("**Architecture**: {}", arch));
        }
    }
    if let Some(flows) = row.get("data_flows").and_then(Value::as_array) {
        if !flows.is_empty() {
            let flow_strs: Vec<String> = flows.iter()
                .filter_map(|f| {
                    let from = f.get("from").and_then(Value::as_str).unwrap_or("?");
                    let to = f.get("to").and_then(Value::as_str).unwrap_or("?");
                    let desc = f.get("description").and_then(Value::as_str).unwrap_or("");
                    Some(format!("- {} → {}: {}", from, to, desc))
                })
                .collect();
            parts.push(format!("**Data Flows**:\n{}", flow_strs.join("\n")));
        }
    }

    if parts.is_empty() {
        String::new()
    } else {
        parts.join("\n\n")
    }
}

/// Parse an LLM enrichment response into (context, acceptance_criteria, examples).
/// Handles JSON wrapped in markdown fences or bare JSON.
fn parse_enrichment_json(text: &str) -> (String, Option<Vec<String>>, String) {
    let cleaned = text.trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    if let Ok(v) = serde_json::from_str::<Value>(cleaned) {
        let context = v.get("context").and_then(Value::as_str).unwrap_or("").to_string();
        let criteria = v.get("acceptance_criteria")
            .and_then(Value::as_array)
            .map(|arr| arr.iter().filter_map(Value::as_str).map(String::from).collect());
        let examples = v.get("examples").and_then(Value::as_str).unwrap_or("").to_string();
        (context, criteria, examples)
    } else {
        // Can't parse JSON — treat the whole text as context
        (text.to_string(), None, String::new())
    }
}

/// Parse the final synthesis response from the orchestrator LLM.
/// Returns (structured output, human-readable summary).
fn parse_synthesis_json(text: &str, step_results: &[Value]) -> (Value, String) {
    let cleaned = text.trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    if let Ok(v) = serde_json::from_str::<Value>(cleaned) {
        let result = v.get("result").cloned().unwrap_or_else(|| v.clone());
        let summary = v.get("summary")
            .and_then(Value::as_str)
            .unwrap_or("Plan execution complete.")
            .to_string();
        (result, summary)
    } else {
        // Can't parse — use text as summary, step results as output
        (json!({"steps": step_results}), text.to_string())
    }
}

/// Load enriched spawn context fields from the execution_nodes table.
/// Returns (spawn_context, acceptance_criteria, spawn_examples, description).
async fn load_spawn_fields(
    db: &crate::pg::PgClient,
    node_id: uuid::Uuid,
) -> (Option<String>, Option<Value>, Option<String>, Option<Value>) {
    match db.execute_with(
        "SELECT spawn_context, acceptance_criteria, spawn_examples, description FROM execution_nodes WHERE id = $1",
        pg_args!(node_id),
    ).await {
        Ok(rows) => {
            if let Some(row) = rows.first() {
                let ctx = row.get("spawn_context")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(String::from);
                let criteria = row.get("acceptance_criteria")
                    .filter(|v| !v.is_null())
                    .cloned();
                let examples = row.get("spawn_examples")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(String::from);
                let description = row.get("description")
                    .filter(|v| !v.is_null() && v.as_object().map_or(true, |o| !o.is_empty()))
                    .cloned();
                (ctx, criteria, examples, description)
            } else {
                (None, None, None, None)
            }
        }
        Err(_) => (None, None, None, None),
    }
}
