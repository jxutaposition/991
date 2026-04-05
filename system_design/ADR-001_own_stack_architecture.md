# ADR-001: Own Stack with Claude API

**Status**: Accepted
**Date**: 2026-04-04

## Decision

Build and operate a self-hosted Rust/Axum backend that calls the Anthropic Messages API directly. Claude Code and Cursor are optional data connectors (transcript ingestion, local file sync) — not the execution runtime.

## Context

The system requires multi-tenant agent orchestration with persistent execution graphs, encrypted credential management, scoped learning loops, real-time monitoring, and quality gates (judge/critic). These are server-side concerns that no local IDE agent can provide.

The codebase already implements this architecture: `anthropic.rs` wraps the Messages API with prompt caching and streaming, `agent_runner.rs` manages the full executor → critic → judge loop with Postgres-backed state, and `planner.rs` generates DAG execution plans from a catalog of skills.

## Decision Drivers

| Requirement | Own stack | Claude Code / Cursor |
|---|---|---|
| Multi-tenancy (workspace-scoped clients, credentials, projects) | `AppState` with per-client isolation | Single-user local sessions |
| Persistent execution (DAG plans, node state, conversation history) | `execution_nodes`, `node_messages` in Postgres | Ephemeral conversation state |
| Quality gates (judge/critic scoring, retries, evaluation) | Three-stage pipeline in `agent_runner.rs` | No built-in quality pipeline |
| Credential management (AES-256-GCM, OAuth flows, runtime injection) | `client_credentials` table, per-URL injection | User's local env vars |
| Learning loops (feedback → overlay → promotion → permanent learning) | Project Learner + Pattern Promoter (SD-003) | No cross-session learning |
| Real-time monitoring (SSE event bus, session observation) | `EventBus`, browser extension | No server-side observability |
| Agent catalog as data (DB-authoritative, PR pipeline, hot-reload) | `agent_definitions` + `skills` tables (SD-001) | Filesystem config only |

## Data Flow

```
Expert Local Environment                 Lele Server                          Lele Frontend
────────────────────────                 ───────────                          ─────────────
Markdown files (playbooks,    ──→  Knowledge ingestion    ──→  Postgres     Expert view
  ICP docs, battle cards)            (parse, chunk, embed)      (knowledge   Junior view
                                                                 chunks,     Customer view
Claude Code transcripts       ──→  Transcript ingestion          overlays,
Cursor chat exports                  (parse, extract)            execution
                                                                 graphs)
Browser extension             ──→  Session observation
  (clicks, navigation,              (events, screenshots,  ──→  EventBus ──→ SSE to clients
   screenshots)                      distillation)

                                   Agent execution
                                     (plan, orchestrate,
                                      judge, learn)
```

## Integration Points for Claude Code / Cursor

1. **Knowledge Sync Connector** — watches a local directory for markdown changes, pushes to `POST /api/knowledge/upload`
2. **Transcript Ingestion** — parses Claude Code JSONL conversation logs or Cursor chat exports, pushes to `POST /api/observe/transcript`
3. **Local Agent Connector** — lightweight local process that registers with the server as a tool endpoint via WebSocket; handles file system read/write when an agent needs local access

## What We Give Up

| Lost capability | Compensation |
|---|---|
| Claude Code's inline thinking UX | Own thinking display via `thinking_blocks` table + SSE streaming |
| Local file system access | Local Agent Connector + knowledge upload pipeline |
| Cursor's inline code editing | Plan review UX in frontend, agent PR pipeline |
| Zero-setup developer experience | Guided onboarding, browser extension auto-detection |

## Future-Proofing

If Claude Code adds an external orchestration API/SDK, the `AnthropicClient` in `anthropic.rs` would gain a second call path alongside the existing `messages()` path. The agent runner would dispatch to it for agents that benefit from local context while retaining server-side orchestration, persistence, and quality gates.

If Cursor adds MCP server endpoints, we could register as an MCP resource provider exposing the agent catalog and execution results as MCP resources.

The `AnthropicClient` is already isolated from business logic — swapping or augmenting the LLM backend is a single-module change.
