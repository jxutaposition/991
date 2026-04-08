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

**Execution model:** Hierarchical with depth limit 3. The orchestrator can spawn sub-orchestrators for complex deliverables, which in turn spawn worker agents. See SD-003 for the full sub-orchestrator pattern.

```
Orchestrator
├── spawns Sub-agent 1 (n8n_operator)
├── spawns Sub-agent 2 (clay_operator)
├── spawns Sub-agent 3 (dashboard_builder)
├── reads outputs, validates
├── retries failures with specific feedback
└── synthesizes final output
```

**Tool selection:** Currently, the orchestrator selects agents directly by slug from the catalog. Each agent has its own tool set defined in `tools.toml`. The planned tool-selection-with-reasoning flow (category browsing, tradeoff analysis, user override) is **not yet implemented**.

### Level 2: Domain Expert Agent

A pre-defined agent type that embodies expertise for a category of work. Knows HOW to think about a problem — methodology, design principles, anti-patterns, decision frameworks. Does NOT know how to operate any specific platform.

**Folder structure (actual):**
```
backend/agents/dashboard_builder/
├── agent.toml            # slug, name, category, description, intents, max_iterations
├── prompt.md             # System prompt (methodology + domain knowledge)
├── tools.toml            # tools = ["http_request", "web_search", ...] — available actions
├── judge_config.toml     # threshold, rubric[], need_to_know[]
└── knowledge/            # Optional RAG documents (markdown)
```

> **Note:** The original SD-004 vision proposed separating domain methodology from platform knowledge (agents own methodology only, tools own platform docs). In practice, agents retain both — e.g., `n8n_operator` has both workflow design methodology and n8n-specific API knowledge in its `prompt.md`. Platform knowledge is additionally stored in `tools/` and injected at runtime via the `tool_catalog`.

