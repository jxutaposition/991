# 2026-04-05: Initial Research

## North Star

Build a complete proprietary API so our server-side agent can do **everything** in Clay programmatically. Playwright UI fallback is the absolute last resort, not a strategy.

---

## PART 1: What We CAN Do Right Now

### Auth Setup Required Before Anything Works

There are two auth layers. Both are needed for full coverage.

**Layer A -- v1 API key (for row/data operations)**:
- Obtain from [app.clay.com/settings](https://app.clay.com/settings)
- Static bearer token, permanent until revoked, account-scoped (all workspaces)
- Already integrated in Lele: stored encrypted in `client_credentials`, auto-injected for any `api.clay.com` request
- **Can be fully automated**: user pastes key once in Lele settings UI, backend validates via `GET /api/v1/sources`, done
- No refresh needed, no expiration

**Layer B -- v3 session cookies (for schema/structural operations)**:
- Requires a browser login to `app.clay.com` (email/password or Google SSO)
- Produces browser session cookies that must be extracted and replayed
- **Cannot be fully automated yet** -- we have the `extract-session.ts` script but haven't tested:
  - Whether headless Playwright login works against Clay (bot detection?)
  - Whether extracted cookies work from a different IP than where they were extracted
  - How long cookies last before expiring
  - Whether `X-Clay-Frontend-Version` header is strictly required or optional
- **Current best path**: headed Playwright (user sees the browser, logs in manually or via automated fill), extract cookies, store encrypted, re-extract on 401
- **Fallback**: user manually exports cookies from browser DevTools and pastes into Lele

### Confirmed v3 API Actions (Session Cookie Auth)

These are **proven working** -- Claymate Lite (22+ stars, MIT, shipping product) calls these exact endpoints.

#### 1. Read Full Table Schema

```
GET /v3/tables/{tableId}
```

**What it gives you**:
- Every field/column: `id`, `name`, `type`, `typeSettings` (formulas, enrichment configs, data types, everything)
- All grid views with field ordering
- Source column configuration
- System fields (`f_created_at`, `f_updated_at`)

**What you can do with it**:
- Export any table's complete structural blueprint
- Inspect formula logic behind any column without clicking in the UI
- See enrichment provider configuration (actionKey, packageId, inputsBinding)
- See conditional run formulas
- See data type settings for every column
- Read the dependency graph between columns (which formulas reference which fields)
- Diff two tables structurally

**Exact call**:
```
Headers: Cookie: {session}, Accept: application/json, Content-Type: application/json, X-Clay-Frontend-Version: {version}
Response: { fields: Field[], gridViews: GridView[] } (or nested under table key)
```

#### 2. Create Any Column Type

```
POST /v3/tables/{tableId}/fields
```

**What you can create**:

| Column Type | Payload Key Fields | Confirmed |
|---|---|---|
| **Text** (plain, URL, email, number, boolean) | `type: "text"`, `typeSettings.dataTypeSettings.type` | Yes |
| **Formula** (JavaScript expressions, DOMAIN(), IF(), COALESCE(), etc.) | `type: "formula"`, `typeSettings.formulaText`, `typeSettings.formulaType` | Yes |
| **Action** (enrichment -- Apollo, ZoomInfo, Hunter, OpenAI, HTTP API, etc.) | `type: "action"`, `typeSettings.actionKey`, `actionPackageId`, `authAccountId`, `inputsBinding` | Yes |
| **Source** (webhook, find-companies, find-people) | `type: "source"`, `typeSettings.sourceIds` (requires source creation first) | Yes |

**What you can configure per column**:
- Display data type (text, url, email, number, boolean, json, select)
- Formula text with field references (`{{f_xxx}}`)
- Enrichment provider, version, package, connected account
- Input bindings (which columns feed into the enrichment)
- Conditional run formulas (only enrich when condition is true)
- Static IP flag for enrichment calls

**Required context for each call**:
- `tableId` (from URL: `t_xxx`)
- `activeViewId` (from table schema: `gv_xxx`) -- REQUIRED
- Field references use internal IDs (`{{f_xxx}}`), not column names
- Must track created field IDs to reference them in subsequent columns

**Rate**: 150ms minimum between calls (Claymate's empirical baseline).

#### 3. Read Source Details

```
GET /v3/sources/{sourceId}
```

**What it gives you**:
- Source name, type, typeSettings
- `dataFieldId` -- the field ID that receives data from this source
- Configuration details (hasAuth, iconType, etc.)

**Use case**: After creating a source, fetch its `dataFieldId` so you can reference source data in formulas.

#### 4. Create Data Sources

```
POST /v3/sources
```

**What you can create**:
- Webhook sources (for inbound data)
- Likely: find-companies, find-people, and other Clay source types

**Required fields**:
- `workspaceId` (numeric, from URL)
- `tableId` (string, `t_xxx`)
- `name`, `type`, `typeSettings`

**Two-step pattern for source columns**:
1. `POST /v3/sources` to create the source -> get `sourceId`
2. `POST /v3/tables/{tableId}/fields` to create the source column referencing the `sourceId`
3. May need `GET /v3/sources/{sourceId}` to retrieve `dataFieldId` if not in creation response

#### 5. Full Schema Export (Composite Operation)

Not a single endpoint, but a proven pipeline combining the above:

1. `GET /v3/tables/{tableId}` -- get all fields and views
2. For each source column: `GET /v3/sources/{sourceId}` -- get source details
3. Transform internal `{{f_xxx}}` references to portable `{{@Column Name}}` format
4. Output ClayMate-compatible JSON

**Confirmed working** end-to-end by Claymate Lite.

#### 6. Full Schema Import (Composite Operation)

Also a proven pipeline:

1. Parse ClayMate JSON schema
2. Topologically sort columns by dependency (source columns first, then by reference order)
3. For source columns: `POST /v3/sources`, then `POST /v3/tables/{tableId}/fields`
4. For each other column: transform `{{@Column Name}}` back to `{{f_xxx}}` using a growing name-to-ID map, then `POST /v3/tables/{tableId}/fields`
5. Track every new field ID for subsequent references

**Confirmed working** end-to-end by Claymate Lite, with one caveat: `authAccountId` in action columns must be replaced with the target account's values.

### Confirmed v1 API Actions (API Key Auth)

#### 7. Read Table Rows

```
GET /api/v1/tables/{tableId}/rows
```

Read row data from a table. Pagination mechanics undocumented.

#### 8. Write Table Rows

```
POST /api/v1/tables/{tableId}/rows
Body: { "rows": [{"Column Name": "value"}] }
```

Add rows to a table. Column references by name.

#### 9. Trigger Enrichment

```
POST /api/v1/tables/{tableId}/trigger
```

Kick off enrichment runs. Exact parameters (which columns, which rows) undocumented.

#### 10. Read Table Metadata

```
GET /api/v1/tables/{tableId}
```

Basic table metadata. Less detailed than v3's full schema.

#### 11. Validate API Key / List Sources

```
GET /api/v1/sources
```

Returns sources list. Used for key validation.

### Webhook Operations (No Auth Required Beyond Webhook URL)

#### 12. Push Data Into Clay

```
POST {webhook_url}
Body: {"field": "value"}
```

Send JSON to a table's webhook. Limit: 50k submissions per webhook endpoint.

### What's Immediately Buildable (No More Research Needed)

These can be implemented today using confirmed endpoints:

| Tool | What It Does | Endpoints Used |
|---|---|---|
| `clay_get_table` | Read complete table schema | `GET /v3/tables/{tableId}` |
| `clay_create_field` | Create any column type | `POST /v3/tables/{tableId}/fields` |
| `clay_create_source` | Create webhook/data source | `POST /v3/sources` |
| `clay_export_schema` | Export table as ClayMate JSON | `GET /v3/tables` + source reads + transform |
| `clay_import_schema` | Import ClayMate JSON to create columns | Sort + source create + field create pipeline |
| `clay_read_rows` | Read table rows | `GET /api/v1/tables/{tableId}/rows` |
| `clay_write_rows` | Add rows to table | `POST /api/v1/tables/{tableId}/rows` |
| `clay_trigger_enrichment` | Trigger enrichment runs | `POST /api/v1/tables/{tableId}/trigger` |

---

## PART 2: What We CANNOT Do (Exhaustive)

Every single thing below is a gap. Organized from most critical to least.

### TIER 1: Total Blockers (Agent Cannot Proceed Without Human)

These operations have **zero programmatic path** today. The agent must call `request_user_action` and wait for a human.

| # | Operation | Why It's Blocked | Impact |
|---|-----------|------------------|--------|
| 1 | **Create a new table** | No known v3 endpoint. Must be done in Clay UI. | Every new project starts here. The agent's very first step is blocked. |
| 2 | **Delete a table** | No known endpoint. | Can't clean up scratch/test tables. |
| 3 | **Create a workbook** | No known endpoint. Workbooks are the organizational container for tables. | Every new project starts here too. |
| 4 | **Delete a workbook** | No known endpoint. | Can't clean up. |
| 5 | **List tables in a workspace** | No known endpoint. The agent doesn't even know what tables exist. | Agent is blind to current state. Must be told table IDs. |
| 6 | **List workbooks** | No known endpoint. | Agent can't navigate the workspace. |
| 7 | **Get webhook URL for a table** | Not returned by any known endpoint. Only visible in Clay UI. | Can't wire up n8n/external systems without manually copying the URL. |
| 8 | **Connect an enrichment provider account** | `authAccountId` is required for action columns but can only be obtained by exporting an existing table that uses that provider, or by inspecting the UI. | Schema import fails for action columns without manual ID replacement. |
| 9 | **Set up initial Clay login session** | Session cookies require browser login. No API-key-based v3 access. | Must have a human log in (or store credentials for Playwright login). |

### TIER 2: Structural Gaps (Can Read But Can't Modify)

We can read these via v3 schema, but have no confirmed way to change them.

| # | Operation | Current State | Impact |
|---|-----------|---------------|--------|
| 10 | **Update/edit an existing column** | No confirmed `PATCH` endpoint. Suspected: `PATCH /v3/tables/{tableId}/fields/{fieldId}` | Can't fix a broken formula or change enrichment config without recreating the column. |
| 11 | **Delete a column** | No confirmed `DELETE` endpoint. Suspected: `DELETE /v3/tables/{tableId}/fields/{fieldId}` | Can't clean up or restructure tables. |
| 12 | **Reorder columns** | Unknown mechanism. May be a view-level operation on `gridViews.fieldOrder`. | Minor UX issue but affects table readability. |
| 13 | **Rename a table** | No confirmed endpoint. | Minor but annoying. |
| 14 | **Rename a column** | May work via the suspected PATCH endpoint. Untested. | Agent can't fix naming mistakes. |
| 15 | **Delete a source/webhook** | No confirmed `DELETE /v3/sources/{sourceId}`. | Can't remove broken or unused sources. |
| 16 | **Configure webhook auth token** | Not exposed in source creation response or source details. | Can't secure webhook endpoints programmatically. |

### TIER 3: Data Gaps (Partial Coverage)

v1 API gives partial access but missing key capabilities.

| # | Operation | Current State | Impact |
|---|-----------|---------------|--------|
| 17 | **Delete rows** | Not in v1 API. No confirmed v3 endpoint. | Can't clean up test data or manage table size. |
| 18 | **Update/edit individual cells** | Not in v1 API. No confirmed v3 endpoint. | Can only add rows, not modify existing ones. |
| 19 | **Filter/query rows** | v1 pagination mechanics unknown. No filtering endpoint. | Must read all rows and filter client-side. Expensive for large tables. |
| 20 | **Bulk row operations** | v1 `POST rows` may accept arrays but limits unknown. | Can't efficiently load thousands of rows. |
| 21 | **Read enrichment status per row** | Not exposed via API. | Can't tell if enrichments completed, failed, or are pending. |
| 22 | **Read formula evaluation results** | Rows endpoint returns rendered values, but error states are not clearly exposed. | Can't detect broken formulas across a table without visual inspection. |

### TIER 4: Configuration & Monitoring Gaps

| # | Operation | Current State | Impact |
|---|-----------|---------------|--------|
| 23 | **List connected enrichment accounts** | Unknown endpoint. `authAccountId` values are opaque. | Must manually find these IDs per provider per account. |
| 24 | **List available enrichment providers** | Unknown endpoint. `actionKey` and `actionPackageId` must be known in advance. | Can't dynamically discover what enrichments are available. |
| 25 | **Read credit balance** | No known endpoint. | Can't warn before running expensive enrichments. |
| 26 | **Get workspace members/settings** | No known endpoint. | Can't manage workspace access. |
| 27 | **Read webhook submission count** | Not exposed. 50k limit can be hit silently. | Can't monitor webhook health. |
| 28 | **Subscribe to real-time updates** | Unknown if Clay uses WebSockets. | Can't know when enrichments complete without polling. |
| 29 | **Trigger selective enrichments** | v1 trigger endpoint parameters unknown. May trigger all columns, not specific ones. | Over-enrichment wastes credits. |
| 30 | **Waterfall enrichment configuration** | Unknown v3 structure. | Must manually configure provider fallback chains. |
| 31 | **Send-to-table column configuration** | Can create via v3 field creation, but exact `typeSettings` for send-to-table routing are undocumented. | May need reverse engineering of the specific typeSettings shape. |
| 32 | **Lookup column configuration** | Can create via v3 field creation, but exact `typeSettings` for cross-table lookups are undocumented. | Same -- need the typeSettings shape. |

### TIER 5: Auth & Session Unknowns

| # | Operation | Current State | Impact |
|---|-----------|---------------|--------|
| 33 | **Session cookie lifetime** | Unknown. Could be hours or weeks. | Can't build reliable session refresh. |
| 34 | **Session IP binding** | Unknown. Cookies may not work from server IP. | Could block server-side v3 usage entirely. |
| 35 | **Concurrent session support** | Unknown. Second login may kill first session. | Could break multi-agent scenarios. |
| 36 | **`X-Clay-Frontend-Version` requirement** | Unknown if required or just informational. | Sending wrong value might break requests. |
| 37 | **2FA/SSO automated login** | Not built. Complex auth flows need handling. | Users with 2FA can't automate session extraction. |
| 38 | **v3 rate limits** | Unknown. Using 150ms as guess. | Could be way too slow (wasting time) or too fast (risking blocks). |

---

## PART 3: The Frontier -- What We Explore Next

### Immediate Priority: CDP Discovery Sprint (Resolves Most of Tier 1)

The single highest-leverage action is running the CDP interception script (`harness/scripts/intercept-clay-api.ts`) while performing a full Clay workflow. This should reveal endpoints for:

- Table creation (`POST /v3/tables` or similar)
- Table deletion
- Table listing
- Workbook CRUD
- Column update and delete
- Webhook URL retrieval
- Connected account listing

**One CDP session could resolve gaps 1-8, 10-16, and 23-24** -- literally half the blockers.

### Parallel: Session Durability Testing (Resolves Tier 5)

Run `extract-session.ts`, then test cookies at intervals. Resolves gaps 33-36.

### Parallel: v1 API Probing (Resolves Tier 3 Partially)

Test `GET /api/v1/tables/{id}/rows` with query parameters like `?limit=10&offset=0`, `?filter=...`, etc. Resolves gap 19.

### After CDP Discovery: Endpoint Probing

For every new endpoint discovered via CDP, run `probe-endpoint.ts` to document:
- Minimum required payload
- Full accepted payload
- Error responses
- Rate limits

### Goal State

When we're done, the agent should be able to:

1. List all workbooks and tables in a workspace
2. Create a new workbook
3. Create a new table
4. Design and create all columns (text, formula, enrichment, webhook, lookup, send-to-table)
5. Import a full ClayMate schema
6. Read and write rows
7. Trigger enrichments (selectively if possible)
8. Read back enriched data
9. Detect and debug errors
10. Configure webhook endpoints and read their URLs
11. Push data to external systems via action columns
12. Monitor enrichment status
13. Clean up (delete columns, tables, workbooks)

Every single one of those via API. Playwright is for the "unknown unknowns" only -- things we haven't even thought of yet.
