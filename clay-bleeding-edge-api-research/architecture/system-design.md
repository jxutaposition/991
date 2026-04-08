# System Design: Proprietary Clay API Layer

Last updated: 2026-04-07 (post INV-020 → INV-027)

## Overview

A layered access stack that gives the Lele agent full programmatic
read/write/configure access to Clay tables, imports, documents, and the new
**tc-workflows** (terracotta) product. Each layer covers different capability
surfaces and has different auth/stability tradeoffs.

This document is the navigational/architectural reference. For exact request
shapes and per-endpoint detail, see `knowledge/internal-v3-api.md` and the
linked `investigations/INV-XXX_*.md` files.

## Architecture

```
┌─────────────────────────────────────────────────┐
│              Clay Operator Agent                 │
│         (backend/agents/clay_operator/)          │
└─────────────┬───────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────┐
│              Clay API Router                     │
│         (backend/src/clay_api.rs)                │
│                                                  │
│  Selects the appropriate layer/surface for       │
│  each operation. Falls back to lower layers      │
│  on failure.                                     │
└──┬──────────┬──────────┬──────────┬─────────────┘
   │          │          │          │
   ▼          ▼          ▼          ▼
┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
│Layer 1 │ │Layer 2 │ │Layer 3 │ │Layer 4 │
│Official│ │Internal│ │Play-   │ │CDP +   │
│v1 API  │ │v3 API  │ │wright  │ │Bundle  │
│(dead)  │ │(prim.) │ │DOM     │ │Discov. │
│API key │ │Session │ │Session │ │Session │
│auth    │ │cookie  │ │cookie  │ │cookie  │
└────────┘ └────────┘ └────────┘ └────────┘
```

## Layer 1: Official v1 API — DEPRECATED

**Auth**: API key
**Status**: **Non-functional** (INV-011). `api.clay.com/api/v1/*` is unrouted
(Express 404). `api.clay.run/v1/*` returns
`{"success": false, "message": "deprecated API endpoint"}`. The entire v1
surface — rows, triggers, table metadata — has moved into v3.

We keep this layer in the diagram only as a reminder that the v3 surface is the
ONLY programmatic option. All v1-shaped operations have v3 equivalents (rows
moved to `/v3/tables/{id}/records`, table metadata stayed in v3, enrichment
trigger is `PATCH /v3/tables/{id}/run`).

## Layer 2: Internal v3 API — primary surface

**Auth**: Session cookies (extracted via Playwright; see `clay_session.rs`)
**Stability**: Medium-high. The v3 API is internal but stable enough to use as
the primary integration. ~110 endpoints cataloged in `registry/endpoints.jsonl`,
the vast majority confirmed end-to-end.
**Scope**: Schema CRUD, row CRUD, source/webhook CRUD, imports/exports, action
configuration, tc-workflows, documents.

The v3 surface decomposes into several distinct sub-surfaces, each documented in
its own knowledge/INV file:

### 2a. Tables, fields, rows, views, sources

The original "schema CRUD" surface — everything you need to build and operate a
Clay table programmatically. Confirmed in INV-006/007/009/011/012/014/015/019.

| Operation | Endpoint | Source |
|-----------|----------|--------|
| Read full table | `GET /v3/tables/{tableId}` | INV-007 |
| Create / rename / delete table | `POST/PATCH/DELETE /v3/tables[/{id}]` | INV-007 |
| List tables | `GET /v3/workspaces/{id}/tables` | INV-007/009 |
| Field CRUD | `POST/PATCH/DELETE /v3/tables/{id}/fields[/{fieldId}]` | INV-007 |
| Row CRUD | `POST/PATCH/DELETE /v3/tables/{id}/records` | INV-011 |
| Row read (paginated) | `GET /v3/tables/{id}/views/{viewId}/records?limit=N` | INV-012/014 |
| View CRUD | `POST/PATCH/DELETE /v3/tables/{id}/views[/{viewId}]` | INV-015/019 |
| Source CRUD | `POST/PATCH/DELETE /v3/sources[/{id}]` | INV-006/009 |
| Trigger enrichment | `PATCH /v3/tables/{id}/run` | INV-006/009 |
| Workspace + user reads | `GET /v3/me`, `GET /v3/workspaces/{id}` | INV-007 |
| Auth accounts (enrichment provider creds) | `GET /v3/app-accounts` | INV-010 |
| Actions catalog | `GET /v3/actions?workspaceId=` | INV-007 |

