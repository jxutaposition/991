# Open Research Gaps

Last updated: 2026-04-07 (post-INV-028)

Prioritized list of things we don't yet know. Each gap is a potential investigation.

## Resolved Gaps

### ~~GAP-002: Table Lifecycle via v3~~ — RESOLVED (INV-006)
`POST /v3/tables` with `{workspaceId, type: spreadsheet|company|people|jobs, name}`. `DELETE /v3/tables/{tableId}`. `PATCH /v3/tables/{tableId}` for updates.

### ~~GAP-006: Table Listing via v3~~ — RESOLVED (INV-006)
Multiple endpoints: `/v3/tables/recent`, `/v3/tables/list`, `/v3/tables/search`, `/v3/tables/all`, `/v3/workspaces/{id}/tables`.

### ~~GAP-007: Column Update and Delete~~ — RESOLVED (INV-006)
`PATCH /v3/tables/{tableId}/fields/{fieldId}` for update. `DELETE /v3/tables/{tableId}/fields/{fieldId}` for delete. PUT does NOT exist.

### ~~GAP-008: Workbook Management~~ — RESOLVED NEGATIVE (INV-006)
`/v3/workbooks` returns 404. No v3 endpoints for workbook CRUD. Workbook operations are UI-only.

### ~~GAP-003: Session Cookie Durability~~ — RESOLVED (INV-008)
Cookie lifetime is 7 days, but the timer **resets on every API call** (confirmed via `set-cookie` header in /v3/me response pushing expiry from Apr 12 → Apr 13). Not IP-bound. As long as any v3 endpoint is hit at least once per 7 days, the session never expires.

### ~~GAP-005: v3 Rate Limits~~ — RESOLVED (INV-008)
20 rapid-fire requests with zero delays: **0 out of 20 rate-limited**. No 429 responses, no `X-RateLimit` headers. Average latency 21ms. The 150ms Claymate baseline was a courtesy, not a requirement. Safe to remove inter-call delays entirely.

### ~~GAP-011: Row-Level v3 Operations~~ — CORRECTED (INV-011)
**Previous finding (INV-008) was WRONG.** We tested `/v3/tables/{id}/rows` (404) but the correct endpoint is `/v3/tables/{id}/records`. Row CRUD is fully functional via v3:
- `POST /v3/tables/{id}/records` — create rows (confirmed working)
- `PATCH /v3/tables/{id}/records` — update rows (async, enqueued)
- `DELETE /v3/tables/{id}/records` — delete rows (confirmed working)
- `GET /v3/tables/{id}/records` — returns 404 (read endpoint unknown, see GAP-025)

### ~~GAP-017: Response Shapes for Discovered Endpoints~~ — MOSTLY RESOLVED (INV-008)
Response shapes now documented for: /v3/me, /v3/workspaces/{id}, /v3/workspaces/{id}/tables, /v3/actions, /v3/sources, /v3/sources/{id}, PATCH /v3/sources/{id}, PATCH /v3/tables/{id}, /v3/imports. Note: /v3/imports/csv and /v3/imports/webhook are NOT separate endpoints (false positives from INV-006).

### ~~GAP-010: Webhook URL Retrieval~~ — RESOLVED (INV-009)
Webhook URL is in `state.url` on the source object. Create webhook source → read back → `state.url` = `https://api.clay.com/v3/sources/webhook/{uuid}`.

### ~~GAP-018: Table Type Semantics~~ — RESOLVED (INV-009)
`spreadsheet` and `company` types are functionally identical in API — both start with 2 fields (Created At, Updated At) and 5 views. Type only affects UI onboarding.

### ~~GAP-021: Enrichment Trigger runRecords Format~~ — RESOLVED (INV-009)
`runRecords: {recordIds: string[]}` → `runMode: "INDIVIDUAL"`. Empty object and `{all: true}` both result in `runMode: "NONE"`.

### ~~GAP-023: Workspace Credit Balance Monitoring~~ — RESOLVED (INV-009)
`GET /v3/workspaces/{id}` returns `credits: {basic: N, actionExecution: N}` and `creditBudgets` in real time.

### ~~GAP-024: Source Delete~~ — RESOLVED (INV-009)
`DELETE /v3/sources/{id}` returns `{success: true}`. Clean deletion.

