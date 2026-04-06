# TODO-001: Read Rows from a Table

**Priority:** P0 — Blocks core agent loop
**Status:** RESOLVED (INV-012, 2026-04-06)
**Related Gap:** GAP-025 (resolved)

## Solution Found

Two endpoints discovered:

### List rows (via view)
```
GET /v3/tables/{tableId}/views/{viewId}/records?limit=N
```
- Returns `{results: Record[]}` — each record has `id`, `tableId`, `cells`, `recordMetadata`, `createdAt`, `updatedAt`
- Cells are keyed by field ID: `{f_xxx: {value: "...", metadata: {...}}}`
- **View ID required** — get from `GET /v3/tables/{tableId}` response under `table.views[]`
- Views apply server-side filtering (e.g., "Fully enriched rows" view vs "All rows" view)
- `limit` param works correctly
- `offset` param is accepted but **silently ignored** (always returns from start)

### Single row by ID
```
GET /v3/tables/{tableId}/records/{recordId}
```
- Returns the full record object (same shape as list items)
- 404 for invalid record IDs

## Remaining Sub-gap: Pagination

`offset` is ignored, so we can't paginate large tables (>limit) with offset-based pagination. This needs a follow-up investigation:
- Cursor-based pagination? (check for `cursor` or `after` params)
- Record ID-based pagination? (e.g., `?after=r_xxx`)
- This is tracked as a new concern but not blocking — most tables are <1000 rows and `limit` can be set high

## Verified On

- Table: `t_0tczmx2dJfFX5XaKTnE` (Experts, 79 rows) — returned all 79 via default view
- Table: `t_0tczn2bMqj5uoCX6BjA` (Creators, 49 rows) — confirmed generalizes
- View filtering confirmed: "Fully enriched" view returned 0, "All rows" returned 85, "Default" returned 79
