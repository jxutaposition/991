# Clay Platform Knowledge

Clay is a data enrichment and prospecting platform. You build tables where each row represents a person, company, or entity. Columns can be manual, formula, enrichment, lookup, action (webhook/API), route-row, or source. The agent has full v3 API access via dedicated `clay_*` tools — only enrichment provider OAuth handshakes still need a UI step.

## Capability map (tools by category)

| Category | Dedicated tools | Reference doc (call `read_tool_doc`) |
|---|---|---|
| **Tables / Workbooks** | `clay_create_table`, `clay_delete_table`, `clay_list_tables`, `clay_get_table_schema`, `clay_duplicate_table`, `clay_create_workbook`, `clay_list_workbooks` | `read_tool_doc(clay, endpoint-reference)` |
| **Rows** | `clay_read_rows`, `clay_write_rows`, `clay_update_rows`, `clay_delete_rows` | (covered below) |
| **Columns / fields** | `clay_create_field`, `clay_update_field`, `clay_delete_field` | (covered below) |
| **Views** | `clay_create_view`, `clay_update_view`, `clay_delete_view` | `read_tool_doc(clay, views)` |
| **Sources / webhooks** | `clay_create_source`, `clay_list_sources`, `clay_get_source`, `clay_update_source`, `clay_delete_source` | (covered below) |
| **Enrichment** | `clay_trigger_enrichment`, `clay_list_actions`, `clay_list_app_accounts` | (covered below) |
| **CSV export** | `clay_export_table`, `clay_get_export` | `read_tool_doc(clay, csv-export)` |
| **Workflows (tc-workflows)** — Claygent agentic graphs | `clay_list_workflows`, `clay_get_workflow`, `clay_run_workflow`, `clay_get_workflow_run`, `clay_list_workflow_runs`, `clay_pause_workflow_run`, `clay_unpause_workflow_run`, `clay_continue_workflow_step`, `clay_list_waiting_steps`, `clay_create_workflow`, `clay_create_workflow_node`, `clay_create_workflow_edge`, `clay_get_workflow_snapshot` | **`read_tool_doc(clay, workflows)` — read this BEFORE triggering any workflow run** |
| **Documents (RAG)** | `clay_upload_document`, `clay_delete_document` | `read_tool_doc(clay, documents)` |
| **Workspace / admin** | `clay_get_workspace`, `clay_list_users`, `clay_list_tags` | `read_tool_doc(clay, admin)` |
| **Anything else** | (use `http_request` with the path) | `read_tool_doc(clay, endpoint-reference)` — full path index |

## Key always-relevant patterns

- **Row reading requires a view ID**: `clay_read_rows` needs `view_id` from `clay_get_table_schema` → `views[]`. There is no view-less row read.
- **Enrichment auto-wiring**: `clay_list_actions` + `clay_list_app_accounts` gives you everything needed to create enrichment columns programmatically without user input.
- **Webhook URLs**: Create source → `clay_get_source` → URL is in `state.url`.
- **No rate limiting** detected. No inter-call delays needed.
- **Session cookie**: 7-day rolling lifetime, refreshes automatically on every API call.
- **`_workspace_id` is injected** into every successful Clay tool response. Always use that value when building artifact URLs — never hardcode.
- **Workflows are NOT enrichments**: an enrichment trigger runs a column on rows. A workflow run executes a multi-step agentic graph (Claygent). They are separate products with separate APIs. Don't conflate them.

## Only requires manual UI action
- Connecting new enrichment provider accounts (OAuth handshake)

## Gotchas

### Tables, rows, columns
- **v1 API is dead.** All `api.clay.com/api/v1/*` endpoints return "deprecated API endpoint". Use v3 exclusively.
- **Row reading requires a view ID.** There is no `GET /v3/tables/{id}/records` — you must use `GET /v3/tables/{id}/views/{viewId}/records`.
- **No pagination.** `offset` parameter is accepted but silently ignored. `limit` works (use `limit=10000` for full reads). No hasMore/nextCursor in responses.
- **Row updates are async.** `PATCH /v3/tables/{id}/records` enqueues updates — they may not be immediately visible.
- **Field references** in formulas and API calls use internal IDs (`{{f_abc123}}`), not column names. Always read the schema first to get correct field IDs.
- **Trailing slashes in URLs** cause lookup mismatches. LinkedIn URLs must NOT end with `/`.
- **"Force run all rows" vs "Run empty or out-of-date rows"**: the latter does NOT re-run rows with "No Record Found" results. Use "Force run all" after adding new reference data.
- **URL normalization** between Clay and other systems (Supabase, n8n) is a common source of mismatches.
- **Route-row ordering**: the destination table must exist before creating a route-row column pointing to it. Route-row auto-creates source fields on target tables.

### Credits and design
- **Enrichment credits are finite.** Always test on a single row before bulk runs. Check balance with `clay_get_workspace`.
- **Row unit matters.** Define it before building any table. Wrong row unit compounds into broken outputs.

### Workflows (always-relevant — full detail in `read_tool_doc(clay, workflows)`)
- **Two run-status enums.** `runStatus` (top-level) is the one to read; the inner `runState.status` is a discriminator, not an independent status.
- **Direct runs are append-only — there is NO cancel or delete.** PATCH and DELETE on `.../runs/{runId}` both 404. Pause/unpause are the only control surface. To cancel, wrap in a 1-row csv_import batch and PATCH the batch.
- **"Inert" workflow nodes are NOT inert.** A `regular` node with no model/prompt silently injects Claude Haiku + a ~2 KB system prompt. Even a 2-node "inert" test burned ~12k tokens in INV-026. Do not assume runs against bare nodes are credit-free on a paid workspace — test small first.