### ~~GAP-006 CORRECTION: Table Listing Paths~~ — CORRECTED (INV-009)
`/v3/tables/recent`, `/v3/tables/list`, `/v3/tables/search`, `/v3/tables/all` are NOT endpoints. They were false positive 401s in INV-006 — "recent" etc. were treated as table IDs. Only `/v3/workspaces/{id}/tables` works.

## P0: Critical for MVP

### GAP-001: Full v3 Endpoint Catalog — MOSTLY RESOLVED
**Investigation**: INV-001, INV-006, INV-008
**Status**: 120 endpoints cataloged (post INV-028 — +3 net: /v3/api-keys POST/PATCH/DELETE confirmed or bundle-suspected, GET pre-existing was upgraded from suspected to confirmed). Response shapes confirmed for all major endpoints incl. tc-workflows (INV-023–027), API-key CRUD (INV-028), and CSV upload + import (INV-020/021). Remaining unknowns are HITL happy path (GAP-035), `agent_action`/`workflow_action` stream config shapes (GAP-037), `terracotta:mcp` scope / MCP surface (GAP-038 new), and a few `suspected` bundle-extracted routes awaiting verification.

## P1: Important for Full Coverage


### ~~GAP-009: v1 API Pagination~~ — RESOLVED NEGATIVE (INV-011)
The entire v1 API is deprecated and non-functional. `api.clay.com/api/v1/*` routes are not registered (Express 404), and `api.clay.run/v1/*` returns `{"success":false,"message":"deprecated API endpoint"}`. The pagination question is moot.


### ~~GAP-028: Source/Table Scheduling~~ — RESOLVED NEGATIVE (INV-022)
**Question**: Do `tableSettings.schedule`, `cronExpression`, `scheduleEnabled`, or source `typeSettings.schedule` actually drive scheduled runs?
**Answer**: No. `tableSettings` is schemaless and accepts ANY schedule-shaped key (verified persisted via GET read-back: `schedule`, `cronExpression`, `scheduleEnabled`, `nextRunAt`, `lastRunAt`, `scheduleStatus`, `runFrequency`, `runFrequencyConfig`) — but the values are pure UI scratch space; nothing in the backend reads them. `HAS_SCHEDULED_RUNS` is server-controlled and silently overrode our `true` write back to `false`. Source `typeSettings` is **validated** (unlike tableSettings) and 500s on any unknown key — sources do not store schedule state at all. Top-level source PATCH fields silently no-op (200, no persistence). 16 candidate scheduling endpoints (`/v3/tables/{id}/schedule`, `/v3/triggers`, `/v3/jobs`, `/v3/recurring-jobs`, `/v3/scheduled-tables`, etc.) all 404. **No v3 API surface for scheduling exists.** Workaround: self-hosted cron → `PATCH /v3/tables/{id}/run`.

### GAP-019: Action Package Definition Format
**Question**: What is the format of `actionPackageDefinition` (string) in `POST /v3/actions`?
**Method**: CDP interception during action column configuration

### ~~GAP-020: Import/Export Mechanics~~ — RESOLVED (INV-017, INV-020)
**Status**: Export confirmed: `POST /v3/tables/{id}/export` creates an async job returning `{id: "ej_xxx", status: "ACTIVE", fileName, uploadedFilePath: null}`. Poll `GET /v3/exports/{jobId}` for `uploadedFilePath`. Import: `POST /v3/imports` confirmed working (INV-020) — synchronous, requires `S3_CSV` source pointing at an existing S3 key. `GET /v3/imports/{id}` polls status. `GET /v3/imports?workspaceId=` lists history.

### ~~GAP-029: Suspected upload-URL endpoints (tc-workflows + documents)~~ — RESOLVED (INV-023)
**Question**: Are `POST /v3/workspaces/{ws}/tc-workflows/{wf}/batches/csv-upload-url` and `POST /v3/documents/{ws}/upload-url` (extracted from bundle in INV-021 but never exercised) actually functional, and what's the real request/response shape?
**Answer**: Both work. Both return an S3 POST policy `{uploadUrl, fields: {bucket, key, Policy, X-Amz-*}, ...}` rather than a presigned PUT. Caller does `multipart/form-data POST` directly to S3 (fields first, file last), S3 returns 204. tc-workflows targets `clay-base-import-prod`, documents targets `file-drop-prod` — same two buckets used by `/v3/imports/{ws}/multi-part-upload`. The tc-workflows response additionally returns `uploadToken` (UUID) for a subsequent `createWorkflowRunBatch` call. The documents flow has a third step: `POST /v3/documents/{ws}/{docId}/confirm-upload` (empty body) which makes the document visible and returns the full record. Verified end-to-end INV-023. The INV-021 registry entries had `fields` wrongly typed as `Array<string>` — it's an object; corrected during promotion.

