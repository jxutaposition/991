# SD-008: Resource Discovery, Attachment, and Flexible Node Management

> **Status: Design** — no code implemented yet.
> **Related:** SD-001 (agent config), SD-002 (integrations/credentials), SD-004 (tool ontology), SD-005 (plan document architecture)

---

## Summary

The existing system already works as a living, connected ecosystem. Agents are stateless, hooked up to real external systems (Clay, n8n, Supabase, etc.) via credentials. You can plan a project from a prompt, build it, then troubleshoot live because agents have full access to the real infrastructure. The architecture document and canvas reflect what was built.

**What's missing is flexibility:**

1. **No way to start from "here's what I already have."** The only entry point is "describe what you want to build." There's no path for "I already have 10 dashboards, 3 workflows, and a Clay pipeline — set up agents to manage them."
2. **No auto-discovery of external resources.** Users can't see what Clay tables, n8n workflows, or Supabase databases exist in their connected integrations.
3. **No structured resource attachment on nodes.** A `clay_operator` node knows it has Clay credentials, but doesn't know _which_ Clay tables it's responsible for until the agent explores at runtime. There's no way to say "this node manages table X, Y, Z."
4. **Limited ability to add/modify nodes after initial planning.** If you later need a new dashboard agent or want to attach a new resource to an existing node, there's no smooth path without re-running the full planner.

This document addresses these gaps with minimal changes to the existing architecture:
- A new `project_resources` table for discovered/linked external artifacts
- Auto-discovery per integration
- Resource references on node descriptions
- Better node CRUD on the canvas
- Planner context enhancement so it knows what already exists

**What this is NOT:** a new persistence layer, a dual-mode canvas, or a rearchitecture of how agents work. Agents remain stateless. Execution nodes remain per-session. The project description remains the living document. We're adding resource awareness and flexibility to the existing system.

---

## Part 1: What Already Works

Before describing what's new, here's what already exists and stays unchanged:

```
┌─────────────────────────────────────────────────────────────┐
│  User prompt  ──▶  Planner  ──▶  Execution nodes (per session)
│                                     │
│                              ┌──────┴──────────────┐
│                              │  agent_runner        │
│                              │  - catalog definition│
│                              │  - system prompt     │
│                              │  - credentials       │
│                              │  - project context   │
│                              │  - upstream outputs   │
│                              └──────┬──────────────┘
│                                     │
│                              External systems (live)
│                              Clay, n8n, Supabase, ...
└─────────────────────────────────────────────────────────────┘
```

- **Agent definitions** (SD-001): global catalog, version-controlled, hot-reloadable.
- **Credentials** (SD-002): per-client and per-project, encrypted, injected at runtime.
- **Execution nodes**: per-session, with rich `description` JSONB (SD-005), editable in the inspector during `awaiting_approval`.
- **Project descriptions**: living architecture document with `architecture`, `data_flows`, `integration_map`, versioned.
- **Canvas**: renders the node DAG, shows status, integrations, credential probes.
- **Inspector**: edit task description, execution mode, model, integration overrides.

All of this stays. The gaps are at the edges: knowing _what_ resources exist, attaching them to nodes, and adding/modifying nodes flexibly.

---

## Part 2: Data Model — `project_resources`

One new table. Stores what exists in the outside world. Distinct from credentials (which store API keys). A credential lets you _access_ Clay; a resource _is_ a specific Clay table.

```sql
CREATE TABLE IF NOT EXISTS project_resources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    integration_slug TEXT NOT NULL,       -- 'clay', 'n8n', 'supabase', 'lovable', 'notion'
    resource_type TEXT NOT NULL,          -- 'table', 'workflow', 'project', 'database', 'page'
    external_id TEXT NOT NULL,            -- ID in the external system
    external_url TEXT,                    -- deep link to the resource
    display_name TEXT NOT NULL,           -- human-readable name
    discovered_metadata JSONB DEFAULT '{}',  -- schema, fields, config from discovery
    last_synced_at TIMESTAMPTZ,          -- when metadata was last refreshed
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(project_id, integration_slug, external_id)
);

CREATE INDEX IF NOT EXISTS project_resources_project_idx
    ON project_resources(project_id);
CREATE INDEX IF NOT EXISTS project_resources_integration_idx
    ON project_resources(project_id, integration_slug);
```

