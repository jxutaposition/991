# Clay Bleeding-Edge API Research

Reverse-engineering Clay's (clay.com) internal v3 API to enable fully programmatic table management — creating tables, configuring enrichments, managing data pipelines, and running AI actions — all without the Clay UI.

## Current Status

| Metric | Value |
|--------|-------|
| Documented endpoints | 68 (45+ confirmed working) |
| Investigation sessions | 11 |
| Exhaustively searched dead-ends | 35 |
| Authentication | Session cookie (`claysession`), 7-day auto-refreshing |
| Rate limiting | None detected (50 req/s tested) |
| Average latency | ~21ms |

**All operations use `https://api.clay.com/v3`** with session cookie auth. The v1 API is fully deprecated.

---

## What We Can Do

### Tables & Workbooks

| Operation | How |
|-----------|-----|
| List tables | `GET /v3/workspaces/{id}/tables` |
| Get full table schema | `GET /v3/tables/{id}` — returns fields, views, sources, settings, abilities |
| Create table | `POST /v3/tables` with `{workspaceId, type, name}` |
| Rename/update table | `PATCH /v3/tables/{id}` with `{name, description, tableSettings}` |
| Delete table | `DELETE /v3/tables/{id}` |
| Duplicate table | `POST /v3/tables/{id}/duplicate` — copies schema + settings, NOT rows. Field IDs preserved. |
| Move table to different workbook | `PATCH /v3/tables/{id}` with `{workbookId: "wb_other"}` |
| List workbooks | `GET /v3/workspaces/{id}/workbooks` |
| Create workbook | `POST /v3/workbooks` with `{workspaceId, name}` |
| Duplicate workbook | `POST /v3/workbooks/{id}/duplicate` |

### Rows (Records)

| Operation | How |
|-----------|-----|
| Create rows | `POST /v3/tables/{id}/records` — up to 500+ rows per call, `{records: [{cells: {f_id: "value"}}]}` |
| Read rows (list) | `GET /v3/tables/{id}/views/{viewId}/records?limit=10000` — requires view ID. Default limit=100, use 10000 for all rows. No pagination mechanism. |
| Read single row | `GET /v3/tables/{id}/records/{recordId}` — bypasses views, always works |
| Update rows | `PATCH /v3/tables/{id}/records` — async (enqueued), last-write-wins |
| Delete rows | `DELETE /v3/tables/{id}/records` with `{recordIds: [...]}` |

**Limits tested**: 500 rows per insert (163ms), 500KB per cell value, invalid field IDs silently ignored (row created, bad fields skipped), 10 concurrent inserts all succeed.

### Columns (Fields)

| Operation | How |
|-----------|-----|
| Create text/url/email/number column | `POST /v3/tables/{id}/fields` with `{name, type: "text", typeSettings: {dataTypeSettings: {type}}, activeViewId}` |
| Create formula column | Same, `type: "formula"`, `typeSettings: {formulaText, formulaType, dataTypeSettings}` |
| Create enrichment (action) column | Same, `type: "action"`, `typeSettings: {actionKey, actionPackageId, inputsBinding, authAccountId?}` |
| Rename column | `PATCH /v3/tables/{id}/fields/{fieldId}` with `{name}` |
| Update formula text | `PATCH /v3/tables/{id}/fields/{fieldId}` with `{typeSettings: {formulaText: "..."}}` |
| Delete column | `DELETE /v3/tables/{id}/fields/{fieldId}` |

**Cannot change field type** (e.g., text→formula) via PATCH — must delete and recreate.

**No formula validation**: Clay accepts ANY formula text at creation time. Invalid references and syntax errors return 200. Errors only surface at runtime. Agent must validate field IDs itself.

**Deletion cascade**: Deleting a field that's referenced by formulas/enrichments marks dependents with `settingsError` (not deleted). Fix via PATCH with corrected references — error auto-clears.

### Formula Language

Clay formulas are **JavaScript expressions** evaluated per-row. All results coerced to strings.

| Pattern | Example | Result |
|---------|---------|--------|
| String ops | `UPPER({{f_text}})`, `LOWER()`, `LEN()` | "ANTHROPIC" |
| JS string methods | `{{f}}?.includes("x")`, `.split("@")?.[1]`, `.slice(0,3)`, `.replace()`, `.startsWith()` | Works |
| Concatenation | `{{f_name}} + " Inc."` | "Anthropic Inc." |
| Number ops | `parseInt({{f}})`, `Math.round()`, `{{f}} * 2` | "42", "43", "85.4" |
| Conditionals | `{{f}} > 50 ? "high" : "low"` | "low" |
| JSON parsing | `JSON.parse({{f_json}})?.key`, `?.nested?.deep`, `?.arr?.[0]` | Extracts from JSON strings |
| Arrays | `[1,2,3].map(x => x*2).join(",")`, `.filter(x => x>3)` | "2,4,6" |
| RegExp | `{{f_url}}?.match(/https?:\/\/([^/]+)/)?.[1]` | "www.anthropic.com" |
| Dates | `new Date().getFullYear()` | "2026" |
| Clay utils | `Clay.formatForJSON({{f}})`, `DOMAIN({{f_url}})` | Clay-specific functions |

