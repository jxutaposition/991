# Clay Platform Knowledge

## How Clay Works

Clay is a data enrichment and prospecting platform. You build tables where each row represents a person, company, or entity. Columns can be:

- **Manual/imported** — data you paste or import
- **Enrichment** — data pulled from external providers (LinkedIn, Apollo, Clearbit, etc.)
- **Formula** — computed values using Clay's formula language (JavaScript syntax, field refs via `{{f_xxx}}`)
- **Lookup** — cross-table joins matching on a key column
- **Action** — outbound webhooks or API calls triggered per row
- **Route-row** — route rows to other Clay tables based on conditions (auto-creates source on target)
- **Source** — inbound data fields populated by webhooks or route-row actions

## Full API Access (v3)

Clay's v3 API provides **complete CRUD** for all objects. The v1 API is deprecated and non-functional.

### What the API can do (all via dedicated tools):

- **Tables**: Create, read schema, update, delete, list all in workspace
- **Rows**: Read (via view), create, update (async), delete
- **Columns**: Create (text, formula, enrichment, action, route-row, source), update, delete
- **Sources**: Create webhooks, read (get webhook URL from `state.url`), list all, update, delete
- **Enrichments**: Trigger runs on specific rows/fields, list all 1,191 available actions, list connected auth accounts
- **Workspace**: Check credit balance, billing, features
- **Workbooks**: Create, list all in workspace

### Key patterns:
- **Row reading requires a view ID**: `clay_read_rows` needs `view_id` from `clay_get_table_schema` → `views[]`
- **Enrichment auto-wiring**: `clay_list_actions` + `clay_list_app_accounts` gives you everything needed to create enrichment columns without user input
- **Webhook URLs**: Create source → read source → URL is in `state.url`
- **No rate limiting**: No inter-call delays needed
- **Session cookie**: 7-day rolling lifetime, refreshes on every API call

### Only requires manual UI action:
- Connecting new enrichment provider accounts (OAuth handshake)
