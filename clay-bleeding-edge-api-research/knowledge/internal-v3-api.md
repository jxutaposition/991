# Clay Internal v3 API Reference

Last updated: 2026-04-07 (post INV-027 — tc-workflows streams + webhook ingestion)
Source: Originally reverse-engineered from Claymate Lite. Expanded via enumeration (INV-006), validation (INV-007), systematic gap investigation (INV-013–017), and the INV-020 through INV-027 sweep covering imports, multipart uploads, and the full tc-workflows surface (CRUD, graph, batches, direct runs, streams, webhook ingestion).

**Canonical endpoint registry**: `registry/endpoints.jsonl` (110 entries). This file documents the most important endpoints in detail. For the full list, always check the registry.

## Overview

Clay's React frontend communicates with its backend via an internal REST API at `https://api.clay.com/v3`. This API is not publicly documented but is stable enough for the Claymate Lite Chrome extension (22+ stars, MIT licensed) to ship against.

The v3 API supports **full table lifecycle CRUD** including table creation/deletion/duplication, column creation/update/deletion, row creation/reading/update/deletion (via `/records`), view creation/rename, source management, enrichment triggering, table listing, workbook creation/duplication, actions catalog, CSV export jobs, and import history. With the v1 API now fully deprecated, v3 is the **only** functional API layer. **57 endpoints documented, 38+ confirmed working** as of Session 4.

## Authentication

**Method**: Session cookie named `claysession` on `.api.clay.com`

**Cookie details** (confirmed in INV-007):
- **Name**: `claysession`
- **Domain**: `.api.clay.com` (NOT `.clay.com` or `app.clay.com`)
- **Format**: Express/connect-session signed cookie: `s:<session_id>.<signature>` (URL-encoded as `s%3A...`)
- **Lifetime**: 7 days from issuance
- **Flags**: HttpOnly, Secure, SameSite=None

**Browser usage** (how Claymate does it):
```javascript
fetch(`${API_BASE}${endpoint}`, {
  ...options,
  credentials: 'include',  // sends claysession cookie
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'X-Clay-Frontend-Version': window.clay_version || 'unknown',
    ...options.headers
  }
});
```

**Server-side usage** (confirmed working):
```bash
curl -H "Cookie: claysession=s%3A<session_id>.<signature>" \
     -H "Accept: application/json" \
     "https://api.clay.com/v3/me"
```

Key points:
- Only the `claysession` cookie is required — no other cookies needed
- `X-Clay-Frontend-Version` header is optional for most endpoints (confirmed by testing without it)
- Current frontend version discoverable via `GET /v3` (no auth needed)
- Sessions established by logging into `app.clay.com` via Google SSO (or email/password)

**Extracting the cookie**: In browser DevTools → Application → Cookies → filter by `api.clay.com` (not `app.clay.com`) → copy `claysession` value. See `timeline/2026-04-05_breakthrough-session.md` for detailed instructions.

## Confirmed Endpoints

### GET /v3/tables/{tableId}

Returns the full table data including all fields and grid views.

**Request**:
```
GET https://api.clay.com/v3/tables/t_abc123
Cookie: [SESSION_COOKIES]
X-Clay-Frontend-Version: ...
```

**Response** (abbreviated):
```json
{
  "fields": [
    {
      "id": "f_abc123",
      "name": "Website",
      "type": "text",
      "typeSettings": {
        "dataTypeSettings": {"type": "url"}
      }
    },
    {
      "id": "f_def456",
      "name": "Domain",
      "type": "formula",
      "typeSettings": {
        "formulaText": "DOMAIN({{f_abc123}})",
        "formulaType": "text",
        "dataTypeSettings": {"type": "text"}
      }
    }
  ],
  "gridViews": [
    {
      "id": "gv_xyz789",
      "fieldOrder": ["f_abc123", "f_def456"]
    }
  ]
}
```

**Notes**:
- Field references use internal IDs like `{{f_abc123}}` (not column names)
- `typeSettings` contains the full configuration: formulas, enrichment actions, data types
- `gridViews` define column ordering per view
- System fields `f_created_at` and `f_updated_at` are present but typically skipped
- May also include `table.fields` or `table.gridViews` nested under a `table` key

### POST /v3/tables/{tableId}/fields

Creates a new column/field on a table.

**Request**:
```
POST https://api.clay.com/v3/tables/t_abc123/fields
Cookie: [SESSION_COOKIES]
Content-Type: application/json

{
  "name": "Company Name",
  "type": "formula",
  "activeViewId": "gv_xyz789",
  "attributionData": {"created_from": "claymate_free_extension"},
  "typeSettings": {
    "formulaText": "{{f_enrichment_col}}?.name",
    "formulaType": "text",
    "dataTypeSettings": {"type": "text"}
  }
}
```

**Response** (abbreviated):
```json
{
  "field": {
    "id": "f_new123",
    "name": "Company Name",
    "type": "formula",
    "typeSettings": {...}
  }
}
```

**Type-specific payload requirements**:

**Text columns**:
```json
{
  "name": "Website",
  "type": "text",
  "typeSettings": {
    "dataTypeSettings": {"type": "text"}
  }
}
```

**Formula columns**:
```json
{
  "name": "Domain",
  "type": "formula",
  "typeSettings": {
    "formulaText": "DOMAIN({{f_abc123}})",
    "formulaType": "text",
    "dataTypeSettings": {"type": "text"}
  }
}
```

**Action (enrichment) columns**:
```json
{
  "name": "Company Data",
  "type": "action",
  "typeSettings": {
    "dataTypeSettings": {"type": "json"},
    "actionKey": "provider-action-name",
    "actionVersion": 1,
    "actionPackageId": "uuid-of-package",
    "useStaticIP": false,
    "inputsBinding": [
      {"name": "domain", "formulaText": "{{f_domain_col}}"}
    ],
    "authAccountId": "aa_account_id",
    "conditionalRunFormulaText": "{{f_score}}?.value > 50 && !!{{f_email}}"
  }
}
```

**Source columns**:
```json
{
  "name": "Webhook Source",
  "type": "source",
  "typeSettings": {
    "sourceIds": ["s_source_id"],
    "canCreateRecords": true
  }
}
```

**Notes**:
- `activeViewId` is required (the current grid view ID)
- `attributionData` is optional metadata
- Field references in formulas must use internal `{{f_xxx}}` IDs, not column names
- The response includes the newly created field's `id` which must be tracked for subsequent references
- Claymate Lite uses 150ms delays between field creation calls

### GET /v3/sources/{sourceId}

Reads details about a data source (webhook, find-people action, etc.).

**Request**:
```
GET https://api.clay.com/v3/sources/s_abc123
Cookie: [SESSION_COOKIES]
```

**Response** (abbreviated):
```json
{
  "id": "s_abc123",
  "name": "Webhook",
  "type": "webhook",
  "dataFieldId": "f_source_data",
  "typeSettings": {
    "hasAuth": false,
    "iconType": "Webhook"
  }
}
```

**Notes**:
- `dataFieldId` links the source to the field that receives source data
- `type` can be `webhook`, `v3-action`, and likely others
- Source details include `typeSettings` which vary by source type

### POST /v3/sources

Creates a new data source on a table.

**Request**:
```
POST https://api.clay.com/v3/sources
Cookie: [SESSION_COOKIES]
Content-Type: application/json

{
  "workspaceId": 12345,
  "tableId": "t_abc123",
  "name": "Webhook",
  "type": "v3-action",
  "typeSettings": {
    "hasAuth": false,
    "iconType": "Webhook"
  }
}
```

**Response**:
```json
{
  "id": "s_new123",
  "dataFieldId": "f_new_data",
  ...
}
```

**Notes**:
- `workspaceId` is a numeric ID (not a string prefix)
- `type` defaults to `v3-action` in Claymate Lite
- The response may nest under a `source` key
- `dataFieldId` may not be immediately available -- Claymate Lite does a follow-up GET to retrieve it