**`discovered_metadata` examples:**

```json
// Clay table
{
  "columns": [
    {"name": "company_name", "type": "text"},
    {"name": "score", "type": "number"},
    {"name": "tier", "type": "text"}
  ],
  "row_count": 2340,
  "workspace_id": "ws_abc123"
}

// n8n workflow
{
  "active": true,
  "node_count": 12,
  "trigger_type": "webhook",
  "trigger_url": "https://n8n.example.com/webhook/abc",
  "nodes": ["Webhook", "HTTP Request", "IF", "Supabase"]
}

// Supabase
{
  "tables": ["partners", "scores", "tiers"],
  "rls_enabled": true,
  "region": "us-east-1"
}
```

### Resource references on nodes

No new join table needed. The existing `execution_nodes.description` JSONB already has `prior_artifacts`. We extend the node description schema with a new `assigned_resources` field:

```json
{
  "display_name": "Scoring Pipeline",
  "architecture": { "purpose": "...", "connections": [...] },
  "assigned_resources": [
    { "resource_id": "uuid-here", "role": "owner" },
    { "resource_id": "uuid-here", "role": "reader" }
  ],
  "prior_artifacts": [...]
}
```

When the `agent_runner` builds context, it looks up `assigned_resources` IDs from `project_resources` and injects the full metadata into the agent's system prompt. This keeps the linkage lightweight — it's just UUIDs in the existing JSONB, resolved at runtime.

### Relationship to existing tables

| Existing table | Change |
|---|---|
| `execution_nodes` | None — resource refs go in the existing `description` JSONB |
| `project_descriptions` | `integration_map` can be auto-populated from `project_resources` |
| `client_credentials` / `project_credentials` | Unchanged — credentials give access, resources are what you access |
| `project_tool_defaults` (SD-004) | Remains unused; not relevant here |

---

## Part 3: Auto-Discovery

### 3.1 Concept

Once credentials are connected (SD-002), the system can call each integration's API to list what resources exist. This replaces the current pattern of users describing resources in natural language or agents discovering them by trial and error at runtime.

### 3.2 Discovery endpoint

```
GET /api/integrations/:slug/discover?client_slug=X&project_id=Y
```

Returns:

```json
{
  "integration": "clay",
  "resources": [
    {
      "external_id": "tbl_abc123",
      "resource_type": "table",
      "display_name": "Partner Enrichment",
      "external_url": "https://app.clay.com/tables/tbl_abc123",
      "metadata": { "columns": [...], "row_count": 2340 }
    }
  ]
}
```

### 3.3 Per-integration discovery

| Integration | API | Auth | What we discover |
|---|---|---|---|
| **Clay** | `GET https://api.clay.com/v1/tables` | API key | Tables: ID, name, column schema, row count |
| **n8n** | `GET {base_url}/api/v1/workflows` | API key | Workflows: ID, name, active status, node types, trigger |
| **Supabase** | Management API + PostgREST introspection | Service key | Tables, columns, RLS status |
| **Notion** | `POST https://api.notion.com/v1/search` | Integration token | Pages, databases: ID, title, parent |
| **Lovable** | No list API | N/A | Manual entry via URL parsing (`lovable.dev/projects/:id`) |

### 3.4 Implementation

New Rust module: `backend/src/discovery.rs`

```rust
pub struct DiscoveredResource {
    pub external_id: String,
    pub resource_type: String,
    pub display_name: String,
    pub external_url: Option<String>,
    pub metadata: Value,
}

pub async fn discover_resources(
    integration_slug: &str,
    credentials: &CredentialMap,
) -> anyhow::Result<Vec<DiscoveredResource>> {
    match integration_slug {
        "clay" => discover_clay(credentials).await,
        "n8n" => discover_n8n(credentials).await,
        "supabase" => discover_supabase(credentials).await,
        "notion" => discover_notion(credentials).await,
        _ => Ok(vec![]),
    }
}
```

