# Clay v3 API Reference

Clay's internal API at `https://api.clay.com/v3` powers all operations. The v1 API is **deprecated and non-functional** — all v1 endpoints return errors. The v3 API is stable and production-ready.

## Authentication

**Session cookie** (`claysession`): Required for all v3 calls. Stored in the Clay credential and auto-injected by all dedicated Clay tools.

- **Domain**: `.api.clay.com`
- **Lifetime**: 7 days, rolling — resets on every API call. As long as any endpoint is hit once per 7 days, the session never expires.
- **Format**: `claysession=s%3A...` (URL-encoded Express session ID)
- **How to get it**: DevTools → Application → Cookies → `api.clay.com` → copy `claysession` value

**Rate limiting**: None detected. 50 rapid-fire requests at zero delay: 0 throttled. No rate-limit headers observed. No inter-call delays needed.

## Table Lifecycle

### Create Table
```
POST /v3/tables
Body: {"workspaceId": <number>, "type": "spreadsheet"|"company"|"people"|"jobs", "name": "<string>", "workbookId": "<string> (optional)"}
```
Returns the new table object with ID. Table types are functionally identical in API — type only affects UI onboarding.

### Read Full Table Schema
```
GET /v3/tables/{tableId}
```
Returns complete schema: all fields with IDs, names, types, full `typeSettings` (formulas, enrichment configs, data types), views with field ordering, sources, and abilities.

Response shape:
```json
{
  "fields": [
    {"id": "f_abc", "name": "Website", "type": "text", "typeSettings": {"dataTypeSettings": {"type": "url"}}},
    {"id": "f_def", "name": "Domain", "type": "formula", "typeSettings": {"formulaText": "DOMAIN({{f_abc}})", "formulaType": "text"}}
  ],
  "views": [{"id": "gv_xyz", "name": "All rows", "fieldOrder": ["f_abc", "f_def"]}],
  "sources": [...]
}
```

### Update Table
```
PATCH /v3/tables/{tableId}
Body: {"name": "New Name"}
```

### Delete Table
```
DELETE /v3/tables/{tableId}
```

### List Tables in Workspace
```
GET /v3/workspaces/{workspaceId}/tables
```
Returns `{results: Table[]}`.

### List Workbooks in Workspace
```
GET /v3/workspaces/{workspaceId}/workbooks
```

## Row CRUD

### Read Rows (requires view ID)
```
GET /v3/tables/{tableId}/views/{viewId}/records?limit=N
```
View IDs (`gv_xxx`) come from `GET /v3/tables/{tableId}` → `views[]`. Views apply server-side filtering (e.g. "Fully enriched rows" returns only enriched records). Use the default or "All rows" view for full table reads.

**Important**: `limit` works. `offset` is accepted but **silently ignored** — always returns from start. No pagination metadata (no hasMore, total, nextCursor).

### Read Single Row
```
GET /v3/tables/{tableId}/records/{recordId}
```

### Write Rows
```
POST /v3/tables/{tableId}/records
Body: {"records": [{"cells": {"f_abc123": "value", "f_def456": 42}}]}
```
Cell keys must be field IDs (`f_xxx`). Multiple records per call.

### Update Rows
```
PATCH /v3/tables/{tableId}/records
Body: {"records": [{"id": "r_xxx", "cells": {"f_abc123": "new value"}}]}
```
Updates are **async (enqueued)** — may not be immediately visible.

### Delete Rows
```
DELETE /v3/tables/{tableId}/records
Body: {"recordIds": ["r_xxx", "r_yyy"]}
```

## Column CRUD

### Create Column
```
POST /v3/tables/{tableId}/fields
Body: {
  "name": "Column Name",
  "type": "text"|"formula"|"action"|"source",
  "activeViewId": "gv_xxx",
  "typeSettings": { ... }
}
```

**Text column**: `{"type": "text", "typeSettings": {"dataTypeSettings": {"type": "text"|"url"|"email"|"number"|"boolean"|"json"|"select"}}}`

**Formula column**: `{"type": "formula", "typeSettings": {"formulaText": "DOMAIN({{f_xxx}})", "formulaType": "text", "dataTypeSettings": {"type": "text"}}}`

**Action/enrichment column**: `{"type": "action", "typeSettings": {"actionKey": "provider-name", "actionPackageId": "uuid", "authAccountId": "aa_xxx", "inputsBinding": [{"name": "domain", "formulaText": "{{f_xxx}}"}], "dataTypeSettings": {"type": "json"}}}`

**Route-row column**: `{"type": "action", "typeSettings": {"actionKey": "route-row", "tableId": "formulaText with literal table ID string", "rowData": {"Key Name": "{{f_xxx}}"}}}`
- Auto-creates source fields on target table
- List mode: `type: "list"` + `listData` creates one row per list item

Returns: `{"field": {"id": "f_new123", "name": "...", "type": "..."}}`

### Update Column
```
PATCH /v3/tables/{tableId}/fields/{fieldId}
Body: {"name": "New Name", "typeSettings": { ... }}
```
Use PATCH only — PUT returns 404. Can update name, formula text, action config, input bindings.

### Delete Column
```
DELETE /v3/tables/{tableId}/fields/{fieldId}
```

Field references in formulas use internal IDs: `{{f_abc123}}`.

## Source Management

### Create Source
```
POST /v3/sources
Body: {"workspaceId": 12345, "tableId": "t_xxx", "name": "Webhook", "type": "v3-action", "typeSettings": {"hasAuth": false, "iconType": "Webhook"}}
```

### Read Source (get webhook URL)
```
GET /v3/sources/{sourceId}
```
Webhook URL is in `state.url`: `https://api.clay.com/v3/sources/webhook/{uuid}`

### List All Sources
```
GET /v3/sources?workspaceId=N
```

### Update Source
```
PATCH /v3/sources/{sourceId}
```

### Delete Source
```
DELETE /v3/sources/{sourceId}
```
Returns `{success: true}`.

## Enrichment & Actions

### List All Available Actions
```
GET /v3/actions?workspaceId=N
```
Returns 1,191 available enrichment actions from 170+ providers, each with full I/O schemas, rate limits, and auth requirements.

### List Connected Auth Accounts
```
GET /v3/app-accounts
```
Returns all auth accounts with their IDs. The `id` field IS the `authAccountId` needed for enrichment column creation. Match `appAccountTypeId` to an action's `auth.providerType` to find the right account.

### Trigger Enrichment/Action Runs
```
PATCH /v3/tables/{tableId}/run
Body: {
  "runRecords": {"recordIds": ["r_xxx"]},
  "fieldIds": ["f_enrichment_col"],
  "forceRun": true
}
```
Target specific rows and fields. `forceRun: true` re-runs even completed rows.

## Workspace & Account

### Get Workspace Details
```
GET /v3/workspaces/{workspaceId}
```
Returns billing, credit balance (`credits: {basic: N, actionExecution: N}`), feature flags, abilities. Real-time credit tracking.

### Get Current User
```
GET /v3/me
```
Returns user info, API token, auth strategy, workspace IDs. Also refreshes session cookie.

## What Requires `request_user_action`

Only one thing has no API endpoint:
- Connecting enrichment provider accounts (OAuth handshake inside Clay UI)

Everything else — including discovering `authAccountId` values — is fully automatable via the API.