### ~~GAP-030: createWorkflowRunBatch (consume the uploadToken)~~ — RESOLVED (INV-024)
**Answer**: `POST /v3/workspaces/{ws}/tc-workflows/{wf}/batches` body `{workflowSnapshotId:'latest', type:'csv_import', csvUploadToken, config?:object}` returns `{batch: {id (wfrb_...), workflowSnapshotId (wfs_...), workflowId, workflowName, status:'pending', type:'csv_import', config:{csvFile, parameterNames}, state:{lastOffsetProcessed:0}, totalRuns, ...}}`. Server resolves `'latest'` to a real snapshot id, parses CSV header into `config.parameterNames`. Batches against zero-step workflows transition `pending → failed` in <500ms with `totalRuns=0` (zero credits). Verified end-to-end INV-024 with scratch workflow + 1-row CSV. Also confirmed in passing: `getWorkflowRunBatches`, `getWorkflowRunBatch`, `deleteWorkflowRunBatch`, `getWorkflowRunsForBatch`. The discriminator's other branch is `type:'cpj_search'` (no upload token, untested). New gap GAP-031 (workflow step CRUD) opened to enable making batches do useful work.

### ~~GAP-031: tc-workflows step/snapshot CRUD~~ — RESOLVED (INV-025)
**Answer**: Two adjacent ts-rest routers in the current bundle (`index-Ba1k0a3-.js`) own this:
- `mYe` graph router under `/v3/workspaces/{ws}/tc-workflows/{wf}/{nodes,edges,graph}` — full CRUD on nodes (single + batch), edges, plus `GET /graph` which returns nodes+edges AND server-side validation (`{isValid, errors[], warnings[], suggestions[]}`).
- `uYe` snapshot routes under `/v3/workspaces/{ws}/tc-workflows/{wf}/snapshots[/{snapshotId}]` — read-only. Snapshots are server-managed, automatically created by `createWorkflowRunBatch` with `workflowSnapshotId='latest'`. No `publishWorkflow` route exists; live edits to nodes/edges become the next snapshot when the next batch is created. Snapshot content is sha256-hashed and embeds the full workflow definition (`{nodes, edges, workflow, containsCycles}`). Plus `createWorkflowFromSnapshot`, `restoreWorkflowFromSnapshot`, `duplicateWorkflow`, `createWorkflowFromPreset` (all bundle-extracted, untested).
- Node creation enum: `regular | code | conditional | map | reduce | tool` (read-only adds `fork|join|collect`). **Inert `regular` nodes with no model/prompt/tools are credit-safe scratch resources.**
- Bonus: `PATCH .../batches/{batchId} {status:'cancelled'}` works (promoted from suspected to confirmed) — beat the ~430ms auto-fail race on empty workflows.
- Bonus: `cpj_search` batch type returns 405 `"CPJ Search batch type is not yet implemented"` — discriminator + UI present, server stubbed.
- 12 endpoints confirmed end-to-end + 7 promoted-from-bundle as suspected. Zero credits consumed.

### ~~GAP-027: CSV Upload Endpoint (file → S3)~~ — RESOLVED (INV-021)
**Answer**: The upload origin IS in `/v3` after all — INV-020 missed it because the path-param shape uses **workspaceId**, not importId. Two confirmed endpoints implement an S3 multipart upload flow:
- `POST /v3/imports/{workspaceId}/multi-part-upload` body `{filename, fileSize, toS3CSVImportBucket}` → `{uploadId, s3Key, uploadUrls: [{url, partNumber}]}`
- `POST /v3/imports/{workspaceId}/multi-part-upload/complete` body `{s3key, uploadId, etags, toS3CSVImportBucket}` → `{}`
Full sequence: init → PUT each part to presigned S3 URL (Content-Type: application/octet-stream, capture ETag) → complete → POST /v3/imports with returned `s3Key`. Verified end-to-end with a 55-byte CSV. Two destination buckets: `clay-base-import-prod` (CSVs, `toS3CSVImportBucket:true`) and `file-drop-prod` (general files, `false`). Watch out: request key on /complete is `s3key` (lowercase k), and ETags must be unwrapped from S3's surrounding quotes. Bundle scan of `app.clay.com/assets/index--X05HdGb.js` revealed `lgt`/`ugt` axios wrappers that confirmed both routes; HTTP probes of non-v3 prefixes and alternate hosts produced ZERO hits, conclusively ruling out other origins.

