# Table Duplication — What Gets Copied

**Status**: FULLY DOCUMENTED
**Investigated**: INV-021 (Session 7A)

## Copied
- All columns (text, formula, action/enrichment) with full typeSettings
- Enrichment configs preserved (actionKey, actionPackageId, inputsBinding)
- All views (5 default views)
- Table settings (autoRun, dedupeFieldId, etc.)
- Stays in same workbook

## NOT Copied
- **Rows** — duplicate is schema-only, zero data
- Field IDs change (new unique IDs generated)
- Field references in formulas still point to OLD field IDs (may need updating)

## Use Case
Perfect for template-based table creation. Duplicate template → insert data → enrichment pipeline is pre-configured.