**Composed at runtime:** When spawned, the system assembles the prompt from:
1. `prompt.md` (from agent folder, loaded into `agent_definitions.system_prompt`)
2. Resolved skill overlays (base + expert + client + project) if the agent matches a skill
3. Selected tool's `knowledge.md` (from `tools/` folder, if `tool_id` is set on the node)
4. Selected tool's `gotchas.md` (from `tools/` folder)
5. Task context, acceptance criteria, and examples (from orchestrator's `spawn_agent` call)

**Current agents:**

| Agent | Category | Description |
|-------|----------|-------------|
| `master_orchestrator` | orchestrator | Decomposes requests, spawns subagents, validates |
| `n8n_operator` | automation | Builds data pipelines and automations with n8n |
| `clay_operator` | enrichment | Designs Clay table structures, enrichment, formulas |
| `notion_operator` | documentation | Operates Notion API (pages, databases, properties) |
| `lovable_operator` | frontend | Diagnoses Lovable dashboards via Supabase |
| `tolt_operator` | referral | Manages Tolt referral/affiliate platform |
| `dashboard_builder` | frontend | Builds dashboards end-to-end (Supabase + Notion + Lovable) |
| `evaluator` | validation | Validates artifacts against acceptance criteria |

### Level 3: Tool

A specific software platform. A rich, expandable knowledge folder. A tool is NOT an agent — it never gets spawned as an LLM instance. Its knowledge gets loaded into a domain expert agent's context when that tool is selected.

**Folder structure (actual):**
```
backend/tools/n8n/
├── tool.toml                  # id, name, category, description, credentials, tradeoffs
├── knowledge.md               # Core overview (always injected into prompt)
├── gotchas.md                 # Learned pitfalls (always injected)
├── actions.toml               # actions = [...] — available Level 4 actions
└── knowledge/                 # Reference docs (on-demand via read_tool_doc)
    ├── error-catalog.md
    ├── expressions.md
    ├── code-js-patterns.md
    └── ...
```

> **Not yet implemented:** `artifacts/`, `conversations/`, and `integration-patterns/` subdirectories described in the original design. These will accumulate over time as agents complete work on each platform.

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

**Knowledge loading — two-tier convention:**

When a tool is selected for a domain expert, knowledge is loaded in two tiers determined by file location:

**Tier 1 — Always injected** (root-level files):
1. `knowledge.md` loaded into system prompt (core overview)
2. `gotchas.md` appended if present

**Tier 2 — On-demand** (`knowledge/` subdirectory files):
3. List of available reference doc filenames from `knowledge/` directory appended to prompt
4. Agent fetches specific docs via `read_tool_doc(tool_id, doc_name)` which reads directly from disk

Additionally:
5. `actions.toml` determines available actions
6. `tool.toml` determines required credentials (preflight check)

**Convention:** The file's location IS the tier decision — no configuration needed.
Root-level `knowledge.md` and `gotchas.md` are always injected. Everything under `knowledge/*.md`
is on-demand only. Guideline: when a tool's total knowledge exceeds ~30K tokens, move reference
material into `knowledge/` subdirectory files. Reference docs are read directly from disk
(no cache, no DB). This matches standard patterns (Cursor rules, CLAUDE.md, MCP server configs).

Artifacts and conversations are NOT auto-loaded (too large). On-demand search for these is not yet implemented.

**Expandability:** Every subfolder is optional and grows over time:
- `artifacts/` grows as more things are built
- `conversations/` grows as agents complete tasks
- `gotchas.md` grows as pitfalls are discovered
- `integration-patterns/` grows as new tool combinations are used
- `knowledge.md` can be split into `knowledge/` directory (n8n already has 12+ files)
- Reference docs grow over time in the `knowledge/` directory. Agents fetch them on-demand via `read_tool_doc`.

### Level 4: Action

An executable function. Stateless. Takes input, produces output.

**Shared actions** (used by many tools):
- `http_request` — generic HTTP with auto-credential injection (SD-002)
- `web_search` — Tavily-powered web search
- `fetch_url` — fetch and parse a web page
- `request_user_action` — pause for human step
- `write_output` — agent writes final structured output
- `read_upstream_output` — read a completed upstream agent's output
- `spawn_agent` — spawn a child agent synchronously (orchestrator only)
- `search_knowledge` — RAG search over the expert knowledge corpus
- `read_tool_doc` — read a platform tool reference document on-demand

> **Not yet implemented:** `git_repo_write`, `shell_execute`, `read_context`, `ask_agent`, `ask_orchestrator`. These inter-agent communication actions are planned for Phase 3 but do not exist in code.

All actions are defined in a single file: `backend/src/actions.rs`. The `all_action_defs()` function returns the full tool library. Each tool's `actions.toml` references which actions are available; at spawn time, the agent runner filters to the intersection plus always-available actions (`read_upstream_output`, `write_output`, `request_user_action`).

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

> **Status: Not implemented.** The three-step resolution chain described below is planned for Phase 3 but does not exist in code.

Currently, sub-agents access upstream outputs via the `read_upstream_output` action, which reads from a `HashMap<String, Value>` of completed node outputs passed by the runner. The orchestrator passes rich context to child agents via the `spawn_agent` tool's `context` field. There is no peer-to-peer or agent-to-orchestrator communication.

**Planned (Phase 3):**

1. `read_context` — DB query for prior sub-agent outputs and session artifacts
2. `ask_agent` — resume a peer sub-agent's conversation with a question
3. `ask_orchestrator` — escalate to orchestrator for cross-task questions

### Conversation persistence

All conversation histories (orchestrator + sub-agents) are stored in `node_messages`. An agent is just stored conversation rows — "resuming" an agent means loading its history, appending a new message, and making one LLM call. At any moment, only one LLM call is active per sub-agent. Everything else is rows in a database.

---

## Part 3: Disk Layout (Actual)

```
backend/
  agents/                          # Level 2: Agents (domain experts + operators)
    master_orchestrator/
      agent.toml, prompt.md, tools.toml, judge_config.toml
    dashboard_builder/
      agent.toml, prompt.md, tools.toml, judge_config.toml
    n8n_operator/
      agent.toml, prompt.md, tools.toml, judge_config.toml, knowledge/
    clay_operator/
      agent.toml, prompt.md, tools.toml, judge_config.toml, knowledge/
    notion_operator/
      agent.toml, prompt.md, tools.toml, judge_config.toml, knowledge/
    lovable_operator/
      agent.toml, prompt.md, tools.toml, judge_config.toml, knowledge/
    tolt_operator/
      agent.toml, prompt.md, tools.toml, judge_config.toml
    evaluator/
      agent.toml, prompt.md, tools.toml, judge_config.toml

  tools/                           # Level 3: Platform knowledge stores
    lovable/   tool.toml, knowledge.md, actions.toml, gotchas.md
    clay/      tool.toml, knowledge.md, actions.toml
    n8n/       tool.toml, knowledge/ (12+ files), actions.toml, gotchas.md
    notion/    tool.toml, knowledge.md, actions.toml
    supabase/  tool.toml, knowledge.md, actions.toml
    tolt/      tool.toml, knowledge.md, actions.toml
    vercel/    tool.toml, knowledge.md, actions.toml

  src/actions.rs                   # Level 4: All executable actions (single file)
```

### Minimum viable contents

- **Agent**: `agent.toml` + `prompt.md` + `tools.toml` + `judge_config.toml`
- **Tool**: `tool.toml` + `knowledge.md` (or `knowledge/`) + `actions.toml`
- **Action**: entry in `all_action_defs()` in `src/actions.rs`

Optional and accumulates: `knowledge/` directory, `gotchas.md`. Future: `artifacts/`, `conversations/`, `integration-patterns/`.

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

### Terminology (actual state)

> **Note:** The terminology migration described in the original SD-004 was not executed. The codebase retains the original naming.

| Concept | Term in Code | SD-004 Proposed | Status |
|---------|-------------|-----------------|--------|
| String identifier | `slug` | `id` | **Kept as `slug`** |
| Operator agents | `agent_definitions` + `agents/` dir | Eliminated | **Retained** — operators still exist |
| Executable function | `ToolDef` | `ActionDef` | **Kept as `ToolDef`** |
| Software platform | `platform_tools` + `tools/` dir | `tool` | **Implemented as `platform_tools`** |
| Agent prompt | `prompt.md` | `methodology.md` | **Kept as `prompt.md`** |
| Per-agent tool list | `tools.toml` (in `agents/`) | `actions.toml` (in `tools/`) | **Both exist** — `tools.toml` in agents, `actions.toml` in tools |

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

### Phase 1 (Implemented)
- [x] `tool_categories` and `platform_tools` tables exist with seed data (migration 022)
- [x] `execution_nodes` has `tool_id`, `tool_reasoning`, `tool_selected_by` columns (migration 022)
- [x] `backend/tools/` directory exists with lovable, clay, n8n, notion, supabase, tolt, vercel
- [x] Each tool has `tool.toml`, `knowledge.md` (or `knowledge/`), and `actions.toml`
- [x] `GET /api/tools`, `GET /api/tools/:tool_id`, and `GET /api/tool-categories` endpoints work
- [ ] `backend/agents/` restructured to domain experts only — **not done, operators retained**
- [ ] `ToolDef` renamed to `ActionDef` — **not done, still `ToolDef` in `anthropic.rs`**

### Phase 2 (Partial)
- [x] Tool knowledge injected into agent prompts when `tool_id` is set on a node
- [ ] Orchestrator tool selection with structured reasoning — **not implemented**
- [ ] `tool_id` auto-populated by orchestrator — **not implemented** (set manually or by planner)
- [ ] User tool override in plan review UI — **not implemented**

### Phase 3 (Not Started)
- [ ] `read_context` action
- [ ] `ask_agent` action
- [ ] `ask_orchestrator` action
- [ ] Self-serve -> peer -> orchestrator resolution chain
