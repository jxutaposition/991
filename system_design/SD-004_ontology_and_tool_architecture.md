# SD-004: System Ontology and Tool Architecture

## Decision

The system has four clearly separated levels of abstraction, forming a strict hierarchy. Each level nests under the one above with no overlaps.

```
Level 1: Orchestrator Agent       — runtime LLM that decomposes, delegates, validates
Level 2: Domain Expert Agent      — pre-defined type with domain methodology
Level 3: Tool                     — software platform with deep knowledge store
Level 4: Action                   — executable function (stateless)
```

This replaces the current flat model where `dashboard_builder` and `lovable_operator` are both "agents" at the same level, and where `http_request` and `web_search` are both "tools." Those conflations created ambiguity about what owns what, what is swappable, and where knowledge lives.

---

## Part 1: The Four Levels

### Why four levels

Three design forces require four distinct levels rather than fewer:

1. **Context pollution** (Orchestrator vs Domain Expert): The orchestrator manages many requirements simultaneously. Loading Lovable API docs, Clay enrichment patterns, and n8n node configuration into one context window degrades performance. A separate domain expert agent gets a focused ~15k token context loaded with exactly the methodology and tool knowledge it needs, versus an 80k+ token shared context.

2. **Independent axes** (Domain Expert vs Tool): A domain expert knows WHAT to build. A tool knows WHERE to build it. `dashboard-builder` can use Lovable or Vercel. `n8n` can be used by `automation-builder` or `data-pipeline-builder`. These are orthogonal concerns. Coupling them produces an N*M explosion of agent types (`dashboard-builder-lovable`, `dashboard-builder-vercel`, etc.).

3. **Knowledge scope** (Tool vs Action): A tool is a rich, expandable knowledge store (API docs, prior artifacts, gotchas, integration patterns). An action is a stateless function. `http_request` is not "Clay" — it is a generic function used by many tools. Actions are shared and composed; tools are distinct knowledge contexts.

### Level 1: Orchestrator Agent

A single runtime LLM instance that owns the full user request. It never loads platform-specific knowledge.

**Responsibilities:**
- Decompose request into tasks
- Select domain expert agent and tool for each task (with reasoning)
- Spawn sub-agents with composed prompts
- Read summarized outputs from sub-agents
- Validate cross-task consistency
- Retry with specific feedback when acceptance criteria fail
- Synthesize final deliverable

**Context contains:**
- Full user request
- Task decomposition reasoning
- Tool selection reasoning and tradeoff analysis
- Summarized sub-agent outputs (structured JSON)
- Cross-task validation results
- Escalation Q&A from sub-agents

**Context does NOT contain:**
- Platform knowledge (no Lovable API docs, no Clay gotchas, no n8n node config)
- Sub-agent conversation histories
- Raw action call results

**Execution model:** Flat. The orchestrator spawns all sub-agents directly. No sub-orchestrators. No nesting beyond depth 1. If a task is too complex for one sub-agent, the orchestrator breaks it into smaller tasks — each a direct sub-agent.

```
Orchestrator
├── spawns Sub-agent 1 (dashboard-builder + lovable)
├── spawns Sub-agent 2 (data-pipeline-builder + clay)
├── spawns Sub-agent 3 (automation-builder + n8n)
├── reads outputs, validates
├── retries failures
└── synthesizes final output
```

**Tool selection:** For each task, the orchestrator:
1. Identifies the domain expert agent needed
2. Determines the relevant tool category (e.g., `frontend-hosting`)
3. Lists available tools in that category (filtered by connected credentials)
4. Recommends one with structured reasoning (tradeoffs, project context, credential availability)
5. The recommendation is shown to the user in the plan review UI
6. The user can override before approving

### Level 2: Domain Expert Agent

A pre-defined agent type that embodies expertise for a category of work. Knows HOW to think about a problem — methodology, design principles, anti-patterns, decision frameworks. Does NOT know how to operate any specific platform.

