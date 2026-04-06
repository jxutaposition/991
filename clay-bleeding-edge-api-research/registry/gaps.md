# Open Research Gaps

Last updated: 2026-04-06 (post-INV-009 Session 3)

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
**Status**: 38 endpoints cataloged. Response shapes confirmed for all major endpoints. Remaining unknowns are edge-case import/export endpoints.

## P1: Important for Full Coverage


### ~~GAP-009: v1 API Pagination~~ — RESOLVED NEGATIVE (INV-011)
The entire v1 API is deprecated and non-functional. `api.clay.com/api/v1/*` routes are not registered (Express 404), and `api.clay.run/v1/*` returns `{"success":false,"message":"deprecated API endpoint"}`. The pagination question is moot.


### GAP-019: Action Package Definition Format
**Question**: What is the format of `actionPackageDefinition` (string) in `POST /v3/actions`?
**Method**: CDP interception during action column configuration

### ~~GAP-020: Import/Export Mechanics~~ — RESOLVED (INV-017)
**Status**: Export confirmed: `POST /v3/tables/{id}/export` creates an async job returning `{id: "ej_xxx", status: "ACTIVE", fileName, uploadedFilePath: null}`. Poll `GET /v3/exports/{jobId}` for `uploadedFilePath`. Import: `GET /v3/imports?workspaceId=` works.

### ~~GAP-026: Row Pagination~~ — RESOLVED (INV-014)
No cursor/page/offset mechanism exists. All params silently ignored. **Workaround**: use `limit=10000` (or larger) to get all rows in one call. Default limit without param = 100. Tested with 160 rows, 39ms response time.

### ~~GAP-004: Enrichment Provider Configuration~~ — FULLY RESOLVED (INV-010)
`GET /v3/app-accounts` returns all 111 auth accounts with IDs, provider types, ownership. The `id` field IS the `authAccountId` needed for enrichment column creation. No need to extract from existing columns — just list and match by `appAccountTypeId` to `auth.providerType` in the actions catalog.

### ~~GAP-022: authAccountId Extraction~~ — SUPERSEDED by GAP-004 resolution
Direct listing via `/v3/app-accounts` is far superior to column extraction.

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

