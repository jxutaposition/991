# Clay Bleeding-Edge API Research

A structured research project to reverse-engineer, document, and build a proprietary server-side API layer for Clay (the GTM enrichment platform at clay.com). Clay has no official public API for structural operations. This project systematically maps what exists, discovers what's possible, and designs the integration layer.

## Goal

Build a proprietary "API" that gives the Lele agent full programmatic read/write/configure access to Clay tables — creating columns, configuring enrichments, managing webhooks, reading schemas, and debugging formulas — all server-side, without requiring a human in the Clay UI.

## Current Status (updated 2026-04-06)

**The v3 API is the only functional API layer.** The v1 API is fully deprecated and non-functional. All operations go through `https://api.clay.com/v3` authenticated with a `claysession` cookie.

| Metric | Value |
|--------|-------|
| Documented endpoints | 57 (38+ confirmed working) |
| Authentication | Session cookie (`claysession`), 7-day auto-refreshing lifetime |
| Rate limiting | None detected (50 req/s tested) |
| Average latency | ~21ms |

### Proof of capability

On 2026-04-06 we programmatically **diagnosed and rebuilt an entire Clay workbook pipeline** using only v3 API calls — no browser, no UI. This included: creating tables, creating enrichment action columns, creating formula columns, creating route-row actions, updating formulas, deleting broken fields, deleting tables, seeding row data, triggering enrichments, and verifying end-to-end data flow across 4 tables with 128 source rows producing 100 output rows.

---

## What We CAN Do (confirmed working)

### Row CRUD (complete)

| Operation | Endpoint | Notes |
|-----------|----------|-------|
| **Create rows** | `POST /v3/tables/{id}/records` | `{records: [{cells: {f_id: "value"}}]}`. Multiple rows per call. |
| **Read rows (list)** | `GET /v3/tables/{id}/views/{viewId}/records?limit=10000` | Requires a view ID. Use `limit=10000` for all rows. No pagination mechanism. |
| **Read single row** | `GET /v3/tables/{id}/records/{recordId}` | Returns full record with cells, metadata, timestamps. |
| **Update rows** | `PATCH /v3/tables/{id}/records` | `{records: [{id: "r_xxx", cells: {...}}]}`. Async/enqueued. |
| **Delete rows** | `DELETE /v3/tables/{id}/records` | `{recordIds: ["r_xxx", "r_yyy"]}`. Synchronous. |

### Column/Field CRUD (complete)

| Operation | Endpoint | Notes |
|-----------|----------|-------|
| **Create text column** | `POST /v3/tables/{id}/fields` | `{name, type: "text", activeViewId, typeSettings: {dataTypeSettings: {type: "text"}}}` |
| **Create formula column** | `POST /v3/tables/{id}/fields` | `{type: "formula", typeSettings: {formulaText: "...", formulaType: "text"}}` |
| **Create action column** | `POST /v3/tables/{id}/fields` | `{type: "action", typeSettings: {actionKey, actionPackageId, inputsBinding: [...]}}` |
| **Create enrichment column** | `POST /v3/tables/{id}/fields` | Same as action, with `authAccountId` for authenticated providers. |
| **Create route-row column** | `POST /v3/tables/{id}/fields` | `actionKey: "route-row"`, supports `type: "list"` for one-to-many routing. Auto-creates source on target table. |
| **Create source column** | Two-step | `POST /v3/sources` then read back `dataFieldId`. Or auto-created via route-row. |
| **Update/rename column** | `PATCH /v3/tables/{id}/fields/{fieldId}` | Can update `name`, `typeSettings` (including `formulaText`). |
| **Delete column** | `DELETE /v3/tables/{id}/fields/{fieldId}` | Returns `{}` on success. |

### Table Lifecycle (complete)