**Folder structure:**
```
backend/agents/dashboard-builder/
├── agent.toml            # id, name, description, default_tool_categories
├── methodology.md        # Domain expertise: layout principles, data viz best practices,
│                         # public vs internal patterns, filtering strategies
├── overlays/             # Scoped additions (SD-003 overlay system)
│   ├── base/             # Universal methodology additions
│   ├── expert/           # Per-expert style preferences
│   ├── client/           # Per-client domain knowledge
│   └── project/          # Per-project specifics
├── examples/             # Prior work at the methodology level
└── rubric.toml           # Judge criteria for this domain
```

**Does NOT contain:**
- Platform-specific API docs, limitations, or gotchas
- References to specific tools (no mention of Lovable, Vercel, Clay, etc.)

**Composed at runtime:** When spawned, the system assembles its prompt from:
1. `methodology.md` (from agent folder)
2. Resolved overlays (base + expert + client + project)
3. Selected tool's `knowledge.md` (from tool folder)
4. Selected tool's `gotchas.md` and relevant `integration-patterns/`
5. Task context and acceptance criteria (from orchestrator)

Available actions come from the selected tool's `actions.toml` plus universal actions.

**Migration from current agents:**

| Current Agent | Becomes | Notes |
|---------------|---------|-------|
| `dashboard_builder` | Domain expert `dashboard-builder` | Methodology content stays |
| `data_pipeline_builder` | Domain expert `data-pipeline-builder` | Methodology content stays |
| `n8n_operator` | Splits: methodology -> `automation-builder`, platform -> `tools/n8n/` | |
| `lovable_operator` | Eliminated. Platform knowledge -> `tools/lovable/` | Lovable is a platform, not a domain |
| `clay_operator` | Eliminated. Platform knowledge -> `tools/clay/` | Same |
| `notion_operator` | Eliminated. Platform knowledge -> `tools/notion/` | Same |
| `tolt_operator` | Eliminated. Platform knowledge -> `tools/tolt/` | Same |
| `master_orchestrator` | Becomes the Level 1 orchestrator | Special role |
| `evaluator` | Stays as special validation agent | Uses browser actions |

### Level 3: Tool

A specific software platform. A rich, expandable knowledge folder. A tool is NOT an agent — it never gets spawned as an LLM instance. Its knowledge gets loaded into a domain expert agent's context when that tool is selected.

**Folder structure:**
```
backend/tools/lovable/
├── tool.toml                  # id, name, category, required_credentials, tradeoffs
├── knowledge.md               # How the platform works, API docs, limitations
│                              # (or knowledge/ directory for complex tools)
├── actions.toml               # Which actions are available on this platform
├── artifacts/                 # Prior things built on this platform
│   └── heyreach-leaderboard/
│       ├── description.md
│       ├── screenshots/
│       └── code-snapshot/
├── conversations/             # Prior agent conversations using this tool (condensed)
├── gotchas.md                 # Learned pitfalls
└── integration-patterns/      # How this tool connects to other tools
    ├── lovable-supabase.md
    └── lovable-github-sync.md
```

**Tool categories** group interchangeable tools:

| Category | Tools | Description |
|----------|-------|-------------|
| `frontend-hosting` | Lovable, Vercel, Cloudflare Pages, Streamlit, self-host | Deploy frontend apps |
| `workflow-automation` | n8n, Zapier, Make.com | Automation workflows |
| `data-enrichment` | Clay, Apollo, ZoomInfo | Enrich contact/company data |
| `documentation` | Notion, Confluence, Google Docs | Documents and wikis |
| `referral-management` | Tolt, PartnerStack | Referral/partner programs |
| `frontend-database` | Supabase, Firebase, PlanetScale | Backend DB for frontends |
| `communication` | Slack, Email, Discord | Messaging |

**Knowledge loading:** When a tool is selected for a domain expert:
1. `knowledge.md` (or `knowledge/*.md`) loaded into system prompt
2. `gotchas.md` appended if present
3. Relevant `integration-patterns/*.md` appended based on other tools in the session
4. `actions.toml` determines available actions
5. `tool.toml` determines required credentials (preflight check)

Artifacts and conversations are NOT auto-loaded (too large). Available via `search_tool_knowledge` action on demand.

**Expandability:** Every subfolder is optional and grows over time:
- `artifacts/` grows as more things are built
- `conversations/` grows as agents complete tasks
- `gotchas.md` grows as pitfalls are discovered
- `integration-patterns/` grows as new tool combinations are used
- `knowledge.md` can be split into `knowledge/` directory (n8n already has 12+ files)
- Any new files/folders are supported — the loader is pattern-based

