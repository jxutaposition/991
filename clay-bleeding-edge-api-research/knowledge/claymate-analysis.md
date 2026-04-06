# Claymate Lite Source Code Analysis

Last updated: 2026-04-05
Source: [github.com/GTM-Base/claymate-lite](https://github.com/GTM-Base/claymate-lite) `content.js` (984 lines)

## Overview

Claymate Lite is a Chrome extension (Manifest V3) that runs on `app.clay.com` pages. It provides copy/paste functionality for Clay table schemas -- export a table's column structure as JSON, import it into another table.

The extension is the single most valuable source of reverse-engineering data for Clay's internal v3 API. It demonstrates that the v3 API is stable enough for production use.

## Architecture

- **Entry point**: `content.js` injected as a content script on `app.clay.com/*`
- **Manifest**: V3, permissions: `activeTab`, `clipboardWrite`, `clipboardRead`
- **Host permissions**: `https://*.clay.com/*`
- **No background script**: Everything runs in the content script context
- **API base**: `https://api.clay.com/v3` (hardcoded constant)

## Core API Wrapper

```javascript
const API_BASE = 'https://api.clay.com/v3';

async function clayApi(endpoint, options = {}) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Clay-Frontend-Version': window.clay_version || 'unknown',
      ...options.headers
    }
  });
  // Error handling: logs endpoint, status, error body
  return response.json();
}
```

Key implementation detail: `window.clay_version` is a global variable set by Clay's frontend. When the extension runs, it piggybacks on whatever version string Clay has set.

## Schema Export Pipeline

### 1. Get Table Context from URL

```javascript
function getTableContext() {
  const url = window.location.href;
  const tableMatch = url.match(/tables\/(t_[a-zA-Z0-9]+)/);
  const viewMatch = url.match(/views\/(gv_[a-zA-Z0-9]+)/);
  const workspaceMatch = url.match(/workspaces\/(\d+)/);
  return { tableId, viewId, workspaceId, isTablePage };
}
```

### 2. Fetch Full Field Configurations

```javascript
async function fetchFullFieldConfigs(tableId, viewId) {
  const tableData = await fetchFullTableData(tableId);  // GET /v3/tables/{tableId}
  const tableFields = tableData.fields || tableData.table?.fields || [];
  const gridViews = tableData.gridViews || tableData.table?.gridViews || [];
  
  // Get field order from the view, or fall back to table order
  const view = gridViews.find(v => v.id === viewId);
  const viewFieldOrder = view?.fieldOrder || [];
  const orderedFieldIds = viewFieldOrder.length > 0
    ? viewFieldOrder
    : tableFields.map(f => f.id);
  
  // Skip system fields
  // Filter: f_created_at, f_updated_at
  
  // For source columns, fetch source details
  // GET /v3/sources/{sourceId} for each sourceId in typeSettings.sourceIds
}
```

### 3. Convert to Portable Format

The `schemaToPortable()` function transforms internal field IDs to column names:

```javascript
// Internal: {{f_abc123}} → Portable: {{@Column Name}}
// Source refs: {{f_source_data}} → {{@source:Source Name}}
```

The transformation walks the entire `typeSettings` object tree recursively, replacing all `{{f_xxx}}` patterns with `{{@ColumnName}}` patterns using the field ID-to-name mapping built from the table data.

### 4. Output Format

```json
{
  "version": "1.0",
  "exportedAt": "2026-01-22T12:00:00.000Z",
  "columnCount": 3,
  "columns": [
    {
      "index": 0,
      "name": "Website",
      "type": "text",
      "typeSettings": {"dataTypeSettings": {"type": "url"}}
    },
    {
      "index": 1,
      "name": "Domain",
      "type": "formula",
      "typeSettings": {
        "formulaText": "DOMAIN({{@Website}})",
        "formulaType": "text",
        "dataTypeSettings": {"type": "text"}
      }
    }
  ]
}
```

## Schema Import Pipeline

### 1. Dependency Resolution

Before creating columns, Claymate sorts them by dependency order:

```javascript
function extractDependencies(typeSettings) {
  // Scans JSON-stringified typeSettings for {{@Column Name}} and {{@source:Name}} patterns
  // Returns array of dependency names
}

function sortByDependencies(columns) {
  // Topological sort: source columns first, then by reference order
  // Handles circular references by breaking the cycle (visiting set)
}
```

### 2. Source Column Creation

Source columns require a two-step process:

1. Create the source via `POST /v3/sources`:
   ```json
   {
     "workspaceId": 12345,
     "tableId": "t_abc123",
     "name": "Webhook",
     "type": "v3-action",
     "typeSettings": {...}
   }
   ```

2. Get the source's `dataFieldId` (may require a follow-up `GET /v3/sources/{id}`)

3. Create the source field via `POST /v3/tables/{tableId}/fields`:
   ```json
   {
     "name": "Webhook Source",
     "type": "source",
     "typeSettings": {
       "sourceIds": ["s_created_id"],
       "canCreateRecords": true
     }
   }
   ```

### 3. Regular Column Creation

For non-source columns, Claymate:

1. Transforms portable `{{@Column Name}}` references back to internal `{{f_xxx}}` IDs using the name-to-ID mapping built as columns are created
2. Calls `POST /v3/tables/{tableId}/fields` with the transformed config
3. Tracks the new field's ID for subsequent column references
4. Waits 150ms between calls

### 4. Reference Resolution

```javascript
function transformColumnNameReferences(obj, nameToFieldId, sourceNameToDataRef) {
  // {{@source:Name}} → {{dataFieldId}}
  // {{@Column Name}} → {{f_fieldId}}
  // Recursive walk of entire object tree
}
```

## DOM Interaction

### Selected Column Detection

```javascript
function getSelectedColumns() {
  const allElements = document.querySelectorAll('[class*="text-white"]');
  // Filter by: text length < 50, vertical position between 100-200px (header row)
  // Sort by horizontal position (left to right)
  return selectedColumns.map(c => c.name);
}
```

This is a heuristic -- it detects which column headers have the "selected" visual state (white text) in the header region. Fragile but functional.

### Selection Watcher

Polls every 250ms + on click events to update the selected column count in the UI.

## Type-Specific Field Creation Details

### Text

Claymate forces `typeSettings.dataTypeSettings.type = 'text'` for text columns.

### Formula

Requires both `formulaType` and `dataTypeSettings`:
```json
{
  "typeSettings": {
    "formulaText": "...",
    "formulaType": "text",
    "dataTypeSettings": {"type": "text"}
  }
}
```

### Action (Enrichment)

Includes `useStaticIP` flag (defaults to `false`) and `dataTypeSettings.type = 'json'`.

## Limitations

1. **No table creation**: Claymate only adds columns to existing tables
2. **No row operations**: Only schema/structure operations
3. **Auth account IDs**: `authAccountId` values in action columns are account-specific and must be replaced manually
4. **No workbook awareness**: Operates on individual tables, not workbook topology
5. **Source type mapping**: Only handles `v3-action` source type; other source types may need different handling
6. **Error recovery**: If a column creation fails mid-import, there's no rollback -- some columns may be created and others not

## Useful Constants

- API base: `https://api.clay.com/v3`
- Table ID pattern: `t_[a-zA-Z0-9]+`
- View ID pattern: `gv_[a-zA-Z0-9]+`
- Workspace ID pattern: `\d+`
- Field ID pattern: `f_[a-zA-Z0-9_]+`
- Source ID pattern: `s_[a-zA-Z0-9]+`
- Inter-call delay: 150ms
- Attribution tag: `created_from: 'claymate_free_extension'`
