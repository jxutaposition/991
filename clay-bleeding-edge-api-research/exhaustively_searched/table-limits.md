# Table Limits & Stress Test

**Status**: TESTED — no limits hit
**Investigated**: INV-021 (Session 7A)

## Results

| Test | Result |
|------|--------|
| 100 rows per single POST | ✅ 115ms |
| 500 rows per single POST | ✅ 163ms |
| 50KB cell value | ✅ works |
| 500KB cell value | ✅ works |
| Invalid field IDs in row insert | Silently ignored — row created, unknown fields dropped |
| 10 concurrent inserts | All 10 succeed |
| 5 concurrent PATCH on same cell | All 5 accepted (async, last-write-wins) |

No hard limits encountered. Feature flags suggest: tableColumnLimit=100, workspaceRowLimit=10M, but these weren't tested at scale.
