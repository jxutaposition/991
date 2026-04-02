/// LLM planner — decomposes a customer NL request into a DAG of agent nodes.
///
/// Adapted from dataAggregate/planner.rs for the GTM domain.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::{info, warn};

use crate::anthropic::{user_message, AnthropicClient};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlannedNode {
    /// Must match an agent slug in the catalog.
    pub agent_slug: String,
    /// Specific task description for this agent in the context of this request.
    pub task_description: String,
    /// 0-based indices of other PlannedNodes in this array that must complete first.
    #[serde(default)]
    pub depends_on: Vec<usize>,
}

const PLANNER_SYSTEM_PROMPT: &str = r#"You are a GTM workflow orchestrator. Your job is to decompose a customer's request into a DAG of expert agents drawn from the catalog below.

## Rules
- CRITICAL: You may ONLY use agent slugs that appear in the "Agent Catalog" section below. If a slug is not listed there, DO NOT use it. Never invent slugs.
- Each node must have a specific task_description scoped to that agent's capability and the customer's request context.
- depends_on is an array of 0-based indices of EARLIER nodes (strictly lower indices) that must complete first. A node at index N can only depend on indices 0..N-1. Never reference the node's own index or higher. No cycles.
- Prefer parallelism: if two agents don't need each other's output, give them empty depends_on arrays.
- Keep the plan focused — typically 3-9 agents. Don't use agents that aren't relevant to the request.
- Use tool_operator agents (clay_operator, n8n_operator, lovable_operator, etc.) for implementation steps after program_operations agents have designed the approach.

## Examples

Request: "Design an expert scoring and tiering program with a leaderboard"
Plan:
[
  {"agent_slug": "program_designer", "task_description": "Design the tiering structure, scoring vectors, and point thresholds", "depends_on": []},
  {"agent_slug": "data_pipeline_builder", "task_description": "Design the data pipeline connecting scoring data sources to storage", "depends_on": [0]},
  {"agent_slug": "dashboard_designer", "task_description": "Design the leaderboard with public and internal views", "depends_on": [0]},
  {"agent_slug": "impact_measurement_designer", "task_description": "Design the measurement framework for program health", "depends_on": [0]},
  {"agent_slug": "clay_operator", "task_description": "Set up Clay tables for social listening data collection", "depends_on": [1]},
  {"agent_slug": "lovable_operator", "task_description": "Build the leaderboard dashboard in Lovable", "depends_on": [2, 1]}
]

Request: "Set up an onboarding automation from application to campaign assignment"
Plan:
[
  {"agent_slug": "onboarding_flow_designer", "task_description": "Design the onboarding flow from application through approval to assignment", "depends_on": []},
  {"agent_slug": "automation_scoper", "task_description": "Evaluate the tool stack and identify automation opportunities", "depends_on": [0]},
  {"agent_slug": "n8n_operator", "task_description": "Build the automation workflow connecting the tools", "depends_on": [1]}
]

Request: "Audit our data across Clay, Supabase, and Notion then fix the pipeline"
Plan:
[
  {"agent_slug": "data_auditor", "task_description": "Cross-check data across Clay, Supabase, and Notion for inconsistencies", "depends_on": []},
  {"agent_slug": "pipeline_diagnostician", "task_description": "Diagnose the broken data flows between systems", "depends_on": [0]},
  {"agent_slug": "data_pipeline_builder", "task_description": "Rebuild the pipeline to fix identified issues", "depends_on": [1]}
]

## Output Format

Return ONLY a JSON array. No explanation, no markdown fences.

[
  {"agent_slug": "program_designer", "task_description": "...", "depends_on": []},
  {"agent_slug": "data_pipeline_builder", "task_description": "...", "depends_on": [0]},
  ...
]"#;

