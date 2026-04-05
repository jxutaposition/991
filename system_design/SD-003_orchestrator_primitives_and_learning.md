# SD-003: Orchestrator Architecture, Primitives, and Learning System

## Summary

The system uses a master orchestrator pattern for task execution, two composable primitives (skills and tools) with scoped overlays for context, and a two-process learning system that captures lessons at project scope and promotes them upward through observed evidence.

---

## Part 1: Orchestrator Architecture

### Master Orchestrator

A persistent master orchestrator agent holds the full user request throughout execution. It decomposes the request into deliverables, dispatches subagents via `spawn_agent` with rich context, reads each subagent's complete output, validates results between steps, retries with specific feedback when needed, and synthesizes the final combined deliverable.

The master orchestrator runs in a standard agent loop (same executor as any agent). Its tools include `spawn_agent`, `write_output`, `web_search`, and `fetch_url`. When it calls `spawn_agent`, the system creates a child `ExecutionPlanNode` with `parent_uid` pointing to the master, runs the child agent synchronously, persists the result, and returns the full output as a tool_result to the master's conversation.

### Sub-orchestrators

For complex deliverables requiring multiple agents in sequence, the master spawns a sub-orchestrator (another master_orchestrator instance scoped to a task group). The sub-orchestrator follows the same pattern: spawn workers, validate, report back. This creates a recursive hierarchy:

```
Master Orchestrator (full request context)
├── spawn sub-orchestrator: "Build tiering system"
│   ├── spawn program_designer: [rich task + criteria]
│   │   └── returns full output to sub-orchestrator
│   ├── sub-orchestrator validates, spawns next agent
│   ├── spawn impact_measurement_designer: [rich task + upstream context]
│   │   └── returns full output to sub-orchestrator
│   └── write_output → returns to master
├── spawn sub-orchestrator: "Build data pipeline"
│   ├── spawn data_pipeline_builder → validate → spawn clay_operator → validate
│   └── write_output → returns to master
├── master validates all groups
└── write_output (final synthesized deliverable)
```

Depth limit: 3 levels (master → sub-orchestrator → worker). Prevents runaway recursion.

### Synchronous spawn_agent

`spawn_agent` is handled in `agent_runner.rs`. When the executor loop encounters a `spawn_agent` tool call:

1. Look up the skill slug in the catalog
2. Create a child `ExecutionPlanNode` with `parent_uid` = current node, `client_id` inherited
3. Persist the child node to DB, emit `node_started` event
4. Call `AgentRunner::run()` on the child node (synchronous within the parent's executor loop)
5. Persist child result, emit `node_completed` event
6. Return the child's full `output` JSON as the tool_result to the parent

The parent agent sees the complete output in its conversation history and decides what to do next.

### Enriched spawn_agent schema

The `spawn_agent` tool accepts rich context beyond a task string:

```json
{
  "agent_slug": "program_designer",
  "task_description": "Design the 4-tier expert scoring system for HeyReach",
  "context": "HeyReach is a LinkedIn outreach SaaS with 59 active experts...",
  "acceptance_criteria": [
    "Must define exactly 4 tiers with point thresholds",
    "Must include 3 scoring vectors: LinkedIn reactions, Tolt referral, HeyReach MRR"
  ],
  "examples": "Reference: Clay used 4 tiers (Artisan through Elite Studio)..."
}
```

The `context`, `acceptance_criteria`, and `examples` fields are injected into the child agent's system prompt after its base prompt and resolved overlays. This is how the orchestrator passes domain-specific, task-specific context to workers.

### Four layers of validation

| Layer | Who | What they check | Depth |
|-------|-----|-----------------|-------|
| Master orchestrator | "Are all deliverables covered? Are outputs consistent?" | Deliverable-level |
| Sub-orchestrator | "Does this output match the spec I wrote?" | Spec-level |
| Worker judge | "Did the agent follow its own methodology?" | Process-level |
| Evaluator agent | "Is the actual built artifact correct in detail?" | Detail-level |

The master orchestrator does not do deep validation (e.g., checking chart legends or axis labels). That is the evaluator agent's job. The master only checks deliverable completeness and cross-deliverable consistency.

The evaluator agent is a dedicated validation agent spawned by the sub-orchestrator after a builder agent completes. It has browser tools, data query tools, and the specific acceptance criteria from the sub-orchestrator. For 10 dashboards, 10 evaluators run independently.

The worker judge is a static rubric check that runs automatically after each worker agent. It catches methodology violations (e.g., "did you read types.ts before making changes?"). It does not validate against the original request or acceptance criteria.

### Execution entry point

`POST /api/execute` creates a single `master_orchestrator` node with the full user request as `task_description`. The master's agent loop handles all decomposition. There is no separate planner step.

The session gets created, approval works, and the work queue picks up the master node. Child nodes appear in the DB as they are spawned and are visible in the UI.

A `mode` field on the execute request supports:
- `mode: "orchestrated"` (default) — uses master orchestrator
- `mode: "planned"` — uses a one-shot DAG planner for simple, well-defined tasks

---

## Part 2: Primitives

The system has two primitives: skills and tools. Agents are not a fixed primitive — they are runtime compositions assembled by the orchestrator for a specific task.

### Primitive 1: Skill

A teachable unit of expertise. Has methodology, examples, lessons, and anti-patterns.

Examples: "chart-building," "tier-system-design," "clay-lead-gen," "data-pipeline-design," "onboarding-flow-design."

A skill is not tied to a specific tool. "chart-building" is a skill whether the tool is Lovable, Retool, or custom React. Skills are about knowing what to do and why. Tools are about executing.

A skill can reference which tools it typically uses, but the binding is loose — the orchestrator decides which tools to give the assembled agent at spawn time.

```sql
skills (
  id UUID PRIMARY KEY,
  slug TEXT UNIQUE,
  name TEXT,
  base_prompt TEXT,          -- methodology, process, anti-patterns
  base_lessons TEXT,         -- universal lessons learned
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
```

### Primitive 2: Tool

An executable capability. Stateless, no opinions. "Call the Supabase API," "navigate Lovable editor," "query Clay table," "send Slack message," "make HTTP request."

Tools do not learn. They execute. The skill tells the agent when and how to use the tool; the tool runs.

Tools can have client-scoped configuration (credentials, API keys, base URLs) stored via the credential system.

```sql
tools (
  id UUID PRIMARY KEY,
  slug TEXT UNIQUE,
  name TEXT,
  description TEXT,
  input_schema JSONB,
  required_credential TEXT   -- integration slug for credential lookup
)
```

### Runtime: Assembled Agent

An agent is a runtime composition assembled by the orchestrator for a specific task:

```
assembled_agent = {
  skills: [chart-building, dashboard-layout],
  tools: [supabase_query, lovable_chat, browser],
  context: resolved overlays (base + expert + client + project) for each skill,
  task: "Build graph 3 with corrected legend labels",
  acceptance_criteria: [...]
}
```

The orchestrator decides which skills, tools, and context to load based on the task. Different tasks get different assemblies. The system prompt for the assembled agent is:

```
skill("chart-building").resolved_prompt   -- base + overlays concatenated
+ skill("dashboard-layout").resolved_prompt
+ tool descriptions
+ task context from orchestrator
+ acceptance criteria from orchestrator
```

---

## Part 3: Scoped Overlays

### Four scope layers with additive resolution

Every skill and tool can have contextual overlays at four scopes:

1. **base** — universal truth. Applies to all experts, all clients, all projects.
2. **expert** — how a specific expert works. Applies to all of that expert's work across all clients.
3. **client** — how a specific client needs things. Applies to all projects for that client.
4. **project** — specific to one body of work within a client. Most granular scope.

Resolution at spawn time is additive concatenation:

```
final_prompt = skill.base_prompt
             + overlays(scope='expert', scope_id=expert_id)
             + overlays(scope='client', scope_id=client_id)
             + overlays(scope='project', scope_id=project_id)
             + task_context (from orchestrator's spawn call)
```

More specific layers override less specific ones on conflicts (e.g., base says "monthly reset," client says "quarterly reset" — client wins).

### Database

```sql
overlays (
  id UUID PRIMARY KEY,
  primitive_type TEXT NOT NULL,     -- 'skill' | 'tool'
  primitive_id UUID NOT NULL,       -- FK to skills or tools
  scope TEXT NOT NULL,              -- 'base' | 'expert' | 'client' | 'project'
  scope_id UUID,                   -- NULL for base, else FK to experts/clients/projects
  content TEXT NOT NULL,            -- the overlay content
  content_embedding VECTOR(1536),  -- for semantic similarity in pattern promotion
  source TEXT NOT NULL,             -- 'feedback' | 'manual' | 'shadowing' | 'promoted'
  promoted_from UUID,              -- FK to original overlay if this was promoted
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
```

### Overlay examples

**Skill: "chart-building"**

| Scope | Content | Source |
|-------|---------|--------|
| base | "Legend labels must match data series column names exactly" | promoted |
| expert(lele) | "Use clean, minimal chart styles. Lead with the data, not decoration." | manual |
| client(heyreach) | "Use tier names (Expert, Pro Expert, Elite Expert, Premium Partner) in all legends and labels, not point ranges" | feedback |
| project(expert-leaderboard) | "Premium partners get amber pill badge. 24 names hardcoded." | feedback |

**Skill: "clay-lead-gen"**

| Scope | Content | Source |
|-------|---------|--------|
| base | "Trailing slashes in LinkedIn URLs break Clay lookups. Normalize before matching." | promoted |
| project(banking-lead-gen) | "Exclude VP titles. VP in banking is junior-level." | feedback |

---

## Part 4: Learning System

### Two independent processes

Learning consists of two completely separate processes with different jobs, cadences, and inputs. They share the `overlays` table but do not interact directly.

### Process 1: Project Learner (real-time)

Runs on every piece of feedback. Stores lessons at project scope. No classification, no guessing about broader applicability.

Input: user feedback on a specific execution (which has a known project, client, and expert).

Logic:
1. Receive feedback text + execution context (session_id, node_id, project_id, client_id, expert_id)
2. Determine which skill(s) the feedback relates to (based on which skills the node used)
3. Extract the lesson: "What should be done differently next time?"
4. Store as an overlay at `scope = 'project'`, `scope_id = project_id`
5. Generate embedding for future similarity matching

This process is always correct because it never tries to generalize. It records what happened at the most specific scope.

### Process 2: Pattern Promoter (background, scheduled)

Runs on a schedule (weekly) or on-demand. Looks across all project-scoped overlays to find patterns worth promoting to broader scopes.

Input: all overlays at project scope across the system.

Logic:
1. Cluster semantically similar overlays using embeddings
2. For each cluster, check evidence:
   - Same lesson across 3+ projects for one client → propose promotion to `scope = 'client'`
   - Same lesson across 2+ clients for one expert → propose promotion to `scope = 'expert'`
   - Same lesson across multiple experts → propose promotion to `scope = 'base'`
3. Output proposed promotions
4. Auto-apply if confidence is high (e.g., identical lesson across 5+ projects), otherwise queue for human review

The promoted overlay stores a `promoted_from` FK pointing to the original project-scoped overlay for audit trail.

### Design rationale

The Project Learner is reactive (instant) and narrow (one project). It cannot make mistakes about scope because it does not determine scope. The Pattern Promoter is reflective (periodic) and broad (sees everything). It has the evidence (multiple instances) to make reliable scope decisions. Asking an LLM at feedback time "is this global?" from a single data point is unreliable. Separating the two means each process operates where it is strong.

### Lesson lifecycle

```
Day 1:  Feedback "don't include VPs" on banking-lead-gen
        → Project Learner stores at project(banking-lead-gen)

Day 15: Same feedback surfaces on fintech-lead-gen
        → Project Learner stores at project(fintech-lead-gen)

Day 30: Pattern Promoter runs, finds 3 HeyReach projects with "exclude VPs"
        → Proposes promotion to client(heyreach)
        → Human confirms (or auto-applies)
        → New overlay at client(heyreach), promoted_from = original

Day 60: Another client's projects show same pattern
        → Pattern Promoter proposes promotion to expert(lele)

Day 90: Multiple experts see it
        → Pattern Promoter proposes promotion to base
```

Lessons start at the most specific scope and earn promotion through observed evidence.

---

## Part 5: End-to-End Request Lifecycle

### Standard flow

1. User submits request text via `POST /api/execute`
2. System creates a single `master_orchestrator` node with the full request as task_description
3. User approves. Work queue picks up the master node.
4. Master orchestrator runs in an agent loop:
   a. Parses the request into deliverables
   b. For each deliverable, determines which skills are needed
   c. Resolves skill overlays (base + expert + client + project) for the target context
   d. Calls `spawn_agent` with rich task_description + resolved context + acceptance_criteria
   e. Child agent runs synchronously. Its system prompt = skill base_prompt + resolved overlays + orchestrator context + acceptance criteria.
   f. Child's judge runs (process quality gate).
   g. Full child output returns to master.
   h. Master validates against acceptance criteria.
   i. If insufficient: master spawns again with specific feedback.
   j. If sufficient: master moves to next deliverable.
5. After all deliverables are met, master synthesizes final output via `write_output`.
6. Session completes.

### Dashboard example (fully traced)

User request: "Build an expert leaderboard dashboard for HeyReach with public and internal views."

```
Master Orchestrator
│ Parses: 1 deliverable (dashboard), needs skills: dashboard-design, lovable-building, chart-building
│ Resolves overlays for HeyReach + expert-leaderboard project
│
├── spawn sub-orchestrator("Build expert leaderboard dashboard") {
│     context: program design output + HeyReach client context + resolved skill overlays
│     acceptance_criteria: [public view no MRR, internal view with MRR, premium badges, time filters]
│   }
│   │
│   ├── spawn worker("Read Supabase schema") {
│   │     skills: [lovable-building]
│   │     tools: [supabase_query]
│   │     context: "Supabase project ygtdnpnizmpthgwtvbjw" (from project overlay)
│   │   }
│   │   └── Returns: full types.ts schema
│   │
│   ├── spawn worker("Build the dashboard") {
│   │     skills: [lovable-building, chart-building]
│   │     tools: [lovable_chat]
│   │     context: schema from step 1 + tier structure + resolved overlays
│   │     acceptance_criteria: [specific routes, components, queries, auth]
│   │     overlays injected:
│   │       chart-building.client(heyreach): "Use tier names in legends"
│   │       chart-building.project(expert-leaderboard): "24 premium partners get amber badge"
│   │   }
│   │   └── Returns: project URL, routes created, components built
│   │
│   ├── spawn evaluator("Validate the dashboard") {
│   │     tools: [browser, supabase_query]
│   │     context: acceptance criteria + expected data
│   │   }
│   │   └── Returns: { pass: false, issues: ["MRR visible on public view"] }
│   │
│   ├── spawn worker("Fix: hide MRR on public view") {
│   │     context: evaluator's specific issue
│   │   }
│   │   └── Returns: fix applied
│   │
│   ├── spawn evaluator("Re-validate") → pass
│   │
│   └── write_output → returns to master
│
└── Master validates: deliverable complete, writes final output
```

---

## Part 6: Infrastructure Components

### Components carried forward
- Work queue infrastructure (polls DB, claims nodes, runs agents, persists results)
- Event/SSE system (child nodes emit events the same way)
- Credential system (child nodes inherit client_id from parent)
- Judge/critic system on individual worker agents
- Frontend canvas (parent_uid support for nested trees)
- Tool execution logic (HTTP, browser, API calls)

### New components
- Master orchestrator skill definition
- Evaluator skill definition (browser-based artifact validation)
- `skills` table (replaces `agent_definitions` as the primitive)
- `overlays` table with scoped resolution logic
- `projects` table (body of work within a client)
- Project Learner process (feedback → project-scoped overlay)
- Pattern Promoter process (background analysis → scope promotions)
- Synchronous spawn_agent execution in `agent_runner.rs`
- Enriched spawn_agent tool schema (context, acceptance_criteria, examples)

### Skill mapping from existing agents

Existing agent definitions become skills:
- `agent.toml` → `skills` row (slug, name, description)
- `prompt.md` → `skills.base_prompt`
- `knowledge/*.md` → concatenated into base_prompt or linked as skill examples
- `judge_config.toml` → judge config on the skill (process quality gate)
- `tools.toml` → skill-to-tool relationship (which tools this skill typically uses)
- `examples/*.json` → skill examples

---

## Part 7: Raw Data Sources

Part 4 describes the learning system as feedback-driven (Project Learner + Pattern Promoter). In practice, user feedback is one of several raw data sources that feed the same overlay inheritance system. This section documents all input channels.

### Source inventory

| Source | What it is | Current state | Gap |
|--------|-----------|---------------|-----|
| **User feedback** | Corrections, complaints, thumbs up/down on agent execution output | `feedback_signals` table, triggers `project_learner::record_lesson()` in `project_learner.rs` | Fully implemented |
| **Browser extension observations** | Clicks, navigation, form submissions, screenshots captured during expert browser sessions | `observation_sessions` + `action_events` tables via `POST /api/observe/session/:id/events`; `extraction.rs` produces `abstracted_tasks` | Distillation into overlays — `abstracted_tasks` exist but no path writes them into overlays |
| **Expert corpus** | Uploaded playbooks, ICP docs, battle cards, meeting notes, call transcripts | Does not exist — no upload endpoint, no storage, no indexing | Everything: upload API, format parsing, chunking, embedding, storage, RAG retrieval, overlay distillation |
| **Execution artifacts** | Outputs from completed agent sessions (`execution_nodes.output`, `execution_nodes.artifacts`) | Stored in Postgres | Not indexed for retrieval or analyzed for patterns across sessions |
| **Conversation transcripts** | Claude Code logs, Cursor chat exports, meeting transcripts | Does not exist | Ingestion endpoint, parsing, structured extraction |

### Unified learning principle

Every source feeds the same overlay inheritance system. A lesson distilled from corpus analysis gets the same `overlays` row as a lesson from user feedback. The `source` column on overlays tracks provenance. Extending the current constraint:

```sql
-- Current
CHECK (source IN ('feedback', 'manual', 'shadowing', 'promoted'))
-- Extended
CHECK (source IN ('feedback', 'manual', 'shadowing', 'promoted',
                  'corpus', 'execution', 'transcript'))
```

The overlay inheritance model (Part 3) does not change. What changes is the number of upstream channels writing into it.

---

## Part 8: Multi-Channel Learning Pipeline

### Extended architecture

The Project Learner and Pattern Promoter from Part 4 remain unchanged. They gain new upstream feeders that process additional raw data sources and write overlays at the appropriate scope.

```
RAW DATA SOURCES                    LEARNING AGENTS                 STORAGE
─────────────────                   ───────────────                 ───────
User feedback on executions    ──→  Project Learner (real-time)  ──→  overlays (scope=project)
Browser extension observations ──→  Observation Distiller (batch) ──→  overlays (scope=project)
Expert corpus uploads          ──→  Corpus Analyzer (per-doc)     ──→  overlays (scope=expert|client)
Execution artifacts/outputs    ──→  Execution Reviewer (batch)    ──→  overlays (scope=project)
Conversation transcripts       ──→  Transcript Analyzer (per-doc) ──→  overlays (scope=project|client)
                                          │
                                    Pattern Promoter (periodic, unchanged)
                                          │
                                    project → client → expert → base
                                          │
                                    (high confidence → agent PR into skill base_prompt)
```

### Existing processes (unchanged)

**Project Learner** — real-time, runs on every feedback signal. Stores lessons at project scope with `source='feedback'`. Implemented in `backend/src/project_learner.rs`.

**Pattern Promoter** — periodic (24h), scans project-scoped overlays, clusters by semantic similarity using LLM, promotes to broader scopes when evidence thresholds are met. Implemented in `backend/src/pattern_promoter.rs`. Processes overlays regardless of their `source` value, so new feeders automatically participate in promotion.

### New feeders

**Observation Distiller** — batch process, runs after browser extension sessions complete. Reads `abstracted_tasks` rows (already produced by `extraction.rs`) and identifies actionable lessons about expert workflows (e.g., "expert always checks X before Y", "expert avoids Z when doing W"). Writes overlays at project scope with `source='shadowing'`.

**Corpus Analyzer** — triggered per-document when the ingestion pipeline marks a `knowledge_documents` row as `status='ready'`. An LLM reads the normalized markdown and extracts actionable lessons or preferences that should influence agent behavior. Writes overlays scoped by the document's `inferred_scope` (expert, client, or project) with `source='corpus'`.

**Execution Reviewer** — batch process, runs after session completion. Reviews the full execution graph (retries, judge failures, evaluator issues, user corrections mid-session) and extracts process improvement lessons. Writes overlays at project scope with `source='execution'`.

All three are background processes following the same pattern as Pattern Promoter: Postgres-backed job queues, LLM-based analysis, overlay writes. Pattern Promoter promotes their outputs the same way it promotes feedback-derived overlays.

### PR escalation path

When an overlay has been promoted to `scope='base'` and has strong evidence (e.g., 10+ source instances across multiple experts), the system can propose a permanent change to the skill's `base_prompt` or `knowledge_docs` via the agent PR pipeline (SD-001). This closes the loop: raw data → project overlay → promoted overlay → permanent skill methodology.

The PR includes:
- The proposed text change to `base_prompt`
- Evidence trail: links to the original overlays and their source contexts
- Confidence score based on evidence count and diversity (how many experts, clients, projects)

---

## Part 9: Expert Corpus and RAG

The expert corpus is the one raw data source that requires new infrastructure, because it serves two purposes:

1. **Learning input** — distill patterns into overlays (handled by Corpus Analyzer in Part 8)
2. **RAG retrieval** — agents search the raw corpus during execution for reference material

### Why RAG is needed alongside overlays

Overlays store distilled, actionable lessons: "don't include VPs in banking titles." But agents also need to reference detailed source material: "the full ICP doc says enterprise targets are 500+ employees in fintech with Series B+ funding and these 12 specific criteria." A 50-page playbook cannot be condensed into overlay sentences. The agent needs to search and read the original content.

### Ingestion pipeline

```
Upload (Rust backend)                      Processing (Python worker)
──────────────────────                     ─────────────────────────────
POST /api/knowledge/upload                 Poll knowledge_documents WHERE status='pending'
  → store raw file in MinIO/S3               → fetch raw file from S3
  → infer scope from source_path             → Docling: any format → Markdown
  → create knowledge_documents row           → Chunker: header-aware markdown split
    with status='pending'                    → Embedder: text-embedding-3-small (1536 dims)
                                             → Write chunks to knowledge_chunks table
                                             → Update document status='ready'
                                             → Trigger Corpus Analyzer (overlay distillation)
```

**Why a Python worker**: Docling (format conversion), LangChain text splitters (markdown-aware chunking), and embedding model clients are Python-ecosystem tools without mature Rust equivalents. The worker communicates through the shared Postgres database — no HTTP sidecar needed. This matches the existing pattern of background workers communicating via Postgres (work queue, Pattern Promoter).

**Why Docling**: MIT-licensed, handles PDF/DOCX/PPTX/XLSX/HTML with OCR, outputs structured Markdown preserving headers and tables. The expert corpus consists of GTM content (playbooks, battle cards, call transcripts), not code — so AST-based chunking (Tree-sitter) is irrelevant. Header-aware markdown splitting is the optimal strategy for this content type.

### Chunking strategy

| Content type | Chunk strategy | Target size |
|--------------|---------------|-------------|
| Markdown playbooks | Split on `##`/`###` headers, then recursive paragraph split for oversized sections | ~500 tokens |
| Call transcripts | Split on speaker turns, merge adjacent turns under 100 tokens | ~400 tokens |
| ICP / battle card docs | Page-level (keep whole doc if under 800 tokens) | up to 800 tokens |
| CSV / structured data | Row batches with header context prepended | 20-50 rows |
| PDF / DOCX / PPTX | Docling converts to Markdown first, then apply the markdown strategy above | ~500 tokens |

### Retrieval interface

Agents call `search_knowledge` during execution:

```sql
SELECT content, section_title, source_path, metadata,
       1 - (embedding <=> $1) AS similarity
FROM knowledge_chunks
WHERE tenant_id = $2
  AND (project_id IS NULL OR project_id = $3)
ORDER BY embedding <=> $1
LIMIT 5
```

The Rust backend embeds the query text at request time (single HTTP call to OpenAI embedding API, ~100ms). Heavy batch embedding during ingestion stays in the Python worker.

### Database schema

```sql
CREATE TABLE IF NOT EXISTS knowledge_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES clients(id),
    project_id UUID REFERENCES projects(id),
    expert_id UUID REFERENCES experts(id),
    source_filename TEXT NOT NULL,
    source_path TEXT NOT NULL,
    source_folder TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    file_hash TEXT NOT NULL,
    normalized_markdown TEXT,
    inferred_scope TEXT CHECK (inferred_scope IN ('expert', 'client', 'project')),
    inferred_scope_id UUID,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'ready', 'error')),
    error_message TEXT,
    chunk_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES clients(id),
    project_id UUID REFERENCES projects(id),
    content TEXT NOT NULL,
    section_title TEXT,
    chunk_index INTEGER NOT NULL,
    embedding VECTOR(1536),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
CREATE INDEX ON knowledge_chunks(tenant_id);
CREATE INDEX ON knowledge_chunks(document_id);
CREATE INDEX ON knowledge_chunks(project_id);
CREATE INDEX ON knowledge_documents(tenant_id, status);
CREATE INDEX ON knowledge_documents(file_hash);
```

---

## Part 10: Knowledge Corpus UI and Folder Structure

### Folder conventions

The corpus UI presents a logical folder structure modeled on the existing `lele/` expert knowledge corpus. Default folders are pre-created per workspace:

```
me/                              → expert-scoped (identity, methodology, principles)
client/{slug}/                   → client-scoped (brief, people, programs)
client/{slug}/{project-slug}/    → project-scoped (project-specific docs)
skills/                          → expert-scoped (skill reference material)
transcripts/                     → scope auto-detected from content metadata
```

Users can create subfolders freely. The system infers scope from the path prefix:
- `client/heyreach/*` → sets `tenant_id` to the `heyreach` client, `inferred_scope='client'`
- `client/heyreach/leaderboard/*` → sets `project_id` to matching project, `inferred_scope='project'`
- `me/*` or `skills/*` → expert-scoped, `inferred_scope='expert'`
- Root-level files → expert-scoped by default

Physical storage is flat (S3 key is a UUID). The UI reconstructs the tree from `source_path` and `source_folder` values on `knowledge_documents`.

### Path-to-scope inference

```
Given: source_path, workspace clients, workspace projects
1. If path starts with "client/":
   a. Extract slug from segment after "client/" → look up client
   b. Extract next segment → look up project under that client
   c. If project found → inferred_scope='project', inferred_scope_id=project.id
   d. Else if client found → inferred_scope='client', inferred_scope_id=client.id
2. Else → inferred_scope='expert', inferred_scope_id=expert.id
```

The `tenant_id` (client FK) is always set based on the resolved client. For expert-scoped docs, `tenant_id` is set to the workspace's default client context. The inferred scope can be overridden manually in the UI.

### UI components

**Route**: `/knowledge` (new top-level page in the frontend)

1. **File tree sidebar** — collapsible folder tree built from `source_folder` values with file counts per folder
2. **Upload zone** — drag-and-drop into any folder; accepts `.md`, `.pdf`, `.docx`, `.pptx`, `.xlsx`, `.csv`, `.zip` (ZIP preserves internal folder structure); shows upload progress and processing status (pending → processing → ready)
3. **File detail panel** — click a file to see:
   - Original filename, upload date, file size
   - Inferred scope (with manual override dropdown)
   - Normalized markdown preview (Docling output)
   - Chunk list with section titles and token counts
   - Processing status and errors
4. **Bulk upload** — ZIP upload preserves directory structure; creates `source_path` entries matching the ZIP's internal paths
5. **Staleness indicators** — per-folder "last updated" timestamp; prompt if a folder hasn't had new uploads beyond a configurable threshold
6. **Search** — full-text search across file names and normalized content (complements the vector search agents use)

### Why structure matters for LLM retrieval

When `search_knowledge` returns chunks, the response includes `source_path` alongside the content. An agent seeing `source_path: "client/heyreach/program/expert-program-tiering.md"` can cite the source and knows which client/project it belongs to. File-name-based search also works — an agent looking for "tiering" can filter by path before vector search runs.
