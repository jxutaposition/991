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
use crate::anthropic::{
    assistant_message_from_response, tool_results_message, user_message, AnthropicClient,
    ToolDef,
};
use crate::config::Settings;
use crate::pg::PgClient;
use crate::session::EventBus;
use crate::tools;

const MAX_JUDGE_RETRIES: u32 = 2;

/// Persist an execution event to the DB and broadcast it via SSE.
async fn emit_event(
    db: &PgClient,
    event_bus: &EventBus,
    session_id: &str,
    node_id: &str,
    event_type: &str,
    payload: &Value,
) {
    let payload_str = payload.to_string().replace('\'', "''");
    let sql = format!(
        r#"
        INSERT INTO execution_events (session_id, node_id, event_type, payload)
        VALUES ('{session_id}', '{node_id}', '{event_type}', '{payload_str}'::jsonb)
        "#
    );
    let _ = db.execute(&sql).await;

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
                crate::credentials::load_credentials_for_client(&self.db, master_key, client_id)
                    .await
                    .unwrap_or_default()
            } else {
                Default::default()
            }
        } else {
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

        // Build tool list for this agent
        let agent_tools = tools::tools_for_agent(
            &agent.tools,
            plan_node.parent_uid.is_none(), // allow spawn_agent only for top-level nodes
        );

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
                let thinking_escaped = full_thinking.replace('\'', "''");
                let sql = format!(
                    r#"
                    INSERT INTO thinking_blocks (session_id, node_id, iteration, thinking_text, token_count)
                    VALUES ('{session_id}', '{node_id}', {iteration}, '{thinking_escaped}', {thinking_tokens})
                    "#,
                    iteration = iteration + 1,
                );
                let _ = self.db.execute(&sql).await;

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
                        model: String::new(),
                        skip_judge: false,
                        variant_group: None,
                        variant_label: None,
                        variant_selected: None,
                        client_id: None,
                    };

                    // Look up client_id from the parent node in DB
                    let parent_client_id = {
                        let rows = self.db.execute(&format!(
                            "SELECT client_id FROM execution_nodes WHERE id = '{}'", node_id
                        )).await.unwrap_or_default();
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

                tool_results.push((tool_use_id.clone(), result));
            }

            if final_output.is_some() {
                break;
            }

            if !tool_results.is_empty() {
                messages.push(tool_results_message(&tool_results));
            }
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
        let depth_sql = format!(
            "SELECT depth FROM execution_nodes WHERE id = '{}'",
            parent_node.uid
        );
        let parent_depth = match self.db.execute(&depth_sql).await {
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

        let child_uid = uuid::Uuid::new_v4();
        let sid = parent_node.session_id;
        let task_escaped = task_description.replace('\'', "''");
        let context_escaped = spawn_context.unwrap_or("").replace('\'', "''");
        let criteria_json = acceptance_criteria
            .as_ref()
            .map(|c| serde_json::to_string(c).unwrap_or_else(|_| "[]".to_string()))
            .unwrap_or_else(|| "null".to_string())
            .replace('\'', "''");
        let examples_escaped = spawn_examples.unwrap_or("").replace('\'', "''");

        let model = agent.model.as_deref()
            .unwrap_or(&parent_node.model);
        let judge_config_json = serde_json::to_string(&agent.judge_config)
            .unwrap_or_else(|_| r#"{"threshold":7.0,"rubric":[],"need_to_know":[]}"#.to_string())
            .replace('\'', "''");

        let node_client_val = parent_node.client_id
            .map(|id| format!("'{id}'"))
            .unwrap_or_else(|| "NULL".to_string());

        // Persist child node to DB
        let insert_sql = format!(
            r#"INSERT INTO execution_nodes
                (id, session_id, agent_slug, agent_git_sha, task_description, status,
                 requires, attempt_count, parent_uid, judge_config, max_iterations,
                 model, skip_judge, client_id, depth, spawn_context, acceptance_criteria,
                 spawn_examples)
               VALUES
                ('{child_uid}', '{sid}', '{slug}', '{sha}', '{task}', 'running',
                 ARRAY[]::uuid[], 0, '{parent}', '{jc}'::jsonb, {max_iter},
                 '{model}', {skip}, {client}, {depth}, '{ctx}',
                 '{criteria}'::jsonb, '{ex}')
            "#,
            slug = agent_slug.replace('\'', "''"),
            sha = "spawned",
            task = task_escaped,
            parent = parent_node.uid,
            jc = judge_config_json,
            max_iter = agent.max_iterations,
            skip = agent.skip_judge,
            client = node_client_val,
            depth = child_depth,
            ctx = context_escaped,
            criteria = criteria_json,
            ex = examples_escaped,
        );

        if let Err(e) = self.db.execute(&insert_sql).await {
            warn!(error = %e, "failed to persist child node");
            return json!({"error": format!("Failed to create child node: {e}")});
        }

        // Emit node_started event
        emit_event(
            &self.db, &self.event_bus, &sid.to_string(), &child_uid.to_string(),
            "node_started",
            &json!({"agent_slug": agent_slug, "parent_uid": parent_node.uid.to_string(), "depth": child_depth}),
        ).await;

        // Build child ExecutionPlanNode
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
            skip_judge: agent.skip_judge,
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
        let status = result.status.as_str();
        let output_json = result.output.as_ref()
            .map(|v| format!("'{}'", v.to_string().replace('\'', "''")))
            .unwrap_or_else(|| "NULL".to_string());
        let score = result.judge_score
            .map(|s| s.to_string())
            .unwrap_or_else(|| "NULL".to_string());
        let feedback = result.judge_feedback.as_deref()
            .map(|s| format!("'{}'", s.replace('\'', "''")))
            .unwrap_or_else(|| "NULL".to_string());

        let update_sql = format!(
            r#"UPDATE execution_nodes
               SET status = '{status}', output = {output}, judge_score = {score},
                   judge_feedback = {feedback}, completed_at = NOW()
               WHERE id = '{child_uid}'"#,
            output = output_json,
            score = score,
            feedback = feedback,
        );
        let _ = self.db.execute(&update_sql).await;

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

        // Return the full output to the parent
        let child_output = result.output.unwrap_or_else(|| {
            json!({
                "summary": result.final_summary.unwrap_or_default(),
                "status": status,
            })
        });

        json!({
            "status": status,
            "agent_slug": agent_slug,
            "node_id": child_uid.to_string(),
            "output": child_output,
        })
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn build_system_prompt(
    base_prompt: &str,
    upstream_context: &str,
    client_context: &str,
    expert_context: &str,
    agent: &crate::agent_catalog::AgentDefinition,
) -> String {
    let mut prompt = base_prompt.to_string();

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
                prompt.push_str("\n\n## Acceptance Criteria\n");
                for (i, c) in arr.iter().enumerate() {
                    if let Some(s) = c.as_str() {
                        prompt.push_str(&format!("{}. {}\n", i + 1, s));
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


/// Load project_id from the session associated with a node.
async fn load_project_id(
    db: &crate::pg::PgClient,
    session_id: uuid::Uuid,
) -> Option<uuid::Uuid> {
    let sql = format!(
        "SELECT project_id FROM execution_sessions WHERE id = '{session_id}'"
    );
    match db.execute(&sql).await {
        Ok(rows) => rows.first()
            .and_then(|r| r.get("project_id").and_then(Value::as_str))
            .and_then(|s| s.parse::<uuid::Uuid>().ok()),
        Err(_) => None,
    }
}

/// Load enriched spawn context fields from the execution_nodes table.
async fn load_spawn_fields(
    db: &crate::pg::PgClient,
    node_id: uuid::Uuid,
) -> (Option<String>, Option<Value>, Option<String>) {
    let sql = format!(
        "SELECT spawn_context, acceptance_criteria, spawn_examples          FROM execution_nodes WHERE id = '{}'",
        node_id
    );

    match db.execute(&sql).await {
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
