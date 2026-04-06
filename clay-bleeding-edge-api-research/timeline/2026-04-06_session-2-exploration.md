# Session 2: Boundary Exploration

**Date**: 2026-04-06
**Session cookie**: Same as April 5 (valid until April 12)
**Investigation**: INV-008 (Authenticated Boundary Probing)

## Summary

Ran 30+ probes against the v3 API to push beyond what INV-006/007 confirmed. Tested source CRUD, table rename, v3 row access, enrichment trigger params, auth account enumeration, rate limits, and workspace details.

## Key Discoveries

### 1. Session cookie auto-refreshes on every request

The `set-cookie` header in the `/v3/me` response returns a new cookie with a refreshed expiry:
```
set-cookie: claysession=s%3A...; Expires=Mon, 13 Apr 2026 01:12:16 GMT
```
Request was made April 6 — expiry pushed to April 13. **The 7-day timer resets on every API call.** As long as you hit any v3 endpoint at least once per 7 days, the session never expires.

### 2. Rate limits are extremely generous (or non-existent)

20 rapid-fire requests to `/v3/me` with **zero delays**:
- 0 out of 20 were rate-limited (429)
- Average latency: 21ms
- No `X-RateLimit-*` or `Retry-After` headers observed
- The 150ms baseline from Claymate was a courtesy delay, not a necessity

### 3. Source CRUD is fully operational

| Endpoint | Status | Response |
|---|---|---|
| `GET /v3/sources?workspaceId=` | 200 | Array of sources with id, name, type, typeSettings, state, recordSourceUpdatedAt |
| `GET /v3/sources/{id}` | 200 | Full source detail with `sourceSubscriptions` (which table/field it feeds) |
| `PATCH /v3/sources/{id}` | 200 | Update works (empty body = no-op returns current state) |

`GET /v3/sources/list` returns 404 — use query string `?workspaceId=` on `/v3/sources` instead.

Source detail response shape:
```json
{
  "id": "s_...",
  "workspaceId": 1080480,
  "name": "Rows from: Posts",
  "type": "manual",
  "typeSettings": {"type": "routing"},
  "state": {"numSourceRecords": 271},
  "recordSourceUpdatedAt": "2026-04-05T03:06:10.381Z",
  "sourceSubscriptions": [
    {"tableId": "t_...", "fieldId": "f_..."}
  ]
}
```

### 4. Table rename (PATCH) confirmed with full response shape

`PATCH /v3/tables/{id}` with `{"name": "New Name"}` returns the full table object:
```
Keys: id, workspaceId, createdByUserId, name, description, type, icon, parentFolderId,
      tableSettings, createdAt, updatedAt, deletedAt, fieldGroupMap, workbookId,
      defaultAccess, ownerId, isSandbox, isHiddenFromNavigation, abilities,
      firstViewId, owner, fields, views, extraData
```
Successfully renamed and reverted a table. Rename is instant and reflects in the UI.

### 5. Enrichment trigger requires `runRecords` as OBJECT, not string

Empty body to `PATCH /v3/tables/{id}/run` returns Zod validation:
```json
{
  "bodyErrors": {
    "issues": [
      {"path": ["fieldIds"], "expected": "array", "message": "Required"},
      {"path": ["runRecords"], "expected": "object", "message": "Required"}
    ]
  }
}
```
Previous docs had `runRecords` as a string `"all"` — it's actually an object like `{"recordIds": ["r_..."]}`.

### 6. v3 has NO row endpoints

All 404:
- `GET /v3/tables/{id}/rows`
- `GET /v3/tables/{id}/rows?limit=5&offset=0`
- `POST /v3/tables/{id}/rows`

**Confirmed: v1 is the only API for row operations.** This is definitive.

### 7. Auth accounts are NOT accessible via any v3 path

All 404:
- `/v3/auth-accounts?workspaceId=`
- `/v3/authAccounts?workspaceId=`
- `/v3/providers?workspaceId=`
- `/v3/workspaces/{id}/auth-accounts`
- `/v3/workspaces/{id}/connections`
- `/v3/workspaces/{id}/providers`
- `/v3/workspaces/{id}/integrations`
- `/v3/workspaces/{id}/accounts`
- `/v3/workspaces/{id}/members`
- `/v3/workspaces/{id}/settings`

`authAccountId` is set per-column (stored in field `typeSettings.authAccountId`) and can only be read from existing enrichment columns, not enumerated globally.

### 8. Actions catalog is massive: 1,191 actions, 170+ providers

`GET /v3/actions?workspaceId=1080480` returns 1,191 action definitions with:
- Full input/output parameter schemas with `semanticType` hints
- Rate limit rules (per-provider)
- Provider type and icon
- Enablement status per billing plan

Auth block only contains `{"providerType": "..."}` — no `authAccountId`. That ID is bound at the column level, not the action level.

Notable providers in catalog: anthropic, gpt-3, google-gemini, mistral, cohere, hubspot, salesforce, apollo, zoominfo, linkedin, slack, notion, airtable, stripe, sendgrid, github, and 160+ more.

### 9. Workspace detail includes billing and credits

`GET /v3/workspaces/1080480` returns:
```
Keys: id, name, createdByUserId, icon, billingPlanType, billingEmail, customerId,
      createdAt, updatedAt, deletedAt, billingPlanUpdatedAt, settings, featureFlags,
      credits, creditBudgets, currentPeriodEnd, centsPerCredit, onboardingData,
      abilities, audienceAbilities
```
- `billingPlanType`: "postPricingChange2026Trial"
- `credits` and `creditBudgets` expose current credit balance
- `featureFlags` contains workspace-level feature toggles
- `abilities` shows CASL-style permissions

### 10. Import history is accessible

`GET /v3/imports?workspaceId=1080480` returns array of 26 import records with:
- Import config with column mapping
- Source table references
- Timestamps (created, finished)
- Import type and status

### 11. CSV export is NOT a simple GET

`GET /v3/exports/csv?tableId=` returns 404 with `"Export job csv not found"`. Export is likely a POST to create an async job, then GET to download.

### 12. Workspaces list requires admin

`GET /v3/workspaces` (without ID) returns 403: `"You must be logged in as an admin"`. Only workspace-specific GET works for regular users.

## What This Means

### Resolved Gaps
- **GAP-003** (Session durability): FULLY RESOLVED. Cookie auto-refreshes. 7-day timer resets on use.
- **GAP-005** (Rate limits): RESOLVED. No rate limiting observed at 20 req/s. Zero 429s.
- **GAP-011** (v3 row access): RESOLVED NEGATIVE. No v3 row endpoints exist.
- **GAP-004** (Auth account enumeration): PARTIALLY RESOLVED NEGATIVE. No global endpoint exists; authAccountIds are per-column only.

### New Tools to Implement
1. `clay_update_table` — `PATCH /v3/tables/{id}` (rename, description, icon)
2. `clay_read_source` — `GET /v3/sources/{id}`
3. `clay_update_source` — `PATCH /v3/sources/{id}`
4. `clay_list_sources` — `GET /v3/sources?workspaceId=`
5. `clay_get_workspace` — `GET /v3/workspaces/{id}` (credits, billing, features)
6. `clay_list_actions` — `GET /v3/actions?workspaceId=` (enrichment catalog)

### Configuration Changes
- Lower inter-call delay from 150ms to 50ms (conservative) or remove entirely
- Implement session cookie auto-refresh by reading `set-cookie` headers
- Fix enrichment trigger payload: `runRecords` is an object, not a string