Discovery is **read-only** — it never modifies external systems. Results are returned to the frontend for the user to select which resources to link to the project.

### 3.5 Re-sync

`POST /api/projects/:project_id/resources/:resource_id/sync` — re-fetches `discovered_metadata` for a linked resource. Updates `last_synced_at`. Keeps the system in sync with reality (no drift).

---

## Part 4: Planner Context Enhancement

### 4.1 The problem

Today the planner knows: the user's request, the agent catalog, client context, knowledge corpus results, and any existing project description. It does NOT know what specific external resources exist. So it always plans as if building from scratch.

### 4.2 The fix

Extend `gather_planner_context()` in `backend/src/planner.rs` with one new section:

```rust
// 4. Linked project resources (existing infrastructure)
if let Some(pid) = project_id {
    let resources = db.execute_with(
        "SELECT integration_slug, resource_type, display_name, external_id, \
                external_url, discovered_metadata \
         FROM project_resources WHERE project_id = $1 ORDER BY integration_slug",
        pg_args!(pid),
    ).await.unwrap_or_default();

    if !resources.is_empty() {
        let mut section = String::from(
            "## Existing Infrastructure\n\
             This project has the following existing resources. \
             Agents should use these directly rather than creating new ones.\n\n"
        );
        // Group by integration_slug, format each resource with metadata
        context_parts.push(section);
    }
}
```

When the existing nodes in a session reference resources, the planner also sees what's already covered and what isn't. This works for both:
- **New projects:** "I have these Clay tables and n8n workflows" → planner generates nodes referencing them
- **Incremental changes:** "Add a dashboard for this new Lovable app" → planner adds a node without duplicating existing ones

### 4.3 Rich planner system prompt update

Add guidance to `RICH_PLANNER_SYSTEM_PROMPT`:

```
When existing infrastructure is listed, generate components that reference those resources.
Set assigned_resources on each component to include the relevant resource external_ids.
Do NOT create new infrastructure when an existing resource serves the same purpose.
When the user asks to "add" something, generate only the new component(s) — 
do not regenerate the entire plan.
```

---

## Part 5: Node Management UI — Current State and Required Changes

### 5.1 Current state audit

The backend has node CRUD endpoints. The frontend barely uses them. Here is the exact gap:

| Action | Backend endpoint | Status | Frontend UI | Status |
|---|---|---|---|---|
| Add node | `POST /api/execute/:sid/nodes` | **Exists** — accepts `agent_slug`, `task_description`, `requires` | None | **Missing** |
| Delete node | `DELETE /api/execute/:sid/nodes/:nid` | **Exists** — only `pending/waiting/ready` statuses | None | **Missing** |
| Edit node fields | `PATCH /api/execute/:sid/nodes/:nid` | **Exists** — 9 patchable fields | Inspector panel | **Exists** (during `awaiting_approval`) |
| Edit dependencies | (not in `UpdateNodeRequest`) | **Missing** | Read-only "Depends on: N node(s)" | **Missing** |
| Edit node description | `PATCH .../nodes/:nid/description` | **Exists** — replaces full JSONB | Document view sections | **Partial** |
| Assign resources | N/A | **Missing** (new feature) | None | **Missing** |
| Chat to modify plan | `POST /api/execute/:sid/chat` | **Exists** — routes to orchestrator during `awaiting_approval` | Chat tab in inspector | **Exists** |

### 5.2 Backend fixes needed

**A. Add `requires` to `UpdateNodeRequest`**

Currently `UpdateNodeRequest` in `routes.rs` has no `requires` field, so dependencies are frozen at creation time. Fix:

```rust
pub struct UpdateNodeRequest {
    // ... existing fields ...
    pub requires: Option<Vec<String>>,  // NEW — dependency UUIDs
}
```

Update handler: when `requires` is provided, validate all UUIDs exist in the session, update the column, and recalculate `status` (`pending` if empty deps, `waiting` otherwise). Emit SSE `node_updated` with new `requires`.

**B. Allow `DELETE` for `preview` status**