### ~~GAP-026: Row Pagination~~ — RESOLVED (INV-014)
No cursor/page/offset mechanism exists. All params silently ignored. **Workaround**: use `limit=10000` (or larger) to get all rows in one call. Default limit without param = 100. Tested with 160 rows, 39ms response time.

### ~~GAP-004: Enrichment Provider Configuration~~ — FULLY RESOLVED (INV-010)
`GET /v3/app-accounts` returns all 111 auth accounts with IDs, provider types, ownership. The `id` field IS the `authAccountId` needed for enrichment column creation. No need to extract from existing columns — just list and match by `appAccountTypeId` to `auth.providerType` in the actions catalog.

### ~~GAP-022: authAccountId Extraction~~ — SUPERSEDED by GAP-004 resolution
Direct listing via `/v3/app-accounts` is far superior to column extraction.

### ~~GAP-032: tc-workflows direct runs API (`Swe` router)~~ — RESOLVED (INV-026)
**Answer**: Actual router name is `Swe` not `Ewe` (INV-025 guessed wrong — `Ewe` is the batches body discriminator). Seven routes under `/v3/workspaces/{ws}/tc-workflows/{wf}`: `POST /runs` (body `{inputs?, batchId?, standaloneActions?}`), `GET /runs`, `GET /runs/{runId}` (returns discriminated `current|archived`), `POST /runs/{runId}/pause`, `POST /runs/{runId}/unpause`, `POST /runs/{runId}/steps/{stepId}/continue` (body `{humanFeedbackInput: discriminated ApproveToolCall|DenyToolCall|DenyTransition|...}`), `GET /steps/waiting`. **No cancel/delete on direct runs** — runs can only pause/unpause after creation; cancellation is batch-level only. WorkflowRun `runStatus` enum: `pending|running|paused|completed|failed|waiting`. `runState` discriminated on status (running/paused/completed/failed). Verified end-to-end INV-026 with a 2-node inert workflow: status lifecycle `running → completed` in ~9s, two steps persisted with full telemetry (system/user prompts, token usage, tool calls, thread context). Credit delta = 0 on this dev workspace. **Surprise finding**: "inert regular nodes" are NOT actually inert — Clay injects a default `claude-haiku-4-5` agent with system prompt and `memory_search`/transition tools automatically. Credit metering on that default-LLM appears absent here but needs re-verification on a normal paid workspace (GAP-034).

### GAP-034: Default-LLM credit metering on `regular` nodes without a configured model
**Question**: INV-026 shows that a `regular` node with no `modelId` still executes: Clay injects `anthropic:claude-haiku-4-5` plus a system prompt and calls tools (`memory_search`, etc). On the INV-026 workspace (1080480, `actionExecution: 999999999897` — basically unlimited) no credit delta was observed. Does this hold on a production workspace with normal credit balances, or is Clay only skipping metering because this account is internal/dev/unlimited? If the default LLM IS metered on normal accounts, INV-025's "inert regular node" claim needs a small correction — but this is a precision issue, not a blocker.
**Status**: Not a blocker. Further tc-workflows investigation can proceed using the inert-regular-node pattern in the meantime; worst case is a minor credit footprint, well within the experimentation budget on this workspace.
**Method**: Opportunistic — next time we have access to a normal-balance workspace, reproduce INV-026 direct-run flow and measure `actionExecution` delta. No urgency.
**Priority**: P3 — precision-only; affects wording of INV-025/INV-026 credit claims but not their structural findings.

