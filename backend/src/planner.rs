/// LLM planner — decomposes a customer NL request into a DAG of agent nodes.
///
/// Adapted from dataAggregate/planner.rs for the GTM domain.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::{info, warn};

use crate::anthropic::{user_message, AnthropicClient};
use crate::pg_args;

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
- Keep the plan focused — typically 2-8 agents. Don't use agents that aren't relevant to the request.
- IMPORTANT: Every agent in the plan must BUILD something or ACT on an external system. Do NOT include agents just for thinking, planning, or designing. Design/strategy reasoning happens in the master_orchestrator, not in subagents. The master_orchestrator enriches context for each builder agent — no separate "designer" step is needed.
- Keep task_description values concise (under 120 chars). Details come from upstream outputs at runtime.

## Examples

Request: "Build an expert scoring and tiering program with a leaderboard and document it"
Plan:
[
  {"agent_slug": "notion_operator", "task_description": "Create expert program wiki: tier structure, scoring rules, documentation", "depends_on": []},
  {"agent_slug": "n8n_operator", "task_description": "Build scoring pipeline from Clay/Tolt sources to Supabase", "depends_on": [0]},
  {"agent_slug": "clay_operator", "task_description": "Build Clay expert table with enrichment and scoring formulas", "depends_on": [0]},
  {"agent_slug": "dashboard_builder", "task_description": "Build leaderboard with internal and public views in Supabase + Lovable", "depends_on": [1, 2]},
  {"agent_slug": "lovable_operator", "task_description": "Build expert-facing leaderboard UI with scores and tiers", "depends_on": [3]}
]

Request: "Set up an onboarding automation from application to campaign assignment"
Plan:
[
  {"agent_slug": "n8n_operator", "task_description": "Build onboarding workflow: form → approval → CRM + Slack + Tolt", "depends_on": []}
]

Request: "Audit our data across Clay, Supabase, and Notion then fix the pipeline"
Plan:
[
  {"agent_slug": "n8n_operator", "task_description": "Audit cross-system data flows, diagnose broken pipelines, rebuild", "depends_on": []}
]

## Ordering Guidelines
When building the DAG, follow this execution order strictly:
1. **Planning / documentation first**: notion_operator (project pages, wikis, databases, documentation).
2. **Automation / pipeline second**: n8n_operator (workflows, webhooks, data pipelines) — depends on Notion pages/config existing.
3. **Enrichment / data third**: clay_operator (Clay tables, enrichment columns, formulas) — depends on pipeline design and data sources.
4. **UI / dashboard / app last**: dashboard_builder, lovable_operator — these reference data from Clay tables and upstream pipelines.

Infer depends_on automatically: if agent B reads from or references a system that agent A creates (e.g. a dashboard that embeds a Notion page, or a pipeline that reads from a Clay table), agent B MUST depend on agent A. When unsure, add the dependency — false dependencies only slow execution, missing dependencies cause failures.

## Output Format

Return ONLY a JSON array. No explanation, no markdown fences. Keep task_description values short.

[
  {"agent_slug": "notion_operator", "task_description": "...", "depends_on": []},
  {"agent_slug": "n8n_operator", "task_description": "...", "depends_on": [0]}
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

    let max_tokens_attempts = [4096u32, 8192];
    let mut last_error = String::new();

    for (attempt, &max_tokens) in max_tokens_attempts.iter().enumerate() {
        let response = client
            .messages(&system, &messages, &[], max_tokens, Some(model))
            .await
            .map_err(|e| anyhow::anyhow!("planner LLM call failed: {e}"))?;

        let text = response.text();
        if text.is_empty() {
            return Err(anyhow::anyhow!("planner returned empty response"));
        }

        let cleaned = text
            .trim()
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();

        match serde_json::from_str::<Vec<PlannedNode>>(cleaned) {
            Ok(nodes) if !nodes.is_empty() => {
                let mut nodes = nodes;
                sanitize_depends_on(&mut nodes);
                info!(node_count = nodes.len(), "planner produced DAG");
                return Ok(nodes);
            }
            Ok(_) => {
                return Err(anyhow::anyhow!("planner returned empty node list"));
            }
            Err(e) => {
                last_error = format!("{e}");
                if attempt < max_tokens_attempts.len() - 1 {
                    warn!(
                        error = %e,
                        max_tokens,
                        "planner JSON parse failed, retrying with higher token limit"
                    );
                } else {
                    warn!(raw = %text, error = %e, "planner output parse failed after retries");
                }
            }
        }
    }

    Err(anyhow::anyhow!("planner output is not valid JSON: {last_error}"))
}

fn sanitize_depends_on(nodes: &mut Vec<PlannedNode>) {
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
    let node_count = nodes.len();
    for node in nodes.iter_mut() {
        node.depends_on.retain(|&dep| dep < node_count);
    }
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
            tool_id: None,
        });
    }

    Ok(nodes)
}

// ── Rich Description Planner ─────────────────────────────────────────────────

