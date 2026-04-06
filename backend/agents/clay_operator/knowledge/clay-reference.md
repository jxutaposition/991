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

**Waterfall enrichment**: Chain multiple providers — if Provider A returns no result, try Provider B. Saves credits on high-hit-rate providers.

**Credit awareness**: Each enrichment run costs credits. Always recommend testing on 1 row before bulk. "Force run all rows" re-runs even previously found results; "Run empty or out-of-date" skips rows with existing data but does NOT re-run "No Record Found" results.

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

### Action Columns (Webhook/HTTP API)
Send data to external systems when triggered.
- **Method**: POST (most common), GET
- **URL**: The webhook endpoint (e.g., n8n webhook URL, Supabase API)
- **Headers**: `Content-Type: application/json`, auth headers as needed
- **Body**: JSON template using `{{column_name}}` for column references
- **Run condition**: On row match, manual trigger, or schedule

### Lookup Columns
Cross-table joins.
- **Source table**: Which other Clay table to look up from
- **Match key**: Which column in this table matches which column in source table
- **Pull columns**: Which columns to copy from the matched source row
- URL normalization is critical — trailing slashes cause match failures

### Send-to-Table Columns
Route rows to other Clay tables based on conditions. Configure: destination table, condition (formula-based), which columns to copy. Used for splitting enriched data into specialized tables.

## API Access

Clay has two API layers. Use the dedicated Clay tools whenever possible — they handle auth and rate limiting automatically.

### v1 API (API key — auto-injected)
- `GET /api/v1/tables/{id}/rows` — read rows
- `POST /api/v1/tables/{id}/rows` — add rows
- `POST /api/v1/tables/{id}/trigger` — trigger enrichment runs
- `GET /api/v1/tables/{id}` — read table metadata

### v3 API (session cookie — auto-injected)

**Table lifecycle:**
- `POST /v3/tables` — create table (`{workspaceId, type, name}`)
- `DELETE /v3/tables/{id}` — delete table
- `GET /v3/workspaces/{id}/tables` — list tables in workspace
- `PATCH /v3/tables/{id}` — update table (rename, etc.)

**Schema management:**
- `GET /v3/tables/{tableId}` — full schema with fields, formulas, enrichment configs, gridViews
- `POST /v3/tables/{tableId}/fields` — create column
- `PATCH /v3/tables/{tableId}/fields/{fieldId}` — update column
- `DELETE /v3/tables/{tableId}/fields/{fieldId}` — delete column

**Sources:**
- `POST /v3/sources` — create webhook source
- `GET /v3/sources/{sourceId}` — read source details
- `PATCH /v3/sources/{sourceId}` — update source
- `DELETE /v3/sources/{sourceId}` — delete source

**Other:**
- `PATCH /v3/tables/{id}/run` — trigger enrichment/action runs (v3 variant)
- `GET /v3/me` — current user info (used for session validation)

### Still requires `request_user_action`
- Connecting enrichment provider accounts (authAccountId values)
- Getting webhook URLs after source creation (not yet programmatic)