**What doesn't work**: `typeof` (parse error).

### Enrichment Actions

Clay has **1193 enrichment actions** from 170+ providers. Each is a packaged API call that takes inputs from row data and stores results in the cell.

| Operation | How |
|-----------|-----|
| List all actions | `GET /v3/actions?workspaceId=` — returns full catalog with I/O schemas, rate limits, auth requirements |
| List auth accounts | `GET /v3/app-accounts` — all connected accounts with IDs and provider types |
| Create enrichment column | `POST /v3/tables/{id}/fields` with `type: "action"`, `actionKey`, `actionPackageId`, `inputsBinding` |
| Trigger enrichment | `PATCH /v3/tables/{id}/run` with `{runRecords: {recordIds}, fieldIds, forceRun}` |
| Check completion | Poll row cells → `cell.metadata.status` |
| Auto-trigger on insert | Set `tableSettings.autoRun: true` — enrichments fire automatically on new rows |
| Conditional execution | Add `conditionalRunFormulaText: "{{f_score}} > 50"` to enrichment typeSettings |
| Re-run only gaps | `forceRun: false` skips cells already at SUCCESS |
| Force re-run all | `forceRun: true` re-runs everything |

**Key actions available without auth (354 total)**:
- **`use-ai`** — Clay's built-in LLM. Inputs: `prompt`, `systemPrompt`, `model`, `temperature`, `jsonMode`, `maxCostInCents`. No API key needed.
- **`claygent`** — AI web researcher. Inputs: `mission`, `model`. Autonomous web research.
- **`table-level-ai`** — AI using entire Clay table as context. Inputs: `tableId`, `question`.
- **`scrape-website`** — Web scraper with JS rendering. Inputs: `url`, `outputFields`, `enableJavaScriptRendering`.
- **`search-google`** — Google search. Inputs: `query`, `numberOfResults`.
- **`normalize-company-name`** — Text normalization.
- **`http-api-v2`** — Call ANY HTTP endpoint with custom method/headers/body.
- **`lookup-*-in-other-table`** — Cross-table JOINs (single, multiple, company).

**Enrichment cell metadata status values**:
- `SUCCESS` — completed, value populated
- `ERROR_OUT_OF_CREDITS` — credit exhaustion
- `ERROR_BAD_REQUEST` — provider error
- `ERROR_RUN_CONDITION_NOT_MET` — intentionally skipped by conditional formula
- `{isStale: true, staleReason: "TABLE_AUTO_RUN_OFF"}` — not yet run

### Table Settings

`PATCH /v3/tables/{id}` with `{tableSettings: {...}}` — schemaless JSON blob, merge semantics (keys accumulate).

