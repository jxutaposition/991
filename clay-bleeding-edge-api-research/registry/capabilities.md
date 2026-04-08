# Clay Capability Matrix

Last updated: 2026-04-07 (post INV-028 — 120 endpoints)

## Legend

- **yes**: Confirmed working with response shape documented
- **partial**: Works with limitations
- **untested**: Endpoint exists (401 response), not yet tested with auth
- **no**: Confirmed not possible via this layer (404)
- **n/a**: Not applicable to this layer

## Data Operations

| Capability | Official v1 | Internal v3 | Status |
|---|---|---|---|
| Read table rows (list) | no (v1 deprecated) | **yes** (GET /v3/tables/{id}/views/{viewId}/records) | **v3 working (INV-012)** |
| Read single row | no (v1 deprecated) | **yes** (GET /v3/tables/{id}/records/{recordId}) | **v3 working (INV-012)** |
| Write table rows | no (v1 deprecated) | **yes** (POST /v3/tables/{id}/records) | **v3 working** |
| Update table rows | no (v1 deprecated) | **yes** (PATCH /v3/tables/{id}/records) | **v3 working (async)** |
| Row deletion | no (v1 deprecated) | **yes** (DELETE /v3/tables/{id}/records) | **v3 working** |
| Row pagination | no (v1 deprecated) | **partial** (no cursor/offset; use limit=10000 workaround) | **RESOLVED (INV-014)**: limit=10000 returns all rows. No cursor/page/offset mechanism. Default limit=100. |
| Trigger enrichments | no (v1 deprecated) | yes (targeted, fieldIds + runRecords) | **v3 working** |
| Read table metadata | no (v1 deprecated) | yes (full schema) | **v3 working** |
| Webhook data ingestion | n/a | **yes** (POST to source webhook URL) | **v3 working** |

## Schema Operations

| Capability | Official v1 | Internal v3 | Status |
|---|---|---|---|
| Read full table schema | partial (metadata only) | yes (fields + views + sources + abilities) | **working** |
| Create text columns | no | yes | **working** |
| Create formula columns | no | yes | **working** |
| Create action columns (enrichment) | no | **yes** | **working — confirmed via pipeline rebuild** |
| Create action columns (route-row) | no | **yes** | **WORKING (Session 12)** — actionPackageId `b1ab3d5d-b0db-4b30-9251-3f32d8b103c1`, inputsBinding with tableId + rowData formulaMap. Auto-creates source + formula columns on target. |
| Create source columns | no | yes (two-step or auto via route-row) | **working** |
| Update/rename columns | no | yes (PATCH) | **working** |
| Update formula text | no | yes (PATCH typeSettings.formulaText) | **working** |
| Update action config | no | yes (PATCH typeSettings.inputsBinding) | **working** |
| Delete columns | no | yes (DELETE) | **working** |
| Reorder columns | no | **yes** (via view field order in PATCH /v3/tables/{id}/views/{viewId}) | **working (INV-015)** — per-view field order |
| Create view | no | **yes** (`POST /v3/tables/{id}/views`) | **working (INV-015)** |
| Update/rename view | no | **yes** (`PATCH /v3/tables/{id}/views/{viewId}`) | **working (INV-015)** |
| Export schema | no | yes (via get_table + transform) | **implementable** |
| Import schema | no | yes (via create_field + resolution) | **implementable** |

## Table & Workbook Lifecycle

| Capability | Official v1 | Internal v3 | Status |
|---|---|---|---|
| List tables in workspace | no | yes (`GET /v3/workspaces/{id}/tables`) | **working** |
| List workbooks in workspace | no | **yes** (`GET /v3/workspaces/{id}/workbooks`) | **working (discovered 2026-04-06)** |
| Create new table | no | yes (`POST /v3/tables`) | **working** |
| Create table in specific workbook | no | yes (`POST /v3/tables` with `workbookId`) | **working** |
| Rename/update table | no | yes (`PATCH /v3/tables/{id}`) | **working** |
| Delete table | no | yes (`DELETE /v3/tables/{id}`) | **working** |
| Duplicate table | no | **yes** (`POST /v3/tables/{id}/duplicate`) | **working (INV-016)** |
| Duplicate workbook | no | **yes** (`POST /v3/workbooks/{id}/duplicate`) | **working (INV-016)** |
| Create workbook | no | **yes** (`POST /v3/workbooks`) | **working (INV-016)** |
| Workbook CRUD | no | **partial** (create + duplicate + list work; GET/PATCH/DELETE individual 404) | **partially available (INV-016)** |

