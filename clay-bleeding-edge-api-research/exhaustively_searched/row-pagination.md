# Row Pagination

**Status**: NOT AVAILABLE — use `limit=10000` workaround
**Investigated**: INV-014 (Session 4)
**Test table**: 160 rows

## Params Tested (All Silently Ignored)
- `offset=50` — returns same rows as offset=0
- `cursor=r_xxx`, `after=r_xxx`, `startAfter=r_xxx`, `lastRecordId=r_xxx`, `fromRecordId=r_xxx`, `startingAfter=r_xxx` — all return same first-page results
- `page=2`, `pageNumber=2`, `skip=50`, `start=50`, `from=50` — all ignored
- `POST /v3/tables/{id}/views/{viewId}/records` with body — 404

## No Pagination Metadata
Response is just `{results: [...]}` — no `hasMore`, `total`, `nextCursor`, `nextPage`.

## Workaround
`limit=10000` returns all 160 rows in 39ms. Default without param = 100. Works for any reasonable table size.
