# Single Field / Sub-Resource Endpoints

**Status**: DO NOT EXIST (all 404)
**Investigated**: INV-025 (Session 10A)

## Paths Tested (All 404)
- `GET /v3/tables/{id}/fields/{fieldId}` — no single field read
- `GET /v3/tables/{id}/fields` — no field listing endpoint
- `GET /v3/tables/{id}/schema` — no schema-only read
- `GET /v3/tables/{id}/metadata` — no metadata sub-resource
- `GET /v3/tables/{id}/stats` — no stats
- `GET /v3/fields/{fieldId}` — no root-level field access
- `POST /v3/tables/{id}/fields/batch` — no batch creation
- `GET /v3/tables/{id}/views/{viewId}/filter` — no filter sub-resource
- `GET /v3/tables/{id}/views/{viewId}/sort` — no sort sub-resource
- `GET /v3/tables/{id}/sources` — no source listing per table
- `GET /v3/tables/{id}/records/count` — treated as record ID lookup (404 "Record count was not found")
- `GET /v3/tables/{id}/workbook` — no workbook sub-resource

All table data comes through `GET /v3/tables/{id}` (full table with fields, views, sources).