## Scheduling

| Capability | Official v1 | Internal v3 | Status |
|---|---|---|---|
| Schedule table runs (cron) | no | **no** | **NOT AVAILABLE (INV-022)** — `tableSettings.schedule`/`cronExpression`/`scheduleEnabled`/`nextRunAt`/`runFrequency` all PERSIST via merge but are pure UI scratch space; backend scheduler does not read them. `HAS_SCHEDULED_RUNS` is server-controlled (PATCH override silently dropped back to false). 16 candidate `/v3/*schedul*`, `/v3/triggers`, `/v3/jobs`, `/v3/recurring-jobs` paths all 404. Workaround: external cron → `PATCH /v3/tables/{id}/run`. |
| Schedule source runs | no | **no** | **NOT AVAILABLE (INV-022)** — source `typeSettings` is validated and 500s on any schedule key (unlike tableSettings). Top-level source PATCH schedule fields silently no-op (200, no persistence). Trigger-source production examples carry no schedule state on the source object. |

## Source/Webhook Management

| Capability | Official v1 | Internal v3 | Status |
|---|---|---|---|
| Create source | no | yes (`POST /v3/sources`) | **working** |
| Read source details | no | yes (`GET /v3/sources/{id}`) | **working** |
| Read webhook URL | no | yes (in `state.url`) | **working (INV-009)** |
| List all sources | no | yes (`GET /v3/sources?workspaceId=`) | **working** |
| Update source | no | yes (`PATCH /v3/sources/{id}`) | **working** |
| Delete source | no | yes (`DELETE /v3/sources/{id}`) | **working (INV-009)** |

## Enrichment Configuration

| Capability | Official v1 | Internal v3 | Status |
|---|---|---|---|
| List enrichment actions | no | yes (1,191 actions, 170+ providers) | **working** |
| Create enrichment column | no | **yes** (POST fields with actionKey + actionPackageId + inputsBinding) | **working — confirmed with real enrichments** |
| Create route-row column | no | **yes** (actionKey: "route-row") | **WORKING (Session 12)** — correct actionPackageId required. Supports rowData (formulaMap), listData, nestedData. |
| Create action package | no | yes (`POST /v3/actions`) | **endpoint confirmed, definition format unknown** |
| List connected auth accounts | no | **yes** (`GET /v3/app-accounts`) | **working (INV-010)** |
| Read authAccountId | no | **yes** (id field from /v3/app-accounts) | **working (INV-010)** |
| Targeted enrichment trigger | no | yes (`PATCH /v3/tables/{id}/run`) | **working** |

## Workspace/Account

