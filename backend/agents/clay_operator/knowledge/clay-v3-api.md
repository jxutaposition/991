# Clay v3 Internal API

Clay's frontend uses an internal API at `https://api.clay.com/v3` for structural operations. This API is not publicly documented but is stable and usable. The v1 API (`/api/v1/`) uses your Clay API key. The v3 API requires a `claysession` browser cookie (7-day lifetime).

## Authentication

**v1 API** (row operations, enrichment triggers): `Authorization: Bearer {CLAY_API_KEY}` — auto-injected for `api.clay.com` URLs.

**v3 API** (table lifecycle, schema, column CRUD): Uses the `claysession` cookie stored in the Clay credential. All dedicated Clay tools handle this automatically. If the session cookie isn't configured, tools return a clear `no_session` error — switch to `request_user_action` for those operations.

## v1 Endpoints (API Key Auth)

### Read Rows
```
GET https://api.clay.com/api/v1/tables/{table_id}/rows
```
Returns row data from a table.

### Write Rows
```
POST https://api.clay.com/api/v1/tables/{table_id}/rows
Body: {"rows": [{"Column Name": "value"}]}
```

### Trigger Enrichment
```
POST https://api.clay.com/api/v1/tables/{table_id}/trigger
```

### Read Table Metadata
```
GET https://api.clay.com/api/v1/tables/{table_id}
```

## v3 Endpoints (Session Cookie Auth)

### Table Lifecycle

#### Create Table
```
POST https://api.clay.com/v3/tables
Body: {
  "workspaceId": <number>,
  "type": "spreadsheet" | "company" | "people" | "jobs",
  "name": "<string>"
}
```
Returns the new table object with its ID.

#### Delete Table
```
DELETE https://api.clay.com/v3/tables/{tableId}
```

#### List Tables in Workspace
```
GET https://api.clay.com/v3/workspaces/{workspaceId}/tables
```
Returns all tables in the workspace.

#### Update Table
```
PATCH https://api.clay.com/v3/tables/{tableId}
Body: {"name": "New Name"}
```

### Schema Management

#### Read Full Table Schema
```
GET https://api.clay.com/v3/tables/{tableId}
```
Returns complete schema: every field with its ID, name, type, and full `typeSettings` (formulas, enrichment configs, data types). Also returns `gridViews` with field ordering.

Response shape:
```json
{
  "fields": [
    {"id": "f_abc", "name": "Website", "type": "text", "typeSettings": {"dataTypeSettings": {"type": "url"}}},
    {"id": "f_def", "name": "Domain", "type": "formula", "typeSettings": {"formulaText": "DOMAIN({{f_abc}})", "formulaType": "text"}}
  ],
  "gridViews": [{"id": "gv_xyz", "fieldOrder": ["f_abc", "f_def"]}]
}
```

Field references in formulas use internal IDs: `{{f_abc123}}`.

#### Create Column
```
POST https://api.clay.com/v3/tables/{tableId}/fields
Body: {
  "name": "Column Name",
  "type": "text|formula|action|source",
  "activeViewId": "gv_xxx",
  "typeSettings": { ... }
}
```

**Text column**: `{"type": "text", "typeSettings": {"dataTypeSettings": {"type": "text"}}}`
**Formula column**: `{"type": "formula", "typeSettings": {"formulaText": "DOMAIN({{f_xxx}})", "formulaType": "text", "dataTypeSettings": {"type": "text"}}}`
**Action column**: `{"type": "action", "typeSettings": {"actionKey": "provider-name", "actionPackageId": "uuid", "authAccountId": "aa_xxx", "inputsBinding": [{"name": "domain", "formulaText": "{{f_xxx}}"}], "dataTypeSettings": {"type": "json"}}}`

Returns: `{"field": {"id": "f_new123", "name": "...", "type": "..."}}`

Wait 150ms between calls. Track returned field IDs for subsequent references.

#### Update Column
```
PATCH https://api.clay.com/v3/tables/{tableId}/fields/{fieldId}
Body: {"name": "New Name", "typeSettings": { ... }}
```
Use PATCH only — PUT returns 404.

#### Delete Column
```
DELETE https://api.clay.com/v3/tables/{tableId}/fields/{fieldId}
```

### Source Management

#### Create Source
```
POST https://api.clay.com/v3/sources
Body: {"workspaceId": 12345, "tableId": "t_xxx", "name": "Webhook", "type": "v3-action", "typeSettings": {"hasAuth": false, "iconType": "Webhook"}}
```

#### Read Source Details
```
GET https://api.clay.com/v3/sources/{sourceId}
```
Returns source name, type, `dataFieldId`, and `typeSettings`.

#### Update Source
```
PATCH https://api.clay.com/v3/sources/{sourceId}
```

#### Delete Source
```
DELETE https://api.clay.com/v3/sources/{sourceId}
```

### Enrichment Trigger (v3)
```
PATCH https://api.clay.com/v3/tables/{tableId}/run
Body: {
  "runRecords": {"recordIds": ["row_id_1", "row_id_2"]},
  "fieldIds": ["f_enrichment_col"],
  "forceRun": true
}
```
More granular than v1 trigger — can target specific rows and columns.

## URL/ID Patterns

- Table IDs: `t_` + alphanumeric (from URL: `/tables/t_abc123`)
- View IDs: `gv_` + alphanumeric (from URL: `/views/gv_abc123`)
- Workspace IDs: numeric (from URL: `/workspaces/12345`)
- Field IDs: `f_` + alphanumeric (from API responses, not URLs)
- Source IDs: `s_` + alphanumeric (from API responses)

## Session Cookie

The `claysession` cookie is required for all v3 API calls.
- **Domain**: `.api.clay.com`
- **Lifetime**: 7 days from issuance
- **Format**: `claysession=s%3A...` (URL-encoded Express session ID)
- **How to get it**: DevTools → Application → Cookies → `api.clay.com` → copy `claysession` value

## What Requires request_user_action

These have no known API endpoint — instruct the user manually:
- Connecting enrichment provider accounts (authAccountId values)
- Getting webhook URLs after source creation
