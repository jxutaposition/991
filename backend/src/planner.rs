/// LLM planner — decomposes a customer NL request into a DAG of agent nodes.
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
- IMPORTANT: Use each agent_slug AT MOST ONCE in the plan. If the request requires multiple workflows, pipelines, or artifacts from the same tool, combine them into a single node with a compound task_description (e.g. "Build 3 workflows: (1) onboarding flow, (2) data sync, (3) tracking"). The agent handles sequencing internally. Duplicate slugs waste execution resources.
- IMPORTANT: Every agent in the plan must BUILD something or ACT on an external system. Do NOT include agents just for thinking, planning, or designing. Design/strategy reasoning happens in the master_orchestrator, not in subagents. The master_orchestrator enriches context for each builder agent — no separate "designer" step is needed.
- Keep task_description values concise (under 120 chars). Details come from upstream outputs at runtime.

## Examples

Request: "Build an expert scoring and tiering program with a leaderboard and document it"
Plan:
[
  {"agent_slug": "notion_operator", "task_description": "Create expert program wiki: tier structure, scoring rules, documentation", "depends_on": []},
  {"agent_slug": "n8n_operator", "task_description": "Build scoring pipeline from Clay/Tolt sources to Supabase", "depends_on": [0]},
  {"agent_slug": "clay_operator", "task_description": "Design Clay workbook: engagement tracking, expert registry, scoring, and webhook routing tables", "depends_on": [0]},
  {"agent_slug": "dashboard_builder", "task_description": "Build leaderboard dashboard with funnel, scores, and tier breakdown", "depends_on": [1, 2]}
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

Request: "Fix data not showing on our Lovable project and add a new page"
Plan:
[
  {"agent_slug": "lovable_operator", "task_description": "Diagnose missing data on Lovable dashboard, generate prompts for new page", "depends_on": []}
]

## dashboard_builder vs lovable_operator — When to Use Which
- **dashboard_builder** is the DEFAULT for any dashboard, analytics view, React dashboard, data visualization, leaderboard, funnel chart, or metrics display. It outputs a spec that the platform renders natively — no external service needed.
- **lovable_operator** is ONLY for tasks that explicitly reference an existing Lovable project (lovable.dev) — diagnosing issues, generating chat prompts for UI changes, or maintaining a Lovable-hosted app. Do NOT use lovable_operator to build new dashboards or React UIs.
- When the request says "dashboard", "React dashboard", "analytics", "leaderboard", "charts", or "data visualization" → use **dashboard_builder**.
- When the request says "Lovable project", "fix my Lovable app", "Lovable dashboard" (referring to an existing lovable.dev project) → use **lovable_operator**.
- NEVER use both together for the same dashboard. They are separate paths, not sequential steps.

## Ordering Guidelines
When building the DAG, follow this execution order strictly:
1. **Planning / documentation first**: notion_operator (project pages, wikis, databases, documentation).
2. **Automation / pipeline second**: n8n_operator (workflows, webhooks, data pipelines) — depends on Notion pages/config existing.
3. **Enrichment / data third**: clay_operator (Clay workspace — workbooks, tables, enrichments, formulas, inter-table routing, webhooks) — depends on pipeline design and data sources. clay_operator owns the ENTIRE Clay workspace. Scope its task to the full workbook (multiple tables with their connections), not a single table.
4. **UI / dashboard / app last**: dashboard_builder OR lovable_operator (not both) — these reference data from Clay tables and upstream pipelines. Use dashboard_builder for platform-rendered dashboards; use lovable_operator only for existing Lovable-hosted projects.

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
                deduplicate_nodes(&mut nodes);
                enforce_canonical_ordering(&mut nodes);
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

/// Trait to allow post-processing functions to work on both `PlannedNode` and `RichPlannedNode`.
trait HasDependsOn {
    fn agent_slug(&self) -> &str;
    fn task_description(&self) -> &str;
    fn depends_on(&self) -> &[usize];
    fn depends_on_mut(&mut self) -> &mut Vec<usize>;
    /// Append another node's task description (used when deduplicating).
    fn merge_from_task(&mut self, task: &str);
}

impl HasDependsOn for PlannedNode {
    fn agent_slug(&self) -> &str { &self.agent_slug }
    fn task_description(&self) -> &str { &self.task_description }
    fn depends_on(&self) -> &[usize] { &self.depends_on }
    fn depends_on_mut(&mut self) -> &mut Vec<usize> { &mut self.depends_on }
    fn merge_from_task(&mut self, task: &str) {
        self.task_description.push_str("; ");
        self.task_description.push_str(task);
    }
}

impl HasDependsOn for RichPlannedNode {
    fn agent_slug(&self) -> &str { &self.agent_slug }
    fn task_description(&self) -> &str { &self.task_description }
    fn depends_on(&self) -> &[usize] { &self.depends_on }
    fn depends_on_mut(&mut self) -> &mut Vec<usize> { &mut self.depends_on }
    fn merge_from_task(&mut self, task: &str) {
        self.task_description.push_str("; ");
        self.task_description.push_str(task);
        // Keep first occurrence's rich description — it captures the primary task
    }
}

fn sanitize_depends_on<T: HasDependsOn>(nodes: &mut Vec<T>) {
    // Retain only backward references (dep < i), which enforces topological ordering
    // and prevents both self-references and cycles.
    for i in 0..nodes.len() {
        let original_len = nodes[i].depends_on_mut().len();
        nodes[i].depends_on_mut().retain(|&dep| dep < i);
        if nodes[i].depends_on_mut().len() != original_len {
            warn!(
                node = i,
                agent = %nodes[i].agent_slug(),
                "dropped invalid depends_on entries (self/forward references)"
            );
        }
    }
}

/// Canonical execution phase for each agent slug.
/// Lower phase = earlier in execution order.
fn agent_phase(slug: &str) -> u8 {
    match slug {
        "notion_operator" => 0,          // planning / documentation first
        "n8n_operator" => 1,             // automation / pipelines second
        "clay_operator" => 2,            // enrichment / data third
        "dashboard_builder"
        | "lovable_operator" => 3,       // UI / dashboards last
        _ => 2,                          // unknown agents default to middle
    }
}

/// Deduplicate nodes that share the same agent_slug by merging their tasks and deps.
fn deduplicate_nodes<T: HasDependsOn>(nodes: &mut Vec<T>) {
    if nodes.len() <= 1 {
        return;
    }

    let n = nodes.len();
    let slugs: Vec<String> = nodes.iter().map(|nd| nd.agent_slug().to_string()).collect();

    // remap[i] = index of the canonical (first) node for slug i
    let mut first_for_slug: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    let mut remap: Vec<usize> = (0..n).collect();

    for (i, slug) in slugs.iter().enumerate() {
        match first_for_slug.entry(slug.clone()) {
            std::collections::hash_map::Entry::Occupied(e) => {
                remap[i] = *e.get();
            }
            std::collections::hash_map::Entry::Vacant(e) => {
                e.insert(i);
            }
        }
    }

    if remap.iter().enumerate().all(|(i, &r)| r == i) {
        return; // no duplicates
    }

    // Collect task descriptions and deps from duplicates before mutating
    let dup_info: Vec<(usize, String, Vec<usize>)> = (0..n)
        .filter(|&i| remap[i] != i)
        .map(|i| {
            (
                remap[i],
                nodes[i].task_description().to_string(),
                nodes[i].depends_on().to_vec(),
            )
        })
        .collect();

    // Merge tasks and deps into first occurrences
    for (first, task, deps) in &dup_info {
        nodes[*first].merge_from_task(task);
        for &dep in deps {
            let canonical_dep = remap[dep];
            if canonical_dep != *first {
                nodes[*first].depends_on_mut().push(canonical_dep);
            }
        }
    }

    // Determine which nodes to keep and build old→new index mapping
    let keep: Vec<bool> = (0..n).map(|i| remap[i] == i).collect();
    let mut old_to_new = vec![0usize; n];
    let mut new_idx = 0usize;
    for i in 0..n {
        if keep[i] {
            old_to_new[i] = new_idx;
            new_idx += 1;
        } else {
            old_to_new[i] = old_to_new[remap[i]];
        }
    }

    // Remap depends_on in all kept nodes, removing self-references
    for i in 0..n {
        if !keep[i] {
            continue;
        }
        let new_self = old_to_new[i];
        let new_deps: Vec<usize> = nodes[i]
            .depends_on()
            .iter()
            .filter_map(|&d| {
                if d >= n {
                    return None;
                }
                let mapped = old_to_new[remap[d]];
                if mapped == new_self { None } else { Some(mapped) }
            })
            .collect();
        *nodes[i].depends_on_mut() = new_deps;
        nodes[i].depends_on_mut().sort();
        nodes[i].depends_on_mut().dedup();
    }

    // Remove duplicate nodes
    let mut idx = 0;
    nodes.retain(|_| {
        let k = keep[idx];
        idx += 1;
        k
    });

    let removed = n - nodes.len();
    warn!(removed, "deduplicated agent nodes (merged duplicate slugs)");
}

/// Reorder nodes to match canonical phase ordering via topological sort.
/// Uses agent phase as a tiebreaker — dependency constraints always win.
fn enforce_canonical_ordering<T: HasDependsOn>(nodes: &mut Vec<T>) {
    if nodes.len() <= 1 {
        return;
    }

    let n = nodes.len();

    // Build adjacency for Kahn's algorithm
    let mut in_degree: Vec<usize> = vec![0; n];
    let mut dependents: Vec<Vec<usize>> = vec![Vec::new(); n];

    for (i, node) in nodes.iter().enumerate() {
        for &d in node.depends_on() {
            if d < n {
                in_degree[i] += 1;
                dependents[d].push(i);
            }
        }
    }

    // Topological sort with (phase, original_index) as priority
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;

    let mut heap: BinaryHeap<Reverse<(u8, usize)>> = BinaryHeap::new();
    for i in 0..n {
        if in_degree[i] == 0 {
            heap.push(Reverse((agent_phase(nodes[i].agent_slug()), i)));
        }
    }

    let mut order: Vec<usize> = Vec::with_capacity(n);
    while let Some(Reverse((_, idx))) = heap.pop() {
        order.push(idx);
        for &dep in &dependents[idx] {
            in_degree[dep] -= 1;
            if in_degree[dep] == 0 {
                heap.push(Reverse((agent_phase(nodes[dep].agent_slug()), dep)));
            }
        }
    }

    if order.len() != n {
        warn!("cycle detected in plan DAG, skipping canonical reorder");
        return;
    }

    // Check if already in canonical order
    if order.iter().enumerate().all(|(new, &old)| new == old) {
        return;
    }

    // Build old→new index mapping
    let mut old_to_new = vec![0usize; n];
    for (new_pos, &old_pos) in order.iter().enumerate() {
        old_to_new[old_pos] = new_pos;
    }

    // Remap depends_on before physical reorder
    for node in nodes.iter_mut() {
        let deps = node.depends_on_mut();
        for dep in deps.iter_mut() {
            if *dep < n {
                *dep = old_to_new[*dep];
            }
        }
        deps.sort();
    }

    // Physical reorder via permutation cycles
    let mut perm = old_to_new.clone();
    for i in 0..n {
        while perm[i] != i {
            let j = perm[i];
            nodes.swap(i, j);
            perm.swap(i, j);
        }
    }

    info!("reordered plan nodes to match canonical phase ordering");

    // Re-sanitize to drop any forward refs introduced by reorder
    sanitize_depends_on(nodes);
}

/// Shared implementation for converting planned nodes to execution nodes.
fn build_execution_nodes(
    slugs_tasks_deps: &[(&str, &str, &[usize])],
    session_id: uuid::Uuid,
    git_sha: &str,
    catalog: &crate::agent_catalog::AgentCatalog,
    session_model: Option<&str>,
) -> anyhow::Result<Vec<crate::agent_catalog::ExecutionPlanNode>> {
    use crate::agent_catalog::{ExecutionPlanNode, NodeStatus};
    use uuid::Uuid;

    let uids: Vec<Uuid> = (0..slugs_tasks_deps.len()).map(|_| Uuid::new_v4()).collect();

    let mut nodes = Vec::new();
    for (i, &(slug, task, deps)) in slugs_tasks_deps.iter().enumerate() {
        let agent = catalog.get(slug).ok_or_else(|| {
            anyhow::anyhow!("planner referenced unknown agent slug: {}", slug)
        })?;

        let requires: Vec<Uuid> = deps.iter()
            .filter(|&&dep| dep < uids.len())
            .map(|&dep| uids[dep])
            .collect();
        let status = if requires.is_empty() { NodeStatus::Pending } else { NodeStatus::Waiting };

        let execution_mode = match agent.automation_mode.as_deref() {
            Some("guided") => "manual".to_string(),
            _ => "agent".to_string(),
        };

        nodes.push(ExecutionPlanNode {
            uid: uids[i],
            session_id,
            agent_slug: agent.slug.clone(),
            agent_git_sha: git_sha.to_string(),
            task_description: task.to_string(),
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
            model: agent.model.clone()
                .or_else(|| session_model.map(|m| m.to_string()))
                .unwrap_or_else(|| "claude-haiku-4-5-20251001".to_string()),
            skip_judge: agent.skip_judge,
            variant_group: None,
            variant_label: None,
            variant_selected: None,
            client_id: None,
            tool_id: None,
            execution_mode,
            integration_overrides: serde_json::json!({}),
        });
    }

    Ok(nodes)
}

/// Convert a list of PlannedNodes into ExecutionPlanNodes with stable UUIDs.
pub fn plan_to_execution_nodes(
    plan: &[PlannedNode],
    session_id: uuid::Uuid,
    git_sha: &str,
    catalog: &crate::agent_catalog::AgentCatalog,
    session_model: Option<&str>,
) -> anyhow::Result<Vec<crate::agent_catalog::ExecutionPlanNode>> {
    let items: Vec<(&str, &str, &[usize])> = plan.iter()
        .map(|p| (p.agent_slug.as_str(), p.task_description.as_str(), p.depends_on.as_slice()))
        .collect();
    build_execution_nodes(&items, session_id, git_sha, catalog, session_model)
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
- IMPORTANT: Use each agent_slug AT MOST ONCE. If the request requires multiple workflows, pipelines, or artifacts from the same tool, combine them into a single component with a compound task_description. The agent handles sequencing internally. Duplicate slugs waste execution resources.
- Every component must BUILD something or ACT on an external system. No planning-only components.
- CRITICAL CONCISENESS: Your total JSON output must stay under 4000 tokens. Keep ALL string values short and declarative. Do NOT generate sample data, mock rows, example records, initial_rows, placeholder content, or any kind of filler. Schemas should be empty objects `{}` unless a specific format is essential. Summaries should be 2-3 sentences max. Acceptance criteria should be one-liners.

## Ordering Guidelines
When building the component list, follow this execution order strictly:
1. **Planning / documentation first**: notion_operator (project pages, wikis, databases, documentation).
2. **Automation / pipeline second**: n8n_operator (workflows, webhooks, data pipelines) — depends on Notion pages/config existing.
3. **Enrichment / data third**: clay_operator (Clay workspace — workbooks, tables, enrichments, formulas, inter-table routing, webhooks) — depends on pipeline design and data sources. clay_operator owns the ENTIRE Clay workspace. Scope its task to the full workbook (multiple tables with their connections), not a single table.
4. **UI / dashboard / app last**: dashboard_builder OR lovable_operator (not both) — these reference data from Clay tables and upstream pipelines. Use dashboard_builder for platform-rendered dashboards; use lovable_operator only for existing Lovable-hosted projects.

Infer depends_on automatically: if component B reads from or references a system that component A creates (e.g. a dashboard that embeds a Notion page, or a pipeline that reads from a Clay table), component B MUST depend on component A. When unsure, add the dependency — false dependencies only slow execution, missing dependencies cause failures.

## dashboard_builder vs lovable_operator — When to Use Which
- **dashboard_builder** is the DEFAULT for any dashboard, analytics view, React dashboard, data visualization, leaderboard, funnel chart, or metrics display. It outputs a dashboard_spec JSON that the platform renders natively — no external service needed.
- **lovable_operator** is ONLY for tasks that explicitly reference an existing Lovable project (lovable.dev) — diagnosing issues, generating chat prompts for UI changes, or maintaining a Lovable-hosted app. Do NOT use lovable_operator to build new dashboards or React UIs.
- When the request says "dashboard", "React dashboard", "analytics", "leaderboard", "charts", or "data visualization" → use **dashboard_builder**.
- When the request says "Lovable project", "fix my Lovable app", "Lovable dashboard" (referring to an existing lovable.dev project) → use **lovable_operator**.
- NEVER use both together for the same dashboard. They are separate paths, not sequential steps.

## Agent-Specific Guidance

### clay_operator — Workbook-Level Scope
clay_operator owns the client's ENTIRE Clay workspace. Its description must reflect the full workbook topology, not a single table. In `technical_spec.configuration`, list ALL tables in the workbook with their roles and inter-table connections:

```json
{
  "configuration": {
    "workbook_name": "Expert Engagement Pipeline",
    "tables": [
      { "name": "Mentions Catcher", "role": "signal_capture", "feeds_into": ["Action Table"] },
      { "name": "Action Table", "role": "routing", "feeds_into": ["Post Reactors", "Post Comments"], "webhooks_to": ["n8n scoring"] },
      { "name": "Post Reactors", "role": "detail" },
      { "name": "Post Comments", "role": "detail" },
      { "name": "Experts", "role": "registry", "key_columns": ["Name", "Email", "LinkedIn URL", "Tier", "Total Points"] },
      { "name": "Tolt Experts", "role": "revenue_scoring", "feeds_into": ["Experts"] }
    ],
    "webhook_target": "n8n scoring workflow URL (to be provided by n8n_operator)"
  }
}
```

In `io_contract`, list the workbook-level inputs and outputs (not per-table). In `acceptance_criteria`, include criteria for the full pipeline (e.g., "data flows end-to-end from signal capture to webhook output"), not just one table.

## Description Structure
Each component's "description" field is a structured object:
- display_name: human-friendly name for the component
- architecture: { purpose, connections (list of tool/platform names), data_flow (narrative) }
- technical_spec: { approach (how it will be built), tools (platform names), configuration (any known config) }
- io_contract: { inputs: [{ name, source, schema }], outputs: [{ name, schema }] }
- optionality: [{ decision, tradeoffs, recommendation }] — where multiple paths exist
- blockers: [{ type ("credential"|"manual"|"decision"|"external"), description, severity ("blocking"|"warning") }] — missing credentials, manual setup steps, decisions needing human input, external dependencies
- agent_actions: [string] — what the agent will do autonomously if it executes this component (e.g. "Create n8n workflow with scoring logic", "Configure webhook trigger"). Always populate this.
- user_actions: [string] — what the user would need to do if they execute this manually (e.g. "Build Clay table in the UI", "Copy prompt into Lovable chat"). For automation_mode=guided agents this is the primary work; for full agents this describes the manual alternative.
- validation_hints: [{ type ("http_probe"|"format_check"|"api_query"|"existence_check"), description }] — how to verify completion. Used by both the judge (for agent execution) and the manual-completion validator (for user execution). E.g. { type: "http_probe", description: "GET webhook URL returns 200" }.
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
        "agent_actions": ["Create n8n workflow with webhook trigger", "Add scoring logic nodes", "Configure Supabase upsert output", "Test and activate workflow"],
        "user_actions": ["Build workflow manually in n8n editor", "Add HTTP/webhook nodes and scoring logic", "Connect Supabase output"],
        "validation_hints": [{ "type": "http_probe", "description": "GET workflow webhook URL returns 200" }, { "type": "api_query", "description": "Query Supabase scored_partners table returns rows" }],
        "acceptance_criteria": ["Partners are scored 0-100", "Tier assignments match defined ranges"],
        "mockup_reference": null,
        "prior_artifacts": null
      }
    }
  ]
}"#;