| Capability | Official v1 | Internal v3 | Status |
|---|---|---|---|
| Get workspace details | no | yes (billing, credits, features, abilities) | **working** |
| Get credit balance | no | yes (`credits: {basic: N, actionExecution: N}`) | **working (real-time)** |
| List all workspaces | no | no (requires admin, 403) | **not available for regular users** |
| Get current user | no | yes (`GET /v3/me`, includes API token) | **working** |
| Import history | no | yes (`GET /v3/imports?workspaceId=`) | **working** |
| Create import job | no | **yes** (`POST /v3/imports` with S3_CSV source) | **working (INV-020 + INV-021)** — synchronous; consume freshly uploaded S3 key from multipart-upload flow |
| Get import status | no | **yes** (`GET /v3/imports/{importId}`) | **working (INV-020)** |
| CSV upload (file → S3) | no | **yes** (`POST /v3/imports/{workspaceId}/multi-part-upload` → S3 PUT → `/multi-part-upload/complete`) | **working (INV-021)** — full 4-step flow verified end-to-end. Returns presigned S3 PUT URLs split into 50MB parts. Uses bucket `clay-base-import-prod` with `toS3CSVImportBucket:true`. Max file size 15 GB. |
| Generic file upload (file-drop bucket) | no | **yes** (same `/v3/imports/{workspaceId}/multi-part-upload` with `toS3CSVImportBucket:false`) | **working (INV-021)** — uploads to `file-drop-prod` bucket; not consumable by POST /v3/imports but useful for action attachments |
| Workflows CSV upload | no | **yes** (`POST /v3/workspaces/{wsId}/tc-workflows/{wfId}/batches/csv-upload-url`) | **working (INV-023)** — returns S3 POST policy `{uploadUrl, fields, uploadToken}`; caller does multipart/form-data POST (fields first, file last) to `clay-base-import-prod`, S3 returns 204. `uploadToken` feeds into `createWorkflowRunBatch` (INV-024). |
| Workflow run batch — create | no | **yes** (`POST /v3/workspaces/{wsId}/tc-workflows/{wfId}/batches`) | **working (INV-024)** — body `{workflowSnapshotId:'latest', type:'csv_import', csvUploadToken, config?}`. Returns `{batch}` with server-resolved `wfs_...` snapshot id and `config.parameterNames` parsed from CSV header. Empty workflow → batch fails in <500ms with `totalRuns=0` (zero credits). Discriminator alt: `type:'cpj_search'` (no upload token, untested). |
| Workflow run batch — list | no | **yes** (`GET /v3/workspaces/{wsId}/tc-workflows/{wfId}/batches`) | **working (INV-024)** — query `{limit?, offset?, status?}` |
| Workflow run batch — get | no | **yes** (`GET /v3/workspaces/{wsId}/tc-workflows/{wfId}/batches/{batchId}`) | **working (INV-024)** — used for status polling |
| Workflow run batch — update / cancel | no | **yes** (`PATCH /v3/workspaces/{wsId}/tc-workflows/{wfId}/batches/{batchId}`) | **working (INV-025)** — body `{status?, config?, state?}`. PATCH `{status:'cancelled'}` verified end-to-end on a pending csv_import batch. Must beat the ~430ms auto-fail race for empty workflows; for non-empty workflows the cancel window is much longer. |
| Workflow run batch — delete | no | **yes** (`DELETE /v3/workspaces/{wsId}/tc-workflows/{wfId}/batches/{batchId}`, body `{}` required) | **working (INV-024)** |
| Workflow runs for batch — list | no | **yes** (`GET /v3/workspaces/{wsId}/tc-workflows/{wfId}/batches/{batchId}/runs`) | **working (INV-024)** — query `{limit?, offset?}` |
| Documents upload (RAG/embedding) | no | **yes** (`POST /v3/documents/{wsId}/upload-url` → S3 POST → `POST /v3/documents/{wsId}/{docId}/confirm-upload`) | **working (INV-023)** — 3-step flow verified. Returns `{documentId, uploadUrl, fields}`, POSTs to `file-drop-prod` bucket, then `confirm-upload` (empty body) returns full document record with mimeType/size/context. Default context is `agent_playground`. |
| List workflows | no | **yes** (`GET /v3/workspaces/{wsId}/tc-workflows`) | **working (INV-023)** |
| Create workflow | no | **yes** (`POST /v3/workspaces/{wsId}/tc-workflows` with `{name, defaultModelId?}`) | **working (INV-023)** |
| Delete workflow | no | **yes** (`DELETE /v3/workspaces/{wsId}/tc-workflows/{wfId}`, body `{}` required) | **working (INV-023)** |
| Workflow graph (read + validation) | no | **yes** (`GET /v3/workspaces/{wsId}/tc-workflows/{wfId}/graph`) | **working (INV-025)** — returns `{nodes, edges, validation:{isValid,errors,warnings,suggestions}, workflowInputVariables}`. Server-side static analysis (terminal nodes need outputs, regular nodes need model+prompt, etc.) — free pre-flight check. |
| Workflow node — create | no | **yes** (`POST /v3/workspaces/{wsId}/tc-workflows/{wfId}/nodes`) | **working (INV-025)** — body `{name<=255, description?, nodeType:'regular'\|'code'\|'conditional'\|'map'\|'reduce'\|'tool', modelId?, promptVersionId?, position?, isInitial?, isTerminal?}`. Inert `regular` nodes (no model/prompt) are credit-safe scratch resources. |
| Workflow node — update | no | **yes** (`PATCH /v3/workspaces/{wsId}/tc-workflows/{wfId}/nodes/{nodeId}`) | **working (INV-025)** — many optional fields incl. `source` (prompt_version\|inline_prompt\|input_schema discriminated), `toolIds`, `subroutineIds`, `inlineScript`, `nodeConfig`, `interventionSettings`, `retryConfig`. |
| Workflow node — batch reposition | no | **yes** (`PATCH /v3/workspaces/{wsId}/tc-workflows/{wfId}/nodes`) | **working (INV-025)** — body `{updates:[{nodeId,position}]}`. Layout autosave. |
| Workflow node — delete | no | **yes** (`DELETE .../nodes/{nodeId}` body `{}`) | **working (INV-025)** |
| Workflow node — batch delete | no | **yes** (`DELETE .../nodes` body `{nodeIds[]}`) | **working (INV-025)** — returns `{deletedCount,success}` |
| Workflow node — duplicate | no | **suspected** (`POST .../nodes/{nodeId}/duplicate` body `{position?}`) | bundle-extracted, not exercised |
| Workflow code node — download | no | **suspected** (`GET .../nodes/{nodeId}/code/download`) | bundle-extracted, returns raw Python source |
| Workflow edge — create | no | **yes** (`POST /v3/workspaces/{wsId}/tc-workflows/{wfId}/edges`) | **working (INV-025)** — body `{sourceNodeId, targetNodeId, metadata?:{conditionalSourceHandle?}}` |
| Workflow edge — update | no | **suspected** (`PATCH .../edges/{edgeId}`) | bundle-extracted, body `{metadata:{handoffConfig?}}` |
| Workflow edge — delete | no | **yes** (`DELETE .../edges/{edgeId}` body `{}`) | **working (INV-025)** |
| Workflow snapshot — list | no | **yes** (`GET /v3/workspaces/{wsId}/tc-workflows/{wfId}/snapshots`) | **working (INV-025)** — server-managed; auto-created by `createWorkflowRunBatch` with `workflowSnapshotId='latest'`. Empty until first batch. |
| Workflow snapshot — get | no | **yes** (`GET .../snapshots/{snapshotId}`) | **working (INV-025)** — returns `{snapshot:{id,workflowId,content:{nodes,edges,workflow,containsCycles},hash (sha256),createdAt,updatedAt}}` |
| Workflow snapshot — create explicitly | no | **no** | No `publishWorkflow` / `createSnapshot` route exists. Snapshots are produced as a side effect of `createWorkflowRunBatch`. |
| Workflow — create from snapshot | no | **suspected** (`POST /v3/workspaces/{wsId}/tc-workflows/from-snapshot/{snapshotId}` body `{name}`) | bundle-extracted |
| Workflow — restore from snapshot | no | **suspected** (`POST .../tc-workflows/{wfId}/restore/{snapshotId}`) | bundle-extracted |
| Workflow — duplicate | no | **suspected** (`POST .../tc-workflows/{wfId}/duplicate` body `{name}`) | bundle-extracted |
| Workflow — create from preset | no | **suspected** (`POST .../tc-workflows/from-preset/{presetId}` body `{name}`) | bundle-extracted |
| Workflow run (direct) — create | no | **yes** (`POST /v3/workspaces/{wsId}/tc-workflows/{wfId}/runs`) | **working (INV-026)** — body `{inputs?:object, batchId?:string, standaloneActions?:object}`. Starts executing immediately; auto-resolves `'latest'` snapshot. Router is `Swe` (INV-025 guessed "Ewe", wrong name). `standaloneActions` is an object not an array — 400 if array. |
| Workflow run (direct) — list | no | **yes** (`GET /v3/workspaces/{wsId}/tc-workflows/{wfId}/runs`) | **working (INV-026)** — query `{limit,offset}` |
| Workflow run (direct) — get with steps | no | **yes** (`GET /v3/workspaces/{wsId}/tc-workflows/{wfId}/runs/{runId}`) | **working (INV-026)** — returns discriminated `{type:'current', workflowRun, workflowRunSteps, workflowSnapshot}` or `{type:'archived', archivedAgentRun}`. Full step telemetry: prompts, tool calls, reasoning, token usage. |
| Workflow run (direct) — pause | no | **yes** (`POST .../runs/{runId}/pause` body `{}`) | **working (INV-026)** — 400 on runs in terminal state |
| Workflow run (direct) — unpause | no | **yes** (`POST .../runs/{runId}/unpause` body `{}`) | **working (INV-026)** — 400 on non-paused runs |
| Workflow run (direct) — cancel/delete | no | **no** | There is NO cancel or delete on the direct-runs router. To cancel, wrap the invocation in a 1-row csv_import batch and PATCH the batch instead. |
| Workflow run step — continue (HITL) | no | **yes** (`POST .../runs/{runId}/steps/{stepId}/continue`) | **working route (INV-026)** — body `{humanFeedbackInput:discriminated ApproveToolCall\|DenyToolCall\|DenyTransition\|...}`. 404 on fake stepId confirms route active; HITL happy path deferred to GAP-035. |
| Workflow waiting steps — list | no | **yes** (`GET /v3/workspaces/{wsId}/tc-workflows/{wfId}/steps/waiting`) | **working (INV-026)** — returns `{waitingSteps:[{stepId,runId,nodeName,waitingSince,callbackData,stepInputs?,stepOutputs?}]}`. `callbackData` discriminated on 10 variants (human_input_tool_decision, async_tool_execution, max_uninterrupted_steps_reached, wait_tool_execution, code/tool_node_execution_*, ...). |
| Workflow run stream — create | no | **yes** (`POST /v3/workspaces/{wsId}/tc-workflows/{wfId}/streams`) | **working (INV-027)** — body `{workflowSnapshotId, streamType:'webhook'\|'agent_action'\|'workflow_action', name, config, status?='active'}`. Router is `lKe` (INV-025/026 guess "sKe" was the request body schema, not the router). For `streamType='webhook'`, response includes `webhookUrl: https://api.clay.com/tc-workflows/streams/{id}/webhook`. |
| Workflow run stream — list / get / update / delete | no | **yes** (`GET/GET/PATCH/DELETE .../streams[/{streamId}]`) | **working (INV-027)** — full CRUD. PATCH `{status:'paused'}` blocks ingestion (`postWebhook` returns 400 'Stream is not active'). DELETE is soft-delete (sets `deletedAt`; spawned runs survive). |
| Workflow run stream — list runs | no | **yes** (`GET .../streams/{streamId}/runs`) | **working (INV-027)** — same `Q_` WorkflowRun shape as direct/batch runs; query `{limit?, offset?, status?}`. New runs have `streamId` set and `batchId:null`. |
| Workflow run stream — webhook ingestion (single) | no | **yes — UNAUTHENTICATED** (`POST /v3/tc-workflows/streams/{streamId}/webhook`) | **working end-to-end (INV-027, auth re-verified INV-028)** — root path, no `/workspaces/{ws}` prefix. **Completely unauthenticated**: 202 Accepted with zero auth headers (INV-028 pass 2). streamId is the bearer. Body is arbitrary JSON, becomes `runState.inputs` verbatim. Lifecycle: webhook → run → `running → completed` in ~7 s on inert 2-node graph. Errors: 400 (paused), 404 (bad streamId), 429 (retryAfter). **Bug**: Clay returns `webhookUrl` without `/v3` prefix in stream-create responses, but that URL 404s — consumers must rewrite to prepend `/v3`. |
| Workflow run stream — webhook ingestion (batch) | no | **no — internal only** (`POST /v3/tc-workflows/streams/{streamId}/webhook/batch`) | **INTERNAL-ONLY (INV-028)** — bundle-confirmed body `{items:[{entityId?, backfillId?, requestData}]}`; Zod validation passes but auth layer rejects every user-facing scheme (11 header forms × 4 API-key scope sets, all 401; cookies + canonical body 403). No frontend caller for this route in the bundle. Route is reserved for Clay's own async workers doing backfill ingestion; not usable from the proprietary layer. Use single-webhook endpoint in a loop instead. GAP-036 closed. |
| Clay API key CRUD | no | **yes** (`GET/POST/PATCH/DELETE /v3/api-keys[/{apiKeyId}]`) | **working (INV-028)** — router `TRe`, all session-cookie-authed. Create body `{name, resourceType:'user', resourceId:<userId>, scope:{routes:Kb[], workspaceId?}}` returns 200 with plaintext `apiKey` exposed ONCE (matches UI modal copy). Scope enum: `all`, `endpoints:run-enrichment`, `endpoints:prospect-search-api`, `terracotta:cli`, `terracotta:code-node`, `terracotta:mcp`, `public-endpoints:all`. UI exposes only 3 of 7 scopes; the `terracotta:*` family including `terracotta:mcp` (GAP-038) is direct-API-only. Minted key ids are `ak_`-prefixed. Credit cost: zero. Replaces the previous 'purpose unclear' placeholder row. |
| `cpj_search` batch type | no | **no — server stub** (`POST .../batches type:'cpj_search'`) | **NOT YET IMPLEMENTED (INV-025)** — server returns 405 `"CPJ Search batch type is not yet implemented"`. The discriminator + React UI exist but the handler is stubbed. Re-probe after future bundle drops. |
| Delete document | no | **yes** (`DELETE /v3/documents/{wsId}/{docId}?hard=true`) | **working (INV-023)** |
| CSV export | no | **yes** (`POST /v3/tables/{id}/export` → async job) | **working (INV-017)** — creates job with ej_xxx ID, status: ACTIVE |
| API key management | no | yes (`GET/POST/PATCH/DELETE /v3/api-keys[/{id}]`) | **working end-to-end (INV-028)** — see Workflows row above for full router details. |