## URL Patterns

Clay's frontend URLs encode entity IDs:

| Entity | URL Pattern | ID Format |
|--------|-------------|-----------|
| Table | `/tables/t_abc123` | `t_` prefix + alphanumeric |
| View | `/views/gv_abc123` | `gv_` prefix + alphanumeric |
| Workspace | `/workspaces/12345` | Numeric |
| Field (internal) | N/A (not in URL) | `f_` prefix + alphanumeric |
| Source (internal) | N/A (not in URL) | `s_` prefix + alphanumeric |

## Field Reference System

Clay uses two reference systems:

**Internal references** (used in API calls):
- `{{f_abc123}}` -- reference a field by ID
- Used in `formulaText`, `inputsBinding`, `conditionalRunFormulaText`

**Portable references** (used by Claymate for export/import):
- `{{@Column Name}}` -- reference a field by name
- `{{@source:Source Name}}` -- reference a source's data field by source name
- Claymate converts between formats during export/import

## Data Type Settings

The `dataTypeSettings.type` field controls display:
- `text` -- plain text
- `url` -- clickable link
- `email` -- email format
- `number` -- numeric
- `boolean` -- checkbox
- `json` -- JSON object (for enrichment results)
- `select` -- dropdown options

## Rate Limiting

**CONFIRMED: No rate limiting observed (INV-008, INV-009)**

Empirical testing:
- 20 rapid-fire requests with zero delays: 0 out of 20 rate-limited (INV-008)
- 50 rapid-fire requests with zero delays: 0 out of 50 rate-limited (INV-009)
- Average latency: 20-21ms
- No `X-RateLimit` or `Retry-After` headers observed
- The 150ms Claymate baseline was a courtesy delay, not a requirement
- Safe to remove inter-call delays entirely for production use

## Additional Confirmed Endpoints (INV-006 + INV-007)

All confirmed working via authenticated API calls:

### GET /v3 — Public Status (no auth required)
Returns current frontend version and CASL auth abilities: `{"status":"ok","version":"v20260403_221301Z_9894a0108e",...}`

### POST /v3/tables — Table Creation
```json
{"workspaceId": 1080480, "type": "spreadsheet", "name": "My Table"}
```
Types: `spreadsheet`, `company`, `people`, `jobs`. Auto-creates a workbook. Returns full table with fields, views.

### DELETE /v3/tables/{tableId} — Table Deletion
Returns deleted table with `deletedAt` timestamp.

### PATCH /v3/tables/{tableId} — Table Update/Rename
```json
{"name": "New Name"}
```

### PATCH /v3/tables/{tableId}/fields/{fieldId} — Field Update/Rename
```json
{"name": "Renamed Column"}
```

### DELETE /v3/tables/{tableId}/fields/{fieldId} — Field Deletion
Returns `{}` on success. Note: `PUT` does NOT exist (404).

### PATCH /v3/tables/{tableId}/run — Trigger Enrichment Runs
```json
{"runRecords": {"recordIds": ["r_xxx"]}, "fieldIds": ["f_xxx"], "forceRun": true, "callerName": "optional"}
```

### GET /v3/workspaces/{id}/tables — List Tables in Workspace
Returns `{results: [{id, name, type, workbookId, abilities, ...}]}`.

### GET /v3/workspaces/{id} — Workspace Details
Returns workspace name, billing plan, and ~150 feature flags.

### GET /v3/me — Current User Info
Returns user profile, API token, auth strategy, last workspace ID.

### GET /v3/actions?workspaceId={id} — Enrichment Actions Catalog
Returns all available actions with input/output schemas, rate limits, auth requirements.

### GET /v3/sources?workspaceId={id} — Source Listing
Returns all sources with IDs, types, states, record counts.

### PATCH /v3/sources/{sourceId} — Source Update
### DELETE /v3/sources/{sourceId} — Source Deletion

### GET /v3/imports?workspaceId={id} — Import History (confirmed INV-008)
Returns array of import records with config and column mapping details.

**Note**: `/v3/imports/csv` and `/v3/imports/webhook` are NOT separate endpoints (INV-009). "csv" and "webhook" are treated as import job IDs. The real pattern is `/v3/imports/{jobId}`.

### POST /v3/imports — Create Import Job (confirmed INV-020)

Creates an import job that loads rows from a CSV already in Clay's S3 bucket into a
destination table. **Executes synchronously** — `state.status` is typically `FINISHED`
by the time the response is serialized.

**Request**:
```json
POST /v3/imports
Cookie: claysession=...
Content-Type: application/json

{
  "workspaceId": 1080480,
  "config": {
    "map": {
      "f_xxxName": "{{\"Name\"}}",
      "f_xxxEmail": "{{\"Email\"}}"
    },
    "source": {
      "key": "1282581/creators_default_vie-1775337345813.csv",
      "type": "S3_CSV",
      "filename": "creators_default_vie-1775337345813.csv",
      "hasHeader": true,
      "recordKeys": ["Name", "Email"],
      "uploadMode": "import",
      "fieldDelimiter": ","
    },
    "destination": {
      "type": "TABLE",
      "tableId": "t_xxx"
    },
    "isImportWithoutRun": true
  }
}
```

**Response (200)**:
```json
{
  "id": "ij_xxx",
  "workspaceId": 1080480,
  "createdAt": "2026-04-07T17:32:45.657Z",
  "finishedAt": null,
  "config": { /* echoed */ },
  "state": {
    "status": "INITIALIZED"
  }
}
```

**Field notes**:
- `map` keys are Clay field IDs (`f_xxx`). Values use Clay's `{{"Header Name"}}` templating.
- `source.type`: only `S3_CSV` has been end-to-end verified. `INLINE_CSV` returns 400 `Could not find source with type INLINE_CSV`.
- `source.key` must be an existing S3 object key under `{userId}/{filename}.csv`. If not found: 400 `Bad source config: Could not locate file with key X`.
- `source.uploadMode` observed value: `"import"` only.
- `destination.type`: `"TABLE"` or `"NOOP"` (NOOP behavior not explored).
- `isImportWithoutRun: true` prevents enrichment auto-trigger (important for credit control).
- **Bogus field IDs in `map` are silently accepted** — rows are imported but mapped cells remain empty.

**Error fingerprints**:
- `{}` → 400 `Must specify workspaceId`
- `{workspaceId}` → 500 `InternalServerError` (no validator before destructuring `config`)
- Bad S3 key → 400 `Bad source config: Could not locate file with key X`
- `multipart/form-data` body → 400 `Must specify workspaceId` (multipart not wired up; JSON only)

### GET /v3/imports/{importId} — Import Job Status (confirmed INV-020)

Returns the full import record for polling.

**Response shape**:
```json
{
  "id": "ij_xxx",
  "workspaceId": 1080480,
  "createdAt": "ISO",
  "updatedAt": "ISO",
  "finishedAt": "ISO|null",
  "deletedAt": "ISO|null",
  "createdBy": "userId",
  "config": { /* same as POST */ },
  "state": {
    "status": "INITIALIZED|FINISHED|FAILED",
    "numRowsSoFar": 49,
    "totalSizeBytes": 5302,
    "csvFilePlatform": "UNKNOWN"
  }
}
```

### CSV Upload Flow (RESOLVED INV-021)

The full programmatic CSV upload path uses two `/v3` endpoints (which INV-020
missed because they take **`{workspaceId}`** as the path param, not `{importId}`)
plus a direct PUT to a presigned S3 URL.

**Step 1 — Initiate multipart upload**
```
POST /v3/imports/{workspaceId}/multi-part-upload
Cookie: claysession=...
Content-Type: application/json

{
  "filename": "data.csv",
  "fileSize": 12345,
  "toS3CSVImportBucket": true
}
```

