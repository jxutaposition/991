# INV-006: v3 API Unauthenticated Endpoint Enumeration

**Status**: completed
**Priority**: P0
**Gap**: GAP-001 (Full v3 Endpoint Catalog), GAP-002 (Table Lifecycle), GAP-007 (Column Update/Delete)
**Date started**: 2026-04-05
**Date completed**: 2026-04-05

## Hypothesis

Clay's v3 API returns different HTTP status codes for valid vs invalid endpoint paths even without authentication. By systematically probing paths, we can map the full endpoint surface without needing session cookies.

## Method

Systematic HTTP probing of `api.clay.com/v3/*` paths. The key insight is Clay's error response types:

| HTTP Status | Error Type | Meaning |
|---|---|---|
| 200 | n/a | Endpoint exists, no auth needed |
| 400 | `BadRequest` | Endpoint exists, validation failed — **reveals required params** |
| 401 | `Unauthorized` | Endpoint exists, needs session cookies |
| 404 (JSON) | `NoMatchingURL` | Endpoint does NOT exist (v3 router) |
| 404 (HTML) | `Cannot GET ...` | Path not in v3 router at all |

The 400 responses are most valuable — Clay's Zod validation returns the next required field, allowing iterative payload discovery.

## Findings

### 1. GET /v3 — Public Status Endpoint (No Auth)

```
GET https://api.clay.com/v3
→ 200
{
  "status": "ok",
  "auth": {
    "type": "unauthenticated",
    "actor": {"type": "unauthenticated", "id": "unauthenticated"},
    "abilities": {"h": false, "l": {}, "p": {}, "$": "manage", "A": "all", "M": [], "m": true}
  },
  "version": "v20260403_221301Z_9894a0108e"
}
```

Key takeaways:
- **Frontend version**: `v20260403_221301Z_9894a0108e` — use this as `X-Clay-Frontend-Version` header
- **Auth model**: CASL-style abilities (`$` = manage, `A` = all)
- **Version is timestamped**: Format is `vYYYYMMDD_HHMMSSz_commithash` — can poll for deployments

### 2. v1 and v2 Are Deprecated

```
GET /v1 → {"success":false,"message":"deprecated API endpoint"}
GET /v2 → {"success":false,"message":"deprecated API endpoint"}
GET /v4 → HTML 404 (doesn't exist)
GET /graphql → HTML 404 (no GraphQL)
```

v1 table-specific endpoints (`/api/v1/tables/{id}/rows`) still work, but the root `/v1` path says deprecated.

### 3. Confirmed v3 Top-Level Resources

| Path | GET | POST | PATCH | DELETE | Auth Level |
|---|---|---|---|---|---|
| `/v3/workspaces` | 401 | 401 | — | — | session |
| `/v3/workspaces/{id}` | 401 | — | — | — | session |
| `/v3/workspaces/{id}/tables` | 401 | — | — | — | session |
| `/v3/tables` | 401 (admin) | 400→401 | — | — | session |
| `/v3/tables/recent` | 401 | — | — | — | session |
| `/v3/tables/list` | 401 | — | — | — | session |
| `/v3/tables/search` | 401 | — | — | — | session |
| `/v3/tables/all` | 401 | — | — | — | session |
| `/v3/tables/{tableId}` | 401 | — | 401 | 401 | session |
| `/v3/tables/{tableId}/fields` | — | 401 | — | — | session |
| `/v3/tables/{tableId}/fields/{fieldId}` | — | — | 401 | 401 | session |
| `/v3/tables/{tableId}/run` | — | — | 400→401 | — | session |
| `/v3/sources` | 401 | 400→401 | — | — | session |
| `/v3/sources/list` | 401 | — | — | — | session |
| `/v3/sources/{sourceId}` | 401 | — | 401 | 401 | session |
| `/v3/users` | 401 (admin) | — | — | — | admin |
| `/v3/users/me` | 401 (admin) | — | — | — | admin |
| `/v3/users/current` | 401 (admin) | — | — | — | admin |
| `/v3/users/list` | 401 (admin) | — | — | — | admin |
| `/v3/users/search` | 401 (admin) | — | — | — | admin |
| `/v3/me` | 401 | — | — | — | session |
| `/v3/actions` | 400 | 400 | — | — | varies |
| `/v3/exports` | 401 (admin) | — | — | — | admin |
| `/v3/exports/csv` | 401 | — | — | — | session |
| `/v3/exports/download` | 401 | — | — | — | session |
| `/v3/imports` | 401 | 401 | — | — | session |
| `/v3/imports/csv` | 401 | — | — | — | session |
| `/v3/imports/webhook` | 401 | — | — | — | session |

### 4. POST /v3/tables — Table Creation Payload Discovery

Iterative probing revealed the required fields:

```
Step 1: POST /v3/tables {} → "workspaceId is required"
Step 2: POST /v3/tables {workspaceId:1} → "type is required"
Step 3: POST /v3/tables {workspaceId:1,type:"blank"} → "type must be one of [spreadsheet, company, people, jobs]"
Step 4: POST /v3/tables {workspaceId:1,type:"spreadsheet"} → 401 (valid payload, needs auth)
Step 5: POST /v3/tables {workspaceId:1,type:"spreadsheet",name:"Test"} → 401 (also valid with name)
```

**Table creation payload**:
```json
{
  "workspaceId": <number>,
  "type": "spreadsheet" | "company" | "people" | "jobs",
  "name": "<optional string>"
}
```

