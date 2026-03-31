# n8n MCP Tools Reference

## nodeType Prefix Convention
- **Discovery/validation tools** (search_nodes, get_node, validate_node): `nodes-base.slack`, `nodes-langchain.agent`
- **Workflow mutation tools** (n8n_create_workflow, n8n_update_partial_workflow): `n8n-nodes-base.slack`, `@n8n/n8n-nodes-langchain.agent`
- `search_nodes` returns both `nodeType` and `workflowNodeType` — use the right one per tool

## Common Flows
- **Discovery:** `search_nodes` → `get_node` (standard detail; optional `includeExamples`)
- **Configuration:** build config → `validate_node` (profile: "runtime")
- **Workflow:** create/update partial → validate → repeat; `activateWorkflow` when ready

## Partial Update Tips
- Use `branch: "true"|"false"` for IF nodes and `case: N` for Switch nodes
- Pass `intent` on `n8n_update_partial_workflow` for clearer behavior

## Templates
`search_templates` (keyword, by_nodes, by_task, by_metadata) → `get_template` → `n8n_deploy_template`

## Pitfalls
- Wrong nodeType prefix for the tool being called
- Defaulting to `detail: "full"` (wasteful)
- Omitting validation profile
- One-shot huge workflow edits instead of iterative updates