During `awaiting_approval`, nodes are in `preview` status. The current DELETE guard only allows `pending/waiting/ready`. Fix:

```sql
-- Change from:
DELETE FROM execution_nodes WHERE id = $1 AND session_id = $2
    AND status IN ('pending', 'waiting', 'ready')
-- To:
DELETE FROM execution_nodes WHERE id = $1 AND session_id = $2
    AND status IN ('pending', 'waiting', 'ready', 'preview')
```

**C. Extend `AddNodeRequest`**

Currently accepts only `agent_slug`, `task_description`, `requires`, `tier_override`, `breakpoint`. Add:

```rust
pub struct AddNodeRequest {
    // ... existing fields ...
    pub execution_mode: Option<String>,       // NEW
    pub model: Option<String>,                // NEW
    pub max_iterations: Option<u32>,          // NEW
    pub description: Option<Value>,           // NEW — rich description JSONB
}
```

This lets the frontend create fully-configured nodes, not just bare stubs.

### 5.3 Canvas: Add Node

**Location:** A `[+ Add Node]` button in the canvas toolbar area, visible only when `sessionStatus === "awaiting_approval"`.

**Interaction flow:**

```
User clicks [+ Add Node]
    │
    ▼
Popover / slide-out panel opens:
┌────────────────────────────────────┐
│  Add Node                          │
│                                    │
│  Agent type:  [clay_operator  ▼]   │  ← dropdown from catalog
│                                    │
│  Display name: [Lead Enrichment ]  │  ← optional, defaults to agent name
│                                    │
│  Task: [Manage and maintain the ]  │  ← textarea
│        [lead enrichment tables  ]  │
│                                    │
│  Execution:  (●) Agent  ( ) Manual │  ← radio
│                                    │
│  Depends on: [☑ n8n_operator    ]  │  ← checkboxes of existing nodes
│              [☐ notion_operator ]  │
│                                    │
│  Resources:  [Partner Enrichment]  │  ← from project_resources
│              [Lead Scoring      ]  │     (if project has linked resources)
│              [+ Link Resource   ]  │
│                                    │
│  [Cancel]              [Add Node]  │
└────────────────────────────────────┘
```

**Backend call:** `POST /api/execute/:session_id/nodes` with the enhanced `AddNodeRequest`. After creation, a second call to `PATCH .../nodes/:nid/description` sets `assigned_resources` and `display_name`.

**SSE:** The existing `node_added` event updates the canvas in real-time (already handled in `page.tsx`).

### 5.4 Canvas: Delete Node

**Location:** On each `NodeBox` during `awaiting_approval`, a small `X` or trash icon in the top-right corner.

**Interaction:**
1. Click the delete icon → confirmation tooltip ("Remove this node from the plan?")
2. On confirm → `DELETE /api/execute/:session_id/nodes/:node_id`
3. Canvas updates via SSE `node_removed` (already handled in `page.tsx`)

**Guard:** Only show the delete icon for nodes in `preview/pending/waiting/ready` status.

### 5.5 Canvas: Dependency Editing

**Location:** In the inspector panel, replace the read-only "Depends on: N node(s)" with an editable control.

**Interaction:**

```
┌─ Inspector ──────────────────────┐
│                                  │
│  Depends on:                     │
│  ┌──────────────────────────┐    │
│  │ ☑ notion_operator        │    │  ← checkbox list of all
│  │ ☑ n8n_operator           │    │     other nodes in the session
│  │ ☐ clay_operator          │    │
│  │ ☐ dashboard_builder      │    │
│  └──────────────────────────┘    │
│  [Save Dependencies]             │
│                                  │
└──────────────────────────────────┘
```

**Backend call:** `PATCH /api/execute/:session_id/nodes/:node_id` with `{ "requires": ["uuid-1", "uuid-2"] }` (using the new `requires` field in `UpdateNodeRequest`).

**Validation:** The backend rejects cycles (a node cannot depend on itself or on a node that depends on it). The frontend should filter out the current node and ideally gray out nodes that would create a cycle.

### 5.6 Canvas: Resource Chips on Nodes

