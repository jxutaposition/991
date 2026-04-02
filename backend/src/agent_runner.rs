/// AgentRunner — Executor → Critic → Judge loop for a single agent node.
///
/// Adapted from dataAggregate/node_runner.rs for GTM agents.
/// Same three-stage pattern: Executor runs tool loop, Critic checks rubric,
/// Judge scores and decides pass/fail/retry.
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use serde_json::{json, Value};
use tracing::{info, warn};

use crate::agent_catalog::{AgentCatalog, ExecutionPlanNode, JudgeConfig, NodeStatus};
use crate::pg_args;
use crate::anthropic::{
    assistant_message_from_response, tool_results_message, user_message, AnthropicClient,
    ToolDef,
};
use crate::config::Settings;
use crate::pg::PgClient;
use crate::session::EventBus;
use crate::tools;

const MAX_JUDGE_RETRIES: u32 = 2;

/// Persist a conversation message for a node.
async fn persist_message(
    db: &PgClient,
    session_id: &str,
    node_id: &str,
    role: &str,
    content: &str,
    metadata: &Value,
) {
    if let (Ok(sid), Ok(nid)) = (
        session_id.parse::<uuid::Uuid>(),
        node_id.parse::<uuid::Uuid>(),
    ) {
        let _ = db.execute_with(
            "INSERT INTO node_messages (session_id, node_id, role, content, metadata) VALUES ($1, $2, $3, $4, $5)",
            pg_args!(sid, nid, role.to_string(), content.to_string(), metadata.clone()),
        ).await;
    }
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
    }
    event_bus.send(session_id, event).await;
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
    event_bus: EventBus,
}

impl AgentRunner {
    pub fn new(
        settings: Arc<Settings>,
        db: PgClient,
        catalog: Arc<AgentCatalog>,
        skill_catalog: Arc<crate::skills::SkillCatalog>,
        event_bus: EventBus,
    ) -> Self {
        Self { settings, db, catalog, skill_catalog, event_bus }
    }

    pub fn db(&self) -> &PgClient {
        &self.db
    }

    pub fn event_bus(&self) -> &EventBus {
        &self.event_bus
    }

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

        let client_context = if let Some(client_id) = plan_node.client_id {
            crate::client::build_client_context(&self.db, client_id, None)
                .await
                .unwrap_or_default()
        } else {
            String::new()
        };

