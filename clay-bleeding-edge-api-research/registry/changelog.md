# Discovery Changelog

Timestamped log of significant discoveries and registry updates.

## 2026-04-06: INV-010 Deep Dive — authAccountId BREAKTHROUGH

**Source**: Creative endpoint probing after systematically exhausting obvious paths

**The Discovery**: `GET /v3/app-accounts` returns ALL 111 auth accounts with their IDs, provider types, and ownership.

The key that unlocked it: when creating an enrichment column with a dummy `authAccountId`, the error said `"App Account not found"`. This told us the entity is called "App Account" — and `/v3/app-accounts` was the path. Previous probes tried `auth-accounts`, `authAccounts`, `connected-accounts` but never `app-accounts`.

**What this means**: The agent can now fully automate enrichment column creation end-to-end:
1. `GET /v3/actions?workspaceId=` → find the enrichment action + its `auth.providerType`
2. `GET /v3/app-accounts` → find the account where `appAccountTypeId` matches the provider
3. `POST /v3/tables/{id}/fields` → create the column with the correct `authAccountId`

**Also discovered**: Action column creation also requires `actionPackageId` (the `package.id` from the actions catalog), not just `actionKey`.

**Gaps resolved**: GAP-004 (FULLY), GAP-022 (superseded)

## 2026-04-06: INV-009 Reach Goals (Session 3)

**Source**: Authenticated probing — webhook creation, enrichment trigger, table type comparison, credit monitoring

**Discoveries**:

1. **Webhook URL is in `state.url`** (GAP-010 RESOLVED)
   - `POST /v3/sources` with `type: "webhook"` → response includes `state.url: "https://api.clay.com/v3/sources/webhook/{uuid}"`
   - URL is stable UUID. Immediately readable after creation.
   - `DELETE /v3/sources/{id}` returns `{success: true}` (GAP-024 RESOLVED)

2. **`runRecords: {recordIds: string[]}` confirmed** (GAP-021 RESOLVED)
   - `{recordIds: []}` → `runMode: "INDIVIDUAL"` (correct key)
   - `{}`, `{all: true}`, `{allRecords: true}` → `runMode: "NONE"` (wrong keys)

3. **Table types are functionally identical** (GAP-018 RESOLVED)
   - `spreadsheet` and `company` both start with 2 fields (Created At, Updated At) and 5 views
   - Type only affects UI onboarding, not API schema

4. **Credit monitoring works in real time** (GAP-023 RESOLVED)
   - `credits: {basic: 574, actionExecution: 9553}` / `creditBudgets: {basic: 2000, actionExecution: 10000}`

5. **50 rapid requests: 0 rate-limited** — rate limits are effectively non-existent

6. **CORRECTED: `/v3/tables/recent`, `/v3/tables/list`, etc. are NOT endpoints**
   - INV-006 reported these as "exists (401)" but they were false positives
   - Authenticated test shows 404: "Table recent does not exist" — treated as table IDs
   - Only valid table listing is `/v3/workspaces/{id}/tables`
   - Same for `/v3/imports/csv`, `/v3/imports/webhook` — these are import job ID lookups, not separate endpoints

**Gaps resolved**: GAP-010, GAP-018, GAP-021, GAP-023, GAP-024
**Registry corrections**: 6 endpoints downgraded from untested → not-endpoint (false positive 401s)

## 2026-04-06: INV-008 Boundary Exploration (Session 2)

**Source**: Authenticated probing of 30+ v3 endpoints using session cookie from INV-007

**Discoveries**:

1. **Session cookie auto-refreshes** (GAP-003 RESOLVED)
   - `set-cookie` header in every response pushes expiry forward by 7 days
   - Cookie never expires as long as any v3 endpoint is hit weekly
   - Eliminates need for complex refresh logic

2. **No rate limiting detected** (GAP-005 RESOLVED)
   - 20 rapid-fire requests: 0 rate-limited, avg 21ms, no rate-limit headers
   - 150ms Claymate baseline was a courtesy delay, not a requirement

3. **v3 has NO row endpoints** (GAP-011 RESOLVED NEGATIVE)
   - GET/POST `/v3/tables/{id}/rows` → 404
   - v1 API is the only path for row CRUD

4. **Source CRUD fully operational** — GET, PATCH confirmed with full response shapes
   - `GET /v3/sources?workspaceId=` lists all sources (use query param, not /sources/list)
   - `GET /v3/sources/{id}` returns sourceSubscriptions (table/field linkage)
   - `PATCH /v3/sources/{id}` works (empty body = no-op)

5. **Table rename confirmed** — `PATCH /v3/tables/{id}` with `{name}` returns full table object

6. **Workspace detail returns billing/credits** — `GET /v3/workspaces/{id}` includes billingPlanType, credits, creditBudgets, featureFlags, abilities