| Setting | Effect |
|---------|--------|
| `autoRun: true` | Auto-trigger enrichments when rows are inserted |
| `dedupeFieldId: "f_xxx"` | Set dedup key (doesn't prevent API inserts; may only affect source/webhook ingestion) |
| `schedule`, `cronExpression` | Accepted but behavioral effect unverified |
| Any arbitrary key | Accepted (schemaless) — set to default value to "undo", null doesn't delete |

### Views

| Operation | How |
|-----------|-----|
| Create view | `POST /v3/tables/{id}/views` with `{name}` |
| Rename view | `PATCH /v3/tables/{id}/views/{viewId}` with `{name}` |
| Delete view | `DELETE /v3/tables/{id}/views/{viewId}` |

**View filter/sort is NOT settable via REST API.** 11 payload formats tested, all return 200 but don't persist. Preconfigured views (Errored rows, Fully enriched rows, etc.) get filters server-side via `typeSettings.preconfiguredType`. See `exhaustively_searched/view-filter-sort.md`.

### Sources & Webhooks

| Operation | How |
|-----------|-----|
| Create source | `POST /v3/sources` with `{workspaceId, tableId, name, type, typeSettings}` |
| Read source | `GET /v3/sources/{id}` — includes `state.url` for webhook sources |
| List sources | `GET /v3/sources?workspaceId=` |
| Rename source | `PATCH /v3/sources/{id}` with `{name}` |
| Delete source | `DELETE /v3/sources/{id}` |

**Webhook sources require a paid plan** (402 Payment Required on Launch plan).

### CSV Export (Full Flow)

1. `POST /v3/tables/{id}/export` → `{id: "ej_xxx", status: "ACTIVE"}`
2. Poll: `GET /v3/exports/{jobId}` → wait for `status: "FINISHED"`
3. Download: `GET /v3/exports/{jobId}?download=true` → `downloadUrl` field contains pre-signed S3 URL (24h expiry)

### Workspace & Users

| Operation | How |
|-----------|-----|
| Workspace details | `GET /v3/workspaces/{id}` — billing, credits, feature flags |
| Credit balance | `credits: {basic: N, actionExecution: N}` |
| Current user | `GET /v3/me` — profile, API token, session state |
| List users | `GET /v3/workspaces/{id}/users` — members with roles |
| Permissions | `GET /v3/workspaces/{id}/permissions` — role assignments |
| Signals | `GET /v3/workspaces/{id}/signals` — monitoring configs (read-only) |
| Resource tags | `POST/GET/DELETE /v3/workspaces/{id}/resource-tags` — full CRUD |
| Attributes catalog | `GET /v3/attributes` — 68 enrichment attributes (28 person, 40 company) with provider mappings |
| Import history | `GET /v3/imports?workspaceId=` |

### Authentication

| Aspect | Details |
|--------|---------|
| Method | Session cookie `claysession` on `.api.clay.com` |
| Format | Express signed cookie: `s:<session_id>.<signature>` (URL-encoded) |
| Lifetime | 7 days, auto-refreshes on every API call |
| Extraction | Browser DevTools → Application → Cookies → `api.clay.com` → `claysession` |
| API key auth | Does NOT work on v3 endpoints. Session cookie is the only mechanism. |

---

## What We Can't Do

| Capability | Status |
|------------|--------|
| View filter/sort via API | Not possible — preconfigured views only |
| Row pagination | No cursor/offset — use `limit=10000` workaround |
| Row sorting via query params | All params ignored — sorting is view-level only |
| Route-row column creation | Endpoint exists but payload format needs investigation (400 error) |
| Webhook source creation | Requires paid plan (402 on Launch plan) |
| WebSocket/real-time updates | Unknown transport, requires CDP browser inspection |
| Individual workbook read/update/delete | Only create, duplicate, and list work |
| Table history/restore | UI-only feature, all endpoints 404 |
| Custom action packages | `POST /v3/actions` exists but `actionPackageDefinition` format undocumented |
| Per-action credit tracking | Only aggregate via workspace details |
| Tag-to-table association | Tags exist but no way to link them to tables via REST |
| Import job creation | Endpoint exists (500 not 404) but requires file upload, not JSON |

Full list of 35 dead-ends: see [exhaustively_searched/](exhaustively_searched/).

---

## Key Behavioral Patterns

| Behavior | Rule |
|----------|------|
| **autoRun** | `tableSettings.autoRun: true` → enrichments auto-fire on row insert (~500ms). Works with conditional formulas. |
| **Formula evaluation** | Formulas auto-evaluate on insert and auto-re-evaluate on dependent cell changes. No trigger needed. |
| **Table duplication** | Schema + settings + views copied. Rows NOT copied. **Field IDs preserved** — all references valid in clone. |
| **tableSettings** | Merge semantics — keys accumulate. `null` doesn't delete. Schemaless blob. |
| **Concurrent writes** | All succeed. PATCH is async last-write-wins. No locking. |
| **Invalid formulas** | Accepted at creation (200). Errors only at runtime. Agent must validate field refs. |
| **Deletion cascade** | Dependent fields get `settingsError`, not deleted. Fix via PATCH — error auto-clears. |
| **forceRun** | `false` = skip SUCCESS cells. `true` = re-run all. Response shows total submitted, not filtered count. |
| **View reads** | Use view ID obtained AFTER all columns created. Or use single record endpoint to bypass views entirely. |
| **Credit cost** | Only enrichment execution costs credits. All CRUD, schema reads, formula eval = FREE. |

---

## ID Formats

| Entity | Format | Example |
|--------|--------|---------|
| Table | `t_` + alphanumeric | `t_0tczx56mXZE94e8vdXs` |
| Field | `f_` + alphanumeric | `f_0tczmx3mm8gbNKuaWMZ` |
| View | `gv_` + alphanumeric | `gv_0tczmx2mhzSo3mFsrYs` |
| Record | `r_` + alphanumeric | `r_0td1wqfzVWADzCQ8fwC` |
| Source | `s_` + alphanumeric | `s_0td1wf0SUdg6kfhgRve` |
| Workbook | `wb_` + alphanumeric | `wb_0td1vqydXftNuRgPgHc` |
| Export job | `ej_` + alphanumeric | `ej_0td27yaDc4FUgFZw6UK` |
| Signal | `sig_` + alphanumeric | `sig_0tczx56sqoRJ8sQnHzP` |
| Tag | `tag_` + alphanumeric | `tag_0td27ypn6EEi9Amo7xk` |
| Workspace | Numeric | `1080480` |

---

## Folder Map

```
clay-bleeding-edge-api-research/
├── README.md                       # This file
├── AGENT.md                        # Instructions for deployed research agents
├── timeline/                       # Chronological progress (13 entries, 11 sessions)
├── knowledge/                      # API reference docs (v3 API, auth, webhooks, Claymate analysis)
├── architecture/                   # System design, tool specs, integration plan
├── registry/
│   ├── endpoints.jsonl             # Machine-readable endpoint registry (68 entries)
│   ├── capabilities.md             # Capability matrix
│   ├── gaps.md                     # Open research questions
│   └── changelog.md                # Timestamped discovery log
├── harness/
│   ├── scripts/                    # 20+ investigation scripts (TypeScript/tsx)
│   └── results/                    # Raw JSON probe results + session cookies
├── investigations/                 # 28 completed investigations (INV-001 through INV-028)
├── exhaustively_searched/          # 35 documented dead-ends (things that DON'T work)
└── todo/                           # 10 open items, 40+ resolved
```
