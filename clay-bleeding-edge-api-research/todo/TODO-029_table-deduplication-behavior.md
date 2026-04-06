# TODO-029: Table Deduplication Behavior

**Priority:** P1 — Preventing duplicate rows in automated pipelines
**Status:** Open

## What We Know
- `tableSettings.dedupeFieldId` is writable (confirmed INV-019)
- `enableAutodedupe: true` feature flag
- Records have `dedupeValue: null` field
- `enableAutodedupeFindCompanies: true` flag

## Investigation Plan
1. Create table, set `dedupeFieldId` to a text column
2. Insert rows with duplicate values in that column
3. Check if duplicates are rejected or merged
4. Check `dedupeValue` field on created records
5. Try `tableSettings.dedupeEnabled: true` and variations
6. Test with route-row: does dedup prevent duplicate routed rows?