7. **Actions catalog: 1,191 actions, 170+ providers** — full I/O schemas, rate limits, enablement info
   - Auth block only has `{providerType}` — no authAccountId (that's per-column only)
   - All auth-account enumeration paths 404'd

8. **Import history accessible** — `GET /v3/imports?workspaceId=` returns 26 records with column mappings

9. **Enrichment trigger `runRecords` is an OBJECT** — not a string. Corrected in registry.

10. **`X-Clay-Frontend-Version` header confirmed optional** — all probes succeeded without it

11. **CSV export is async** — `GET /v3/exports/csv?tableId=` returns 404 "job not found", likely needs POST to create job first

12. **`GET /v3/workspaces` (list all) requires admin** — 403 for regular users

**Gaps resolved**: GAP-003, GAP-005, GAP-011, GAP-017 (mostly)
**Gaps partially resolved**: GAP-004 (negative — no auth-account endpoint), GAP-020 (import works, export unclear)
**New gaps added**: GAP-021 (runRecords format), GAP-022 (authAccountId extraction), GAP-023 (credit monitoring), GAP-024 (source delete)
**Endpoint registry**: 10 endpoints upgraded from untested → confirmed with full response shapes

## 2026-04-05: Initial Research Sprint

**Source**: Conversation analysis + Claymate Lite source code reverse-engineering + Clay University docs + web research

**Discoveries**:

1. **Clay internal v3 API confirmed** (`api.clay.com/v3`)
   - Reverse-engineered from Claymate Lite `content.js` (984 lines)
   - 4 endpoints confirmed: table read, field create, source read, source create
   - Authentication: browser session cookies + `X-Clay-Frontend-Version` header
   - Added 4 v3 entries to endpoints.jsonl

2. **Clay official v1 API documented**
   - 5 endpoints cataloged: table metadata, row read/write, enrichment trigger, sources list
   - API key auth (Bearer token)
   - Added 5 v1 entries to endpoints.jsonl

3. **Claymate Lite fully analyzed**
   - Schema format documented (version 1.0, columns array with typeSettings)
   - Field reference system mapped: `{{f_xxx}}` internal, `{{@Column Name}}` portable
   - Dependency resolution algorithm documented (topological sort)
   - Source column two-step creation process documented
   - 150ms inter-call delay noted

4. **Product disambiguation documented**
   - Clay GTM (clay.com) vs Clay Personal CRM (clay.earth)
   - `@clayhq/clay-mcp` is for personal CRM, NOT GTM
   - `clay-mcp-bridge` (bleed-ai) referenced but no public artifact found

5. **16 research gaps identified and prioritized**
   - 3 P0 gaps (endpoint catalog, table lifecycle, session durability)
   - 7 P1 gaps (enrichment config, rate limits, table listing, column CRUD, workbooks, pagination, webhook URLs)
   - 6 P2 gaps (row v3, formula triggers, error states, version header, WebSockets, bulk ops)

6. **Architecture designed**
   - Four-layer access stack (v1 API, v3 bridge, Playwright, CDP)
   - Session management lifecycle
   - 11 new agent tools specified
   - Integration plan with main codebase
   - Risk assessment with mitigation strategies

**Files created**: 8 knowledge docs, 5 architecture docs, 4 registry files, 5 harness prompts, 4 harness scripts, 6 investigation stubs

## 2026-04-05: INV-006 Unauthenticated Endpoint Enumeration

**Source**: Systematic HTTP probing of `api.clay.com/v3/*` using 401/404 differentiation and Zod validation error mining

**Method**: Send requests to every plausible v3 path. 401 = endpoint exists (needs auth). 404 = doesn't exist. 400 = exists AND reveals required parameters via Zod validation errors. Iteratively build payloads by fixing one validation error at a time.

**Discoveries**:

1. **`GET /v3` is publicly accessible** (no auth) — returns:
   - Current frontend version: `v20260403_221301Z_9894a0108e`
   - CASL-style auth abilities structure
   - Can be polled to detect deployments

2. **`POST /v3/tables` — TABLE CREATION CONFIRMED** (GAP-002 RESOLVED)
   - Payload: `{workspaceId: number, type: "spreadsheet"|"company"|"people"|"jobs", name?: string}`
   - Table types enumerated via validation error: must be one of [spreadsheet, company, people, jobs]

3. **`DELETE /v3/tables/{tableId}` and `PATCH /v3/tables/{tableId}` — TABLE DELETE/UPDATE CONFIRMED**

4. **`PATCH /v3/tables/{tableId}/run` — ENRICHMENT TRIGGER CONFIRMED**
   - Payload: `{runRecords: {recordIds: string[]}, fieldIds: string[], forceRun: boolean, callerName?: string}`
   - Zod validation revealed full schema

5. **Column CRUD completed** (GAP-007 RESOLVED)
   - `PATCH /v3/tables/{tableId}/fields/{fieldId}` — update
   - `DELETE /v3/tables/{tableId}/fields/{fieldId}` — delete
   - `PUT` does NOT exist (404)

6. **Table listing endpoints discovered** (GAP-006 RESOLVED)
   - `/v3/tables/recent`, `/v3/tables/list`, `/v3/tables/search`, `/v3/tables/all`
   - `/v3/workspaces/{id}/tables`

7. **Source CRUD completed**
   - `PATCH /v3/sources/{sourceId}` — update
   - `DELETE /v3/sources/{sourceId}` — delete
   - `GET /v3/sources/list` — listing

8. **Import/Export endpoints discovered**
   - `/v3/imports/csv`, `/v3/imports/webhook`
   - `/v3/exports/csv`, `/v3/exports/download`

9. **Actions endpoint discovered**
   - `GET /v3/actions?workspaceId=` — list actions
   - `POST /v3/actions` — create action package: `{workspaceId, actionPackageId, actionPackageDefinition: string}`

10. **Workbook CRUD confirmed NOT available** (GAP-008 RESOLVED NEGATIVE)
    - `/v3/workbooks` → 404

11. **v1 and v2 deprecated** — `/v1` and `/v2` both return `{"success":false,"message":"deprecated API endpoint"}`

12. **v1 has no collection endpoints** — `/api/v1/tables`, `/api/v1/sources`, `/api/v1/workspaces` all 404. Only table-specific paths work.

**Endpoint registry**: Grew from 9 to 37 entries
**Gaps resolved**: GAP-002, GAP-006, GAP-007, GAP-008
**New gaps added**: GAP-017 (response shapes), GAP-018 (table types), GAP-019 (action definition format), GAP-020 (import/export mechanics)
