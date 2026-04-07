# System Design

This folder is the canonical reference for **how Lele 2.0 works**. Each document captures one slice of the architecture; together they describe a self-hosted, multi-tenant agent orchestration platform that turns expert GTM knowledge into running automations.

If you're new, read in this order: [ADR-001](ADR-001_own_stack_architecture.md) → [SD-004](SD-004_ontology_and_tool_architecture.md) → [SD-003](SD-003_orchestrator_primitives_and_learning.md) → [SD-005](SD-005_plan_document_and_conversation_architecture.md) → [SD-006](SD-006_knowledge_and_data_architecture.md) → the rest.

---

## How the system works (high level)

Lele 2.0 is a **Rust/Axum backend + Next.js frontend** that calls the Anthropic Messages API directly. Postgres is the source of truth for everything: agent definitions, credentials, plans, conversations, knowledge, learned overlays. The frontend is a thin viewer over server state, with SSE for live updates.

A user request flows through four layers of abstraction (see [SD-004](SD-004_ontology_and_tool_architecture.md)):

```
Orchestrator Agent  →  Domain Expert Agent  →  Tool  →  Action
(decomposes,           (knows WHAT to             (knows           (stateless
 delegates,             build — methodology)       WHERE to         function)
 validates)                                        build it)
```

1. The **Master Orchestrator** ([SD-003](SD-003_orchestrator_primitives_and_learning.md)) is a persistent LLM agent that holds the full user request. It is also the user's primary chat surface ([SD-005](SD-005_plan_document_and_conversation_architecture.md)) — their "Claude Code for GTM."
2. It produces a **Plan**, a living system-design document (not a task list). Each node has architecture, I/O contract, optionality, blockers, acceptance criteria, prior-artifact references.
3. After the user approves, the orchestrator **spawns sub-agents** synchronously via `spawn_agent`. Each child is a Domain Expert Agent loaded with focused methodology and one or more Tools (Clay, n8n, Lovable, HubSpot…). Tools execute via stateless Actions (`http_request`, `web_search`, etc.).
4. Every agent runs through a three-stage **executor → critic → judge** pipeline in [agent_runner.rs](../backend/src/agent_runner.rs), with retries on judge failure.
5. Agents read from **five memory layers** ([SD-006](SD-006_knowledge_and_data_architecture.md)): system knowledge, learned overlays, execution memory, expert corpus (RAG), and observation memory.
6. Outputs flow back up the hierarchy. The orchestrator validates cross-task consistency and synthesizes a final deliverable.
7. After the session, **learning loops** ([SD-003](SD-003_orchestrator_primitives_and_learning.md), [SD-007](SD-007_chat_learning_pipeline.md)) distill feedback, transcripts, uploaded docs, and observation sessions into scoped overlays (`base > expert > client > project`). The Pattern Promoter generalizes them upward when evidence accumulates.
8. Drift between expert behavior and current agent prompts opens **agent PRs** ([SD-001](SD-001_agent_config_management.md)) which, when approved, hot-reload the in-memory agent catalog with no deployment.

External integrations (Clay, n8n, HubSpot, Notion, Slack, Google, Meta, Supabase, Tavily, Apollo, Tolt) are wired through a per-client encrypted credential store ([SD-002](SD-002_integrations_and_credentials.md)) so any client can take full ownership of their stack.

---

## Document index

### Architectural decisions

- **[ADR-001 — Own Stack with Claude API](ADR-001_own_stack_architecture.md)**
  Why we run a self-hosted Rust/Axum backend that calls the Anthropic Messages API directly instead of riding on Claude Code or Cursor. Covers multi-tenancy, persistent execution, quality gates, credential management, learning loops, and how Claude Code / Cursor still slot in as optional local data connectors.

### System designs

- **[SD-001 — Agent Config Management](SD-001_agent_config_management.md)**
  Agent definitions (prompts, tools, judge configs, examples, knowledge docs) are **content, not code**. Postgres is the single source of truth; filesystem files are seed-only. Documents the PR lifecycle, drift detection, version history, and the in-memory `AgentCatalog` cache that hot-reloads on approval.

- **[SD-002 — Integrations and Credentials](SD-002_integrations_and_credentials.md)**
  The integration registry, AES-256-GCM credential storage, OAuth2 vs API-key flows, validation-on-save, agency-vs-client ownership tracking, and the handoff model that lets clients fully assume their automation stack.

- **[SD-003 — Orchestrator Primitives and Learning](SD-003_orchestrator_primitives_and_learning.md)**
  The master/sub-orchestrator pattern, synchronous `spawn_agent`, the two composable primitives (skills + tools), the four-scope overlay system (`base > expert > client > project`), and the two-process learning system (Project Learner + Pattern Promoter). The architectural backbone — read this early.

- **[SD-004 — System Ontology and Tool Architecture](SD-004_ontology_and_tool_architecture.md)**
  The strict four-level hierarchy: Orchestrator Agent → Domain Expert Agent → Tool → Action. Why four levels are necessary (context pollution, independent axes, knowledge scope), how tools become rich expandable knowledge stores, and how this replaces the old flat "agents and tools" model.

- **[SD-005 — Plan Document and Conversation Architecture](SD-005_plan_document_and_conversation_architecture.md)**
  The orchestrator as the user's always-available conversational partner. The plan as a living, structured system-design document (architecture, I/O contracts, optionality, blockers, acceptance criteria, mockups, prior-artifact refs). Hierarchical conversations that mirror execution, queued user interjections, and the editor experience.

- **[SD-006 — Knowledge and Data Architecture](SD-006_knowledge_and_data_architecture.md)**
  The five memory layers (System Knowledge, Learned Knowledge, Execution Memory, Expert Corpus, Observation Memory) with their lifecycles, scopes, and retrieval patterns. Canonical reference for the Expert Corpus (ingestion, chunking, contextual embeddings, hybrid search, pgvector schema) and the multi-channel learning pipeline that feeds Layer 2.

- **[SD-007 — Chat Learning Pipeline](SD-007_chat_learning_pipeline.md)**
  A three-stage background system that periodically analyzes completed chat transcripts (orchestrator, sub-agents, Slack) and distills implicit learnings — corrections, preferences, domain rules — into scoped overlays. Also produces ChatGPT-style holistic user-knowledge narratives. The canonical reference for the Transcript Analyzer in SD-006 Part 5.

### Planning

- **[GAP_WORKSTREAMS.md](GAP_WORKSTREAMS.md)**
  Self-contained session prompts for closing each gap between the Lele 2.0 thesis and the current codebase. Each workstream is designed to be dropped into a fresh Cursor/Claude conversation and produce a new SD doc + implementation plan. Ordered by priority. Use this as the to-do list for the architecture itself.

---

## Cross-references at a glance

| If you want to understand… | Start with |
|---|---|
| Why we don't use Claude Code as the runtime | ADR-001 |
| How agent prompts get updated without deploys | SD-001 |
| Where Clay/n8n/HubSpot keys live and how they're injected | SD-002 |
| How a request becomes a DAG of agent calls | SD-003, SD-004 |
| What a "plan" actually contains and how users edit it | SD-005 |
| Where uploaded playbooks/ICP docs end up and how they're retrieved | SD-006 |
| How the system learns from conversations over time | SD-003, SD-006, SD-007 |
| What still needs to be built | GAP_WORKSTREAMS.md |