### ~~GAP-036: API-key auth for `postWebhookBatch` / productized inbound webhook channel~~ — RESOLVED BY ELIMINATION (INV-028)
**Answer**: `postWebhookBatch` is **not reachable from any user-facing auth scheme**. Minted 5 scratch API keys via newly-discovered `POST /v3/api-keys` (session-cookie), spanning 4 different scope sets (`['terracotta:cli']`, all three `terracotta:*`, `['all']`, and the full 7-scope union). Probed the batch route under 11 header forms (`Authorization: Bearer/bearer/Basic`, `X-Api-Key`, `X-Clay-API-Key`, `Clay-API-Key`, `clay-api-token`, `Token`, `x-auth-token`, query-param `?apiKey=`, `?api_key=`) + no-auth + cookie. Every combination returns 401 ('Unauthorized') or 403 ('Forbidden' — for cookies or `Clay-API-Key` header specifically). Zod validation runs BEFORE auth (wrong body shapes return 400 with `items Required`), proving the handler is reached. The `/v1` namespace is fully deprecated (404 `{success:false,message:'deprecated API endpoint'}`). No frontend caller exists for `postWebhookBatch` in the bundle — only the router definition — contrast with `postWebhook` (single) which the Workflows editor calls directly. Conclusion: `postWebhookBatch` is **internal-only**, used by Clay's own async workers for backfill ingestion (body shape `{entityId, backfillId, requestData}` strongly suggests this). The **productized inbound webhook channel was hiding in plain sight** as the single-event route: INV-028 proved `POST /v3/tc-workflows/streams/{streamId}/webhook` is **completely unauthenticated** — zero auth headers, 202 Accepted, workflowRunId returned. The streamId itself is the bearer (same security model as Clay table webhook URLs or Slack incoming webhooks). Consumers must rewrite the `webhookUrl` field in stream-create responses to prepend `/v3` — Clay returns a URL without the prefix that 404s (minor backend bug). New capability discovered: API-key CRUD at `/v3/api-keys` — `GET/POST/PATCH/DELETE`, all session-cookie-authed, UI exposes 3 of 7 scopes (the `terracotta:*` scopes including `terracotta:mcp` are mintable only via direct API — see GAP-038).

### GAP-038: `terracotta:mcp` scope — does Clay ship an MCP server?
**Question**: INV-028 discovered Clay's API-key scope enum (`Kb`) contains `terracotta:mcp` — a scope with no UI checkbox but mintable via `POST /v3/api-keys` direct call. This implies Clay has (or is building) an **MCP (Model Context Protocol) server surface** — a Claude/LLM-compatible interface into tc-workflows. If real and reachable, this would be a very large capability unlock. Also need to characterize `terracotta:cli` and `terracotta:code-node` scopes (also non-UI-exposed, likely internal CLI and code-node exec surfaces).
**Method**: Bundle scan for `mcp`, `modelcontextprotocol`, `/mcp`, `/v3/mcp`, `.well-known`. Mint a key with `['terracotta:mcp']` and probe common MCP server paths. Check the existing `/v3/tc-workflows/` tree for MCP-shaped routes (e.g. `/resources/list`, `/tools/list`, `/prompts/list`, standard MCP verbs).
**Priority**: P2 — high upside if real.