/// A rich planned node — includes the structured description alongside the
/// execution-relevant fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RichPlannedNode {
    pub agent_slug: String,
    pub task_description: String,
    #[serde(default)]
    pub depends_on: Vec<usize>,
    /// Rich structured description for the living document.
    #[serde(default)]
    pub description: Value,
}

/// The full output of the rich planner — project-level + per-node descriptions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RichPlanOutput {
    pub title: String,
    pub summary: String,
    pub architecture: Value,
    pub data_flows: Value,
    pub components: Vec<RichPlannedNode>,
}

const RICH_PLANNER_SYSTEM_PROMPT: &str = r#"You are a GTM system architect. Your job is to decompose a customer's request into a rich system description — both a project-level overview and per-component specifications — that will serve as a living design document and execution blueprint.

## Rules
- CRITICAL: You may ONLY use agent slugs that appear in the "Agent Catalog" section below.
- Each component must have a specific task_description (concise, under 120 chars) AND a rich description object.
- depends_on is an array of 0-based indices of EARLIER components. No cycles, no self-references.
- Prefer parallelism: if two components don't need each other's output, give them empty depends_on.
- Keep the plan focused — typically 2-8 components.
- Every component must BUILD something or ACT on an external system. No planning-only components.

## Description Structure
Each component's "description" field is a structured object:
- display_name: human-friendly name for the component
- architecture: { purpose, connections (list of tool/platform names), data_flow (narrative) }
- technical_spec: { approach (how it will be built), tools (platform names), configuration (any known config) }
- io_contract: { inputs: [{ name, source, schema }], outputs: [{ name, schema }] }
- optionality: [{ decision, tradeoffs, recommendation }] — where multiple paths exist
- blockers: [{ type ("credential"|"manual"|"decision"|"external"), description, severity ("blocking"|"warning") }] — missing credentials, manual setup steps, decisions needing human input, external dependencies
- acceptance_criteria: [string] — specific, testable conditions for validating the component's output
- mockup_reference: string or null — for UI components, a brief description of the expected visual output
- prior_artifacts: string or null — references to relevant prior work (leave null if unknown)

## Output Format
Return ONLY valid JSON matching this structure. No explanation, no markdown fences.

{
  "title": "Short project title",
  "summary": "1-3 paragraph system overview explaining what this system does and why",
  "architecture": { "overview": "High-level architecture narrative", "patterns": ["pattern1", "pattern2"] },
  "data_flows": [{ "from": "source", "to": "destination", "description": "what data moves" }],
  "components": [
    {
      "agent_slug": "n8n_operator",
      "task_description": "Build scoring pipeline from Clay/Tolt to Supabase",
      "depends_on": [],
      "description": {
        "display_name": "Expert Scoring Pipeline",
        "architecture": {
          "purpose": "Scores and tiers partners based on engagement and revenue metrics",
          "connections": ["clay", "supabase", "n8n"],
          "data_flow": "Clay enrichment → n8n scoring workflow → Supabase upsert"
        },
        "technical_spec": {
          "approach": "Build n8n workflow to pull enrichment data, compute weighted composite score, write tiers",
          "tools": ["n8n", "clay", "supabase"],
          "configuration": {}
        },
        "io_contract": {
          "inputs": [{ "name": "partner_list", "source": "clay_enrichment", "schema": {} }],
          "outputs": [{ "name": "scored_partners", "schema": {} }]
        },
        "optionality": [],
        "blockers": [{ "type": "credential", "description": "Clay API key required", "severity": "blocking" }],
        "acceptance_criteria": ["Partners are scored 0-100", "Tier assignments match defined ranges"],
        "mockup_reference": null,
        "prior_artifacts": null
      }
    }
  ]
}"#;

/// Call the LLM to generate a rich system description with project-level overview
/// and per-component structured descriptions.
pub async fn plan_rich_description(
    request: &str,
    catalog_summary: &str,
    api_key: &str,
    model: &str,
) -> anyhow::Result<RichPlanOutput> {
    let system = format!(
        "{RICH_PLANNER_SYSTEM_PROMPT}\n\n## Agent Catalog\n\n{catalog_summary}"
    );

    let client = AnthropicClient::new(api_key.to_string(), model.to_string());
    let messages = vec![user_message(request.to_string())];

    info!(request = %request, "running rich description planner");

    let max_tokens_attempts = [8192u32, 16384];
    let mut last_error = String::new();

    for (attempt, &max_tokens) in max_tokens_attempts.iter().enumerate() {
        let response = client
            .messages(&system, &messages, &[], max_tokens, Some(model))
            .await
            .map_err(|e| anyhow::anyhow!("rich planner LLM call failed: {e}"))?;

        let text = response.text();
        if text.is_empty() {
            return Err(anyhow::anyhow!("rich planner returned empty response"));
        }

        let cleaned = text
            .trim()
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();

        match serde_json::from_str::<RichPlanOutput>(cleaned) {
            Ok(mut output) if !output.components.is_empty() => {
                sanitize_rich_depends_on(&mut output.components);
                info!(
                    component_count = output.components.len(),
                    title = %output.title,
                    "rich planner produced system description"
                );
                return Ok(output);
            }
            Ok(_) => {
                return Err(anyhow::anyhow!("rich planner returned empty component list"));
            }
            Err(e) => {
                last_error = format!("{e}");
                if attempt < max_tokens_attempts.len() - 1 {
                    warn!(
                        error = %e,
                        max_tokens,
                        "rich planner JSON parse failed, retrying with higher token limit"
                    );
                } else {
                    warn!(raw = %text, error = %e, "rich planner output parse failed after retries");
                }
            }
        }
    }

    Err(anyhow::anyhow!("rich planner output is not valid JSON: {last_error}"))
}