**On `NodeBox`** (in `execution-canvas.tsx`), below the existing integration/credential chips, show assigned resource badges:

```
┌──────────────────────────────┐
│  clay_operator               │
│  Manage enrichment tables    │
│                              │
│  🔗 Clay  ✓ connected       │  ← existing integration chip
│  📋 Partner Enrichment       │  ← NEW resource chip
│  📋 Lead Scoring             │  ← NEW resource chip
│                              │
│  Status: preview             │
└──────────────────────────────┘
```

Resources are read from `node.description.assigned_resources`, resolved against the session's project resources (loaded once on session fetch).

### 5.7 Inspector: Resource Assignment

**Location:** New "Assigned Resources" section in `inspector-panel.tsx`, below the existing config rows, visible when `isEditable`.

**Interaction:**

```
┌─ Inspector ──────────────────────┐
│  ...existing fields...           │
│                                  │
│  Assigned Resources              │
│  ┌──────────────────────────┐    │
│  │ 📋 Partner Enrichment  ✕ │    │  ← click ✕ to unassign
│  │    Clay table · 2340 rows│    │
│  │ 📋 Lead Scoring        ✕ │    │
│  │    Clay table · 890 rows │    │
│  └──────────────────────────┘    │
│                                  │
│  [+ Assign Resource]             │
│                                  │
│  Clicking opens:                 │
│  ┌──────────────────────────┐    │
│  │ Clay                     │    │
│  │  ☐ Prospect Pipeline     │    │  ← unlinked resources
│  │ n8n                      │    │     from project_resources
│  │  ☐ Scoring Workflow      │    │
│  │  ☐ Onboarding Flow      │    │
│  └──────────────────────────┘    │
│  [Assign Selected]               │
│                                  │
└──────────────────────────────────┘
```

**Backend call:** Updates `description.assigned_resources` via `PATCH .../nodes/:nid/description`. The frontend merges the new assignments into the existing description JSONB.

### 5.8 Resource Discovery Panel

**Location:** Accessible from the session page (e.g., a "Discover Resources" button in the toolbar or a panel tab), visible when the project has connected integrations.

**Interaction flow:**

```
User clicks [Discover Resources]
    │
    ▼
┌────────────────────────────────────────┐
│  Discover Resources                    │
│                                        │
│  Clay (connected ✓)    [Discover]      │
│  ┌──────────────────────────────────┐  │
│  │ ☐ Partner Enrichment  (2340 rows)│  │  ← results from
│  │ ☐ Lead Scoring        (890 rows) │  │     GET /api/integrations/clay/discover
│  │ ☑ Prospect Pipeline   (450 rows) │  │
│  └──────────────────────────────────┘  │
│                                        │
│  n8n (connected ✓)     [Discover]      │
│  ┌──────────────────────────────────┐  │
│  │ ☑ Scoring Workflow    (active)   │  │
│  │ ☐ Onboarding Flow    (active)   │  │
│  └──────────────────────────────────┘  │
│                                        │
│  Lovable (no API)                      │
│  [+ Add manually]  URL: [________]    │
│                                        │
│  Already linked: 3 resources           │
│  [Link Selected (2)]                   │
└────────────────────────────────────────┘
```

**Backend calls:**
- `GET /api/integrations/:slug/discover?client_slug=X&project_id=Y` per integration
- `POST /api/projects/:id/resources` for each selected resource to link

**Already-linked resources** (from `GET /api/projects/:id/resources`) are shown as checked/disabled in the discovery results.

### 5.9 Chat-based plan modification

This already works today. During `awaiting_approval`, the chat tab routes messages to `POST /api/execute/:session_id/chat`, which sends them to the orchestrator. The orchestrator can add/remove/modify nodes.

**What we should improve:**
- The chat placeholder text could be more explicit: "Ask me to add, remove, or change nodes in the plan..."
- When the orchestrator modifies nodes (via SSE events), the canvas should highlight what changed (flash animation or badge)
- If the orchestrator adds a node, it should ideally also set `assigned_resources` from the project's linked resources

No new backend endpoint needed — the orchestrator already has `spawn_agent` and access to plan manipulation tools.

