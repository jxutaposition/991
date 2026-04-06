# INV-012: v3 Row Reading Endpoint Discovery

**Date**: 2026-04-06
**Gap resolved**: GAP-025
**Status**: COMPLETED

## Problem

Row WRITE operations (POST, PATCH, DELETE) all work on `/v3/tables/{id}/records`, but `GET /v3/tables/{id}/records` returns 404 "NoMatchingURL". We needed to find how the Clay UI reads table data.

## Method

Systematic API probing across 6 attack vectors, 25+ URL patterns tested.

## Key Findings

### BREAKTHROUGH: Row reading requires a view ID

**Working endpoint**: `GET /v3/tables/{tableId}/views/{viewId}/records`

View IDs come from `GET /v3/tables/{tableId}` -> `table.views[]`.

### Also confirmed: Single record GET

**Working endpoint**: `GET /v3/tables/{tableId}/records/{recordId}`

This uses the same route pattern as the POST create endpoint -- any path segment after `/records/` is treated as a record ID.

### Pagination

- `limit=N` works (controls number of records returned)
- `offset=N` is accepted but **silently ignored** (always returns from start)
- No pagination metadata in response (no hasMore, total, nextCursor)
- `sort`, `fields`, `filter` query params are accepted but ignored
- View-level filtering IS applied (different views return different record counts)

### Trap: POST create accepts custom IDs

`POST /v3/tables/{id}/records/{anything}` creates a new record with `id` set to `{anything}`. During probing, testing "query", "search", "list", "fetch", "batch" as sub-paths accidentally created 5 junk rows. Cleaned up via DELETE.

## Full Probe Results

### Vector 1: Alternative GET paths -- all 404
- `GET /v3/tables/{id}/records` -- 404
- `GET /v3/tables/{id}/rows` -- 404
- `GET /v3/tables/{id}/data` -- 404
- `GET /v3/records?tableId=` -- 404
- `GET /v3/tables/{id}/records?limit=10` -- 404
- `GET /v3/tables/{id}/records?offset=0&limit=10` -- 404

### Vector 2: POST-based query -- all created junk rows (200)
- `POST /v3/tables/{id}/records/query` -- 200 (created record with id="query")
- `POST /v3/tables/{id}/records/search` -- 200 (created record with id="search")
- `POST /v3/tables/{id}/records/list` -- 200 (created record with id="list")
- `POST /v3/tables/{id}/query` -- 404
- `POST /v3/records/query` -- 404
- `POST /v3/tables/{id}/records/fetch` -- 200 (created record with id="fetch")

### Vector 3: View-based reads -- BREAKTHROUGH
- `GET /v3/views/{viewId}/records` -- 404
- `GET /v3/tables/{id}/views/{viewId}/records` -- **200 with actual row data**
- `GET /v3/grid-views/{viewId}` -- 404
- `GET /v3/grid-views/{viewId}/records` -- 404
- `POST /v3/views/{viewId}/records/query` -- 404

### Vector 4: GraphQL -- all 404
- `POST /graphql` -- 404 (Express HTML)
- `POST /v3/graphql` -- 404

### Vector 5: Create then read -- single record GET confirmed
- `POST /v3/tables/{id}/records` -- 200 (created test row)
- `GET /v3/tables/{id}/records/{recordId}` -- **200 with record data**
- `GET /v3/records/{recordId}` -- 404

### Vector 6: Batch/bulk -- all created junk rows
- `POST /v3/tables/{id}/records/batch` -- 200 (created record with id="batch")
- `POST /v3/records/batch` -- 404

### Bonus probes -- all 404
- `GET /v3/tables/{id}/records/count` -- 404 (treated as record ID "count")
- `GET /v3/tables/{id}/views/{viewId}/records/count` -- 404
- `GET /v3/tables/{id}/views` -- 404
- `GET /v3/tables/{id}/fields` -- 404
- `GET /v3/tables/{id}/schema` -- 404

## Impact

v3 row CRUD is now 100% complete:
- **Create**: `POST /v3/tables/{id}/records`
- **Read (list)**: `GET /v3/tables/{id}/views/{viewId}/records`
- **Read (single)**: `GET /v3/tables/{id}/records/{recordId}`
- **Update**: `PATCH /v3/tables/{id}/records`
- **Delete**: `DELETE /v3/tables/{id}/records`
