# Deduplication Behavior

**Status**: DOES NOT PREVENT API INSERTS
**Investigated**: INV-024 (Session 9), INV-020 (Session 6)

## Findings
- `tableSettings.dedupeFieldId` is writable but does NOT prevent duplicate rows via `POST /records`
- All duplicate rows created successfully, `dedupeValue: null` on all
- 4 inserts of "alice@test.com" → 4 rows in table

## Likely Purpose
Dedup probably:
- Only applies during source/webhook ingestion (not direct API inserts)
- Flags duplicates for UI review (the "De-duped rows" preconfigured view)
- Or is purely cosmetic metadata

Cannot verify source-fed dedup — webhook sources require paid plan (402).
