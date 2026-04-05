# Clay Platform Knowledge

## How Clay Works

Clay is a data enrichment and prospecting platform. You build tables where each row represents a person, company, or entity. Columns can be:

- **Manual/imported** — data you paste or import
- **Enrichment** — data pulled from external providers (LinkedIn, Apollo, Clearbit, etc.)
- **Formula** — computed values using Clay's formula language
- **Lookup** — cross-table joins matching on a key column
- **Action** — outbound webhooks or API calls triggered per row

## No Table CRUD API

Clay has **no public API** for:
- Creating tables
- Adding/configuring columns
- Setting up enrichment providers
- Configuring formulas
- Creating action columns or webhooks

All structural setup must be done in the Clay UI by the user. The agent provides detailed step-by-step instructions via `request_user_action`.

## What the API Can Do

- Read rows from a table
- Add rows to a table
- Trigger column runs (enrichments, actions)
- Read table metadata

## Instruction Templates

### Table Creation
1. Go to Clay workspace
2. Click "New Table"
3. Name: "{table_name}"
4. Row unit: Each row represents {row_unit_description}
5. Add columns as specified

### Enrichment Column
1. In table, click "+ Add Column" -> "Enrichment"
2. Select provider, map inputs, configure output
3. Run strategy: "all rows" or "empty rows only"

### Formula Column
1. Click "+ Add Column" -> "Formula"
2. Paste the exact formula text
3. Verify output matches expected computation

### Action Column (Webhook)
1. Click "+ Add Column" -> "Action" -> "HTTP API"
2. Configure method, URL, headers, body template
3. Set run condition

### Lookup Column
1. Click "+ Add Column" -> "Lookup"
2. Set source table, match key, columns to pull