---

## Part 6: Agent Runtime — Resource-Aware Execution

### 6.1 The change

When `agent_runner` builds the system prompt for a node, check if `description.assigned_resources` exists. If so, load the full resource metadata from `project_resources` and inject it:

```
## Your Assigned Resources
You are responsible for the following resources. Use these directly.

### Clay Tables
- "Partner Enrichment" (tbl_abc123) — 15 columns, 2,340 rows
  Columns: company_name (text), email (text), score (number), tier (text), ...

### n8n Workflows
- "Scoring Pipeline" (wf_456) — active, 12 nodes
  Trigger: webhook → enrich → score → upsert Supabase
```

This is a small addition to the existing `build_system_prompt` / context assembly in `agent_runner.rs`. The agent gets concrete resource details instead of discovering them by trial and error.

### 6.2 Where this fits in the existing code

In `agent_runner.rs`, after loading `spawn_context` and `project_description`, add a step:

```rust
// Load assigned resources for this node
if let Some(desc) = &node_description {
    if let Some(assigned) = desc.get("assigned_resources").and_then(Value::as_array) {
        let resource_ids: Vec<Uuid> = assigned.iter()
            .filter_map(|r| r.get("resource_id").and_then(Value::as_str))
            .filter_map(|s| s.parse().ok())
            .collect();
        if !resource_ids.is_empty() {
            let resources = load_project_resources(&self.db, &resource_ids).await;
            let resources_context = format_resources_for_agent(&resources);
            // Append to system prompt
        }
    }
}
```

No changes to how agents work, how tools are dispatched, or how credentials are injected. Just more context in the prompt.

---

## Part 7: The Onboarding Flow (Prompt → Discover → Plan)

### 7.1 Putting it all together

With the above pieces in place, the "onboard from existing" flow works like this:

```
User: "I have Clay enrichment tables and n8n scoring workflows.
       Set up a project to manage them."
  │
  ▼
System creates a project (existing POST /api/projects flow)
  │
  ▼
User goes to Settings > Integrations, connects Clay + n8n credentials
  (this already works today)
  │
  ▼
User clicks "Discover Resources" on the session/project page
  System calls Clay API → finds 4 tables
  System calls n8n API → finds 7 workflows
  User selects which to link → saved to project_resources
  │
  ▼
User describes the goal: "Set up agents to manage these resources"
  Planner sees the linked resources in gather_planner_context()
  Generates nodes that reference specific resources:
    - clay_operator → assigned: Partner Enrichment, Lead Scoring
    - n8n_operator → assigned: Scoring Pipeline, Onboarding Flow
    - dashboard_builder → assigned: (reads from Clay tables)
  │
  ▼
Canvas shows the plan with resource assignments on each node
  User adjusts in inspector (reassign, add, remove resources)
  User adds a new node if needed (+ Add Node on canvas)
  │
  ▼
User approves → agents execute with full resource context
  clay_operator already knows which tables to work with
  n8n_operator already knows which workflows to manage
```

### 7.2 Incremental changes after initial setup

Once a project has resources and nodes:

- **"Add a new Lovable dashboard"** → user links the resource (manually or discover), assigns it to an existing node or creates a new one
- **"What's wrong with the scoring pipeline?"** → agent already has the n8n workflow details in its context, can troubleshoot immediately
- **"Add a new n8n workflow for onboarding"** → user creates a new node, assigns the new resource, executes

The prompt can also drive these changes — the planner sees existing resources and nodes, and proposes additions rather than rebuilding.

---

## Part 8: API Routes

