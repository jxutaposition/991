# Clay Internal v3 API Reference

Last updated: 2026-04-06 (post Session 4 — INV-013 through INV-017)
Source: Originally reverse-engineered from Claymate Lite. Expanded via enumeration (INV-006), validation (INV-007), and systematic gap investigation (INV-013–017).

**Canonical endpoint registry**: `registry/endpoints.jsonl` (57 entries). This file documents the most important endpoints in detail. For the full list, always check the registry.

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

### GET/POST /v3/api-keys — API Key Management (INV-011)
- `GET /v3/api-keys?resourceType=user&resourceId={userId}` — list user's API keys
- `POST /v3/api-keys` with `{resourceType: "user", resourceId: "userId", name: "key-name", keyData: {scopes: []}}` — creates a UUID API key
- Note: These keys do NOT work with the deprecated v1 API. Their purpose is unclear but they may be used for webhook auth or future API versions.

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

### GET /v3/api-keys — API Key Management (INV-017)

Requires query params `?resourceType=user&resourceId={userId}`. Returns 400 without them.

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

## Confirmed Non-Existent Endpoints

These return 404 (NoMatchingURL) — definitively do not exist:
`/v3/workbooks`, `/v3/fields`, `/v3/rows`, `/v3/columns`, `/v3/webhooks`, `/v3/views`, `/v3/enrichments`, `/v3/integrations`, `/v3/accounts`, `/v3/billing`, `/v3/credits`, `/v3/formulas`, `/v3/providers`, `/v3/connectors`, `/v3/folders`, `/v3/people`, `/v3/companies`, `/v3/notifications`, `/v3/templates`, `/v3/settings`, `/v3/graphql`, `/v3/auth-accounts`, `/v3/authAccounts`, `/v3/connected-accounts`