Response (200):
```json
{
  "uploadId": "WJjMz_Cr43NFUDc7TjOPv...",
  "s3Key": "1080480/1282581/data-1775590033057.csv",
  "uploadUrls": [
    {
      "url": "https://clay-base-import-prod.s3.us-east-1.amazonaws.com/1080480/1282581/data-1775590033057.csv?X-Amz-Algorithm=...",
      "partNumber": 1
    }
  ]
}
```

- S3 key format: `{workspaceId}/{userId}/{normalized_filename}-{epochMs}.{ext}`
- For files <50 MB you get a single-part upload URL.
- For larger files Clay returns N parts (50 MB each, max 15 GB total). The Clay
  UI uploads parts in parallel with concurrency=5.
- `toS3CSVImportBucket: true` writes to `clay-base-import-prod` (the bucket
  consumable by `POST /v3/imports`). `false` writes to `file-drop-prod` (used
  for general action attachments / documents).

**Step 2 — PUT each part directly to S3**
```
PUT <uploadUrls[i].url>
Content-Type: application/octet-stream

<raw file chunk>
```

S3 returns 200 with `ETag: "fcc4537294f55876b43523cf6c536c8e"`. Capture the
ETag for each part. **Strip the surrounding double quotes before sending to
the complete endpoint** — this is a documented footgun.

**Step 3 — Complete multipart upload**
```
POST /v3/imports/{workspaceId}/multi-part-upload/complete
Cookie: claysession=...
Content-Type: application/json

{
  "s3key": "1080480/1282581/data-1775590033057.csv",
  "uploadId": "WJjMz_Cr43NFUDc7TjOPv...",
  "etags": [
    {"partNumber": 1, "etag": "fcc4537294f55876b43523cf6c536c8e"}
  ],
  "toS3CSVImportBucket": true
}
```

Response (200): `{}` (empty object). **Footgun**: the request key is `s3key`
(lowercase k), but the init response returns `s3Key` (camelCase). The
`toS3CSVImportBucket` flag must match the init call.

**Step 4 — Create the import job** (see `POST /v3/imports` above)

Pass the `s3Key` from Step 1 as `config.source.key`. The flow is fully
programmatic — no UI required.

**End-to-end verified** in INV-021 with a 55-byte CSV: init → S3 PUT (200) →
complete (200) → POST /v3/imports (200, `state.totalSizeBytes: 55`).

#### Alternate upload pattern: S3 POST policy (INV-023)

In addition to the multipart PUT flow above, Clay has a second upload
mechanism returning S3 POST policy form fields — simpler (single-shot, no
`/complete` step) but capped at S3's 5 GB POST limit. Two endpoints use it,
both confirmed end-to-end in INV-023:

**1) tc-workflows CSV upload** →
`POST /v3/workspaces/{wsId}/tc-workflows/{wfId}/batches/csv-upload-url`

Request: `{filename: string, fileSize: number}`
Response 200:
```json
{
  "uploadUrl": "https://clay-base-import-prod.s3.us-east-1.amazonaws.com/",
  "fields": {
    "bucket": "clay-base-import-prod",
    "key": "...",
    "Policy": "<base64>",
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": "...",
    "X-Amz-Date": "...",
    "X-Amz-Security-Token": "...",
    "X-Amz-Signature": "..."
  },
  "uploadToken": "<uuid — passed to createWorkflowRunBatch (INV-024)>"
}
```
Targets the SAME `clay-base-import-prod` S3 bucket as multi-part-upload with
`toS3CSVImportBucket:true`.

**2) Documents upload** →
`POST /v3/documents/{wsId}/upload-url`

Request: `{name: string (1-500 chars), folderId?: string|null, context?: string (default "agent_playground")}`
Response 200:
```json
{
  "documentId": "doc_0td531m9Z7tsq3a734n",
  "uploadUrl": "https://file-drop-prod.s3.us-east-1.amazonaws.com/",
  "fields": { "bucket": "file-drop-prod", "key": "...", "Policy": "...", "X-Amz-*": "..." }
}
```
Targets the `file-drop-prod` bucket. After the S3 POST succeeds, the caller
must call `POST /v3/documents/{wsId}/{documentId}/confirm-upload` (empty body)
to make the document queryable — returns the full document record:
```json
{
  "id": "doc_0td5...", "name": "...", "folderId": null,
  "mimeType": "binary/octet-stream", "size": 42,
  "context": "agent_playground",
  "createdAt": "...", "updatedAt": "..."
}
```
Delete with `DELETE /v3/documents/{wsId}/{documentId}?hard=true`.

**POST-policy S3 upload mechanics (both endpoints)**:
1. Build a `FormData` — append ALL of `response.fields` entries first (order matters for S3 POST policies), then append the actual `file` LAST.
2. `fetch(uploadUrl, { method: "POST", body: formData })` — let `FormData` set
   `Content-Type: multipart/form-data; boundary=...` itself. Do NOT override.
3. S3 returns `204 No Content` on success (not 200, unlike the PUT flow).
4. Single-shot — no `/complete` step on the Clay side.

**When to pick which flow**:
- POST policy (`csv-upload-url`, `documents/upload-url`) for files <5 GB —
  simpler code path, fewer round-trips.
- Multipart PUT (`multi-part-upload` + `/complete`) for files up to 15 GB,
  when parallel chunk uploads matter, or when ingesting into tables via
  `POST /v3/imports` (only the PUT flow produces an `s3Key` that
  `POST /v3/imports` can consume).

#### tc-workflows batch ingestion loop (INV-024)

The `csv-upload-url` endpoint above produces an `uploadToken` that the
`createWorkflowRunBatch` endpoint consumes to actually kick off a batch run
against a workflow. The full ingestion loop:

```
POST .../tc-workflows/{wfId}/batches/csv-upload-url   {filename, fileSize}
  → {uploadUrl, fields, uploadToken}
S3 POST  uploadUrl  (multipart/form-data; fields first, file last)
  → 204
POST .../tc-workflows/{wfId}/batches                  {workflowSnapshotId, type, csvUploadToken, config?}
  → {batch}
GET  .../tc-workflows/{wfId}/batches/{batchId}        (poll status)
  → {batch} with status: pending|running|completed|failed|cancelled
GET  .../tc-workflows/{wfId}/batches/{batchId}/runs   (list spawned runs)
  → {runs:[...], total}
DELETE .../tc-workflows/{wfId}/batches/{batchId}      (body {})
  → {success}
```

**`createWorkflowRunBatch` body** is a discriminated union on `type`:
```jsonc
// type=csv_import
{ "workflowSnapshotId": "latest",
  "type": "csv_import",
  "csvUploadToken": "<uuid from csv-upload-url>",
  "config": { "standaloneActions": [] } }
// type=cpj_search (untested as of INV-024)
{ "workflowSnapshotId": "latest",
  "type": "cpj_search",
  "config": { /* ... */ } }
```

**Server enrichment of the batch object**:
- `workflowSnapshotId: 'latest'` is replaced with a real snapshot id `wfs_...`
- `config.csvFile = {fileSize, filename}` is reconstructed from upload metadata
- `config.parameterNames = string[]` is parsed from the CSV's first row
- `state.lastOffsetProcessed: 0` is initialized (cursor for the row processor)

**Status enum**: `pending | running | completed | failed | cancelled`.

**Credit safety**: a batch against a workflow with **zero defined steps**
transitions `pending → failed` within ~430ms with `totalRuns: 0` and
`runs: []`. The executor never spawns work units, so zero credits are
consumed. This makes empty workflows ideal as scratch resources for
tc-workflows investigations.

**Sibling endpoints in the batches router** (extracted from the bundle's
`xwe` ts-rest router, all under `/v3/workspaces/{ws}/tc-workflows/{wf}`):

