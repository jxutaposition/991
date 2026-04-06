# Formula Error & Fix Lifecycle

**Status**: FULLY DOCUMENTED
**Investigated**: INV-024 (Session 9)

## Error Creation
- Invalid formulas accepted at creation (200) → `settingsError` array populated
- Error types: `INVALID_FORMULA_MISSING_INPUT_FIELD`, `INVALID_FORMULA_PARSING_FAILED`
- `inputFieldIds` captures all referenced fields including non-existent ones

## Fixing
- PATCH `typeSettings.formulaText` with valid formula → `settingsError` auto-clears
- No manual error clearing needed

## Deletion Cascade
- Deleting a referenced field does NOT delete dependent fields
- Dependent fields get `settingsError` with `INVALID_FORMULA_MISSING_INPUT_FIELD`
- Both formula and action fields affected
- Agent must PATCH dependent fields to fix references after deletion