/// Gather relevant context from the knowledge corpus for the planner.
/// Does a simple vector search — no reranking, just top results.
pub async fn gather_planner_context(
    db: &crate::pg::PgClient,
    request: &str,
    client_id: Option<uuid::Uuid>,
    project_id: Option<uuid::Uuid>,
    openai_api_key: Option<&str>,
) -> String {
    tracing::debug!(client_id = ?client_id, project_id = ?project_id, "gathering planner context");
    let mut context_parts: Vec<String> = Vec::new();

    // 1. Client context
    if let Some(cid) = client_id {
        if let Ok(ctx) = crate::client::build_client_context(db, cid, None).await {
            if !ctx.is_empty() {
                context_parts.push(format!("## Client Context\n{ctx}"));
            }
        }
    }

    // 2. Knowledge corpus search (if OpenAI key available for embeddings)
    if let (Some(api_key), Some(tenant_id)) = (openai_api_key, client_id) {
        if let Ok(embedding) = crate::embeddings::embed_text(api_key, request).await {
            let embedding_str = format!(
                "[{}]",
                embedding.iter().map(|f| f.to_string()).collect::<Vec<_>>().join(",")
            );
            let project_clause = project_id
                .map(|p| format!("AND (c.project_id IS NULL OR c.project_id = '{p}')"))
                .unwrap_or_default();

            let sql = format!(
                "SELECT c.id, c.content, c.section_title, d.source_filename, \
                        1 - (c.embedding <=> '{embedding_str}'::vector) AS similarity \
                 FROM knowledge_chunks c \
                 JOIN knowledge_documents d ON c.document_id = d.id \
                 WHERE c.tenant_id = '{tenant_id}' \
                   AND d.status = 'ready' \
                   {project_clause} \
                   AND 1 - (c.embedding <=> '{embedding_str}'::vector) > 0.3 \
                 ORDER BY c.embedding <=> '{embedding_str}'::vector \
                 LIMIT 8"
            );

            if let Ok(rows) = db.execute(&sql).await {
                if !rows.is_empty() {
                    let mut knowledge_text = String::from("## Relevant Knowledge Base Results\n");
                    knowledge_text.push_str("Prior work, decisions, and reference material found in the knowledge base:\n\n");

                    // Fire-and-forget: log chunk retrievals for observatory
                    let db_log = db.clone();
                    let log_rows: Vec<(String, f64)> = rows.iter().filter_map(|r| {
                        let id = r.get("id").and_then(serde_json::Value::as_str)?.to_string();
                        let sim = r.get("similarity").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
                        Some((id, sim))
                    }).collect();
                    let log_query = request.to_string();
                    tokio::spawn(async move {
                        for (chunk_id, sim) in log_rows {
                            if let Ok(rid) = chunk_id.parse::<uuid::Uuid>() {
                                let _ = db_log.execute_with(
                                    "INSERT INTO knowledge_access_log (access_type, resource_id, query_text, similarity_score) \
                                     VALUES ('chunk_retrieval', $1, $2, $3)",
                                    crate::pg_args!(rid, log_query.clone(), sim as f32),
                                ).await;
                            }
                        }
                    });

                    for row in &rows {
                        let filename = row.get("source_filename").and_then(serde_json::Value::as_str).unwrap_or("unknown");
                        let section = row.get("section_title").and_then(serde_json::Value::as_str).unwrap_or("");
                        let content = row.get("content").and_then(serde_json::Value::as_str).unwrap_or("");
                        let preview: String = content.chars().take(500).collect();
                        if !section.is_empty() {
                            knowledge_text.push_str(&format!("### {filename} — {section}\n{preview}\n\n"));
                        } else {
                            knowledge_text.push_str(&format!("### {filename}\n{preview}\n\n"));
                        }
                    }
                    context_parts.push(knowledge_text);
                }
            }
        }
    }

    // 3. Existing project description (if project already has one)
    if let Some(pid) = project_id {
        if let Ok(Some(desc)) = crate::system_description::get_for_project(db, pid).await {
            let title = desc.get("title").and_then(serde_json::Value::as_str).unwrap_or("");
            let summary = desc.get("summary").and_then(serde_json::Value::as_str).unwrap_or("");
            if !title.is_empty() || !summary.is_empty() {
                context_parts.push(format!(
                    "## Existing Project Description\nThis project already has an architecture document:\n**{title}**\n{summary}"
                ));
            }
        }
    }

    tracing::debug!(sections = context_parts.len(), total_chars = context_parts.iter().map(|s| s.len()).sum::<usize>(), "planner context gathered");
    context_parts.join("\n\n")
}