### 5. PATCH /v3/tables/{tableId}/run — Enrichment Trigger

```
Step 1: PATCH /v3/tables/{id}/run {fieldIds:[]} → "runRecords is Required"
Step 2: PATCH /v3/tables/{id}/run {runRecords:{},fieldIds:[]} → validation error (runRecords needs shape)
Step 3: PATCH /v3/tables/{id}/run {runRecords:{recordIds:["r_test"]},fieldIds:["f_test"],forceRun:true} → 401 (valid)
```

**Run endpoint payload**:
```json
{
  "runRecords": {"recordIds": ["<row_id>", ...]},
  "fieldIds": ["<field_id>", ...],
  "forceRun": true|false,
  "callerName": "<string>"  // optional, e.g. "ActionCellViewer"
}
```

### 6. POST /v3/actions — Action Package Creation

```
Step 1: POST /v3/actions {} → "workspaceId is required"
Step 2: POST /v3/actions {workspaceId:1} → "actionPackageId is required"
Step 3: POST /v3/actions {actionPackageId:"test",workspaceId:1} → "actionPackageDefinition is required"
Step 4: POST /v3/actions {actionPackageId:"test",actionPackageDefinition:{}} → "actionPackageDefinition must be a string"
```

**Actions payload**:
```json
{
  "workspaceId": <number>,
  "actionPackageId": "<string>",
  "actionPackageDefinition": "<serialized JSON string>"
}
```

### 7. Field CRUD Confirmed

| Operation | Endpoint | Status |
|---|---|---|
| Create field | `POST /v3/tables/{tableId}/fields` | 401 (confirmed by Claymate) |
| Update field | `PATCH /v3/tables/{tableId}/fields/{fieldId}` | 401 (NEW) |
| Delete field | `DELETE /v3/tables/{tableId}/fields/{fieldId}` | 401 (NEW) |
| Replace field | `PUT /v3/tables/{tableId}/fields/{fieldId}` | 404 (doesn't exist) |

### 8. Source CRUD Confirmed

| Operation | Endpoint | Status |
|---|---|---|
| List sources | `GET /v3/sources` / `GET /v3/sources/list` | 401 |
| Create source | `POST /v3/sources` | 400→401 (Claymate confirmed) |
| Read source | `GET /v3/sources/{sourceId}` | 401 (Claymate confirmed) |
| Update source | `PATCH /v3/sources/{sourceId}` | 401 (NEW) |
| Delete source | `DELETE /v3/sources/{sourceId}` | 401 (NEW) |

### 9. Confirmed Non-Existent Paths (404)

These paths definitively do NOT exist in the v3 router:
`/v3/workspace` (singular), `/v3/fields`, `/v3/enrichments`, `/v3/integrations`, `/v3/accounts`, `/v3/auth`, `/v3/search`, `/v3/webhooks`, `/v3/views`, `/v3/rows`, `/v3/columns`, `/v3/organizations`, `/v3/team`, `/v3/billing`, `/v3/credits`, `/v3/formulas`, `/v3/providers`, `/v3/connectors`, `/v3/folders`, `/v3/workbooks`, `/v3/people`, `/v3/companies`, `/v3/persons`, `/v3/contacts`, `/v3/lookups`, `/v3/enrichment`, `/v3/notifications`, `/v3/templates`, `/v3/invitations`, `/v3/activity`, `/v3/audit`, `/v3/changelog`, `/v3/versions`, `/v3/settings`, `/v3/config`, `/v3/health`, `/v3/status`, `/v3/actions/run-enrichment`, `/v3/actions/run`

## New Endpoints Discovered

**28 new endpoints** added to endpoints.jsonl (see registry update).

## Implications

1. **GAP-002 RESOLVED**: Table creation is confirmed via `POST /v3/tables`. Needs session cookies and a valid workspaceId.
2. **GAP-007 RESOLVED**: Column update (`PATCH`) and delete (`DELETE`) confirmed on `/v3/tables/{tableId}/fields/{fieldId}`.
3. **GAP-006 PARTIALLY RESOLVED**: Multiple table listing endpoints exist (`/v3/tables/recent`, `/v3/tables/list`, `/v3/tables/search`, `/v3/tables/all`, `/v3/workspaces/{id}/tables`).
4. **Table deletion confirmed**: `DELETE /v3/tables/{tableId}` exists.
5. **Source CRUD complete**: Create, read, update, delete all confirmed.
6. **Import/export endpoints exist**: `/v3/imports/csv`, `/v3/imports/webhook`, `/v3/exports/csv`, `/v3/exports/download`.
7. **v3 run endpoint confirmed**: `PATCH /v3/tables/{tableId}/run` with full payload structure known.
8. **Frontend version discoverable**: `GET /v3` returns current version string without auth.

## Next Steps

1. **Get session cookies** to authenticate and actually execute these endpoints
2. Test `POST /v3/tables` with real workspaceId to create a table
3. Test `DELETE /v3/tables/{tableId}` on a scratch table
4. Test `PATCH /v3/tables/{tableId}/fields/{fieldId}` for column updates
5. Probe `/v3/tables/list` and `/v3/tables/recent` for response shapes
6. Probe `/v3/actions?workspaceId={id}` for connected action/enrichment accounts
7. Investigate `/v3/imports/webhook` for programmatic webhook URL retrieval