| Operation | Endpoint | Notes |
|-----------|----------|-------|
| **List tables** | `GET /v3/workspaces/{id}/tables` | Returns `{results: [{id, name, type, workbookId, ...}]}` |
| **List workbooks** | `GET /v3/workspaces/{id}/workbooks` | Returns all workbooks with names, settings, ownership. |
| **Get table schema** | `GET /v3/tables/{id}` | Full schema: fields, views, sources, abilities. |
| **Create table** | `POST /v3/tables` | `{workspaceId, type: "spreadsheet"\|"company"\|"people"\|"jobs", name, workbookId?}` |
| **Rename table** | `PATCH /v3/tables/{id}` | `{name: "New Name"}` |
| **Delete table** | `DELETE /v3/tables/{id}` | Returns deleted table with `deletedAt` timestamp. |
| **Duplicate table** | `POST /v3/tables/{id}/duplicate` | `{name?: "Custom Name"}`. Also works via `POST /v3/tables` with `sourceTableId` param. |
| **Create workbook** | `POST /v3/workbooks` | `{workspaceId, name}`. Returns full workbook object. |
| **Duplicate workbook** | `POST /v3/workbooks/{id}/duplicate` | Copies entire workbook. |

### View Management (new — Session 4)

| Operation | Endpoint | Notes |
|-----------|----------|-------|
| **Create view** | `POST /v3/tables/{id}/views` | `{name: "Custom View"}`. Returns view with id, fields, filter, sort. |
| **Rename view** | `PATCH /v3/tables/{id}/views/{viewId}` | `{name: "New Name"}`. |
| **Update filter/sort** | `PATCH /v3/tables/{id}/views/{viewId}` | Returns 200 but may not persist — payload format needs refinement. |

### Source/Webhook Management (complete)

| Operation | Endpoint | Notes |
|-----------|----------|-------|
| **Create source** | `POST /v3/sources` | `{workspaceId, tableId, name, type, typeSettings}` |
| **Read source** | `GET /v3/sources/{id}` | Includes `state.url` for webhook sources. |
| **List sources** | `GET /v3/sources?workspaceId=` | All sources with IDs, types, states. |
| **Update source** | `PATCH /v3/sources/{id}` | |
| **Delete source** | `DELETE /v3/sources/{id}` | Returns `{success: true}`. |

### Enrichment & Actions

| Operation | Endpoint | Notes |
|-----------|----------|-------|
| **List all actions** | `GET /v3/actions?workspaceId=` | 1,191 actions, 170+ providers. Full I/O schemas, rate limits. |
| **List auth accounts** | `GET /v3/app-accounts` | Returns all 111 auth accounts with IDs and provider types. |
| **Trigger enrichment** | `PATCH /v3/tables/{id}/run` | `{runRecords: {recordIds: [...]}, fieldIds: [...], forceRun: true}`. Returns `{recordCount, runMode}`. |
| **Check enrichment status** | Poll row cells → `metadata.status` | Values: `SUCCESS`, `ERROR_OUT_OF_CREDITS`, `ERROR_BAD_REQUEST`. Stale: `{isStale: true}`. |
| **Create action column** | `POST /v3/tables/{id}/fields` | Requires `actionKey`, `actionPackageId`, `inputsBinding`, optionally `authAccountId`. |
| **Run history** | `recordMetadata.runHistory` on rows | Per-field `[{time: unix_ms, runId: "run_xxx"}]`. |

### Workspace & Account

| Operation | Endpoint | Notes |
|-----------|----------|-------|
| **Workspace details** | `GET /v3/workspaces/{id}` | Billing, credits, feature flags, abilities. |
| **Current user** | `GET /v3/me` | User profile, API token, auth strategy. |
| **Credit balance** | `GET /v3/workspaces/{id}` | `credits: {basic: N, actionExecution: N}` in real time. |
| **Import history** | `GET /v3/imports?workspaceId=` | Import records with column mapping details. |
| **CSV export** | `POST /v3/tables/{id}/export` | Creates async job (`ej_xxx`). Poll for `uploadedFilePath`. |
| **API key management** | `GET /v3/api-keys?resourceType=user&resourceId=` | List API keys per user. |

### Authentication