Stability notes from INV-008: zero rate limiting at 50 req/s, average latency
21ms, no `X-RateLimit` headers, sessions are 7-day rolling. The 150ms baseline
was conservative; 50ms or no delay is fine.

### 2b. CSV import — multipart upload + import job

Confirmed end-to-end in INV-020/021. The full sequence is:

1. **Init**: `POST /v3/imports/{workspaceId}/multi-part-upload` body
   `{filename, fileSize, toS3CSVImportBucket: true}` → `{uploadId, s3Key,
   uploadUrls: [{url, partNumber}]}`. Server splits the file into N parts and
   returns presigned **PUT** URLs for each.
2. **Upload parts**: For each part, `PUT` to the presigned URL with
   `Content-Type: application/octet-stream`. Capture the `ETag` header per
   part (and unwrap it from S3's surrounding quotes).
3. **Complete**: `POST /v3/imports/{workspaceId}/multi-part-upload/complete`
   body `{s3key, uploadId, etags, toS3CSVImportBucket: true}` (note the
   lowercase `k` in `s3key`) → `{}`.
4. **Create import job**: `POST /v3/imports` with an `S3_CSV` source pointing
   at the returned `s3Key`. Synchronous. `GET /v3/imports/{id}` to poll, `GET
   /v3/imports?workspaceId=` to list history.

Buckets: `clay-base-import-prod` for CSVs (`toS3CSVImportBucket: true`),
`file-drop-prod` for general files (`false`). See INV-021 + INV-023 for the
full bucket-routing story.

### 2c. tc-workflows ("terracotta") — full surface

This is a separate product family discovered after the original architecture
doc was written. It exposes ~30 endpoints under
`/v3/workspaces/{wsId}/tc-workflows/...`. Confirmed end-to-end in
INV-023/024/025/026.

| Sub-surface | Endpoints | Source |
|-------------|-----------|--------|
| Workflow CRUD | `GET/POST/PATCH/DELETE /v3/workspaces/{ws}/tc-workflows[/{wf}]` | INV-023 |
| Graph + validation | `GET .../{wf}/graph` (returns nodes+edges + `{isValid, errors, warnings, suggestions}`) | INV-025 |
| Node CRUD (single + batch) | `POST/PATCH/DELETE .../{wf}/nodes[/{nodeId}]` | INV-025 |
| Edge CRUD | `POST/DELETE .../{wf}/edges[/{edgeId}]` | INV-025 |
| Snapshots (read-only, server-managed) | `GET .../{wf}/snapshots[/{snapshotId}]` | INV-025 |
| Batch CRUD + cancel | `GET/PATCH/DELETE .../{wf}/batches[/{batchId}]` | INV-024/025 |
| Batch type `csv_import` | `POST .../{wf}/batches {workflowSnapshotId:'latest', type:'csv_import', csvUploadToken}` | INV-024 |
| CSV ingest into a batch | `POST .../{wf}/batches/csv-upload-url` (S3 POST policy) | INV-023 |
| Direct runs (`Swe` router) | `POST/GET .../{wf}/runs[/{runId}]` + `pause` / `unpause` / `steps/{stepId}/continue` / `steps/waiting` | INV-026 |
| Streams CRUD (`lKe` router) | `POST/GET/PATCH/DELETE .../{wf}/streams[/{streamId}]` + `GET .../streams/{streamId}/runs` | INV-027 |
| Live webhook ingestion (`uKe` router) | `POST /v3/tc-workflows/streams/{streamId}/webhook[/batch]` (root path, no `/workspaces/{ws}` prefix) | INV-027 |

**Snapshot semantics**: snapshots are auto-materialized. When you create a
batch with `workflowSnapshotId: 'latest'`, the server resolves it to the
current graph state, sha256-hashes the full `{nodes, edges, workflow,
containsCycles}` payload, and stores it as a `wfs_xxx` record. There is no
explicit `publishWorkflow` call — live edits become the next snapshot when the
next batch (or direct run) is created.

**Three invocation primitives** (post INV-027):

1. **Batches** — CSV-driven set of runs, one per row (`type:'csv_import'`).
   Cancellable at the batch level. INV-024.
2. **Direct runs** — single ad-hoc invocation with optional `inputs` and
   `standaloneActions`. Synchronous polling. Pause/unpause and HITL via
   `continueWorkflowRunStep`. No cancel/delete; the `Swe` router is
   append-only. INV-026.
3. **Webhook streams** — long-lived stream objects scoped to a workflow
   snapshot. Create a stream with `streamType:'webhook'` →
   response includes a public `webhookUrl` →
   external systems POST arbitrary JSON to that URL → each POST creates
   a new run with the body as `runState.inputs` verbatim. End-to-end
   verified INV-027 (~7 s webhook → completed on inert 2-node graph).
   `lKe` router for stream CRUD; `uKe` router for ingestion. The single
   `postWebhook` route accepts session cookies; the `postWebhookBatch`
   variant returns 403 under cookies and is almost certainly the
   API-key-authed productized inbound channel (GAP-036). Two other
   `streamType` values (`agent_action`, `workflow_action`) exist but
   expose no `webhookUrl` — they look like internal stream types
   written from inside the workflow runtime (GAP-037).

**Run telemetry**: each step on a workflow run persists full
`{systemPrompt, userPrompt, tokenUsage, toolCalls, threadContext}`. `runStatus`
discriminator is `pending|running|paused|completed|failed|waiting`.

**Inert nodes are not as inert as we thought**: INV-026 surprise — a `regular`
node with no `modelId` still executes; Clay injects
`anthropic:claude-haiku-4-5` plus a system prompt and calls
`memory_search`/transition tools by default. On the dev workspace (1080480) no
credit delta was observed; whether normal-balance workspaces meter this is
GAP-034 (low priority — see `registry/gaps.md`).

### 2d. Documents / RAG upload flow

Confirmed in INV-023. Three-step flow:

1. `POST /v3/documents/{wsId}/upload-url` body `{name, folderId?, context?}`
   → `{documentId, uploadUrl, fields}` (S3 POST policy targeting
   `file-drop-prod`).
2. `multipart/form-data POST` directly to S3 (form fields first, file last) →
   204.
3. `POST /v3/documents/{wsId}/{documentId}/confirm-upload` (empty body) →
   returns the full document record with `id, name, folderId, mimeType, size,
   context, createdAt, updatedAt`.

`DELETE /v3/documents/{wsId}/{documentId}?hard=true` for cleanup. Replace
flow: `POST /v3/documents/{ws}/replace-upload-url` (same body shape, untested
but bundle-confirmed).

### 2e. Two upload mechanics, same buckets

Important architectural note: Clay exposes **two distinct upload mechanisms**
that both terminate at the same pair of S3 buckets.

| Mechanism | Endpoint | S3 method | Bucket | Use when |
|-----------|----------|-----------|--------|----------|
| Presigned multipart **PUT** | `/v3/imports/{ws}/multi-part-upload[/complete]` | `PUT` per part + complete | both (flag `toS3CSVImportBucket`) | files >5 GB, CSV imports |
| Presigned **POST policy** | `.../tc-workflows/{wf}/batches/csv-upload-url`, `/v3/documents/{ws}/upload-url` | single `multipart/form-data POST` | `clay-base-import-prod` (CSV) or `file-drop-prod` (docs) | files ≤5 GB, simpler one-shot |

The POST policy flow is simpler (no `/complete` step) but capped at S3's 5 GB
single-POST limit. The multipart PUT flow scales to Clay's advertised 15 GB
max. The proprietary layer should pick whichever is ergonomic per use case.

### 2f. Exports

`POST /v3/tables/{id}/export` creates an async job returning
`{id: "ej_xxx", status: "ACTIVE", fileName, uploadedFilePath: null}`. Poll
`GET /v3/exports/{jobId}` for `uploadedFilePath`. Free. INV-017.

## Layer 3: Playwright DOM Automation

**Auth**: Authenticated browser session
**Stability**: Low (DOM selectors can change)
**Scope**: UI-only operations the v3 API doesn't cover

The v3 surface has grown to cover most operations the agent needs, so Playwright
is a shrinking residual layer. Current uses:

| Operation | Method | Status |
|-----------|--------|--------|
| Read formula from cell | Click cell, read formula bar | Needs selector verification |
| Detect error states | Scan cell `metadata.status` (preferred) or DOM fallback | metadata.status path resolved INV-013 |
| Configure enrichment providers (UI flows) | UI automation | Mostly bypassable via `/v3/app-accounts` (INV-010) |
| Session cookie extraction | `extract-session.ts` | Working |

**Implementation**: `clay_playwright.rs` (or a TS helper invoked from Rust)
maintains a persistent browser context with the authenticated session, exposes
high-level operations, and shares the e2e/ infrastructure.

## Layer 4: CDP + Bundle Discovery

**Auth**: Authenticated browser session (CDP) or none (bundle scan)
**Stability**: N/A — research tool
**Scope**: Discovering new v3 endpoints and request shapes

This layer is the research harness, not a production layer. Two complementary
techniques:

1. **CDP interception** (`harness/scripts/intercept-clay-api.ts`): instruments
   a real browser session and catalogs every API call. Best for finding
   endpoints in active UI flows.
2. **Bundle reverse-engineering** (INV-021/023/025/026): download the current
   `app.clay.com/assets/index-*.js` bundle, grep for ts-rest router objects
   and zod schemas, extract authoritative request/response shapes without
   running the UI. This is how the entire tc-workflows surface
   (csv-upload-url, batches, snapshots, direct runs, continue) was found
   before any of it was exercised.

**Caveat**: bundle hashes rotate (we've seen `index--X05HdGb.js` and
`index-Ba1k0a3-.js` over a few days). Don't hardcode bundle URLs in
investigation scripts; resolve via `https://app.clay.com/` HTML each run.

Findings from both techniques feed into `registry/endpoints.jsonl` and the
`knowledge/` files.

## Fallback Chain

When the agent needs to perform an operation:

```
1. Try v3 API
   ├── Success → done
   ├── 401 → refresh session, retry once
   └── Not supported → try Playwright
2. Try Playwright automation
   ├── Success → done
   └── Failed → fall back to user action
3. Fall back to request_user_action
   └── Agent provides structured instructions for the user to do it manually
```

(v1 has been removed from the chain — INV-011 confirmed it's dead.)

The key design principle: **never block the agent on a capability gap**. If
automated access fails, the agent gracefully degrades to structured human
instructions.

## Module Structure (Target)

```
backend/src/
├── clay_api.rs          # Unified Clay v3 client (tables, fields, rows, sources,
│                        #   imports, exports, tc-workflows, documents)
├── clay_session.rs      # Session cookie management (extract/refresh/persist)
├── clay_playwright.rs   # Residual Playwright automation layer
└── ...

backend/tools/clay/
├── tool.toml            # Tool definition
├── actions.toml         # Clay-specific actions exposed to agent
└── ...
```

## Cross-references

- Per-endpoint detail and request/response shapes:
  `knowledge/internal-v3-api.md`
- Endpoint catalog (machine-readable): `registry/endpoints.jsonl`
- Capability matrix: `registry/capabilities.md`
- Open questions: `registry/gaps.md`
- Investigations: `investigations/INV-{006..026}_*.md` (INV-020+ is where the
  imports/tc-workflows/documents surfaces were uncovered)
- Credit-safety guidance: `exhaustively_searched/credit-usage-patterns.md`
- Session-by-session timeline: `timeline/`