| Method | Path | Body | Notes |
|---|---|---|---|
| POST   | `/batches`                              | `{workflowSnapshotId, type, csvUploadToken?, config?}` | createWorkflowRunBatch — confirmed INV-024 |
| GET    | `/batches`                              | query `{limit?, offset?, status?}` | list batches |
| GET    | `/batches/{batchId}`                    | – | get one batch |
| PATCH  | `/batches/{batchId}`                    | `{status?, config?, state?}` | **confirmed INV-025** — `{status:'cancelled'}` works; race the auto-fail (~430ms for empty workflows) |
| DELETE | `/batches/{batchId}`                    | `{}` (empty body required) | – |
| GET    | `/batches/{batchId}/runs`               | query `{limit?, offset?}` | list runs spawned by the batch |
| POST   | `/batches/csv-upload-url`               | `{filename, fileSize}` | INV-023 |

#### tc-workflows graph (nodes + edges) and snapshots (INV-025)

The `mYe` ts-rest router exposes the workflow definition surface. The
`uYe` router adds read-only snapshot routes. Both are under
`/v3/workspaces/{ws}/tc-workflows/{wf}`.

```
GET    /graph                                       → {nodes, edges, validation, workflowInputVariables}
POST   /nodes                                       → {node}
PATCH  /nodes/{nodeId}                              → {node}
PATCH  /nodes              {updates:[{nodeId,position}]} → {nodes,success}    (batch reposition)
DELETE /nodes/{nodeId}     body {}                  → {success}
DELETE /nodes              body {nodeIds[]}         → {deletedCount,success}  (batch delete)
POST   /nodes/{nodeId}/duplicate  {position?}       → {node, edges}           (suspected)
GET    /nodes/{nodeId}/code/download                → raw Python source       (suspected, code nodes)

POST   /edges              {sourceNodeId,targetNodeId,metadata?:{conditionalSourceHandle?}} → {edge}
PATCH  /edges/{edgeId}     {metadata:{handoffConfig?}}  → {edge}              (suspected)
DELETE /edges/{edgeId}     body {}                  → {success}

GET    /snapshots                                   → {snapshots:[Snapshot]}
GET    /snapshots/{snapshotId}                      → {snapshot:Snapshot}

POST   /v3/workspaces/{ws}/tc-workflows/from-snapshot/{snapshotId}  {name} → {workflow}  (suspected)
POST   /v3/workspaces/{ws}/tc-workflows/{wf}/restore/{snapshotId}   {}     → {success}    (suspected)
POST   /v3/workspaces/{ws}/tc-workflows/from-preset/{presetId}      {name} → {workflow}  (suspected)
POST   /v3/workspaces/{ws}/tc-workflows/{wf}/duplicate              {name} → {workflow}  (suspected)
PATCH  /v3/workspaces/{ws}/tc-workflows/{wf}    {name?, defaultModelId?, lastRunAt?} → {workflow}
```

**Node creation body**:
```jsonc
{
  "name": "first node",                  // required, max 255
  "description": "optional",
  "nodeType": "regular",                 // 'regular'|'code'|'conditional'|'map'|'reduce'|'tool'  (default 'regular')
  "modelId": "...",                      // optional
  "promptVersionId": "...",              // optional
  "position": { "x": 100, "y": 100 },    // optional
  "isInitial": true,                     // optional
  "isTerminal": false                    // optional
}
```

The full read enum for `nodeType` (in graph responses) also includes
`fork | join | collect`. **Inert `regular` nodes** (no `modelId` /
`promptVersionId` / `toolIds` / `inlineScript`) consume zero credits and
are safe scratch resources.

**Node response shape**:
```jsonc
{
  "node": {
    "id": "wfn_0td5643dp3GRSygz3Ri",
    "workspaceId": "1080480",
    "workflowId": "wf_...",
    "name": "...", "description": null,
    "nodeType": "regular",
    "tools": [],
    "nodeConfig": { "nodeType": "regular" },
    "subroutineIds": [],
    "position": { "x": 100, "y": 100 },
    "isInitial": true, "isTerminal": false,
    "createdAt": "...", "updatedAt": "..."
  }
}
```

**`PATCH /nodes/{nodeId}` accepts** (all optional): `name`, `description`,
`nodeType`, `modelId`, `modelOverrides`, discriminated `source`
(`prompt_version`/`inline_prompt`/`input_schema`), `toolIds`,
`subroutineIds`, `isInitial`, `isTerminal`, `position`, `nodeConfig`,
`interventionSettings`, `retryConfig`, `scriptVersionId`, `inlineScript`
(`{code, language?, inputSchema?, outputSchema?, packages?, allowedToolIds?,
timeoutMs?, shouldIndexStdout?}`).

**Graph response includes server-side validation** — a free pre-flight
static analysis:
```jsonc
{
  "nodes": [...], "edges": [...],
  "validation": {
    "isValid": false,
    "errors": [
      { "type": "terminal_node_missing_tool_or_output_schema",
        "message": "Terminal node \"...\" must have either a destination tool or an output schema defined",
        "nodeId": "wfn_..." }
    ],
    "warnings": [
      { "type": "missing_model",  "message": "...", "nodeId": "wfn_..." },
      { "type": "missing_prompt", "message": "...", "nodeId": "wfn_..." }
    ],
    "suggestions": []
  },
  "workflowInputVariables": []
}
```

**Snapshots are server-managed** — there is no `publishWorkflow` or
`createSnapshot` mutation. A snapshot is auto-created the first time a
batch is created with `workflowSnapshotId: 'latest'`. The snapshot embeds
the full workflow definition (deep copy of nodes/edges) and is sha256-hashed
for content addressing:

```jsonc
{
  "snapshot": {
    "id": "wfs_0td5646iBTS96RT7jyJ",
    "workflowId": "wf_...",
    "content": {
      "edges": [...],
      "nodes": [...],
      "workflow": {
        "id": "wf_...", "name": "...",
        "workspaceId": 1080480,
        "creatorUserId": 1282581,
        "maxConcurrentBranches": 0
      },
      "createdAt": "...",
      "containsCycles": false
    },
    "hash": "74a1d52f47089c20e660f2d69112b5120989a7eb3fd5b1d02ca48bb58184c166",
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

**`cpj_search` batch type is server-stubbed** (INV-025):
```jsonc
// POST .../batches { workflowSnapshotId:'latest', type:'cpj_search', config:{} }
// 405 Method Not Allowed
{ "type":"MethodNotAllowed",
  "message":"CPJ Search batch type is not yet implemented",
  "details":null }