### Level 4: Action

An executable function. Stateless. Takes input, produces output.

**Shared actions** (used by many tools):
- `http_request` — generic HTTP with auto-credential injection (SD-002)
- `git_repo_write` — clone, write files, commit, push
- `request_user_action` — pause for human step
- `write_output` — agent writes final structured output
- `shell_execute` — sandboxed shell command

**Tool-specific actions:**
- `vercel_deploy` — Vercel REST API
- `cloudflare_pages_deploy` — Cloudflare API

**Inter-agent actions** (universal, available to all agents):
- `read_context` — search DB for prior sub-agent outputs and session artifacts
- `ask_agent` — resume a peer sub-agent's context with a question
- `ask_orchestrator` — escalate to orchestrator (last resort)

Actions are declared in code (`backend/src/actions/` directory). Each tool's `actions.toml` references which actions it uses. At spawn time, the system unions the tool's actions with universal actions.

---

## Part 2: Execution Model

### Request lifecycle

```
1. User submits request

2. Orchestrator decomposes into tasks:
   Task A: dashboard (domain: dashboard-builder, category: frontend-hosting)
   Task B: enrichment (domain: data-pipeline-builder, category: data-enrichment)
   Task C: wiring    (domain: automation-builder, category: workflow-automation)

3. Orchestrator selects tools with reasoning:
   Task A -> Lovable (client has existing project) | alt: Vercel, Cloudflare
   Task B -> Clay (client data already there) | alt: Apollo
   Task C -> n8n (existing workflows) | alt: Zapier

4. Plan shown to user: recommendations + reasoning + override dropdowns

5. User approves (or overrides)

6. Orchestrator spawns sub-agents with composed prompts:

   Sub-agent A (~15k tokens):         Sub-agent B (~10k tokens):
   ├── methodology.md (dashboard)     ├── methodology.md (pipeline)
   ├── overlays (resolved)            ├── overlays (resolved)
   ├── lovable/knowledge.md           ├── clay/knowledge/ (relevant)
   ├── lovable/gotchas.md             ├── clay/gotchas.md
   ├── task context + criteria        ├── task context + criteria
   └── actions: git_repo_write, ...   └── actions: http_request, ...

7. Sub-agents execute, using inter-agent context resolution if needed

8. Orchestrator reads outputs, validates, retries if needed

9. Orchestrator synthesizes final output
```

### Inter-agent context resolution

When a sub-agent needs information from another sub-agent (e.g., Sub-agent C needs the Clay table ID that Sub-agent B created), it follows a three-step resolution chain. Design principle: **self-serve first, ask peers second, ask orchestrator last.**

**Step 1: `read_context` (cheapest — DB query, no LLM call)**

Searches the DB for:
- Completed sub-agent outputs (structured JSON from `write_output`)
- Session-level artifacts (files, URLs, IDs)
- Orchestrator's decomposition context

Works when the needed info was captured in a prior `write_output`. Handles ~80% of cases.

**Step 2: `ask_agent` (moderate — one LLM call)**

If `read_context` doesn't have it, the sub-agent targets a specific peer:
```
ask_agent(target: "sub-agent-B", question: "What Supabase table does the Clay pipeline write to?")
```
Sub-agent B's full conversation history is loaded, the question appended, one LLM call produces the answer. The Q&A is stored in Sub-agent B's history (it gets smarter).

**Step 3: `ask_orchestrator` (last resort — largest context)**

If the peer can't answer or the sub-agent doesn't know which peer to ask:
```
ask_orchestrator(question: "Which sub-agent set up the Clay table?")
```
The orchestrator's conversation is resumed. It has seen all summaries and knows the full decomposition. It answers or redirects.

### Conversation persistence

All conversation histories (orchestrator + sub-agents) are stored in `node_messages`. An agent is just stored conversation rows — "resuming" an agent means loading its history, appending a new message, and making one LLM call. At any moment, only one LLM call is active per sub-agent. Everything else is rows in a database.

---

## Part 3: Disk Layout

