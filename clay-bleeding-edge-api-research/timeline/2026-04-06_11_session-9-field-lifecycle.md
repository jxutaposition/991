# Session 9: Field Lifecycle & Enrichment Results

**Date**: 2026-04-06
**Investigation**: INV-024

## Critical Findings

### 1. forceRun=false SKIPS Already-Succeeded Cells (TODO-033 — RESOLVED)

Definitive proof:
- Before: 1 run history entry
- `forceRun=false` → `{recordCount: 1}` but run history stays at 1 → **SKIPPED**
- `forceRun=true` → `{recordCount: 1}` and run history goes to 2 → **RE-RAN**

**Agent rule**: Use `forceRun: false` to "fill gaps only" — it skips SUCCESS cells and only runs on cells that haven't succeeded yet. Use `forceRun: true` to re-run everything.

### 2. Formula Fix via PATCH Works (TODO-040 — RESOLVED)

1. Create broken formula: `settingsError: [{type: "INVALID_FORMULA_MISSING_INPUT_FIELD"}]`
2. PATCH with valid `formulaText` → `settingsError` disappears
3. Read back: `settingsError: undefined`, formula text updated

**Agent pattern**: If a formula breaks (field deleted), PATCH its `typeSettings.formulaText` with a corrected reference → error auto-clears.

### 3. Field Deletion Cascade — settingsError Propagates (TODO-042 — RESOLVED)

Deleting a field that's referenced by other fields:
- Formula referencing deleted field → `settingsError: [{type: "INVALID_FORMULA_MISSING_INPUT_FIELD", message: "Settings contains deleted column  input"}]`
- Enrichment referencing deleted field → `settingsError: [{type: "INVALID_FORMULA_MISSING_INPUT_FIELD", message: "Settings contains deleted column for \"companyName\" input"}]`
- The deletion itself succeeds (200)
- **No cascade deletion** — dependent fields survive but get marked with errors
- `inputFieldIds` still contains the deleted field ID

**Agent pattern**: Before deleting a field, check other fields' `inputFieldIds` for references. After deletion, PATCH dependent fields to fix their references.

### 4. Enrichment Result is Preview String, Not JSON Object (TODO-043 — RESOLVED)

The cell value for `normalize-company-name` is just a preview string: `"✅ Anthropic"`. It's NOT a structured JSON object with `{original_name, normalized_name}`.

The `isPreview: true` metadata flag confirms this — Clay stores a human-readable preview, not the raw enrichment output. The full structured result may only be accessible via:
- Formula extraction: `{{f_enrichCol}}?.normalized_name`
- Or the value IS the full result for simple actions (normalize returns just the name)

### 5. Field Lock Settings — NOT User-Settable (TODO-039 — RESOLVED NEGATIVE)

- System fields have `lockSettings: {lockDelete: true, lockUpdateCells: true, lockUpdateSettings: true}`
- User fields have `lockSettings: undefined`
- PATCH with `lockSettings` or `isLocked: true` returns 200 but **values don't persist**
- Field protection is system-only, not configurable via API

### 6. Deduplication — Does NOT Prevent API Inserts (TODO-029 — CONFIRMED)

With `dedupeFieldId` set:
- 3 rows inserted (including duplicate email) → all 3 created, `dedupeValue: null`
- 4th insert with same email → also created
- Dedup is **not an insert-time check**. It likely:
  - Only flags duplicates in the UI for manual review
  - Or only applies during source/webhook ingestion (can't test — webhooks require paid plan)
  - Or is purely cosmetic (the view "De-duped rows" may filter, but the data still exists)

## Summary

| TODO | Status | Finding |
|------|--------|---------|
| TODO-033 (forceRun) | **RESOLVED** | `forceRun: false` skips SUCCESS cells, `true` re-runs all |
| TODO-039 (field locks) | **RESOLVED NEGATIVE** | Not user-settable via API |
| TODO-040 (formula fix) | **RESOLVED** | PATCH formulaText → settingsError auto-clears |
| TODO-042 (deletion cascade) | **RESOLVED** | Dependent fields get settingsError, not deleted |
| TODO-043 (enrichment results) | **RESOLVED** | Cell value is preview string, metadata has `isPreview: true` |
| TODO-029 (dedup) | **CONFIRMED** | dedupeFieldId doesn't prevent API inserts |
