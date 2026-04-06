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
**Layer**: v3 API (v1 is deprecated)
**Auth**: Session cookie

```
Input:
  table_id: string,
  view_id: string | null,  // null = auto-select "All rows" view
  limit: number | null      // default 100, max tested 10000

Output:
  rows: [object],           // array of {id, cells, recordMetadata, ...}
  count: number             // count of returned rows (no server-side total)
```

**Status**: **Confirmed** (`GET /v3/tables/{id}/views/{viewId}/records?limit=N`). View ID required — get from table schema. No pagination: use `limit=10000` for all rows.

### clay_write_rows

**Purpose**: Add rows to a table.
**Layer**: v3 API
**Auth**: Session cookie

```
Input:
  table_id: string,
  rows: [{cells: {field_id: value}}]

Output:
  records: [{id, cells, createdAt}]
```

**Status**: **Confirmed** (`POST /v3/tables/{id}/records`).

### clay_update_rows

**Purpose**: Update existing rows in a table.
**Layer**: v3 API
**Auth**: Session cookie

```
Input:
  table_id: string,
  records: [{id: "r_xxx", cells: {field_id: value}}]

Output:
  message: "Record updates enqueued"  // async
```

**Status**: **Confirmed** (`PATCH /v3/tables/{id}/records`). Updates are async/enqueued.

### clay_delete_rows

**Purpose**: Delete rows from a table.
**Layer**: v3 API
**Auth**: Session cookie

```
Input:
  table_id: string,
  record_ids: string[]

Output:
  {}  // empty on success
```

**Status**: **Confirmed** (`DELETE /v3/tables/{id}/records`).

### clay_trigger_enrichment

**Purpose**: Trigger enrichment runs on specific rows and fields.
**Layer**: v3 API
**Auth**: Session cookie

```
Input:
  table_id: string,
  field_ids: string[],
  record_ids: string[],
  force_run: boolean  // default true

Output:
  record_count: number,
  run_mode: "INDIVIDUAL"
```

**Status**: **Confirmed** (`PATCH /v3/tables/{id}/run`).

### clay_duplicate_table

**Purpose**: Duplicate a table with all its columns.
**Layer**: v3 API
**Auth**: Session cookie

```
Input:
  table_id: string,
  name: string | null  // default "Copy of {original}"

Output:
  table: {id, name, fields, views, workbookId}
```

**Status**: **Confirmed** (`POST /v3/tables/{id}/duplicate`).

### clay_create_view

**Purpose**: Create a custom view on a table.
**Layer**: v3 API
**Auth**: Session cookie

```
Input:
  table_id: string,
  name: string

Output:
  view: {id, name, fields, filter, sort}
```

**Status**: **Confirmed** (`POST /v3/tables/{id}/views`). Filter/sort update via PATCH needs payload refinement.

### clay_export_csv

**Purpose**: Export table data as CSV (async job).
**Layer**: v3 API
**Auth**: Session cookie

```
Input:
  table_id: string

Output:
  job: {id: "ej_xxx", status: "ACTIVE", uploadedFilePath: null}
```

**Status**: **Confirmed** (`POST /v3/tables/{id}/export`). Poll `GET /v3/exports/{jobId}` for `uploadedFilePath`.

### clay_check_enrichment_status

**Purpose**: Check completion status of enrichment runs by polling row metadata.
**Layer**: v3 API
**Auth**: Session cookie

```
Input:
  table_id: string,
  view_id: string,
  field_ids: string[]  // enrichment fields to check

Output:
  rows: [{
    id: string,
    status: "SUCCESS" | "ERROR_OUT_OF_CREDITS" | "ERROR_BAD_REQUEST" | "STALE" | "PENDING",
    has_value: boolean
  }]
```

**Status**: **Implementable** — poll `GET /v3/tables/{id}/views/{viewId}/records` and inspect `cell.metadata.status`.

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
  "clay_update_rows",
  "clay_delete_rows",
  "clay_trigger_enrichment",
  "clay_check_enrichment_status",
  "clay_duplicate_table",
  "clay_create_view",
  "clay_export_csv"
]
```

## Error Handling

All tools should:
1. Return structured errors with error type and message
2. On auth failure (401), trigger session refresh and retry once
3. Rate limiting (429): Not observed in testing (50 req/s, 0 throttled). No backoff needed.
4. On v3 failure, suggest Playwright fallback or `request_user_action`
5. Never expose raw session cookies in error messages or logs

## Notes (updated Session 4)

- **v1 API is dead.** All tools must use v3 with session cookie auth.
- **No rate limiting.** Safe to call endpoints sequentially without delays.
- **Formulas auto-evaluate.** No need to trigger formula recalculation after row writes.
- **No pagination.** Use `limit=10000` to get all rows. No cursor/offset mechanism.
- **Enrichment completion = polling.** After triggering, poll rows every 2-5s and check `cell.metadata.status`.