```
The discriminator and React `CreateBatchModal` UI both exist; the server
handler is stubbed. Re-probe after future bundle drops.

**Sibling routers in the same region**:

- `Swe` **direct workflow runs — RESOLVED INV-026**. Seven routes under `/v3/workspaces/{ws}/tc-workflows/{wf}`: `POST /runs`, `GET /runs`, `GET /runs/{runId}`, `POST /runs/{runId}/pause`, `POST /runs/{runId}/unpause`, `POST /runs/{runId}/steps/{stepId}/continue`, `GET /steps/waiting`. See "tc-workflows direct runs (INV-026)" section below. (INV-025 guessed the name was `Ewe`; that was wrong — `Ewe` is the batches body discriminator.)
- `lKe` **workflow run streams — RESOLVED INV-027**. Six CRUD routes under `/v3/workspaces/{ws}/tc-workflows/{wf}/streams[/{id}]` plus `GET .../streams/{id}/runs`. Sibling root-path router `uKe` exposes `POST /v3/tc-workflows/streams/{streamId}/webhook[/batch]` for live ingestion. See "tc-workflows streams + webhook ingestion (INV-027)" section below. (INV-025/026 guessed the streams router was `sKe`; that's actually the request body Zod schema, same trap as `Ewe`/`Swe`.)

#### tc-workflows direct runs (INV-026)

The `Swe` router (bundle `index-D2XXxr_J.js` offset ~361931) exposes a
single-run API sibling to the batch-based runs from INV-024. This is the
right primitive for chat-style / agentic integrations — one row, one
agent turn, synchronous polling, pause/resume, human-in-the-loop.

```
POST   .../tc-workflows/{wf}/runs                          {inputs?, batchId?, standaloneActions?}  → {workflowRun}
GET    .../tc-workflows/{wf}/runs                          (query: limit=50, offset=0)              → {runs[], total}
GET    .../tc-workflows/{wf}/runs/{runId}                  → discriminated {type:'current',workflowRun,workflowRunSteps[],workflowSnapshot} | {type:'archived',archivedAgentRun}
POST   .../tc-workflows/{wf}/runs/{runId}/pause            {}  → {success,runId,status}
POST   .../tc-workflows/{wf}/runs/{runId}/unpause          {}  → {success,runId,status}
POST   .../tc-workflows/{wf}/runs/{runId}/steps/{stepId}/continue  {humanFeedbackInput}  → {success,stepId,status}
GET    .../tc-workflows/{wf}/steps/waiting                 → {waitingSteps[]}
```

**No cancel/delete on direct runs.** The Swe router is append-only. To
cancel a single run, wrap the invocation in a 1-row csv_import batch
(INV-024) and PATCH the batch per INV-025. Individual runs can only be
paused / unpaused once started.

**WorkflowRun shape (`Q_` in bundle)**:
```ts
{
  id: string,                       // wfr_...
  workflowId: string,               // wf_...
  workflowName: string | null,
  workflowSnapshotId: string,       // wfs_... (server auto-resolves 'latest')
  batchId: string | null,
  streamId: string | null,
  runStatus: 'pending'|'running'|'paused'|'completed'|'failed'|'waiting',
  runState: {
    status: 'running'|'paused'|'completed'|'failed',
    currentNodeId?: string,
    inputs: object, globalContext: object, startedAt: string,
    // if completed: outputs, completedAt, completedByStepId?, completedByNodeId?
    // if failed:    failedAt, error, failedByStepId?, failedByNodeId?
  },
  maxUninterruptedSteps: number,
  createdAt: string, updatedAt: string,
  langsmithTraceHeader?: string | null,
}
```

Note the two status enums are not 1:1 — top-level `runStatus` includes
`pending` + `waiting`; the inner `runState.status` does not.

**Observed lifecycle** (2-node inert graph, 1 row, INV-026):
`running → completed` in ~9.3s. Two `workflowRunSteps` persisted with
complete telemetry: system/user prompts (~2 KB each), tool name +
params, reasoning text, `threadContext {threadId,threadPath,threadType,
uninterruptedStepCount}`, token usage (`anthropic:claude-haiku-4-5`
~12k total across 2 nodes), and `executionMetadata`. This is enough
data to build observability/replay features without any extra endpoints.

**Body shape gotchas**:
- `standaloneActions` is an **object** (`J_` in bundle), not an array —
  passing `[]` returns a 400 with `"Expected object, received array"`.
- Explicit `workflowSnapshotId` in body is silently ignored; server
  always resolves its own `'latest'`.
- Empty body `{}` is accepted; `inputs` defaults to `{}`.
- React caller (`createWorkflowRun.useMutation`) uses `body: {inputs: n}`
  where `n = runState.inputs || {}`.

**"Inert regular nodes" are not actually inert — just free on this
workspace.** INV-025 called `regular` nodes with no `modelId` "credit-safe
scratch resources". INV-026 proved they DO execute: the server injects
`anthropic:claude-haiku-4-5` with a detailed system prompt (memory
search, transition routing, fail_node, etc.) and the node runs a full
LLM turn. Token usage was ~12k across the 2-node test. Despite this, the
workspace balance was unchanged (`basic: 1934.4 → 1934.4`,
`actionExecution: 999999999897 → 999999999897`), but workspace 1080480
appears to be a dev/unlimited account. **Do not generalise the
credit-safe claim to production workspaces without re-measuring.** See
GAP-034.

**`continueWorkflowRunStep` body** — discriminated union on `type`
(called `hCe` in bundle, offset 342410):
```ts
humanFeedbackInput:
  | { type:'ApproveToolCall', toolName, approveToolCallForEntireRun:boolean }
  | { type:'RejectToolCall', ... }
  | { type:'DenyToolCall', preventFutureToolCallsWithThisTool:boolean, toolName, feedback?:string }
  | { type:'DenyTransition', targetNodeId, feedback?:string }
  // + 2 more (fCe, pCe) not yet unminified
```
INV-026 verified the route is reachable (404 `"Workflow run step not
found"` on a fake stepId) but did not drive the happy path — that needs
a workflow whose step actually ends in `waiting` state, which requires
`interventionSettings` on a node (tracked as GAP-035). `GET /steps/waiting`
returns the live list of steps awaiting human input, with
`callbackData` discriminated on 10 variants
(`human_input_tool_decision`, `human_input_transition_decision`,
`async_tool_execution`, `max_uninterrupted_steps_reached`,
`workflow_run_paused`, `wait_tool_execution`, `code_execution_pending`,
`code_execution_complete`, `tool_node_execution_pending`,
`tool_node_execution_complete`).

#### tc-workflows streams + webhook ingestion (INV-027)

The third invocation primitive for tc-workflows (alongside batches and
direct runs) is **streams** — long-lived stream objects scoped to a
workflow snapshot, fed by external producers. For `streamType='webhook'`
the stream object exposes a public ingestion URL that accepts arbitrary
JSON; each POST creates a new workflow run whose `runState.inputs` is
the request body verbatim.

Two routers in the current bundle (`index-BS8vlUPJ.js`, offsets
~623100–625900):

- `lKe = terracottaWorkflowRunStreams` — workspace-scoped CRUD (6 routes).
- `uKe = terracottaStreamWebhook` — root-path ingestion (2 routes).

```
POST   /v3/workspaces/{ws}/tc-workflows/{wf}/streams                       {workflowSnapshotId, streamType, name, config, status?='active'} → {stream}
GET    /v3/workspaces/{ws}/tc-workflows/{wf}/streams                       (query: limit, offset, status, streamType)                       → {streams[], total}
GET    /v3/workspaces/{ws}/tc-workflows/{wf}/streams/{streamId}                                                                            → {stream}
PATCH  /v3/workspaces/{ws}/tc-workflows/{wf}/streams/{streamId}            {name?, workflowSnapshotId?, config?, status?}                  → {stream}
DELETE /v3/workspaces/{ws}/tc-workflows/{wf}/streams/{streamId}            {}                                                              → {success:true}    (soft-delete; sets deletedAt)
GET    /v3/workspaces/{ws}/tc-workflows/{wf}/streams/{streamId}/runs       (query: limit, offset, status)                                  → {runs[], total}

POST   /v3/tc-workflows/streams/{streamId}/webhook                         Record<string,any>                                              → 202 {success:true, workflowRunId, message}          (UNAUTHENTICATED — streamId is the bearer)
POST   /v3/tc-workflows/streams/{streamId}/webhook/batch                   {items:[{entityId?, backfillId?, requestData}]}                 → 202 {success:true, runs:[{requestId, workflowRunId}], count}   ⛔ INTERNAL-ONLY (INV-028) — every user-facing auth scheme rejected
```

**WorkflowRunStream shape (`VS` in bundle)**:
```ts
{
  id: string,                       // wfrs_...
  workflowId: string,
  workflowSnapshotId: string,
  streamType: 'webhook' | 'agent_action' | 'workflow_action',
  name: string,
  createdBy: number | null,
  config: any | null,               // free-form per streamType
  status: 'active' | 'paused' | 'disabled',
  createdAt, updatedAt: ISO,
  deletedAt: ISO | null,
  webhookUrl?: string,              // ONLY for streamType='webhook'
  referencedTables?: [{tableId, tableName, workbookId|null}],
}
```