fn sanitize_rich_depends_on(nodes: &mut Vec<RichPlannedNode>) {
    for i in 0..nodes.len() {
        let original_len = nodes[i].depends_on.len();
        nodes[i].depends_on.retain(|&dep| dep < i);
        if nodes[i].depends_on.len() != original_len {
            warn!(
                node = i,
                agent = %nodes[i].agent_slug,
                "dropped invalid depends_on entries in rich plan"
            );
        }
    }
    let node_count = nodes.len();
    for node in nodes.iter_mut() {
        node.depends_on.retain(|&dep| dep < node_count);
    }
}

/// Convert rich planned nodes into ExecutionPlanNodes, preserving the description JSONB.
/// Returns (nodes, descriptions) where descriptions[i] is the JSONB for node i.
pub fn rich_plan_to_execution_nodes(
    plan: &[RichPlannedNode],
    session_id: uuid::Uuid,
    git_sha: &str,
    catalog: &crate::agent_catalog::AgentCatalog,
) -> anyhow::Result<Vec<crate::agent_catalog::ExecutionPlanNode>> {
    use crate::agent_catalog::{ExecutionPlanNode, NodeStatus};
    use uuid::Uuid;

    let uids: Vec<Uuid> = (0..plan.len()).map(|_| Uuid::new_v4()).collect();

    let mut nodes = Vec::new();
    for (i, planned) in plan.iter().enumerate() {
        let agent = catalog.get(&planned.agent_slug).ok_or_else(|| {
            anyhow::anyhow!(
                "rich planner referenced unknown agent slug: {}",
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
            tool_id: None,
        });
    }

    Ok(nodes)
}

/// After plan generation, check each component's required tools against available
/// credentials and create node_issues for gaps.
pub async fn identify_blockers(
    db: &crate::pg::PgClient,
    components: &[RichPlannedNode],
    node_uids: &[uuid::Uuid],
    session_id: uuid::Uuid,
    client_id: Option<uuid::Uuid>,
) {
    use crate::system_description;

    for (i, component) in components.iter().enumerate() {
        let node_id = node_uids[i];

        // Extract tool names from description.technical_spec.tools
        let tools: Vec<&str> = component.description
            .get("technical_spec")
            .and_then(|ts| ts.get("tools"))
            .and_then(|t| t.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect())
            .unwrap_or_default();

        if tools.is_empty() {
            continue;
        }

        // Check credentials for each tool
        if let Some(cid) = client_id {
            for tool_name in &tools {
                let rows = db.execute_with(
                    "SELECT id FROM client_credentials WHERE client_id = $1 AND LOWER(platform) = LOWER($2) AND deleted_at IS NULL LIMIT 1",
                    pg_args!(cid, tool_name.to_string()),
                ).await.unwrap_or_default();

                if rows.is_empty() {
                    let desc = format!("No {} credentials found for this client. Add them in Settings before executing.", tool_name);
                    let _ = system_description::create_issue(
                        db, node_id, session_id, "credential", &desc, "preflight",
                    ).await;
                    info!(node_id = %node_id, tool = tool_name, "auto-created credential blocker");
                }
            }
        } else {
            let tool_list = tools.join(", ");
            let desc = format!("No client associated with this session. Cannot verify credentials for: {}", tool_list);
            let _ = system_description::create_issue(
                db, node_id, session_id, "credential", &desc, "preflight",
            ).await;
        }

        // Check for LLM-identified blockers in the description
        if let Some(blockers) = component.description.get("blockers").and_then(|b| b.as_array()) {
            for blocker in blockers {
                let btype = blocker.get("type").and_then(|v| v.as_str()).unwrap_or("technical");
                let bdesc = blocker.get("description").and_then(|v| v.as_str()).unwrap_or("Unknown blocker");
                let issue_type = match btype {
                    "credential" => "credential",
                    "manual" => "manual",
                    "decision" => "decision",
                    "external" => "external",
                    _ => "technical",
                };
                let _ = system_description::create_issue(
                    db, node_id, session_id, issue_type, bdesc, "agent",
                ).await;
            }
        }
    }
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
