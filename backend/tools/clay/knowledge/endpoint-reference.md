# Clay v3 Endpoint Reference

Comprehensive index of every Clay v3 API endpoint reverse-engineered as of 2026-04-07. **103 confirmed + 9 suspected + 8 untested + 6 deprecated.** Use this when you need to call something that isn't wrapped as a dedicated `clay_*` tool.

For tools wrapped today, prefer the dedicated tool over `http_request`. For everything else, use `http_request` with the path below — the auth header for clay endpoints is `Cookie: claysession=…` (the runtime injects it; do not pass an `Authorization: Bearer …` header to `api.clay.com` — that's wrong for v3).

For category-level details, request shapes, and gotchas, fetch the focused doc:
- Workflows: `read_tool_doc(clay, workflows)`
- CSV export: `read_tool_doc(clay, csv-export)`
- Views: `read_tool_doc(clay, views)`
- Documents: `read_tool_doc(clay, documents)`
- Admin / users / credits / api keys: `read_tool_doc(clay, admin)`

For full request/response shapes and discovery notes, see [clay-bleeding-edge-api-research/registry/endpoints.jsonl](../../../../clay-bleeding-edge-api-research/registry/endpoints.jsonl).

## Auth
- All `/v3/*` endpoints use `Cookie: claysession=…`. Auto-injected by the dedicated `clay_*` tools and by `http_request` against `api.clay.com`.
- The unauthenticated exception is `POST /v3/tc-workflows/streams/{streamId}/webhook` (the streamId is the bearer).
- v1 endpoints (`/api/v1/*`) are deprecated and return errors. Do not use.

## Tables and Workbooks

```
GET    /v3/tables/{tableId}                            — get table schema (fields + views + sources + abilities)
PATCH  /v3/tables/{tableId}                            — update table (name, settings); pass workbookId to move
DELETE /v3/tables/{tableId}                            — delete table
POST   /v3/tables                                       — create table (also supports duplicateFromTableId)
POST   /v3/tables/{tableId}/duplicate                  — duplicate table (schema only, NO rows)
POST   /v3/tables/{tableId}/export                     — start CSV export job → returns {id (ej_…)}
GET    /v3/exports/{exportJobId}                       — poll export job; FINISHED → uploadedFilePath populated
PATCH  /v3/tables/{tableId}/run                        — trigger enrichment on specific fields/records
GET    /v3/workspaces/{workspaceId}/tables             — list tables in workspace

POST   /v3/workbooks                                    — create workbook
POST   /v3/workbooks/{workbookId}/duplicate            — duplicate entire workbook
GET    /v3/workspaces/{workspaceId}/workbooks          — list workbooks
```

Workbook GET/PATCH/DELETE for individual workbooks all 404 — only create + duplicate + list work at the workbook level.

## Columns (fields)

```
POST   /v3/tables/{tableId}/fields                      — create column (text/formula/action/source/route-row)
PATCH  /v3/tables/{tableId}/fields/{fieldId}           — update column (rename, change typeSettings)
DELETE /v3/tables/{tableId}/fields/{fieldId}           — delete column
```

## Rows (records)

```
GET    /v3/tables/{tableId}/views/{viewId}/records      — read rows (limit works; offset accepted but ignored)
GET    /v3/tables/{tableId}/records/{recordId}          — read single row
POST   /v3/tables/{tableId}/records                     — write rows (body: {records: [{cells: {fieldId: value}}]})
PATCH  /v3/tables/{tableId}/records                     — update rows (async)
DELETE /v3/tables/{tableId}/records                     — delete rows (body: {recordIds: [...]})
```

## Views

```
POST   /v3/tables/{tableId}/views                      — create view (name only; filter/sort PATCH not yet figured out)
PATCH  /v3/tables/{tableId}/views/{viewId}             — update view (rename works; filter/sort accepted but null)
DELETE /v3/tables/{tableId}/views/{viewId}             — delete view (cannot delete the last view)
```

## Sources & webhooks

```
GET    /v3/sources?workspaceId={id}                     — list sources
POST   /v3/sources                                      — create source (webhook)
GET    /v3/sources/{sourceId}                          — get source (state.url has webhook URL)
PATCH  /v3/sources/{sourceId}                          — update source
DELETE /v3/sources/{sourceId}                          — delete source
```

## Enrichment

```
GET    /v3/actions?workspaceId={id}                    — list 1,191 enrichment actions (full schemas)
POST   /v3/actions                                      — create action package (definition format unknown)
GET    /v3/app-accounts                                 — list connected auth accounts
PATCH  /v3/tables/{tableId}/run                        — trigger enrichment (also under Tables above)
```

## CSV import (multi-step S3 upload)

```
POST   /v3/imports/{workspaceId}/multi-part-upload      — start multi-part upload, returns presigned PUT URLs
POST   /v3/imports/{workspaceId}/multi-part-upload/complete — finalize upload
POST   /v3/imports                                      — create import job from S3 key
GET    /v3/imports/{importId}                          — poll import job status
GET    /v3/imports?workspaceId={id}                    — list past import jobs
```

Bucket: `clay-base-import-prod` for table imports. Max 15 GB.

## Documents (RAG)

```
POST   /v3/documents/{workspaceId}/upload-url           — start upload, returns S3 POST policy
POST   /v3/documents/{workspaceId}/{documentId}/confirm-upload — finalize after S3 PUT
DELETE /v3/documents/{workspaceId}/{documentId}        — delete (?hard=true&deleteContents=true)
```

Bucket: `file-drop-prod`.

## Workflows (tc-workflows) — 33 endpoints

### Workflow CRUD
```
GET    /v3/workspaces/{wsId}/tc-workflows
POST   /v3/workspaces/{wsId}/tc-workflows
PATCH  /v3/workspaces/{wsId}/tc-workflows/{wfId}
DELETE /v3/workspaces/{wsId}/tc-workflows/{wfId}                           (body {})
POST   /v3/workspaces/{wsId}/tc-workflows/{wfId}/duplicate                 [suspected]
POST   /v3/workspaces/{wsId}/tc-workflows/from-snapshot/{snapshotId}       [suspected]
POST   /v3/workspaces/{wsId}/tc-workflows/from-preset/{presetId}           [suspected]
POST   /v3/workspaces/{wsId}/tc-workflows/{wfId}/restore/{snapshotId}      [suspected]
```

### Graph (nodes + edges)
```
GET    /v3/workspaces/{wsId}/tc-workflows/{wfId}/graph                     — read graph + free static validation
POST   /v3/workspaces/{wsId}/tc-workflows/{wfId}/nodes                     — create node
PATCH  /v3/workspaces/{wsId}/tc-workflows/{wfId}/nodes/{nodeId}            — update node
DELETE /v3/workspaces/{wsId}/tc-workflows/{wfId}/nodes/{nodeId}            — delete node (body {})
PATCH  /v3/workspaces/{wsId}/tc-workflows/{wfId}/nodes                     — batch reposition
DELETE /v3/workspaces/{wsId}/tc-workflows/{wfId}/nodes                     — batch delete (body {nodeIds[]})
POST   /v3/workspaces/{wsId}/tc-workflows/{wfId}/nodes/{nodeId}/duplicate  [suspected]
GET    /v3/workspaces/{wsId}/tc-workflows/{wfId}/nodes/{nodeId}/code/download [suspected]
POST   /v3/workspaces/{wsId}/tc-workflows/{wfId}/edges                     — create edge
PATCH  /v3/workspaces/{wsId}/tc-workflows/{wfId}/edges/{edgeId}            [suspected]
DELETE /v3/workspaces/{wsId}/tc-workflows/{wfId}/edges/{edgeId}            — delete edge (body {})
```

### Snapshots (read-only, server-managed)
```
GET    /v3/workspaces/{wsId}/tc-workflows/{wfId}/snapshots
GET    /v3/workspaces/{wsId}/tc-workflows/{wfId}/snapshots/{snapshotId}
```

### Direct runs
```
POST   /v3/workspaces/{wsId}/tc-workflows/{wfId}/runs                       — start run
GET    /v3/workspaces/{wsId}/tc-workflows/{wfId}/runs                       — list runs
GET    /v3/workspaces/{wsId}/tc-workflows/{wfId}/runs/{runId}              — get run + steps
POST   /v3/workspaces/{wsId}/tc-workflows/{wfId}/runs/{runId}/pause
POST   /v3/workspaces/{wsId}/tc-workflows/{wfId}/runs/{runId}/unpause
POST   /v3/workspaces/{wsId}/tc-workflows/{wfId}/runs/{runId}/steps/{stepId}/continue  — HITL
GET    /v3/workspaces/{wsId}/tc-workflows/{wfId}/steps/waiting             — list HITL-waiting steps
```

**No cancel/delete on direct runs.** Wrap in a 1-row csv_import batch and PATCH the batch to cancel.

### Batches (CSV-driven runs)
```
POST   /v3/workspaces/{wsId}/tc-workflows/{wfId}/batches/csv-upload-url    — get S3 POST policy
POST   /v3/workspaces/{wsId}/tc-workflows/{wfId}/batches                    — create batch from uploaded CSV
GET    /v3/workspaces/{wsId}/tc-workflows/{wfId}/batches
GET    /v3/workspaces/{wsId}/tc-workflows/{wfId}/batches/{batchId}
PATCH  /v3/workspaces/{wsId}/tc-workflows/{wfId}/batches/{batchId}         — supports {status: 'cancelled'}
DELETE /v3/workspaces/{wsId}/tc-workflows/{wfId}/batches/{batchId}         — soft delete
GET    /v3/workspaces/{wsId}/tc-workflows/{wfId}/batches/{batchId}/runs
```

### Streams (webhook-driven runs)
```
POST   /v3/workspaces/{wsId}/tc-workflows/{wfId}/streams
GET    /v3/workspaces/{wsId}/tc-workflows/{wfId}/streams
GET    /v3/workspaces/{wsId}/tc-workflows/{wfId}/streams/{streamId}
PATCH  /v3/workspaces/{wsId}/tc-workflows/{wfId}/streams/{streamId}
DELETE /v3/workspaces/{wsId}/tc-workflows/{wfId}/streams/{streamId}        — soft delete
GET    /v3/workspaces/{wsId}/tc-workflows/{wfId}/streams/{streamId}/runs
POST   /v3/tc-workflows/streams/{streamId}/webhook                         — UNAUTHENTICATED ingestion
POST   /v3/tc-workflows/streams/{streamId}/webhook/batch                   — INTERNAL ONLY (don't use)
```

## Workspace, users, credits

```
GET    /v3/workspaces/{workspaceId}                    — workspace details + credits + features
GET    /v3/workspaces/{workspaceId}/users              — list workspace members
GET    /v3/me                                          — current user (includes API token)
GET    /v3/workspaces/{workspaceId}/permissions        — list permissions (most ops require admin)
GET    /v3/workspaces/{workspaceId}/signals            — signals subsystem (not yet documented)
GET    /v3/workspaces/{workspaceId}/signals/{signalId}
GET    /v3/workspaces/{workspaceId}/resource-tags
POST   /v3/workspaces/{workspaceId}/resource-tags
DELETE /v3/workspaces/{workspaceId}/resource-tags/{tagId}
GET    /v3/attributes                                  — attributes catalog
GET    /v3/presets                                     — preset catalog
```

## API keys

```
GET    /v3/api-keys                                    — list (router TRe)
POST   /v3/api-keys                                    — mint key (plaintext returned ONCE)
PATCH  /v3/api-keys/{apiKeyId}                         [suspected]
DELETE /v3/api-keys/{apiKeyId}
```

Scope enum: `all | endpoints:run-enrichment | endpoints:prospect-search-api | terracotta:cli | terracotta:code-node | terracotta:mcp | public-endpoints:all`. UI exposes only 3 of 7 scopes; the `terracotta:*` family is direct-API-only.

## What does NOT exist (don't waste time trying)

- `GET/PATCH/DELETE /v3/workbooks/{id}` — individual workbook operations 404. Only create + duplicate + list work.
- `PATCH /v3/tc-workflows/{wfId}/runs/{runId}` and `DELETE` — direct runs are append-only.
- Schedule fields on `tableSettings` (`cronExpression`, `nextRunAt`, etc.) — accepted by the merge but the backend scheduler doesn't read them. UI scratch space only. Same for sources.
- `GET /v3/exports/csv` — `csv` is parsed as a job ID, returns 404.
- `POST .../tc-workflows/{wfId}/batches type:'cpj_search'` — server stub, returns 405.
- `POST /v3/tc-workflows/streams/{streamId}/webhook/batch` from outside Clay — internal-only, every user-facing auth scheme returns 401/403.
- All `/api/v1/*` endpoints — v1 is deprecated and non-functional.