```
backend/
  agents/                          # Level 2: Domain Expert Agents
    dashboard-builder/
      agent.toml
      methodology.md
      overlays/
      examples/
      rubric.toml
    data-pipeline-builder/
      agent.toml
      methodology.md
      overlays/
      examples/
    automation-builder/
      agent.toml
      methodology.md
      overlays/
      examples/
    lead-gen/
      agent.toml
      methodology.md
      overlays/
      examples/

  tools/                           # Level 3: Platforms
    lovable/
      tool.toml
      knowledge.md
      actions.toml
      artifacts/
      conversations/
      gotchas.md
      integration-patterns/
    vercel/
      tool.toml
      knowledge.md
      actions.toml
      artifacts/
    clay/
      tool.toml
      knowledge/
        overview.md
        api-reference.md
        table-design-patterns.md
        enrichment-providers.md
        formula-syntax.md
        webhook-actions.md
        linkedin-url-gotchas.md
      actions.toml
      artifacts/
      gotchas.md
      integration-patterns/
    n8n/
      tool.toml
      knowledge/
        node-configuration.md
        expressions.md
        workflow-patterns.md
        code-nodes.md
        code-js-reference.md
        code-js-patterns.md
        code-js-errors.md
        code-python-reference.md
        validation.md
        error-catalog.md
        false-positives.md
        operation-patterns.md
        heyreach-instance.md
      actions.toml
      artifacts/
      gotchas.md
      integration-patterns/
    notion/
      tool.toml
      knowledge.md
      actions.toml
    supabase/
      tool.toml
      knowledge.md
      actions.toml
    tolt/
      tool.toml
      knowledge.md
      actions.toml

  src/actions/                     # Level 4: Executable functions (Rust)
    mod.rs
    http_request.rs
    git_repo_write.rs
    vercel_deploy.rs
    cloudflare_pages_deploy.rs
    shell_execute.rs
    write_output.rs
    read_context.rs
    ask_agent.rs
    ask_orchestrator.rs
    request_user_action.rs
```

### Minimum viable contents

- **Agent**: `agent.toml` + `methodology.md`
- **Tool**: `tool.toml` + `knowledge.md` + `actions.toml`
- **Action**: one Rust module + registry entry

Everything else (`overlays/`, `examples/`, `artifacts/`, `conversations/`, `gotchas.md`, `integration-patterns/`) is optional and accumulates over time. The loader walks each directory, loads what exists, ignores what doesn't.

---

## Part 4: Schema

### New tables

```sql
CREATE TABLE tool_categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tools (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL REFERENCES tool_categories(id),
    description TEXT,
    knowledge TEXT NOT NULL,
    gotchas TEXT,
    actions TEXT[] NOT NULL,
    required_credentials TEXT[],
    tradeoffs JSONB,
    enabled BOOLEAN NOT NULL DEFAULT true,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE project_tool_defaults (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tool_category TEXT NOT NULL REFERENCES tool_categories(id),
    tool_id TEXT NOT NULL REFERENCES tools(id),
    PRIMARY KEY (project_id, tool_category)
);
```

### Changes to existing tables

```sql
-- execution_nodes gains tool selection columns
ALTER TABLE execution_nodes
    ADD COLUMN tool_id TEXT REFERENCES tools(id),
    ADD COLUMN tool_reasoning TEXT,
    ADD COLUMN tool_selected_by TEXT;
    -- tool_selected_by: 'orchestrator' | 'user_override' | 'project_default'
```

The existing `agent_definitions` table is retained for the orchestrator and evaluator (special agents). Domain expert agents are seeded into it with the same pattern but their `system_prompt` comes from `methodology.md`, and their `tools` list is now resolved at runtime from the selected tool's `actions.toml`.

### Tables from SD-003 that apply unchanged

- `overlays` — scoped additions to domain expert agents
- `projects` — body of work within a client
- `experts` — expert identity

---

## Part 5: Relationship to Prior Design Docs

### SD-001 (Agent Config Management)

Same DB-as-source-of-truth + disk seeding pattern for both domain expert agents and tools. Same hot-reload on change. Agent PR system extends to cover tool knowledge changes. Version tracking on both.

### SD-002 (Integrations and Credentials)

Each tool's `required_credentials` maps to SD-002's integration registry. Credential injection in actions follows the existing URL-pattern-matching approach. Tools are only selectable when their credentials are connected. Per-project credential scoping means different projects can use different tools.