**Stream typing**:
- `'webhook'` — externally pushable. Response includes
  `webhookUrl: https://api.clay.com/tc-workflows/streams/{id}/webhook`
  (note: no `/v3` prefix in the returned URL even though the only path
  actually routable under cookie auth is `/v3/tc-workflows/streams/{id}/webhook`
  — Clay's gateway probably remaps the public form for non-cookie auth).
  Verified `config:{}` and `config:{inputSchema:{type:'object',properties:{...}}, webhook:{requiresAuth:false}}`.
- `'agent_action'`, `'workflow_action'` — created cleanly with
  `config:{}`, but the response has **no `webhookUrl`**. These are not
  externally pushable; they look like internal stream types written to
  from inside the workflow runtime (sub-workflows / agent tools emitting
  events). See GAP-037.

**Webhook → run lifecycle observed end-to-end (INV-027)**:
```
POST /v3/tc-workflows/streams/wfrs_.../webhook  {"email":"...","company":"Lele"}
  → 202 {success:true, workflowRunId:"wfr_...", message:"Webhook request accepted and queued for processing"}

GET /runs/{wfRunId} immediately afterwards:
  runStatus: 'running'
  runState.inputs: {"email":"...","company":"Lele"}    // verbatim
  streamId: "wfrs_..."
  batchId:  null

After ~7 s:
  runStatus: 'completed'
```

Live ingestion adds no meaningful latency over direct runs (~7 s vs
~9.3 s for the same inert 2-node graph). The body becomes
`runState.inputs` with no wrapping or transformation.

**Negative paths verified**:
- POST to a `paused` stream → 400 `{error:'BadRequest', message:'Stream is not active'}`.
- POST to non-existent streamId → 404 `{error:'NotFound', message:'Stream not found'}`.
- POST `/tc-workflows/streams/{id}/webhook` (no `/v3` prefix) → 404 under cookie auth.

**`postWebhook` (single) is COMPLETELY UNAUTHENTICATED (INV-028
correction)**: INV-027 assumed the single-webhook endpoint required
cookies because that's how the script sent it. INV-028 pass 2 verified
that POSTing with zero auth headers returns 202 and creates a run. The
streamId is the bearer token — same security model as table webhook
URLs or Slack incoming webhooks. This IS Clay's productized inbound
channel. The endpoint is `auth: none` in `endpoints.jsonl`.

**Important: Clay's `webhookUrl` response field is buggy**. The stream
create response returns `webhookUrl: "https://api.clay.com/tc-workflows/
streams/{id}/webhook"` (no `/v3` prefix), but that URL form 404s under
every auth scheme. Only the `/v3`-prefixed form routes. Consumers
integrating against the returned URL as-is will fail — **always rewrite
to prepend `/v3`** before using it.

**`postWebhookBatch` is internal-only (INV-028)**. The batch variant's
Zod validator runs (wrong body shapes return 400 `items Required`, so
the handler is reached), but the auth layer rejects every scheme:
- Session cookies: 403 "Forbidden".
- API-key Bearer (minted via `POST /v3/api-keys`) across 4 scope sets:
  401 "Unauthorized".
- 10+ other header variants (`x-clay-api-key`, `X-Api-Key`,
  `Clay-API-Key`, `Token`, query-param `?apiKey=`, etc.): 401 or 403.
- No auth: 401.
- v1 namespace: 404 "deprecated".

No frontend caller for this route exists in the bundle. Body shape
(`entityId`, `backfillId`, `requestData`) is consistent with Clay's
own async workers iterating over source rows. Conclusion: this route
is reserved for internal backfill workers, not externalizable. Use
the single-event endpoint in a loop for batch-like workloads. GAP-036
closed in INV-028.

**Stream snapshot binding**: `createWorkflowRunStream` requires a real
`wfs_xxx` snapshot id (we passed one harvested from a seed direct run).
Updating the workflow graph after stream creation leaves the stream
pointing at a stale snapshot — `updateWorkflowRunStream` accepts a new
`workflowSnapshotId`, so the consumer model is "create stream → graph
evolves → bump stream snapshot manually". Same pattern as batches and
direct runs.

**No explicit cancel/disable separation**: `lKe` exposes
create/read/list/update/delete/listRuns and nothing else. To stop
ingestion: `PATCH {status:'paused'}` (resumable) or `'disabled'`
(harder stop) or `DELETE` (soft delete).

#### BadRequest error shape (all confirmed endpoints)

Missing or malformed request fields return a consistent structured error:
```json
{
  "type": "BadRequest",
  "message": "Invalid request parameter(s): Field \"filename\" - Required, Field \"fileSize\" - Required",
  "details": {
    "pathParameterErrors": [],
    "headerErrors": [],
    "queryParameterErrors": [],
    "bodyErrors": [...]
  }
}
```
Useful for distinguishing "route exists, body wrong" (400 with this schema)
from "route doesn't exist" (404 HTML/empty) during endpoint probing.

### POST /v3/tables/{tableId}/export — CSV Export Job (INV-017)
Creates an async export job.

**Request**:
```
POST /v3/tables/{tableId}/export
Cookie: claysession=...
Content-Type: application/json

{"format": "csv"}
```

**Response** (200):
```json
{
  "id": "ej_xxx",
  "workspaceId": 1080480,
  "tableId": "t_xxx",
  "viewId": "",
  "userId": "1282581",
  "fileName": "table-name-export",
  "status": "ACTIVE",
  "uploadedFilePath": null
}
```

**Async flow**: POST to create → poll `GET /v3/exports/{ej_xxx}` for `uploadedFilePath` → download when populated.
Note: `GET /v3/exports/csv` treats "csv" as a job ID (404). `GET /v3/exports` requires admin.

### POST /v3/actions — Action Package Creation
```json
{"workspaceId": 1080480, "actionPackageId": "string", "actionPackageDefinition": "serialized JSON string"}
```

### GET /v3/app-accounts — Auth Account Enumeration (BREAKTHROUGH, INV-010)
Returns ALL auth accounts (Clay-managed + user-owned) for the authenticated user.

**Request**:
```
GET https://api.clay.com/v3/app-accounts
Cookie: [SESSION_COOKIE]
```

**Response** (abbreviated):
```json
[
  {
    "id": "aa_ZR72u7bn5qmS",
    "name": "Clay-managed ElevenLabs account",
    "appAccountTypeId": "elevenlabs",
    "isSharedPublicKey": true,
    "userOwnerId": null,
    "workspaceOwnerId": 4515,
    "defaultAccess": "can_use",
    "abilities": {"canUpdate": false, "canDelete": false, "canAccess": true}
  }
]
```

**Usage**: The `id` field is the `authAccountId` required in enrichment column `typeSettings`. Match `appAccountTypeId` to `auth.providerType` from the actions catalog to find the right account.

**Also accessible via**: `GET /v3/workspaces/{id}/app-accounts` (returns same results).

111 accounts returned for test workspace (all Clay-managed shared accounts).

### POST /v3/tables/{tableId}/records — Row Creation (INV-011)

Creates rows in a table. Replaces the deprecated v1 `POST /api/v1/tables/{id}/rows`.

**Request**:
```
POST /v3/tables/{tableId}/records
Cookie: claysession=...

{
  "records": [
    {
      "cells": {
        "f_fieldId1": "plain string value",
        "f_fieldId2": "another value"
      }
    }
  ]
}
```

**Key rules**:
- `cells` keys MUST be field IDs (f_xxx), not field names
- Values are plain strings/numbers — NOT nested {value: "..."} objects
- Multiple records per call supported
- Empty cells ({}) creates a row with only system fields

**Response** (200):
```json
{
  "records": [{
    "id": "r_xxx",
    "tableId": "t_xxx",
    "cells": {"f_fieldId1": {"value": "plain string value"}, "f_created_at": {...}, "f_updated_at": {...}},
    "recordMetadata": {},
    "createdAt": "...",
    "updatedAt": "..."
  }]
}
```

### PATCH /v3/tables/{tableId}/records — Row Update (INV-011)
Updates are async. Response: `{"records":[],"extraData":{"message":"Record updates enqueued"}}`

### DELETE /v3/tables/{tableId}/records — Row Deletion (INV-011)
Request: `{"recordIds": ["r_xxx", "r_yyy"]}`
Response: `{}`

### GET /v3/tables/{tableId}/views/{viewId}/records — Row Reading (INV-012, BREAKTHROUGH)

**The missing piece.** Reading rows requires a view ID -- there is no view-less GET for records.

**Request**:
```
GET /v3/tables/{tableId}/views/{viewId}/records?limit=50
Cookie: claysession=...
```

**Response** (200):
```json
{
  "results": [
    {
      "id": "r_xxx",
      "tableId": "t_xxx",
      "cells": {
        "f_fieldId1": {"value": "Mateo Fois"},
        "f_fieldId2": {"value": "https://linkedin.com/in/...", "metadata": {"status": "SUCCESS"}},
        "f_created_at": {"value": "2026-04-04T21:12:43.917Z", "metadata": {"isCoerced": true}},
        "f_updated_at": {"value": "2026-04-05T02:53:33.731Z", "metadata": {"isCoerced": true}}
      },
      "recordMetadata": {"runHistory": {...}, "preprocessingMarkerMax": {...}},
      "createdAt": "2026-04-04T21:12:43.947Z",
      "updatedAt": "2026-04-05T02:53:33.788Z",
      "deletedBy": null,
      "dedupeValue": null
    }
  ]
}
```

**Query parameters**:
- `limit=N` — works, limits number of records returned
- `offset=N` — accepted but **silently ignored** (always returns from start)
- No pagination metadata in response (no hasMore, total, nextCursor)
- `sort`, `fields`, `filter` query params are accepted but ignored — filtering/sorting is controlled by the view definition

**View selection**:
- View IDs come from `GET /v3/tables/{tableId}` → `table.views[]`
- Each table has multiple views: "Default view", "All rows", "Fully enriched rows", "Errored rows", etc.
- Views apply server-side filtering — "Fully enriched rows" may return 0 records while "All rows" returns all
- For full table reads, use "All rows" or "Default view"
- View ID format: `gv_xxx` (grid view)

**How to get view IDs**:
```bash
curl -s -H "Cookie: claysession=..." "https://api.clay.com/v3/tables/t_xxx" | \
  python3 -c "import json,sys; [print(f'{v[\"id\"]}: {v[\"name\"]}') for v in json.loads(sys.stdin.read())['table']['views']]"
```

### GET /v3/tables/{tableId}/records/{recordId} — Single Record Read (INV-012)

Fetches a single record by ID.

**Request**:
```
GET /v3/tables/{tableId}/records/{recordId}
Cookie: claysession=...
```

**Response**: Same record shape as items in the view-based list endpoint (id, tableId, cells, recordMetadata, createdAt, updatedAt, deletedBy, dedupeValue).

**Important caveat**: The route pattern `/v3/tables/{id}/records/{recordId}` means ANY sub-path is treated as a record ID lookup. For example, `/v3/tables/{id}/records/count` does NOT return a count — it returns 404 "Record count was not found".

### Clay API Key CRUD — `/v3/api-keys` (`TRe` router, INV-028)

Full CRUD surface, session-cookie authed. Matches the Settings → API Keys
UI modal in Clay but exposes more scope options than the UI does.

```
GET    /v3/api-keys?resourceType=user&resourceId={userId}          → ApiKey[]
POST   /v3/api-keys                                                → ApiKey & {apiKey: "plaintext"}
PATCH  /v3/api-keys/{apiKeyId}  {name?, workspaceId?}              → ApiKey    (bundle-confirmed, not exercised)
DELETE /v3/api-keys/{apiKeyId}  {}                                 → {success:true}
```

**Create body**:
```ts
{
  name: string,
  resourceType: 'user',          // Gb enum has ONLY 'user'
  resourceId: string,            // user.id as string
  scope: {
    routes: Kb[],                // see scope enum below
    workspaceId?: number,        // constrain key to a single workspace
  },
}
```

**Scope enum (`Kb`) — 7 values, UI exposes only 3 as checkboxes**:

| Scope | UI checkbox | Notes |
|---|---|---|
| `all` | yes | "Full access" (UI label) |
| `endpoints:prospect-search-api` | yes | "Prospect search API" |
| `public-endpoints:all` | yes | "Public API" — default-on in UI |
| `endpoints:run-enrichment` | no | Direct-API-mintable only |
| `terracotta:cli` | no | Likely for a Terracotta CLI surface — no bundle callers |
| `terracotta:code-node` | no | Likely for code-node execution inside tc-workflow runs |
| `terracotta:mcp` | no | **MCP (Model Context Protocol) scope — GAP-038**. Strong implication Clay has or is building an MCP server surface. |

**resourceType enum (`Gb`)** has ONLY `'user'`. Keys are user-owned;
`scope.workspaceId` constrains which workspace the key can act in.

**Plaintext key handling**: the `apiKey` field is in the POST response
ONCE — matches the UI modal text "For security reasons, this API Key
will not be displayed again. Make sure to store it safely." Subsequent
GETs do not include the plaintext. Minted key ids are `ak_`-prefixed.

**Credit cost**: zero. CRUD is metadata-only; no per-key charges observed.

**What these keys are USED for — still incomplete**: INV-028 verified
the CRUD works end-to-end but did not find a user-facing endpoint that
accepts these keys as authentication. Specifically:

- `postWebhookBatch` rejects them under every header form (see
  tc-workflows section above).
- The v1 API is fully deprecated — no working endpoint accepts any
  bearer token.
- The `prospect-search-api` and `public-endpoints:all` scopes hint at
  public-API surfaces Clay hasn't yet exposed (or are behind a separate
  subdomain / gateway we haven't probed).
- `terracotta:mcp` scope strongly suggests an MCP server surface
  (potentially at `/mcp`, `/v3/mcp`, or a separate host) — GAP-038.

Opened as follow-up: probe `terracotta:mcp`-scoped keys against
plausible MCP paths and search the bundle for MCP-shaped route
definitions.

### POST /v3/tables/{tableId}/duplicate — Table Duplication (INV-016)

**Request**:
```
POST /v3/tables/{tableId}/duplicate
Cookie: claysession=...
Content-Type: application/json

{"name": "My Copy"}
```

**Response**: Full table object (same as POST /v3/tables). Name defaults to "Copy of {original}" if not specified.

**Alternative paths**: `POST /v3/tables` with `sourceTableId` or `duplicateFromTableId` also work for duplication.

### POST /v3/tables/{tableId}/views — View Creation (INV-015)

**Request**:
```
POST /v3/tables/{tableId}/views
Cookie: claysession=...
Content-Type: application/json

{"name": "My Custom View"}
```

**Response** (200):
```json
{
  "id": "gv_xxx",
  "tableId": "t_xxx",
  "name": "My Custom View",
  "description": null,
  "order": "y",
  "fields": {"f_created_at": {"order": "b", "isVisible": false, "width": 200}},
  "sort": null,
  "filter": null,
  "limit": null,
  "offset": null
}
```

Only `/v3/tables/{id}/views` path works. `/v3/views`, `/v3/grid-views` return 404.

### PATCH /v3/tables/{tableId}/views/{viewId} — View Update (INV-015)

**Request**:
```
PATCH /v3/tables/{tableId}/views/{viewId}
Cookie: claysession=...
Content-Type: application/json

{"name": "Renamed View"}
```

Rename confirmed working. Filter/sort update returns 200 but values show null — payload format needs further investigation (see TODO-010).

### POST /v3/workbooks — Workbook Creation (INV-016)

**Request**:
```json
{"workspaceId": 1080480, "name": "My Workbook"}
```
Returns full workbook object with id (wb_xxx).

### POST /v3/workbooks/{workbookId}/duplicate — Workbook Duplication (INV-016)

**Request**:
```json
{"name": "My Copy"}
```
Returns duplicated workbook. Name defaults to "Copy of {original}".

**Note**: `GET /v3/workbooks/{id}`, `PATCH /v3/workbooks/{id}`, and `DELETE /v3/workbooks/{id}` all return 404. Only collection-level operations work (list via workspace, create, duplicate).

### GET /v3/api-keys — API Key Management

Superseded by the full API-key CRUD section earlier in this file (see
"Clay API Key CRUD — `/v3/api-keys` (`TRe` router, INV-028)"). Requires
`?resourceType=user&resourceId={userId}`; 400 without them.

## Enrichment Cell Metadata (INV-013)

When reading rows, enrichment/action column cells include a `metadata` object that reveals run status:

**Successful enrichment**:
```json
{"value": "✅ 25 posts found", "metadata": {"status": "SUCCESS", "isPreview": true, "imagePreview": "https://..."}}
```

**Failed enrichment (out of credits)**:
```json
{"value": null, "metadata": {"status": "ERROR_OUT_OF_CREDITS", "isPreview": true}}
```

**Failed enrichment (bad request)**:
```json
{"value": null, "metadata": {"status": "ERROR_BAD_REQUEST", "isPreview": true}}
```

**Not yet run (stale)**:
```json
{"value": null, "metadata": {"isStale": true, "staleReason": "TABLE_AUTO_RUN_OFF"}}
```

**Formula cells**:
```json
{"value": "HELLO WORLD", "metadata": {"status": "SUCCESS"}}
```

### recordMetadata.runHistory

Per-field array of run entries with unix timestamp and unique run ID:
```json
{
  "runHistory": {
    "f_enrichmentFieldId": [
      {"time": 1775443230930, "runId": "run_0td1wrisJxroYsg5UxE"},
      {"time": 1775443585553, "runId": "run_0td1x1ddn8m87zK6S3g"}
    ]
  }
}
```

**Polling-based completion detection**: After triggering enrichment, poll `GET /v3/tables/{id}/views/{viewId}/records` every 2-5 seconds. Check `cell.metadata.status` for each enrichment column — when all are `SUCCESS` or `ERROR_*`, the run is complete.

## Pagination (INV-014)

**There is no pagination mechanism.** All cursor/page/offset query params are silently ignored.

**Workaround**: Set `limit=10000` (or any large number) to retrieve all rows in a single call. Default limit without param = 100. Tested with 160 rows at 39ms response time.

## Formula Evaluation (INV-017)

Formulas auto-evaluate immediately on row insert and auto-re-evaluate when dependent cells are updated. No manual trigger is needed. `PATCH /v3/tables/{id}/run` with formula fieldIds also works if explicit re-evaluation is desired.

**No formula validation**: Clay accepts ANY formula text at creation time — invalid field references, syntax errors, everything returns 200. Errors only surface at runtime. Agents must validate field references themselves.

## autoRun Behavior (INV-023)

Setting `tableSettings.autoRun: true` via `PATCH /v3/tables/{id}` causes enrichment columns to **automatically execute on newly inserted rows**. Verified: insert row via `POST /records` → 500ms later enrichment already shows `status: "SUCCESS"`. No manual `PATCH /run` needed.

## Conditional Enrichment Execution (INV-023)

Enrichment columns can include `conditionalRunFormulaText` in typeSettings:
```json
{"conditionalRunFormulaText": "{{f_scoreField}} > 50"}
```

Behavior:
- Rows where condition is truthy → enrichment executes normally → `status: "SUCCESS"`
- Rows where condition is falsy → enrichment skipped → `status: "ERROR_RUN_CONDITION_NOT_MET"`
- The skip status `ERROR_RUN_CONDITION_NOT_MET` is distinct from actual errors

Optional enrichment parameters work via `inputsBinding`:
```json
{"inputsBinding": [
  {"name": "companyName", "formulaText": "{{f_input}}"},
  {"name": "titleCase", "formulaText": "true"}
]}
```

## tableSettings Merge Semantics (INV-023, INV-022)

`PATCH /v3/tables/{id}` with `tableSettings` uses **MERGE** (not replace):
- New keys are added to existing settings
- Setting a key to `null` stores null (does NOT delete the key)
- System keys `autoRun` and `HAS_SCHEDULED_RUNS` always present
- The object is schemaless — any key accepted
- **Top-level (non-`tableSettings`) PATCH fields** for the same shapes are silently dropped: `PATCH /v3/tables/{id}` with top-level `cronExpression` or `schedule` returns 200 but the keys never appear on read-back. Settings keys must be nested under `tableSettings`.

## Source Scheduling — UI-Only / Not Available via REST (INV-022)

Despite `tableSettings` happily accepting any schedule-shaped key, **none of them have any backend effect**. Scheduling is UI-only or scheduler-internal; there is no v3 REST surface for it.

**`tableSettings` schedule keys (all PERSIST via merge but are pure scratch space)**:
`schedule` (object), `cronExpression` (5-field, 6-field, `@hourly`, `@daily` all stored as opaque strings — no parsing/validation), `scheduleEnabled`, `nextRunAt`, `lastRunAt`, `scheduleStatus`, `runFrequency`, `runFrequencyConfig`. Round-trip a value like `nextRunAt: "2030-01-01T00:00:00.000Z"` and it stays exactly as written — nothing on the server is computing these.

**`HAS_SCHEDULED_RUNS` is server-controlled.** PATCH `tableSettings.HAS_SCHEDULED_RUNS: true` is silently overridden back to `false`. It's the only schedule-related key the backend manages itself.

**Sources do not store schedule state at all**:
- `PATCH /v3/sources/{id}` with `typeSettings.cronExpression` / `typeSettings.schedule` / `typeSettings.scheduleEnabled` / `typeSettings.runFrequency` / `typeSettings.nextRunAt` returns **500 InternalServerError**. Source `typeSettings` is **validated** (unlike `tableSettings`'s schemaless bucket) and 500s on unknown keys.
- Top-level source PATCH (`schedule`, `cronExpression`, `scheduleEnabled`, `isScheduled`, `scheduleConfig`) returns 200 but persists nothing — final source object is empty of any schedule keys.
- Production `trigger-source` examples carry only `signalType`, `triggerDefinitionId`, `actionSourceSettings` — no cron/schedule/frequency/nextRun fields anywhere on the source object.

**No scheduling endpoints exist** (404 across both INV-018 and INV-022 probes):
`/v3/schedules`, `/v3/scheduled-sources`, `/v3/scheduled-runs`, `/v3/scheduled-tables`, `/v3/cron`, `/v3/triggers`, `/v3/jobs`, `/v3/recurring-jobs`, `/v3/workspaces/{id}/schedules`, `/v3/workspaces/{id}/scheduled-runs`, `/v3/workspaces/{id}/scheduled-tables`, `/v3/tables/{id}/schedule(s)`, `/v3/tables/{id}/scheduled-runs`, `/v3/tables/{id}/runs`, `/v3/sources/{id}/schedule`, `/v3/sources/{id}/next-run`, plus POST variants.

**Workaround for automated refresh**: self-host cron and call `PATCH /v3/tables/{id}/run` with the desired `fieldIds` / `runRecords`. This is the only API-accessible way to get recurring enrichment runs today.

## Table Duplication Field IDs (INV-023)

`POST /v3/tables/{id}/duplicate` preserves **identical field IDs** between original and duplicate. Formulas, enrichment inputsBinding, and all field references remain valid in the clone. Duplication is a perfect template mechanism.

## Confirmed Non-Existent Endpoints

These return 404 (NoMatchingURL) — definitively do not exist:
`/v3/workbooks`, `/v3/fields`, `/v3/rows`, `/v3/columns`, `/v3/webhooks`, `/v3/views`, `/v3/enrichments`, `/v3/integrations`, `/v3/accounts`, `/v3/billing`, `/v3/credits`, `/v3/formulas`, `/v3/providers`, `/v3/connectors`, `/v3/folders`, `/v3/people`, `/v3/companies`, `/v3/notifications`, `/v3/templates`, `/v3/settings`, `/v3/graphql`, `/v3/auth-accounts`, `/v3/authAccounts`, `/v3/connected-accounts`