## Authentication

| Capability | Method | Status |
|---|---|---|
| API key auth (v1) | `Authorization: Bearer <key>` | **deprecated / non-functional** |
| Session cookie auth (v3) | `Cookie: claysession=<value>` | **working** |
| Session auto-refresh | Cookie refreshes via set-cookie on every call | **confirmed (7-day rolling)** |
| Frontend version header | Optional (all calls succeed without it) | **confirmed optional** |

## Rate Limits

| Observation | Value |
|---|---|
| Tested rate | 50 requests, zero delay |
| 429 responses | 0 out of 50 |
| Rate-limit headers | None observed |
| Average latency | 21ms |
| Recommended pacing | None required (50ms for courtesy) |

## Route-Row Mechanics (discovered 2026-04-06)

| Behavior | Details |
|---|---|
| Auto-creates source on target | When route-row targets a table, Clay auto-creates a source field + formula columns for each `rowData` key |
| Source merging | If target already has a source from another route-row, new source ID is added to existing `sourceIds` array |
| List mode | `type: "list"` + `listData` creates one row per list item; `rowData` becomes `parent` context |
| Parent access | `{{source}}?.parent?.["Key Name"]` reads from the `rowData` of the route-row that created the row |
| Required fields | `tableId` (formulaText with literal string), `rowData` (formulaMap with field references) |