### GAP-037: `agent_action` and `workflow_action` stream types
**Question**: INV-027 confirmed `streamType` enum is `'webhook'|'agent_action'|'workflow_action'`. Webhook streams expose a `webhookUrl` and accept external payloads. `agent_action` and `workflow_action` streams created cleanly with `config:{}` but **no `webhookUrl` is returned** — they are not externally pushable. Likely they are written to from inside the workflow runtime (e.g., an agent tool publishing an event, or a sub-workflow's terminal node emitting an action). Need to find: who writes to them, what `config` shape they expect, and how a downstream workflow consumes them.
**Method**: Bundle scan around the `agent_action`/`workflow_action` literal occurrences (positions 622748 / 622763 in current bundle) for code paths that POST to `/streams/{id}/runs` or similar internal endpoints; cross-reference node types (especially `agent_action` / `tool_node` / `code` nodes) for emit-to-stream wiring.
**Priority**: P3 (curiosity — webhook streams cover the live ingestion need)

### GAP-035: Human-in-the-loop happy path for `continueWorkflowRunStep`
**Question**: INV-026 verified the route is reachable (404 on fake stepId) but never drove a real step into `waiting` state. To exercise `continueWorkflowRunStep` properly we need to configure a node with `interventionSettings` so an agent step transitions to `waiting` + produces `callbackData:{type:'human_input_tool_decision',...}`, then POST each `humanFeedbackInput` variant (`ApproveToolCall`, `DenyToolCall`, `DenyTransition`, plus ~2 others visible in `hCe` at bundle offset 342410) and observe resume semantics.
**Method**: Build a regular node with `interventionSettings:{requireHumanApprovalForAllToolCalls:true}` (field shape from `PATCH /nodes/:id` body, TBD), run a workflow, poll until `runStatus:'waiting'`, use `GET /steps/waiting` to find stepId, invoke continue.
**Priority**: P2

### ~~GAP-033: tc-workflows streams + webhook ingestion (`lKe`+`uKe` routers)~~ — RESOLVED (INV-027)
**Answer**: Actual router objects are `lKe = terracottaWorkflowRunStreams` (workspace-scoped CRUD, 6 routes) and `uKe = terracottaStreamWebhook` (root-path ingestion, 2 routes). INV-025/026 guess "sKe" was the request body Zod schema, not the router. Stream CRUD: `POST/GET/GET/PATCH/DELETE /v3/workspaces/{ws}/tc-workflows/{wf}/streams[/{id}]` plus `GET .../streams/{id}/runs`. Body: `{workflowSnapshotId, streamType: 'webhook'|'agent_action'|'workflow_action', name, config, status?='active'}`. WorkflowRunStream (`VS`) has `id (wfrs_...), workflowSnapshotId, streamType, status (active|paused|disabled), webhookUrl?` (only populated for `streamType='webhook'`). Live ingestion: `POST /v3/tc-workflows/streams/{streamId}/webhook` with arbitrary JSON body → 202 `{success, workflowRunId, message}`; payload becomes `runState.inputs` verbatim. Verified end-to-end INV-027 with inert 2-node graph: webhook → run created (`streamId` set, `batchId:null`) → `running → completed` in ~7 s. Negative paths: paused stream returns 400 'Stream is not active'; bad streamId returns 404; non-`/v3` URL form 404s under cookie auth. Credit delta = 0. **Surprises**: (1) `webhookUrl` returned in create-response **without** `/v3` prefix even though only the `/v3` path actually routes under cookie auth — Clay's gateway probably remaps the public form to `/v3` for non-cookie auth modes; (2) `postWebhookBatch` returned 403 'You must be logged in' under cookies despite canonical body shape, strongly hinting at API-key auth (GAP-036). Closes GAP-033; opens GAP-036 + GAP-037.

## P2: Nice to Have

### ~~GAP-012: Formula Evaluation Trigger~~ — RESOLVED (INV-017)
Formulas auto-evaluate immediately on row insert AND auto-re-evaluate when dependent cells are updated. No trigger needed. `PATCH /run` also works explicitly for formulas. Formula cell metadata shows `{"status":"SUCCESS"}`.

### ~~GAP-013: Error State API Access~~ — RESOLVED (INV-013)
Error states are in cell `metadata.status`. Observed values: `ERROR_OUT_OF_CREDITS`, `ERROR_BAD_REQUEST`. Stale/not-run cells show `{"isStale":true,"staleReason":"TABLE_AUTO_RUN_OFF"}`. No detailed error messages — just status codes.

### GAP-014: Clay Frontend Version Requirement — RESOLVED
**Status**: All probes succeeded WITHOUT this header. Confirmed optional.

### GAP-015: WebSocket/Real-time Updates
**Question**: Does Clay use WebSockets for real-time table updates?
**Note**: Not solvable with API probing — requires CDP/Playwright browser inspection.

### ~~GAP-016: Bulk Field Creation~~ — RESOLVED NEGATIVE (CLOSED)
No bulk endpoint exists. But with zero rate limiting and 21ms latency, 20 sequential field creates take <500ms. Non-issue in practice.

### ~~GAP-025: v3 Row Reading~~ — RESOLVED (INV-012)
Reading rows requires a **view ID**. Two endpoints confirmed:
- **List**: `GET /v3/tables/{tableId}/views/{viewId}/records?limit=N` — returns `{results: Record[]}`. Views apply server-side filtering. `limit` works; `offset` is accepted but **ignored**.
- **Single**: `GET /v3/tables/{tableId}/records/{recordId}` — returns one record by ID.
View IDs (gv_xxx) come from `GET /v3/tables/{tableId}` response under `table.views[]`. Use "All rows" or "Default view" for full table reads.

