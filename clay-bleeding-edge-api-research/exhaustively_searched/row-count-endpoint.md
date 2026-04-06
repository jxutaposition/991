# Row Count / Table Size Endpoint

**Status**: NO ENDPOINT OR FIELD
**Investigated**: INV-014 (Session 4)

## Checked
- No `count`, `numRecords`, `size`, `total` field in `GET /v3/tables/{id}` response
- No count fields in view objects
- `GET /v3/tables/{id}/records/count` treated as record ID lookup (404 "Record count was not found")

## Workaround
`GET /v3/tables/{id}/views/{viewId}/records?limit=10000` then count `results.length`.
