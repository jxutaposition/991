# INV-007: Authenticated v3 API Validation

**Status**: completed
**Priority**: P0
**Gap**: GAP-001, GAP-002, GAP-003, GAP-006, GAP-007, GAP-017
**Date started**: 2026-04-05
**Date completed**: 2026-04-05

## Hypothesis

The 30+ endpoints discovered via unauthenticated enumeration (INV-006) are fully functional with a valid `claysession` cookie.

## Method

1. Extracted `claysession` cookie from user's browser DevTools (Application > Cookies > api.clay.com)
2. Tested each discovered endpoint with authenticated requests
3. Performed full table lifecycle: create → rename → add field → rename field → delete field → delete table

## Key Finding: Auth Cookie

**Cookie name**: `claysession`
**Domain**: `.api.clay.com` (NOT `.clay.com` or `app.clay.com`)
**Format**: Express/connect session — `s:<session_id>.<signature>` (URL-encoded as `s%3A...`)
**Lifetime**: 7 days
**Flags**: HttpOnly, Secure, SameSite=None

This cookie is set by `api.clay.com`, not `app.clay.com`. It will NOT appear when filtering cookies by the `app.clay.com` domain in DevTools — you must look at the `api.clay.com` domain specifically.

## Findings

### 1. GET /v3/me — User Info (200)

Returns full user profile including API token, auth strategy, session state, workspace IDs.

```json
{
  "id": 1282581,
  "username": "amit21min",
  "email": "[REDACTED]",
  "apiToken": "[REDACTED]",
  "authStrategy": "google",
  "sessionState": {"last_workspace_visited_id": "1080480"},
  "accountRiskStatus": "real"
}
```

### 2. GET /v3/workspaces/{id} — Workspace Details (200)

Returns workspace name, billing plan, and ~150 feature flags. Feature flags reveal:
- `enableWebhooks: true`
- `enableHttpApi: true`
- `enableApiKeys: true`
- `enableRunEnrichmentAPIEndpoint: false` (!)
- `workspaceRowLimit: 10000000`
- `tableColumnLimit: 100`
- `tableComputableColumnLimit: 40`
- `scheduledSourcesLimit: 100`

### 3. GET /v3/workspaces/{id}/tables — Table Listing (200)

Returns all tables in workspace with full metadata:
- Table ID, name, description, type, icon
- Workbook ID
- Table settings (AUTO_RUN_ON, HAS_SCHEDULED_RUNS, etc.)
- User abilities (canUpdate, canDelete, canManageAccess)
- Owner info, tags, sandbox status

**Important**: The table listing endpoint is `/v3/workspaces/{id}/tables`, NOT `/v3/tables/list` or `/v3/tables/recent` (those are interpreted as table IDs).

### 4. POST /v3/tables — Table Creation (200)

```
POST /v3/tables
{
  "workspaceId": 1080480,
  "type": "spreadsheet",
  "name": "_API_TEST_delete_me"
}
```

Returns:
- Full table object with ID, fields (Created At, Updated At), views (5 pre-configured)
- **Automatically creates a new workbook** with the same name
- `extraData.newlyCreatedWorkbook` contains the new workbook object

### 5. PATCH /v3/tables/{id} — Table Rename (200)

```
PATCH /v3/tables/{tableId}
{"name": "_API_TEST_renamed"}
```

Returns updated table object.

### 6. POST /v3/tables/{id}/fields — Field Creation (200)

```
POST /v3/tables/{tableId}/fields
{
  "name": "Test Field 2",
  "type": "text",
  "activeViewId": "gv_...",
  "typeSettings": {"dataTypeSettings": {"type": "text"}}
}
```

Returns field object with ID, supported filter operators, sort capability.

### 7. PATCH /v3/tables/{id}/fields/{fId} — Field Rename (200)

```
PATCH /v3/tables/{tableId}/fields/{fieldId}
{"name": "Renamed Field"}
```

Returns updated field object.

### 8. DELETE /v3/tables/{id}/fields/{fId} — Field Deletion (200)

Returns `{}` on success.

### 9. DELETE /v3/tables/{id} — Table Deletion (200)

Returns deleted table with `deletedAt` timestamp set.

### 10. GET /v3/sources?workspaceId={id} — Source Listing (200)

Returns all sources with IDs, types, states, record counts, typeSettings.

### 11. GET /v3/imports?workspaceId={id} — Import History (200)

Returns import jobs with full configs (field mappings, source files, destination tables).

### 12. GET /v3/actions?workspaceId={id} — Actions Catalog (200)

Returns ALL available enrichment actions with:
- Input/output parameter schemas (full Zod-like definitions)
- Auth requirements (providerType)
- Rate limit rules
- Enablement status and billing gates

### Endpoints Requiring Admin Access (403)

These endpoints require admin-level session auth:
- `GET /v3/workspaces` (list all workspaces)
- `GET /v3/exports` (needs admin)
- `GET /v3/users`, `/v3/users/me`, `/v3/users/list`

## Session Cookie Details

- **Cookie name**: `claysession`
- **Domain**: `.api.clay.com`
- **Lifetime**: 7 days from issuance
- **Current expiry**: 2026-04-12
- **Auth mechanism**: Express/connect-session with signed cookie
- **Required headers**: Only `Cookie: claysession=...` — no `X-Clay-Frontend-Version` required for most endpoints

## Implications

1. **Full table CRUD is now automated** — create, read, update, delete tables and fields via API
2. **The clay_operator agent can now be upgraded** to use these endpoints instead of `request_user_action` for table creation
3. **Session cookies last 7 days** — manageable with periodic refresh (user re-extracts from browser)
4. **Workbook creation is automatic** — creating a table also creates a workbook. No separate workbook API needed.
5. **The actions catalog endpoint** provides everything needed for enrichment configuration (input schemas, auth requirements)

## Next Steps

1. Build automated session refresh using Playwright + Xvfb (blocked by Google 2FA)
2. Test `PATCH /v3/tables/{id}/run` with real table to trigger enrichments
3. Investigate `/v3/imports/webhook` for programmatic webhook URL retrieval
4. Update the clay_operator agent tools with new capabilities
5. Build production-ready v3 API client in `backend/src/clay_api.rs`
