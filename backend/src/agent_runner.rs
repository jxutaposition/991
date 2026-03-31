/// AgentRunner — Executor → Critic → Judge loop for a single agent node.
///
/// Adapted from dataAggregate/node_runner.rs for GTM agents.
/// Same three-stage pattern: Executor runs tool loop, Critic checks rubric,
/// Judge scores and decides pass/fail/retry.
use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Value};
use tracing::{info, warn};

use crate::agent_catalog::{AgentCatalog, ExecutionPlanNode, JudgeConfig, NodeStatus};
use crate::anthropic::{
    assistant_message_from_response, tool_results_message, user_message, AnthropicClient,
    ToolDef,
};
use crate::config::Settings;
use crate::pg::PgClient;
use crate::tools;

const MAX_JUDGE_RETRIES: u32 = 2;

#[derive(Debug, Clone)]
pub struct AgentResult {
    pub node_uid: String,
    pub status: NodeStatus,
    pub judge_score: Option<f64>,
    pub judge_feedback: Option<String>,
    pub final_summary: Option<String>,
    pub output: Option<Value>,
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct AgentRunner {
    settings: Arc<Settings>,
    db: PgClient,
    catalog: Arc<AgentCatalog>,
}

impl AgentRunner {
    pub fn new(settings: Arc<Settings>, db: PgClient, catalog: Arc<AgentCatalog>) -> Self {
        Self { settings, db, catalog }
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

        let expert_context = if let Some(expert_id) = agent.expert_id {
            crate::client::build_expert_context(&self.db, expert_id)
                .await
                .unwrap_or_default()
        } else {
            String::new()
        };

        let system_prompt = build_system_prompt(
            &agent.system_prompt,
            &upstream_context,
            &client_context,
            &expert_context,
            &agent,
        );

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

        for attempt in 0..=MAX_JUDGE_RETRIES {
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
                    &plan_node.session_id.to_string(),
                    upstream_outputs,
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
                };
            }

            // ── Stage 2: Critic (rubric check) ──────────────────────────────
            if !plan_node.judge_config.rubric.is_empty() {
                let critic_result = self
                    .critic_run(&executor_summary, &plan_node.judge_config, model)
                    .await;

                let critic_passed = critic_result
                    .get("overall_pass")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);

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
    ) -> Value {
        let client = AnthropicClient::new(
            self.settings.anthropic_api_key.clone(),
            model.to_string(),
        );

        let mut messages = vec![user_message(question.to_string())];
        let mut final_output: Option<Value> = None;
        let mut final_summary = String::new();

        for iteration in 0..max_iterations {
            let response = match client
                .messages(system_prompt, &messages, tool_defs, 8192, Some(model))
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    warn!(iteration, error = %e, "executor LLM call failed");
                    break;
                }
            };

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

                let result = tools::execute_tool(tool_name, tool_input, session_id, upstream_outputs).await;
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
