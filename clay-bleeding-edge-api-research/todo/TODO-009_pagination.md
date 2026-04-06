# TODO-009: Row Pagination for Large Tables

**Priority:** P1 — Blocks reading tables with >limit rows
**Status:** Open
**Emerged from:** TODO-001 / INV-012

## Problem

`GET /v3/tables/{tableId}/views/{viewId}/records?limit=N` works, but `offset` is silently ignored. For tables larger than the limit, we can't paginate to get all rows.

## What We Know

- `limit=N` correctly returns N records
- `offset=N` is accepted (no error) but returns the same records regardless of value
- No pagination metadata in response (no `hasMore`, `total`, `nextCursor`, `nextPage`)
- Response shape is just `{results: Record[]}`

## Investigation Plan

1. **Cursor-based pagination**: Try `?cursor=r_xxx` or `?after=r_xxx` using the last record ID
2. **Page-based**: Try `?page=2` or `?pageNumber=2`
3. **Large limit**: Test if we can just set `limit=10000` and get everything in one call
4. **CDP intercept**: Watch how Clay UI loads data when scrolling a large table — it must paginate somehow
5. **Sort + filter**: If we can sort by createdAt and filter by range, we can manually paginate

## Success Criteria

- Can retrieve ALL rows from a table with >100 rows
- Understand the pagination model or maximum single-request row count