### SD-003 (Orchestrator Primitives and Learning)

| SD-003 Concept | SD-004 Mapping |
|----------------|----------------|
| Skill (teachable expertise) | Level 2: Domain Expert Agent |
| Tool (executable function) | Level 4: Action (renamed) |
| Assembled agent (runtime composition) | Orchestrator composes skill + tool at spawn time |
| Overlays (base -> expert -> client -> project) | Apply to domain expert agents (unchanged) |
| Learning system (Project Learner + Pattern Promoter) | Feeds overlays into domain expert agents (unchanged) |
| Orchestrator description | Becomes the Level 1 flat orchestrator |
| _(missing concept)_ | Level 3: Tool (platform knowledge) — new in SD-004 |

### Terminology migration

| Current codebase | SD-004 term | Notes |
|-----------------|------------|-------|
| `slug` | `id` | String identifier, not UUID |
| `agent_definitions` (for operators) | Eliminated; content moves to `tools/` | Operators were platform knowledge |
| `tool` (in code: executable function) | `action` | Avoids conflict with platform meaning |
| `tool` (in conversation: software platform) | `tool` | Now a first-class concept |
| `prompt.md` (methodology) | `methodology.md` | In `agents/` |
| `prompt.md` (platform knowledge) | `knowledge.md` | In `tools/` |
| `tools.toml` (per agent) | `actions.toml` | In `tools/`, not `agents/` |
| `knowledge/*.md` (per agent) | `knowledge/*.md` (per tool) | Moves to tool folder |

---

## Part 6: Implementation Phases

### Phase 1: Schema and disk layout
- DB migrations: `tool_categories`, `tools`, `project_tool_defaults`, new columns on `execution_nodes`
- Create `backend/tools/` directory structure
- Migrate existing agent knowledge into tool folders (split `prompt.md` files)
- Rename `tools.rs` to `actions/` module, update all references
- Seed tools from disk into DB on startup

### Phase 2: Orchestrator and agent composition
- Rewrite orchestrator to compose agents from skill + tool + context
- Implement tool selection with LLM reasoning
- Store tool recommendations on execution nodes
- Spawn sub-agents with composed prompts

### Phase 3: Inter-agent communication
- `read_context` action (DB query for prior outputs)
- `ask_agent` action (resume peer context)
- `ask_orchestrator` action (escalate to orchestrator)

### Phase 4: Frontend
- Plan review: tool recommendations with reasoning + override dropdowns
- Project settings: default tool per category
- Execution canvas: tool chips on nodes
- Catalog: browse domain experts and tools separately

### Phase 5: Expand tools and actions
- `git_repo_write` action
- `vercel_deploy` action
- New tool definitions (Vercel, Cloudflare, Zapier, Make.com, etc.)
- Capture artifacts and conversations from completed work

---

## Acceptance Criteria

### Phase 1
- [ ] `tool_categories` and `tools` tables exist with seed data
- [ ] `execution_nodes` has `tool_id`, `tool_reasoning`, `tool_selected_by` columns
- [ ] `backend/tools/` directory exists with at least lovable, clay, n8n, notion, supabase, tolt
- [ ] Each tool has `tool.toml`, `knowledge.md` (or `knowledge/`), and `actions.toml`
- [ ] `backend/agents/` contains only domain experts (dashboard-builder, data-pipeline-builder, automation-builder, lead-gen)
- [ ] `tools.rs` renamed to `actions/` module; `ToolDef` renamed to `ActionDef`
- [ ] `GET /api/tools` and `GET /api/tool-categories` endpoints return seeded data

### Phase 2
- [ ] Orchestrator composes sub-agent prompts from methodology + tool knowledge
- [ ] Tool selection produces structured reasoning
- [ ] `tool_id` populated on execution nodes
- [ ] Sub-agents only see actions from their selected tool + universals

### Phase 3
- [ ] `read_context` returns structured data from prior sub-agent outputs
- [ ] `ask_agent` resumes a peer's conversation and returns an answer
- [ ] `ask_orchestrator` resumes orchestrator context and returns an answer
- [ ] Sub-agents use self-serve -> peer -> orchestrator resolution chain
