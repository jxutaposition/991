# Clay Capability Matrix

Last updated: 2026-04-06 (post workbook pipeline rebuild)

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
| Row pagination | no (v1 deprecated) | **no** (offset silently ignored) | needs investigation (GAP-026) |
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
| Create action columns (route-row) | no | **yes** | **working — auto-creates source on target table** |
| Create source columns | no | yes (two-step or auto via route-row) | **working** |
| Update/rename columns | no | yes (PATCH) | **working** |
| Update formula text | no | yes (PATCH typeSettings.formulaText) | **working** |
| Update action config | no | yes (PATCH typeSettings.inputsBinding) | **working** |
| Delete columns | no | yes (DELETE) | **working** |
| Reorder columns | no | unknown | needs investigation |
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
| Duplicate table | no | unknown | needs investigation |
| Workbook CRUD | no | **no** (`/v3/workbooks` → 404) | **not available** |

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
| Create route-row column | no | **yes** (actionKey: "route-row", supports list mode) | **working — confirmed with list routing** |
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
| CSV export | no | untested (async job model?) | needs investigation |
| API key management | no | yes (`GET/POST /v3/api-keys`) | **working (purpose unclear)** |

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