/// Call the LLM to generate a rich system description with project-level overview
/// and per-component structured descriptions.
/// Accepts pre-gathered context (from gather_planner_context) to avoid double-fetching.
pub async fn plan_rich_description(
    request: &str,
    catalog_summary: &str,
    api_key: &str,
    model: &str,
    gathered_context: &str,
) -> anyhow::Result<RichPlanOutput> {
    let system = if gathered_context.is_empty() {
        format!("{RICH_PLANNER_SYSTEM_PROMPT}\n\n## Agent Catalog\n\n{catalog_summary}")
    } else {
        format!(
            "{RICH_PLANNER_SYSTEM_PROMPT}\n\n{gathered_context}\n\n## Agent Catalog\n\n{catalog_summary}"
        )
    };

    let client = AnthropicClient::new(api_key.to_string(), model.to_string());
    let messages = vec![user_message(request.to_string())];

    info!(request = %request, "running rich description planner");

    let max_tokens_attempts = [16384u32, 32768, 65536];
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

        // Strip trailing non-JSON text (LLM sometimes appends explanation after the closing brace)
        let cleaned = if let Some(last_brace) = cleaned.rfind('}') {
            &cleaned[..=last_brace]
        } else {
            cleaned
        };

        match serde_json::from_str::<RichPlanOutput>(cleaned) {
            Ok(mut output) if !output.components.is_empty() => {
                sanitize_depends_on(&mut output.components);
                deduplicate_nodes(&mut output.components);
                enforce_canonical_ordering(&mut output.components);
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

// sanitize_rich_depends_on removed — uses the generic sanitize_depends_on<T> above.

/// Convert rich planned nodes into ExecutionPlanNodes, preserving the description JSONB.
/// Returns (nodes, descriptions) where descriptions[i] is the JSONB for node i.
pub fn rich_plan_to_execution_nodes(
    plan: &[RichPlannedNode],
    session_id: uuid::Uuid,
    git_sha: &str,
    catalog: &crate::agent_catalog::AgentCatalog,
    session_model: Option<&str>,
) -> anyhow::Result<Vec<crate::agent_catalog::ExecutionPlanNode>> {
    let items: Vec<(&str, &str, &[usize])> = plan.iter()
        .map(|p| (p.agent_slug.as_str(), p.task_description.as_str(), p.depends_on.as_slice()))
        .collect();
    build_execution_nodes(&items, session_id, git_sha, catalog, session_model)
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
            "execution_mode": n.execution_mode,
            "integration_overrides": n.integration_overrides,
        }))
        .collect::<Vec<_>>())
}
