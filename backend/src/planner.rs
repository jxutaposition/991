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
- Only use agent slugs from the catalog above. The "slug" field is the exact identifier.
- Each node must have a specific task_description scoped to that agent's capability and the customer's request context.
- depends_on is an array of 0-based indices of earlier nodes that must complete first. No cycles allowed.
- Prefer parallelism: if two agents don't need each other's output, give them empty depends_on arrays.
- Keep the plan focused — typically 3-9 agents. Don't use agents that aren't relevant to the request.
- End with a reporting/CRM step when the request involves outreach or campaign execution.

## Examples

Request: "Run cold outbound to fintech companies 50-500 employees in NYC"
Plan: icp_builder → company_researcher → contact_finder → lead_scorer → lead_list_builder → cold_email_writer → subject_line_optimizer → follow_up_sequence_builder → crm_updater

Request: "Launch Meta and Google ad campaign for our new product"
Plan: icp_builder → creative_brief_generator → ad_copy_writer → [meta_ads_campaign_builder, google_ads_campaign_builder (both depend on ad_copy_writer)] → campaign_performance_analyzer

Request: "Analyze Q1 performance and build Q2 plan"
Plan: [outreach_results_reporter, campaign_performance_analyzer (both independent)] → competitor_analyzer → icp_builder → creative_brief_generator → ad_copy_writer

## Output Format

Return ONLY a JSON array. No explanation, no markdown fences.

[
  {"agent_slug": "icp_builder", "task_description": "...", "depends_on": []},
  {"agent_slug": "company_researcher", "task_description": "...", "depends_on": [0]},
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

    // Validate depends_on indices are valid predecessors only
    for (i, node) in nodes.iter().enumerate() {
        for &dep in &node.depends_on {
            if dep >= i {
                return Err(anyhow::anyhow!(
                    "node {i} ({}) depends on index {dep} which is not a predecessor",
                    node.agent_slug
                ));
            }
        }
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
                .unwrap_or_else(|| "claude-opus-4-6".to_string()),
            skip_judge: agent.skip_judge,
            variant_group: None,
            variant_label: None,
            variant_selected: None,
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