        // Load client credentials for tool execution
        let mut credentials = if let Some(client_id) = plan_node.client_id {
            if let Some(ref master_key) = self.settings.credential_master_key {
                let creds = crate::credentials::load_credentials_for_client(&self.db, master_key, client_id)
                    .await
                    .unwrap_or_default();
                let slugs: Vec<&str> = creds.keys().map(|s| s.as_str()).collect();
                tracing::info!(
                    agent = %plan_node.agent_slug,
                    %client_id,
                    credentials = ?slugs,
                    "loaded client credentials"
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

        let expert_context = if let Some(expert_id) = agent.expert_id {
            crate::client::build_expert_context(&self.db, expert_id)
                .await
                .unwrap_or_default()
        } else {
            String::new()
        };

        // Check for enriched spawn context on the node (from DB)
        let (node_spawn_context, node_criteria, node_examples) = load_spawn_fields(&self.db, plan_node.uid).await;

        // Resolve skill overlays if we have a skill match
        let skill_overlays = if let Some(skill) = self.skill_catalog.get(&plan_node.agent_slug) {
            crate::skills::resolve_overlays(
                &self.db,
                skill.id,
                agent.expert_id,
                plan_node.client_id,
                load_project_id(&self.db, plan_node.session_id).await,
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
                prompt.push_str("\n\n## Contextual Lessons & Preferences\n");
                prompt.push_str(&skill_overlays);
            }
            prompt
        };

        // If this is a master_orchestrator, load preview plan children and inject into prompt
        let (system_prompt, orchestrator_plan) = if plan_node.agent_slug == "master_orchestrator" {
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
                (p, preview_plan)
            } else {
                let mut p = system_prompt;
                p.push_str("\n\n## Agent Catalog\n\n");
                p.push_str(&self.catalog.catalog_summary());
                (p, vec![])
            }
        } else {
            (system_prompt, vec![])
        };

        // Build tool list for this agent
        let agent_tools = tools::tools_for_agent(
            &agent.tools,
            plan_node.parent_uid.is_none(), // allow spawn_agent only for top-level nodes
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

        // ── Stage 1: Executor ────────────────────────────────────────────────
        let executor_question = format!(
            "Task: {}\n\nSession context:\n{}",
            plan_node.task_description, upstream_context
        );

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

            let feedback_prefix = if judge_feedback_for_retry.is_empty() {
                String::new()
            } else {
                format!(
                    "Previous attempt was rejected. Feedback from quality review:\n{}\n\nPlease revise your work to address this feedback.\n\n",
                    judge_feedback_for_retry
                )
            };

            let question_with_feedback = format!("{feedback_prefix}{executor_question}");

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
                )
                .await;

            executor_output = result.get("output").cloned();
            executor_summary = result
                .get("summary")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();

            if plan_node.skip_judge || self.settings.skip_judge {
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
            }

            // ── Stage 2: Critic (rubric check) ──────────────────────────────
            if !plan_node.judge_config.rubric.is_empty() {
                emit_event(&self.db, &self.event_bus, &sid, &nid, "critic_start", &json!({
                    "attempt": attempt,
                })).await;

                let critic_result = self
                    .critic_run(&executor_summary, &plan_node.judge_config, model)
                    .await;

                let critic_passed = critic_result
                    .get("overall_pass")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);

                emit_event(&self.db, &self.event_bus, &sid, &nid, "critic_done", &json!({
                    "attempt": attempt,
                    "passed": critic_passed,
                    "summary": critic_result.get("summary").and_then(Value::as_str).unwrap_or(""),
                    "items": critic_result.get("items"),
                })).await;

                if !critic_passed {
                    let summary = critic_result
                        .get("summary")
                        .and_then(Value::as_str)
                        .unwrap_or("Rubric check failed")
                        .to_string();
                    judge_feedback_for_retry = summary;
                    warn!(attempt, "critic failed — retrying executor");
                    continue;
                }
            }

            // ── Stage 3: Judge ───────────────────────────────────────────────
            emit_event(&self.db, &self.event_bus, &sid, &nid, "judge_start", &json!({
                "attempt": attempt,
            })).await;

            let judge_result = self
                .judge_run(&executor_question, &executor_summary, &plan_node.judge_config, model)
                .await;

            let verdict = judge_result
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

        // Persist initial user message
        persist_message(&self.db, session_id, node_id, "user", question, &json!({})).await;

        for iteration in 0..max_iterations {
            emit_event(&self.db, &self.event_bus, session_id, node_id, "executor_llm_send", &json!({
                "iteration": iteration + 1,
                "model": model,
            })).await;

            let llm_started_at = Instant::now();
            let response = match if let Some(budget) = thinking_budget {
                client
                    .messages_with_thinking(system_prompt, &messages, tool_defs, 8192, Some(model), budget)
                    .await
            } else {
                client
                    .messages(system_prompt, &messages, tool_defs, 8192, Some(model))
                    .await
            } {
                Ok(r) => r,
                Err(e) => {
                    warn!(iteration, error = %e, "executor LLM call failed");
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
            let tool_call_names: Vec<String> = response
                .tool_uses()
                .iter()
                .map(|(_, name, _)| name.to_string())
                .collect();

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
                persist_message(&self.db, session_id, node_id, "assistant", &llm_text, &json!({
                    "iteration": iteration + 1,
                    "tool_calls": tool_call_names,
                })).await;
            }

            // Persist tool_use entries
            for (id, name, input) in response.tool_uses() {
                persist_message(&self.db, session_id, node_id, "tool_use", &name, &json!({
                    "tool_use_id": id,
                    "tool_name": name,
                    "tool_input": input,
                })).await;
            }

            if response.is_end_turn() {
                final_summary = response.text();
                break;
            }

            if !response.is_tool_use() {
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
                    let _skill_slugs: Vec<String> = tool_input.get("skill_slugs")
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

                    let spawn_result = self.run_child(
                        &parent_node,
                        agent_slug,
                        task_desc,
                        context,
                        criteria,
                        examples,
                    ).await;

                    tool_results.push((tool_use_id.clone(), spawn_result.to_string()));
                    continue;
                }

                if tool_name == "write_output" {
                    // Agent is done — capture output and break
                    final_output = tool_input.get("result").cloned();
                    final_summary = tool_input
                        .get("summary")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();

                    tool_results.push((
                        tool_use_id.clone(),
                        json!({"stored": true}).to_string(),
                    ));

                    messages.push(tool_results_message(&tool_results));
                    // Get final response after write_output
                    if let Ok(r) = client
                        .messages(system_prompt, &messages, tool_defs, 1024, Some(model))
                        .await
                    {
                        if !r.text().is_empty() {
                            final_summary = r.text();
                        }
                    }
                    break;
                }

                let tool_started_at = Instant::now();
                let result = tools::execute_tool(tool_name, tool_input, session_id, upstream_outputs, credentials, &self.settings).await;
                let tool_duration_ms = tool_started_at.elapsed().as_millis() as u64;

                emit_event(&self.db, &self.event_bus, session_id, node_id, "tool_call", &json!({
                    "tool": tool_name,
                    "iteration": iteration + 1,
                    "duration_ms": tool_duration_ms,
                })).await;

                // Persist tool result message
                let result_preview: String = result.chars().take(2000).collect();
                persist_message(&self.db, session_id, node_id, "tool_result", &result_preview, &json!({
                    "tool_use_id": tool_use_id,
                    "tool_name": tool_name,
                })).await;

                tool_results.push((tool_use_id.clone(), result));
            }

            if final_output.is_some() {
                break;
            }

            if !tool_results.is_empty() {
                messages.push(tool_results_message(&tool_results));
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

        json!({
            "output": final_output,
            "summary": final_summary,
        })
    }

    /// Critic: check rubric items against the executor's output.
    async fn critic_run(
        &self,
        narrative: &str,
        judge_config: &JudgeConfig,
        model: &str,
    ) -> Value {
        if judge_config.rubric.is_empty() {
            return json!({"overall_pass": true, "items": [], "summary": ""});
        }

        let client = AnthropicClient::new(
            self.settings.anthropic_api_key.clone(),
            model.to_string(),
        );

        let rubric_list = judge_config
            .rubric
            .iter()
            .enumerate()
            .map(|(i, item)| format!("{}. {}", i + 1, item))
            .collect::<Vec<_>>()
            .join("\n");

        let system = "You are a quality checker reviewing an agent's output against a checklist.";
        let prompt = format!(
            "Review this output against each checklist item. For each item, state PASS or FAIL and briefly explain why.\n\n## Checklist\n{rubric_list}\n\n## Output to Review\n{narrative}\n\nRespond with JSON: {{\"overall_pass\": bool, \"summary\": \"string\", \"items\": [{{\"item\": \"...\", \"pass\": bool, \"reason\": \"...\"}}]}}"
        );

        let response = match client
            .messages(system, &[user_message(prompt)], &[], 2048, Some(model))
            .await
        {
            Ok(r) => r,
            Err(e) => {
                warn!(error = %e, "critic LLM call failed — treating as fail");
                return json!({"overall_pass": false, "items": [], "summary": "critic unavailable — LLM call failed"});
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
            warn!("critic returned unparseable JSON — treating as fail");
            json!({"overall_pass": false, "items": [], "summary": "critic parse error — could not validate output"})
        })
    }

    /// Judge: score the output 0-10 and decide pass/fail/reject.
    async fn judge_run(
        &self,
        question: &str,
        narrative: &str,
        judge_config: &JudgeConfig,
        model: &str,
    ) -> Value {
        let client = AnthropicClient::new(
            self.settings.anthropic_api_key.clone(),
            model.to_string(),
        );

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

        let system = "You are a quality judge evaluating an AI agent's output.";
        let prompt = format!(
            "Score this agent output from 0-10 based on quality, completeness, and accuracy.\n\nThreshold to pass: {threshold:.1}\n{need_to_know}\n\n## Question / Task\n{question}\n\n## Agent Output\n{narrative}\n\nRespond with JSON: {{\"verdict\": \"pass\"|\"fail\"|\"reject\", \"score\": number, \"feedback\": \"string\"}}",
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
    async fn run_orchestrated_plan(
        &self,
        plan_node: &ExecutionPlanNode,
        system_prompt: &str,
        model: &str,
        _credentials: &crate::credentials::CredentialMap,
        preview_children: &[(uuid::Uuid, String, String)],
    ) -> AgentResult {
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

        persist_message(&self.db, &sid, &nid, "system", "Plan-driven execution started", &json!({
            "total_steps": preview_children.len(),
        })).await;

        let plan_summary: String = preview_children.iter().enumerate()
            .map(|(i, (_, slug, task))| format!("{}. **{}**: {}", i + 1, slug, task))
            .collect::<Vec<_>>()
            .join("\n");

        let mut messages: Vec<Value> = Vec::new();
        let mut child_outputs: HashMap<String, Value> = HashMap::new();
        let mut all_passed = true;
        let mut step_results: Vec<Value> = Vec::new();
        let mut blockers: Vec<String> = Vec::new();

        for (i, (_child_uid, agent_slug, task_desc)) in preview_children.iter().enumerate() {
            let upstream_summary = if child_outputs.is_empty() {
                "No upstream results yet.".to_string()
            } else {
                child_outputs.iter()
                    .map(|(k, v)| {
                        let preview: String = serde_json::to_string(v)
                            .unwrap_or_default()
                            .chars()
                            .take(1500)
                            .collect();
                        format!("### {}\n{}", k, preview)
                    })
                    .collect::<Vec<_>>()
                    .join("\n\n")
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
                upstream = upstream_summary,
            );

            messages.push(user_message(enrichment_prompt.clone()));

            emit_event(&self.db, &self.event_bus, &sid, &nid, "plan_step_enriching", &json!({
                "step": i + 1,
                "agent_slug": agent_slug,
                "task_description": task_desc,
            })).await;

            persist_message(&self.db, &sid, &nid, "user", &enrichment_prompt, &json!({
                "step": i + 1,
                "phase": "enrichment_request",
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

            persist_message(&self.db, &sid, &nid, "assistant", &enrichment_text, &json!({
                "step": i + 1,
                "phase": "enrichment_response",
            })).await;

            let (context, criteria, examples) = parse_enrichment_json(&enrichment_text);
            let effective_context = if context.is_empty() { None } else { Some(context.as_str()) };
            let effective_examples = if examples.is_empty() { None } else { Some(examples.as_str()) };

            // Execute the planned child agent
            emit_event(&self.db, &self.event_bus, &sid, &nid, "plan_step_executing", &json!({
                "step": i + 1,
                "agent_slug": agent_slug,
            })).await;

            let result = self.run_child(
                plan_node,
                agent_slug,
                task_desc,
                effective_context,
                criteria,
                effective_examples,
            ).await;

            let status = result.get("status").and_then(Value::as_str).unwrap_or("unknown").to_string();

            // If the child failed, retry once with the error context
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

                let retry_context = format!(
                    "{}\n\n## Previous Attempt Failed\n{}\nPlease address this issue in your retry.",
                    context, error_info
                );

                self.run_child(
                    plan_node,
                    agent_slug,
                    task_desc,
                    Some(&retry_context),
                    None, // criteria already on the node
                    effective_examples,
                ).await
            } else {
                result
            };

            let final_status = result.get("status").and_then(Value::as_str).unwrap_or("unknown").to_string();
            if final_status != "passed" {
                all_passed = false;
                blockers.push(format!("Step {} ({}) ended with status: {}", i + 1, agent_slug, final_status));
            }

            child_outputs.insert(agent_slug.clone(), result.clone());
            step_results.push(result.clone());

            // Feed result back to the conversation for subsequent enrichment calls
            let result_preview: String = serde_json::to_string_pretty(&result)
                .unwrap_or_default()
                .chars()
                .take(2000)
                .collect();
            let result_msg = format!(
                "Step {} ({}) completed with status: {}.\n\nResult:\n{}",
                i + 1, agent_slug, final_status, result_preview
            );
            messages.push(user_message(result_msg.clone()));

            persist_message(&self.db, &sid, &nid, "user", &result_msg, &json!({
                "step": i + 1,
                "phase": "step_result",
                "status": &final_status,
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
                persist_message(&self.db, &sid, &nid, "assistant", &text, &json!({"phase": "synthesis"})).await;
                parse_synthesis_json(&text, &step_results)
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

        AgentResult {
            node_uid: nid,
            status: if all_passed { NodeStatus::Passed } else { NodeStatus::Failed },
            judge_score: None,
            judge_feedback: None,
            final_summary: Some(final_summary),
            output: Some(final_output),
            error: if all_passed { None } else { Some(blockers.join("; ")) },
            duration_ms: started_at.elapsed().as_millis() as u64,
        }
    }

    /// Run a child agent synchronously within the parent's executor loop.
    /// Creates a child ExecutionPlanNode, runs it, persists results, returns output.
    pub async fn run_child(
        &self,
        parent_node: &ExecutionPlanNode,
        agent_slug: &str,
        task_description: &str,
        spawn_context: Option<&str>,
        acceptance_criteria: Option<Vec<String>>,
        spawn_examples: Option<&str>,
    ) -> Value {
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
                   skip_judge = true,
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
                sid
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
                    true,
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

        // Build child ExecutionPlanNode
        // Spawned children skip the judge — the parent orchestrator validates
        // via acceptance criteria, which is more context-aware than a generic rubric.
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
            judge_config: agent.judge_config.clone(),
            max_iterations: agent.max_iterations,
            model: model.to_string(),
            skip_judge: true,
            variant_group: None,
            variant_label: None,
            variant_selected: None,
            client_id: parent_node.client_id,
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

        response
    }

    /// Resume a node's conversation with a user reply.
    /// Loads the saved conversation_state, appends the user message,
    /// and continues the executor loop.
    pub async fn resume_with_reply(
        &self,
        session_id: &str,
        node_id: &str,
        user_reply: &str,
    ) -> AgentResult {
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
        let max_iterations = row.get("max_iterations").and_then(Value::as_i64).unwrap_or(12) as usize;

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

        // Append user reply
        messages.push(user_message(user_reply.to_string()));
        persist_message(&self.db, session_id, node_id, "user", user_reply, &json!({"source": "human_reply"})).await;

        // Emit event
        emit_event(&self.db, &self.event_bus, session_id, node_id, "user_reply", &json!({
            "message": user_reply,
        })).await;

        // Load agent tools
        let agent = self.catalog.get(agent_slug);
        let tool_defs = if let Some(ref a) = agent {
            tools::tools_for_agent(&a.tools, false)
        } else {
            vec![]
        };

        // Load credentials
        let client_id_rows = self.db.execute_with(
            "SELECT client_id FROM execution_nodes WHERE id = $1",
            pg_args!(nid),
        ).await.unwrap_or_default();
        let client_id = client_id_rows.first()
            .and_then(|r| r.get("client_id").and_then(Value::as_str))
            .and_then(|s| s.parse::<uuid::Uuid>().ok());

        let credentials = if let Some(cid) = client_id {
            if let Some(ref master_key) = self.settings.credential_master_key {
                crate::credentials::load_credentials_for_client(&self.db, master_key, cid)
                    .await
                    .unwrap_or_default()
            } else {
                Default::default()
            }
        } else {
            Default::default()
        };

        // Load upstream outputs
        let upstream_outputs = std::collections::HashMap::new();

        let client = AnthropicClient::new(
            self.settings.anthropic_api_key.clone(),
            model.to_string(),
        );

        let started_at = Instant::now();
        let mut final_output: Option<Value> = None;
        let mut final_summary = String::new();

        // Resume executor loop
        for iteration in 0..max_iterations {
            emit_event(&self.db, &self.event_bus, session_id, node_id, "executor_llm_send", &json!({
                "iteration": iteration + 1,
                "model": model,
                "resumed": true,
            })).await;

            let response = match client
                .messages(&system_prompt, &messages, &tool_defs, 8192, Some(model))
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    warn!(error = %e, "resume LLM call failed");
                    break;
                }
            };

            let llm_text = response.text();
            let tool_call_names: Vec<String> = response
                .tool_uses()
                .iter()
                .map(|(_, name, _)| name.to_string())
                .collect();

            emit_event(&self.db, &self.event_bus, session_id, node_id, "executor_llm_receive", &json!({
                "iteration": iteration + 1,
                "stop_reason": response.stop_reason.as_deref().unwrap_or("end_turn"),
                "llm_text": if llm_text.len() > 5000 { format!("{}...", &llm_text[..5000]) } else { llm_text.clone() },
                "tool_calls": tool_call_names,
                "resumed": true,
            })).await;

            messages.push(assistant_message_from_response(&response.content));

            if !llm_text.is_empty() {
                persist_message(&self.db, session_id, node_id, "assistant", &llm_text, &json!({
                    "iteration": iteration + 1,
                    "tool_calls": tool_call_names,
                })).await;
            }

            for (id, name, input) in response.tool_uses() {
                persist_message(&self.db, session_id, node_id, "tool_use", &name, &json!({
                    "tool_use_id": id,
                    "tool_name": name,
                    "tool_input": input,
                })).await;
            }

            if response.is_end_turn() {
                final_summary = response.text();
                break;
            }

            if !response.is_tool_use() {
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
                    tool_results.push((tool_use_id.clone(), json!({"stored": true}).to_string()));
                    messages.push(tool_results_message(&tool_results));
                    break;
                }

                let result = tools::execute_tool(tool_name, tool_input, session_id, &upstream_outputs, &credentials, &self.settings).await;

                emit_event(&self.db, &self.event_bus, session_id, node_id, "tool_call", &json!({
                    "tool": tool_name,
                    "iteration": iteration + 1,
                })).await;

                let result_preview: String = result.chars().take(2000).collect();
                persist_message(&self.db, session_id, node_id, "tool_result", &result_preview, &json!({
                    "tool_use_id": tool_use_id,
                    "tool_name": tool_name,
                })).await;

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

        AgentResult {
            node_uid: node_id.to_string(),
            status: if final_output.is_some() { NodeStatus::Passed } else { NodeStatus::AwaitingReply },
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
        prompt.push_str("\n\n## Reference Knowledge\n");
        for doc in &agent.knowledge_docs {
            prompt.push_str(doc);
            prompt.push('\n');
        }
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
        prompt.push_str("\n\n## Quality Criteria (your work will be evaluated against these)\n");

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
    }

    if !upstream_context.is_empty() {
        prompt.push_str("\n\n");
        prompt.push_str(upstream_context);
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
            prompt.push_str("\n\n## Task Context\n");
            prompt.push_str(ctx);
        }
    }

    if let Some(criteria) = acceptance_criteria {
        if let Some(arr) = criteria.as_array() {
            if !arr.is_empty() {
                prompt.push_str("\n\n## Acceptance Criteria (ALL must be met before calling write_output)\n");
                prompt.push_str("Do NOT call write_output until every criterion below is satisfied and verified:\n");
                for (i, c) in arr.iter().enumerate() {
                    if let Some(s) = c.as_str() {
                        prompt.push_str(&format!("- [ ] {}. {}\n", i + 1, s));
                    }
                }
            }
        }
    }

    if let Some(examples) = spawn_examples {
        if !examples.is_empty() {
            prompt.push_str("\n\n## Examples & References\n");
            prompt.push_str(examples);
        }
    }

    prompt
}

fn build_upstream_context(upstream_outputs: &HashMap<String, Value>) -> String {
    if upstream_outputs.is_empty() {
        return String::new();
    }

    let mut parts = vec!["## Upstream Agent Outputs (available via read_upstream_output tool)".to_string()];
    for (slug, output) in upstream_outputs {
        let preview = serde_json::to_string(output)
            .unwrap_or_default()
            .chars()
            .take(200)
            .collect::<String>();
        parts.push(format!("- **{}**: {}...", slug, preview));
    }
    parts.join("\n")
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
async fn load_spawn_fields(
    db: &crate::pg::PgClient,
    node_id: uuid::Uuid,
) -> (Option<String>, Option<Value>, Option<String>) {
    match db.execute_with(
        "SELECT spawn_context, acceptance_criteria, spawn_examples FROM execution_nodes WHERE id = $1",
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
                (ctx, criteria, examples)
            } else {
                (None, None, None)
            }
        }
        Err(_) => (None, None, None),
    }
}