/// Call the LLM to decompose a customer request into a DAG of agent nodes.
pub async fn plan_execution(
    request: &str,
    catalog_summary: &str,
    api_key: &str,
    model: &str,
) -> anyhow::Result<Vec<PlannedNode>> {
    let system = format!(
        "{PLANNER_SYSTEM_PROMPT}\n\n## Agent Catalog\n\n{catalog_summary}"
    );

    let client = AnthropicClient::new(api_key.to_string(), model.to_string());
    let messages = vec![user_message(request.to_string())];

    info!(request = %request, "running GTM planner");

    let response = client
        .messages(&system, &messages, &[], 2048, Some(model))
        .await
        .map_err(|e| anyhow::anyhow!("planner LLM call failed: {e}"))?;

    let text = response.text();
    if text.is_empty() {
        return Err(anyhow::anyhow!("planner returned empty response"));
    }

    // Strip markdown fences if LLM wraps the JSON
    let cleaned = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let nodes: Vec<PlannedNode> = serde_json::from_str(cleaned).map_err(|e| {
        warn!(raw = %text, error = %e, "planner output parse failed");
        anyhow::anyhow!("planner output is not valid JSON: {e}")
    })?;

    if nodes.is_empty() {
        return Err(anyhow::anyhow!("planner returned empty node list"));
    }

    // Sanitize depends_on: drop self-references and forward references instead of failing
    let mut nodes = nodes;
    for i in 0..nodes.len() {
        let original_len = nodes[i].depends_on.len();
        nodes[i].depends_on.retain(|&dep| dep < i);
        if nodes[i].depends_on.len() != original_len {
            warn!(
                node = i,
                agent = %nodes[i].agent_slug,
                "dropped invalid depends_on entries (self/forward references)"
            );
        }
    }

    // Also clamp any out-of-bounds indices
    let node_count = nodes.len();
    for node in &mut nodes {
        node.depends_on.retain(|&dep| dep < node_count);
    }

    info!(node_count = nodes.len(), "planner produced DAG");
    Ok(nodes)
}

/// Convert a list of PlannedNodes into ExecutionPlanNodes with stable UUIDs.
/// Returns (nodes, uid_map) where uid_map[position_index] = uid.
pub fn plan_to_execution_nodes(
    plan: &[PlannedNode],
    session_id: uuid::Uuid,
    git_sha: &str,
    catalog: &crate::agent_catalog::AgentCatalog,
) -> anyhow::Result<Vec<crate::agent_catalog::ExecutionPlanNode>> {
    use crate::agent_catalog::{ExecutionPlanNode, NodeStatus};
    use uuid::Uuid;

    // First pass: assign UIDs
    let uids: Vec<Uuid> = (0..plan.len()).map(|_| Uuid::new_v4()).collect();

    // Second pass: build nodes with resolved requires
    let mut nodes = Vec::new();
    for (i, planned) in plan.iter().enumerate() {
        let agent = catalog.get(&planned.agent_slug).ok_or_else(|| {
            anyhow::anyhow!(
                "planner referenced unknown agent slug: {}",
                planned.agent_slug
            )
        })?;

        let requires: Vec<Uuid> = planned.depends_on.iter().map(|&dep| uids[dep]).collect();

        let status = if requires.is_empty() {
            NodeStatus::Pending
        } else {
            NodeStatus::Waiting
        };

        nodes.push(ExecutionPlanNode {
            uid: uids[i],
            session_id,
            agent_slug: agent.slug.clone(),
            agent_git_sha: git_sha.to_string(),
            task_description: planned.task_description.clone(),
            status,
            requires,
            attempt_count: 0,
            parent_uid: None,
            input: None,
            output: None,
            judge_score: None,
            judge_feedback: None,
            judge_config: agent.judge_config.clone(),
            max_iterations: agent.max_iterations,
            model: agent
                .model
                .clone()
                .unwrap_or_else(|| "claude-haiku-4-5-20251001".to_string()),
            skip_judge: agent.skip_judge,
            variant_group: None,
            variant_label: None,
            variant_selected: None,
            client_id: None,
        });
    }

    Ok(nodes)
}

/// Serialize a plan to JSONB for storage.
pub fn plan_to_json(nodes: &[crate::agent_catalog::ExecutionPlanNode]) -> Value {
    serde_json::json!(nodes
        .iter()
        .map(|n| serde_json::json!({
            "uid": n.uid.to_string(),
            "agent_slug": n.agent_slug,
            "task_description": n.task_description,
            "requires": n.requires.iter().map(|u| u.to_string()).collect::<Vec<_>>(),
        }))
        .collect::<Vec<_>>())
}