| Aspect | Details |
|--------|---------|
| **Method** | Session cookie `claysession` on `.api.clay.com` |
| **Format** | Express signed cookie: `s:<session_id>.<signature>` (URL-encoded) |
| **Lifetime** | 7 days, auto-refreshes on every API call |
| **Extraction** | Browser DevTools → Application → Cookies → `api.clay.com` → `claysession` |
| **Headers needed** | Only `Cookie` + `Accept: application/json`. `X-Clay-Frontend-Version` is optional. |
| **Rate limiting** | None detected at 50 req/s. |

---

## What We CAN'T Do (remaining gaps)

| Capability | Status | Notes |
|------------|--------|-------|
| **WebSocket/real-time** | Unknown | Clay UI shows live updates but no WS/SSE endpoint discovered. Requires CDP browser inspection. |
| **View filter/sort update** | Partially working | PATCH returns 200 but filter/sort not persisted. Payload format needs CDP intercept. |
| **Custom action packages** | Endpoint exists, format unknown | `POST /v3/actions` with `actionPackageDefinition` — serialized format undocumented. (GAP-019) |
| **List all workspaces** | Requires admin | 403 for regular users. |
| **Individual workbook CRUD** | Not available | `GET/PATCH/DELETE /v3/workbooks/{id}` all 404. Only create, duplicate, and list (via workspace) work. |
| **Table history/restore** | Not available | All endpoints 404. Feature flag exists but API is UI-only. |
| **Per-action credit tracking** | Not available | No credit-usage endpoints. Only aggregate via workspace details. |
| **Row sorting via query params** | Not available | All sort params silently ignored. Sorting is view-level only. |

### Confirmed non-existent endpoints

These v3 paths return 404 — they definitively do not exist:

`/v3/workbooks`, `/v3/fields`, `/v3/rows`, `/v3/columns`, `/v3/webhooks`, `/v3/views`, `/v3/enrichments`, `/v3/integrations`, `/v3/accounts`, `/v3/billing`, `/v3/credits`, `/v3/formulas`, `/v3/providers`, `/v3/connectors`, `/v3/folders`, `/v3/people`, `/v3/companies`, `/v3/notifications`, `/v3/templates`, `/v3/settings`, `/v3/graphql`, `/v3/auth-accounts`, `/v3/authAccounts`, `/v3/connected-accounts`

### Deprecated (non-functional)

| Layer | Status |
|-------|--------|
| **v1 API** (`api.clay.com/api/v1/*`) | Routes not registered (Express HTML 404) |
| **v1 API** (`api.clay.run/v1/*`) | Returns `{"success":false,"message":"deprecated API endpoint"}` |
| **v2 API** | Same deprecated response as v1 |

---

## Key Technical Details

### Field reference system

Clay formulas use internal field IDs, not column names:
- **Internal**: `{{f_abc123}}` — used in all API calls
- **Portable** (Claymate only): `{{@Column Name}}` — does NOT work at runtime

### Data type settings

The `dataTypeSettings.type` field controls display: `text`, `url`, `email`, `number`, `boolean`, `json`, `select`

### Route-row mechanics

Route-row actions (`actionKey: "route-row"`) have special behavior:
- **Auto-creates source**: When a route-row targets a table, Clay auto-creates a source field on the target plus formula columns for each `rowData` key
- **List mode**: `type: "list"` with `listData` creates one row per list item. The `rowData` becomes `parent` context accessible via `{{source}}?.parent?.["key"]`
- **Single mode**: Default. Creates one row per source row.
- **Source merging**: If the target table already has a source from another route-row, Clay adds the new source ID to the existing source field's `sourceIds` array

### ID formats

| Entity | Format | Example |
|--------|--------|---------|
| Table | `t_` + alphanumeric | `t_0tczx56mXZE94e8vdXs` |
| Field | `f_` + alphanumeric | `f_0tczmx3mm8gbNKuaWMZ` |
| View | `gv_` + alphanumeric | `gv_0tczmx2mhzSo3mFsrYs` |
| Record | `r_` + alphanumeric | `r_0td1wqfzVWADzCQ8fwC` |
| Source | `s_` + alphanumeric | `s_0td1wf0SUdg6kfhgRve` |
| Workbook | `wb_` + alphanumeric | `wb_0td1vqydXftNuRgPgHc` |
| Workspace | Numeric | `1080480` |