### New: Resource management

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/integrations/:slug/discover` | Auto-discover available resources from connected integration |
| `GET` | `/api/projects/:id/resources` | List linked resources for a project |
| `POST` | `/api/projects/:id/resources` | Link a resource (from discovery or manual entry) |
| `DELETE` | `/api/projects/:id/resources/:rid` | Unlink a resource |
| `POST` | `/api/projects/:id/resources/:rid/sync` | Re-sync resource metadata from external system |

### Existing: Enhanced node CRUD

| Method | Path | Change needed |
|---|---|---|
| `POST` | `/api/execute/:sid/nodes` | Add `execution_mode`, `model`, `max_iterations`, `description` to `AddNodeRequest` |
| `PATCH` | `/api/execute/:sid/nodes/:nid` | Add `requires` to `UpdateNodeRequest` for dependency editing |
| `DELETE` | `/api/execute/:sid/nodes/:nid` | Allow `preview` status in the DELETE guard |
| `PATCH` | `/api/execute/:sid/nodes/:nid/description` | No change — already supports arbitrary JSONB including `assigned_resources` |

### Existing: Used as-is

| Method | Path | Used for |
|---|---|---|
| `POST` | `/api/execute/:sid/chat` | Chat-based plan modification (orchestrator) |
| `POST` | `/api/execute/:sid/approve` | Plan approval |
| `GET` | `/api/execute/:sid` | Session + nodes fetch (includes descriptions) |

---

## Part 9: Implementation Phases

### Phase 1: Backend — Data + Discovery + Node CRUD Fixes
- Migration: `project_resources` table
- `backend/src/discovery.rs` — per-integration discovery logic (start with Clay + n8n)
- Routes: discovery endpoint + resource CRUD
- Fix `UpdateNodeRequest`: add `requires` field for dependency editing
- Fix `AddNodeRequest`: add `execution_mode`, `model`, `max_iterations`, `description`
- Fix node DELETE guard: allow `preview` status
- **Delivers:** Resource storage, discovery API, and complete node CRUD backend

### Phase 2: Backend — Planner + Agent Context
- Extend `gather_planner_context()` to include project resources
- Update `RICH_PLANNER_SYSTEM_PROMPT` to reference existing resources
- Load `assigned_resources` in `agent_runner` and inject into system prompt
- **Delivers:** Planner generates resource-aware plans; agents know their assigned resources at runtime

### Phase 3: Frontend — Node CRUD
- Add Node button on canvas with agent picker, task, dependencies, resources (Part 5.3)
- Delete Node button on canvas nodes (Part 5.4)
- Dependency editing in inspector (Part 5.5)
- Better chat placeholder text for plan modification guidance
- **Delivers:** Full CRUD for nodes directly on the canvas

### Phase 4: Frontend — Resource Discovery + Assignment
- Discovery panel with per-integration discover + link flow (Part 5.8)
- Resource assignment UI in inspector panel (Part 5.7)
- Resource chips on canvas nodes (Part 5.6)
- Manual resource entry for integrations without discovery APIs
- **Delivers:** Visual resource management and node-resource linking

### Phase 5: End-to-End Onboarding
- Full flow: connect credentials → discover → link resources → plan with context → review → adjust → approve → execute
- Incremental resource/node changes from prompts and UI
- **Delivers:** The complete "onboard from existing" experience

---

## Acceptance Criteria

| # | Criterion | Phase |
|---|---|---|
| 1 | `project_resources` table exists and has CRUD endpoints | 1 |
| 2 | Auto-discovery returns resources for Clay and n8n given valid credentials | 1 |
| 3 | Users can add new nodes to a session via the API with full config | 1 |
| 4 | Users can change node dependencies via PATCH | 1 |
| 5 | Users can delete `preview`-status nodes | 1 |
| 6 | The planner receives linked resources as context and generates plans that reference them | 2 |
| 7 | Agents receive assigned resource metadata in their system prompt at runtime | 2 |
| 8 | Users can add nodes from the canvas UI (agent picker, task, deps, resources) | 3 |
| 9 | Users can delete nodes from the canvas UI | 3 |
| 10 | Users can edit node dependencies in the inspector | 3 |
| 11 | Users can discover resources from connected integrations in the UI | 4 |
| 12 | Users can assign/unassign resources to nodes in the inspector | 4 |
| 13 | Resource chips are visible on canvas nodes | 4 |
| 14 | Users can manually add resources for integrations without discovery APIs | 4 |
| 15 | A user can go from "I have existing infrastructure" to a working plan in one flow | 5 |
| 16 | Incremental changes (add resource, add node, reassign) work without re-planning from scratch | 5 |
