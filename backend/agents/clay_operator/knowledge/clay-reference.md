# Clay Platform Reference

## Column Types

| Type | Use Case | Notes |
|------|----------|-------|
| **Text** | Free-form strings, names, descriptions | Default type for most fields |
| **URL** | Website links, LinkedIn profiles | Renders as clickable link |
| **Email** | Email addresses | Used as enrichment input |
| **Number** | Scores, counts, amounts | Supports decimals |
| **Currency** | Revenue, MRR, deal values | Formats with $ prefix |
| **Date** | Timestamps, deadlines | ISO format preferred |
| **Checkbox** | Boolean flags, status toggles | True/false |
| **Select** | Single-choice dropdown | Define options in column config |
| **Multi-Select** | Tags, categories | Multiple values per row |
| **Image from URL** | Avatars, logos | Renders image inline |
| **Assigned To** | Team member ownership | Links to Clay workspace users |

## Special Column Types

### Enrichment Columns
Fetch data from external providers. Configure: provider, input mapping (which column feeds in), output fields.

**Common providers**: Apollo (people/company lookup), ZoomInfo (contact data), Hunter (email finding), LinkedIn (profile data), Clearbit (firmographics), OpenAI (AI classification/summarization).

**Auto-wiring enrichments** (fully automated):
1. `clay_list_actions` → find action by name/provider → get `actionKey`, `actionPackageId`, `auth.providerType`
2. `clay_list_app_accounts` → match `appAccountTypeId` to `providerType` → get `authAccountId` (the `id` field)
3. `clay_create_field` with `type: "action"`, full `typeSettings`

**Waterfall enrichment**: Chain multiple providers — if Provider A returns no result, try Provider B. Saves credits on high-hit-rate providers.

**Credit awareness**: Each enrichment run costs credits. Check balance with `clay_get_workspace`. Always test on 1 row before bulk. "Force run all rows" re-runs even previously found results; "Run empty or out-of-date" skips rows with existing data but does NOT re-run "No Record Found" results.

### Formula Columns
JavaScript syntax. Common patterns:

```javascript
// URL normalization (strip trailing slash)
return value.replace(/\/$/, '')

// Conditional tier assignment
if (score >= 80) return "Gold"
else if (score >= 50) return "Silver"
else return "Bronze"

// Null-safe field access
return (firstName || "") + " " + (lastName || "")

// Date formatting
return new Date(dateField).toISOString().split('T')[0]
```

Field references in formulas use internal IDs: `{{f_abc123}}`.

### Action Columns (Webhook/HTTP API)
Send data to external systems when triggered.
- **Method**: POST (most common), GET
- **URL**: The webhook endpoint (e.g., n8n webhook URL, Supabase API)
- **Headers**: `Content-Type: application/json`, auth headers as needed
- **Body**: JSON template using `{{f_xxx}}` for field references
- **Run condition**: On row match, manual trigger, or schedule

### Route-Row Columns
Route rows to other Clay tables based on conditions.
- **Destination table**: Must exist before creating the route-row column
- **Row data**: Map of column names to field references (`{{f_xxx}}`)
- **List mode**: `type: "list"` + `listData` creates one row per list item
- **Auto-creates source**: Target table automatically gets source fields for each `rowData` key
- **Parent access**: `{{source}}?.parent?.["Key Name"]` in target table formulas

### Lookup Columns
Cross-table joins.
- **Source table**: Which other Clay table to look up from
- **Match key**: Which column in this table matches which column in source table
- **Pull columns**: Which columns to copy from the matched source row
- URL normalization is critical — trailing slashes cause match failures

## API Access — v3 Only

The v1 API is **deprecated and non-functional**. All operations use v3 with session cookie auth.

### Full v3 capabilities:

**Table & workbook lifecycle:**
- `POST /v3/workbooks` — create workbook (`{workspaceId, name}` → returns `id` as `wb_xxx`)
- `POST /v3/tables` — create table (`{workspaceId, type, name, workbookId?}` — pass `workbookId` to place table in an existing workbook)
- `GET /v3/tables/{id}` — full schema (fields, views, sources, abilities)
- `PATCH /v3/tables/{id}` — update table
- `DELETE /v3/tables/{id}` — delete table
- `GET /v3/workspaces/{id}/tables` — list tables
- `GET /v3/workspaces/{id}/workbooks` — list workbooks

**Row CRUD:**
- `GET /v3/tables/{id}/views/{viewId}/records?limit=N` — read rows (view ID required)
- `GET /v3/tables/{id}/records/{recordId}` — read single row
- `POST /v3/tables/{id}/records` — create rows
- `PATCH /v3/tables/{id}/records` — update rows (async)
- `DELETE /v3/tables/{id}/records` — delete rows

**Column CRUD:**
- `POST /v3/tables/{id}/fields` — create column
- `PATCH /v3/tables/{id}/fields/{fieldId}` — update column
- `DELETE /v3/tables/{id}/fields/{fieldId}` — delete column

**Sources:**
- `POST /v3/sources` — create source
- `GET /v3/sources/{id}` — read source (webhook URL in `state.url`)
- `GET /v3/sources?workspaceId=N` — list all sources
- `PATCH /v3/sources/{id}` — update source
- `DELETE /v3/sources/{id}` — delete source

**Enrichment & discovery:**
- `PATCH /v3/tables/{id}/run` — trigger enrichment/action runs
- `GET /v3/actions?workspaceId=N` — list all 1,191 enrichment actions
- `GET /v3/app-accounts` — list all auth accounts (authAccountId values)

**Workspace:**
- `GET /v3/workspaces/{id}` — workspace details, credit balance, features
- `GET /v3/me` — current user info, session validation

### Only requires `request_user_action`:
- Connecting enrichment provider accounts (OAuth handshake inside Clay UI)