---

## Quick Reference

| What | Where |
|------|-------|
| Iterative progress log | [timeline/](timeline/) |
| Everything we know about Clay's APIs | [knowledge/](knowledge/) |
| System design for the proprietary API layer | [architecture/](architecture/) |
| Endpoint registry and capability matrix | [registry/](registry/) |
| Agent-deployable probing infrastructure | [harness/](harness/) |
| Individual research threads | [investigations/](investigations/) |
| Open research gaps | [registry/gaps.md](registry/gaps.md) |
| TODO tracker | [todo/](todo/) |

## How to Deploy an Agent

1. Point the agent at this folder
2. Have it read [AGENT.md](AGENT.md) first
3. It will check [registry/gaps.md](registry/gaps.md) for open research questions
4. It picks a gap, probes it using the harness scripts/prompts, writes findings to `investigations/`
5. It updates `registry/endpoints.jsonl` and `registry/capabilities.md` with new discoveries

## Folder Map

```
clay-bleeding-edge-api-research/
├── README.md                       # This file
├── AGENT.md                        # Instructions for deployed agents
├── timeline/                       # Iterative progress: what we know, can do, can't do
│   └── YYYY-MM-DD_slug.md         # One entry per research session
├── knowledge/                      # Persistent documentation of everything known
│   ├── landscape.md                # Full landscape: official vs unofficial vs bleeding-edge
│   ├── official-api.md             # v1 API reference (deprecated)
│   ├── internal-v3-api.md          # Reverse-engineered v3 API (primary reference)
│   ├── webhooks.md                 # Webhook capabilities, limits, patterns
│   ├── authentication.md           # Auth mechanics per layer
│   ├── claymate-analysis.md        # Full Claymate Lite source analysis
│   ├── third-party-tools.md        # Community tools and integrations
│   └── clay-dom-structure.md       # DOM selectors, React SPA structure
├── architecture/                   # Design docs for the proprietary API layer
│   ├── system-design.md            # Four-layer stack architecture
│   ├── session-management.md       # Cookie extraction, storage, refresh
│   ├── tool-specifications.md      # New agent tool definitions
│   ├── risk-assessment.md          # ToS, stability, fallback strategies
│   └── integration-plan.md         # Integration with existing clay_operator
├── registry/                       # Structured endpoint/capability tracking
│   ├── endpoints.jsonl             # Machine-readable endpoint registry (57 entries)
│   ├── capabilities.md             # What can we do vs. what we can't
│   ├── gaps.md                     # Open research questions (prioritized)
│   └── changelog.md                # Timestamped discovery log
├── harness/                        # Agent-deployable probing infrastructure
│   ├── README.md                   # How to run probes
│   ├── prompts/                    # Structured prompts for agent sessions
│   ├── scripts/                    # Runnable Playwright/CDP scripts
│   ├── fixtures/sample-schemas/    # Test data for probing
│   └── results/                    # Output directory for probe results
├── investigations/                 # Individual research threads (17 completed)
│   ├── _index.md                   # Index of all investigations
│   └── INV-XXX_*.md                # One file per investigation
└── todo/                           # Task tracker (2 open, 17 resolved)
    ├── README.md                   # Task management overview + resolved log
    └── TODO-XXX_*.md               # Individual open task files
```

## Relationship to Main Codebase

This folder is a **research project** — it does not modify the main `backend/` or `frontend/` code. When findings are ready for promotion to production:

- New Clay API client code goes to `backend/src/clay_api.rs`
- New tool definitions go to `backend/tools/clay/actions.toml`
- Updated agent prompts go to `backend/agents/clay_operator/prompt.md`
- Updated knowledge goes to `backend/agents/clay_operator/knowledge/clay-reference.md`

The promotion path is documented in [architecture/integration-plan.md](architecture/integration-plan.md).

---

**Important**: When updating any file in this project, ensure ALL related files (knowledge/, registry/, architecture/) are also updated. Stale claims create confusion for deployed agents. The single source of truth for endpoint status is `registry/endpoints.jsonl`. All other files should reference or align with it.
