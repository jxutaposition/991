# Clay Agent Tool Specifications

Last updated: 2026-04-05

## Overview

New tools for the `clay_operator` agent that leverage the proprietary API layer. These replace many current `request_user_action` calls with direct programmatic operations.

## Tool Definitions

### clay_list_tables

**Purpose**: List all tables in a Clay workspace.
**Layer**: v3 API (preferred) or Playwright (fallback)
**Auth**: Session cookie

```
Input:
  workspace_id: string (numeric)

Output:
  tables: [
    {
      id: string,        // "t_abc123"
      name: string,
      row_count: number,
      created_at: string
    }
  ]
```

**Status**: **Confirmed** (INV-007). Endpoint: `GET /v3/workspaces/{id}/tables`. Returns full table list with IDs, names, row counts, and timestamps.

### clay_get_table

**Purpose**: Get full table schema including all columns, views, sources.
**Layer**: v3 API
**Auth**: Session cookie

```
Input:
  table_id: string  // "t_abc123"

Output:
  table: {
    id: string,
    fields: [
      {
        id: string,           // "f_abc123"
        name: string,
        type: string,         // "text" | "formula" | "action" | "source"
        typeSettings: object  // full config per type
      }
    ],
    gridViews: [
      {
        id: string,           // "gv_abc123"
        fieldOrder: string[]  // ordered field IDs
      }
    ]
  }
```

**Status**: Confirmed (`GET /v3/tables/{tableId}`).

### clay_create_field

**Purpose**: Create a new column on a table.
**Layer**: v3 API
**Auth**: Session cookie

```
Input:
  table_id: string,
  view_id: string,
  name: string,
  type: "text" | "formula" | "action" | "source",
  type_settings: object  // type-specific config

Output:
  field: {
    id: string,     // the new field's internal ID
    name: string,
    type: string
  }
```

**Type-specific input examples**:

Text:
```json
{"type": "text", "type_settings": {"dataTypeSettings": {"type": "url"}}}
```

Formula:
```json
{
  "type": "formula",
  "type_settings": {
    "formulaText": "DOMAIN({{f_website}})",
    "formulaType": "text",
    "dataTypeSettings": {"type": "text"}
  }
}
```

Action (enrichment):
```json
{
  "type": "action",
  "type_settings": {
    "actionKey": "provider-action",
    "actionPackageId": "uuid",
    "authAccountId": "aa_xxx",
    "inputsBinding": [{"name": "domain", "formulaText": "{{f_domain}}"}],
    "dataTypeSettings": {"type": "json"}
  }
}
```

**Status**: Confirmed (`POST /v3/tables/{tableId}/fields`).

### clay_create_source

**Purpose**: Create a data source (webhook, find-people, etc.) on a table.
**Layer**: v3 API
**Auth**: Session cookie

```
Input:
  workspace_id: string,
  table_id: string,
  name: string,
  type: string,           // "v3-action", "webhook", etc.
  type_settings: object

Output:
  source: {
    id: string,           // "s_abc123"
    dataFieldId: string   // "f_source_data"
  }
```

**Status**: Confirmed (`POST /v3/sources`).

### clay_export_schema

**Purpose**: Export a table's full schema as a portable JSON (ClayMate format).
**Layer**: v3 API
**Auth**: Session cookie

```
Input:
  table_id: string,
  view_id: string | null  // null = use default view

Output:
  schema: {
    version: "1.0",
    exportedAt: string,
    columnCount: number,
    columns: [
      {
        index: number,
        name: string,
        type: string,
        typeSettings: object  // portable refs: {{@Column Name}}
      }
    ]
  }
```

This replicates Claymate Lite's export functionality server-side: fetches the table via v3, transforms field ID references to column name references, and returns a portable schema.

**Status**: Can be implemented using confirmed `GET /v3/tables/{tableId}` + Claymate's transformation logic.

### clay_import_schema

**Purpose**: Import a ClayMate-format schema to create columns on a table.
**Layer**: v3 API
**Auth**: Session cookie

```
Input:
  table_id: string,
  view_id: string,
  schema: object  // ClayMate format JSON

Output:
  results: [
    {
      name: string,
      success: boolean,
      field_id: string | null,
      error: string | null
    }
  ]
```

This replicates Claymate Lite's import functionality server-side: resolves dependencies, sorts columns topologically, creates sources first, then creates fields in order with reference resolution.

**Status**: Can be implemented using confirmed `POST /v3/tables/{tableId}/fields` + `POST /v3/sources` + Claymate's dependency resolution logic.

### clay_read_rows

**Purpose**: Read rows from a table.
**Layer**: v1 API
**Auth**: API key

```
Input:
  table_id: string,
  limit: number | null,
  offset: number | null

Output:
  rows: [object],
  total: number
```

**Status**: Available (`GET /api/v1/tables/{id}/rows`). Exact pagination mechanics need verification.

### clay_write_rows

**Purpose**: Add rows to a table.
**Layer**: v1 API
**Auth**: API key

```
Input:
  table_id: string,
  rows: [object]  // key-value pairs matching column names

Output:
  created: number
```

**Status**: Available (`POST /api/v1/tables/{id}/rows`).

### clay_trigger_enrichment

**Purpose**: Trigger enrichment runs on a table.
**Layer**: v1 API
**Auth**: API key

```
Input:
  table_id: string

Output:
  triggered: boolean
```

**Status**: Available (`POST /api/v1/tables/{id}/trigger`). Exact parameters (which columns, which rows) need verification.

### clay_read_formula (Future)

**Purpose**: Read the formula text behind a specific cell.
**Layer**: Playwright DOM
**Auth**: Session cookie (browser)

```
Input:
  table_id: string,
  column_name: string,
  row_index: number | null  // null = just read column formula

Output:
  formula_text: string
```

**Status**: Needs DOM selector verification.

### clay_scan_errors (Future)

**Purpose**: Scan a table for cells with error states.
**Layer**: Playwright DOM
**Auth**: Session cookie (browser)

```
Input:
  table_id: string

Output:
  errors: [
    {
      column_name: string,
      row_index: number,
      error_type: string,
      error_message: string | null
    }
  ]
```

**Status**: Needs DOM selector verification.

## Integration with actions.toml

Current `backend/tools/clay/actions.toml`:
```toml
actions = ["http_request", "request_user_action"]
```

Target:
```toml
actions = [
  "http_request",
  "request_user_action",
  "clay_list_tables",
  "clay_get_table",
  "clay_create_field",
  "clay_create_source",
  "clay_export_schema",
  "clay_import_schema",
  "clay_read_rows",
  "clay_write_rows",
  "clay_trigger_enrichment"
]
```

## Error Handling

All tools should:
1. Return structured errors with error type and message
2. On auth failure (401), trigger session refresh and retry once
3. On rate limit (429), wait and retry with exponential backoff
4. On v3 failure, suggest Playwright fallback or `request_user_action`
5. Never expose raw session cookies in error messages or logs
