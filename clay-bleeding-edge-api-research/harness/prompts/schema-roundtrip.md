# Prompt: Schema Roundtrip Test

## Objective

Test the full export -> modify -> import cycle for Clay table schemas to validate that our ClayMate-compatible schema handling works end-to-end. This validates the `clay_export_schema` and `clay_import_schema` tool implementations.

## Prerequisites

- Read `../AGENT.md` for conventions and safety rules
- Read `../../knowledge/internal-v3-api.md` for v3 API details
- Read `../../knowledge/claymate-analysis.md` for schema format details
- Valid Clay session cookies
- A source table with diverse column types (text, formula, action, source)
- An empty destination table for import testing

## Method

### Step 1: Export Source Table Schema

```typescript
// Fetch full table data via v3
const tableData = await clayApi(`/tables/${sourceTableId}`);
const fields = tableData.fields || tableData.table?.fields || [];
const gridViews = tableData.gridViews || tableData.table?.gridViews || [];

// Get field order from default view
const view = gridViews[0];
const fieldOrder = view?.fieldOrder || fields.map(f => f.id);

// Build ID-to-name mappings
const fieldIdToName = {};
fields.forEach(f => { fieldIdToName[f.id] = f.name; });

// Transform to portable format
// Replace all {{f_xxx}} references with {{@Column Name}}
// Save as JSON
```

### Step 2: Validate Export

Check that the exported schema:
- Has correct `version: "1.0"` and `columnCount`
- All field references use `{{@Column Name}}` format (no `{{f_xxx}}` remaining)
- Source columns have `sourceDetails` if applicable
- Column ordering matches the view's `fieldOrder`
- All `typeSettings` are preserved (formulas, action configs, etc.)

### Step 3: Optionally Modify Schema

Make a small change to test that modifications work:
- Add a new formula column to the schema
- Change a column name
- Adjust a formula reference

### Step 4: Import to Destination Table

```typescript
// Sort columns by dependency
const sorted = sortByDependencies(schema.columns);

// Create each column in order
for (const col of sorted) {
  // Transform {{@Column Name}} back to {{f_xxx}} using growing name-to-id map
  // Create source first if type === 'source'
  // POST /v3/tables/{destTableId}/fields
  // Track new field ID for subsequent references
  // Wait 150ms
}
```

### Step 5: Validate Import

Fetch the destination table's schema and verify:
- All columns were created with correct names
- Column types match the source
- Formulas reference the correct columns (by new field IDs)
- Action columns have correct `inputsBinding` references
- Source columns have working sources attached
- Column order matches the schema

### Step 6: Compare Source and Destination

Export the destination table and compare with the original export:
- Same number of columns
- Same column names and types
- Equivalent `typeSettings` (field IDs will differ but structure should match)
- Formula logic is equivalent

## Test Cases

### Case 1: Simple Table
- 3 columns: text input, formula (DOMAIN), text output
- Should roundtrip perfectly

### Case 2: Enrichment Table
- Text input, formula to extract domain, action column (enrichment), formula to extract from enrichment result
- Tests action column handling and `authAccountId` (expect this to need manual replacement)

### Case 3: Source Column Table
- Webhook source column, text columns for webhook data, formula column
- Tests the two-step source creation process

### Case 4: Complex Dependencies
- 8+ columns with deep dependency chains (formula referencing formula referencing enrichment)
- Tests topological sort correctness

## Output

1. **Results**: Save exported schemas and comparison reports to `../results/`
2. **Sample schemas**: Save known-good schemas to `../fixtures/sample-schemas/`
3. **Bug reports**: If roundtrip fails, document the failure in the investigation file
4. **Capability updates**: Update `../../registry/capabilities.md` with roundtrip status
