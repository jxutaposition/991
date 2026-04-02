# n8n MCP Tools Reference

## CRITICAL: nodeType Prefix Convention

Two different formats depending on the tool:

**Discovery/validation tools** (search_nodes, get_node, validate_node):
```
nodes-base.slack
nodes-base.httpRequest
nodes-base.webhook
nodes-langchain.agent
```

**Workflow mutation tools** (n8n_create_workflow, n8n_update_partial_workflow):
```
n8n-nodes-base.slack
n8n-nodes-base.httpRequest
n8n-nodes-base.webhook
@n8n/n8n-nodes-langchain.agent
```

**Conversion**: `search_nodes` returns both `nodeType` and `workflowNodeType` — use the right one per tool.

---

## Tool Reference

### search_nodes — START HERE

**Speed**: <20ms

```javascript
search_nodes({
  query: "slack",           // keywords
  mode: "OR",               // OR (default), AND, FUZZY (typo-tolerant)
  limit: 20,                // max results
  source: "all",            // all, core, community, verified
  includeExamples: false    // real template configs
})
```

Returns: `nodeType` (for get_node/validate), `workflowNodeType` (for workflow tools), displayName, category, relevance.

**Common searches**: webhook, http, database, email, slack, google, ai, schedule, code

---

### get_node — UNIFIED NODE INFO

| Detail Level | Tokens | Use When |
|-------------|--------|----------|
| `minimal` | ~200 | Quick metadata check |
| `standard` | ~1-2K | **Most use cases (DEFAULT)** |
| `full` | ~3-8K | Complex debugging only |

**Standard (recommended)**:
```javascript
get_node({nodeType: "nodes-base.slack", includeExamples: true})
```

**Search for specific field**:
```javascript
get_node({nodeType: "nodes-base.httpRequest", mode: "search_properties", propertyQuery: "auth"})
```

**Documentation mode**:
```javascript
get_node({nodeType: "nodes-base.slack", mode: "docs"})
```

**Other modes**: `versions` (version history), `compare` (diff between versions), `breaking` (breaking changes only), `migrations` (auto-migratable changes)

**Additional params**: `includeTypeInfo` (validation rules, ~80-120 tokens/property), `includeExamples` (template configs, ~200-400 tokens/example)

---

### validate_node — CHECK CONFIGURATION

```javascript
validate_node({
  nodeType: "nodes-base.slack",
  config: {resource: "message", operation: "post", channel: "#general", text: "Hi"},
  profile: "runtime"    // minimal, runtime (recommended), ai-friendly, strict
})
```

Returns: errors (must fix), warnings (should review), suggestions (optional)

---

### Workflow Management Tools

**Create**:
```javascript
n8n_create_workflow({name: "My Workflow", nodes: [...], connections: {...}})
```

**Update (most used!)**:
```javascript
n8n_update_partial_workflow({
  id: "workflow-id",
  operations: [{type: "updateNode", name: "Slack", parameters: {text: "Updated"}}]
})
```

**Validate workflow**:
```javascript
n8n_validate_workflow({id: "workflow-id"})
```

**Activate**:
```javascript
// Use activateWorkflow operation
```

**Clean stale connections**:
```javascript
n8n_update_partial_workflow({id: "...", operations: [{type: "cleanStaleConnections"}]})
```

**Auto-fix**:
```javascript
n8n_autofix_workflow({id: "...", preview: true})  // preview first, then apply
```

---

## Common Flows

### Discovery Flow
```
search_nodes({query: "slack"})
→ get_node({nodeType: "nodes-base.slack", includeExamples: true})
→ Optional: get_node({..., mode: "search_properties", propertyQuery: "auth"})
```
Average: 18s search → get_node

### Configuration Flow
```
Build minimal config → validate_node (profile: "runtime")
→ Fix errors → validate again → repeat 2-3 times
```
Average: 56s between edits, 23s thinking, 58s fixing

### Workflow Flow
```
n8n_create_workflow → n8n_validate_workflow
→ n8n_update_partial_workflow (iterate) → n8n_validate_workflow
→ Activate when ready
```

---

## Partial Update Tips

- **IF nodes**: Use `branch: "true"` or `branch: "false"` to target specific branch
- **Switch nodes**: Use `case: N` to target specific case
- **Intent**: Pass `intent` parameter for clearer behavior
- **Iterate**: Small updates + validate, not one-shot huge edits

---

## Templates

```javascript
search_templates({query: "keyword"})        // by keyword
search_templates({by_nodes: ["slack"]})      // by nodes used
search_templates({by_task: "send email"})    // by task
get_template({id: "template-id"})            // get details
n8n_deploy_template({id: "template-id"})     // deploy to workspace
```

2,700+ real workflow templates available.

---

## Tool Speed Reference

| Tool | Speed | Typical Size |
|------|-------|-------------|
| search_nodes | <20ms | Small |
| get_node (standard) | <10ms | 1-2K tokens |
| get_node (full) | <100ms | 3-8K tokens |
| validate_node | <100ms | Small |
| n8n_create_workflow | 100-500ms | Medium |
| n8n_update_partial_workflow | 50-200ms | Small (most used!) |
| validate_workflow | 100-500ms | Medium |
| n8n_deploy_template | 200-500ms | Medium |

---

## Common Pitfalls

1. **Wrong nodeType prefix** → "Node not found" error. Use short prefix for discovery, full prefix for workflow tools.
2. **Using `detail: "full"` by default** → Huge payload, wastes tokens. Start with "standard".
3. **Not using validation profiles** → Too many false positives with strict, too few catches with minimal. Use "runtime".
4. **Ignoring auto-sanitization** → Don't manually fix operator structures that auto-sanitization handles.
5. **One-shot huge edits** → Break into small iterative updates + validate after each.
6. **Not using smart parameters** → For IF/Switch, use branch/case targeting instead of complex sourceIndex calculations.
