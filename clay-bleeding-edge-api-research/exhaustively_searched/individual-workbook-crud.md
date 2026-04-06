# Individual Workbook CRUD

**Status**: NOT AVAILABLE for read/update/delete individual workbooks
**Investigated**: INV-016 (Session 4), INV-018 (Session 5)

## What Works
- `GET /v3/workspaces/{id}/workbooks` — list all workbooks (200)
- `POST /v3/workbooks` — create new workbook (200)
- `POST /v3/workbooks/{id}/duplicate` — duplicate workbook (200)

## What Doesn't Work (All 404)
- `GET /v3/workbooks/{id}` — read single workbook
- `PATCH /v3/workbooks/{id}` — update/rename workbook
- `DELETE /v3/workbooks/{id}` — delete workbook
- `GET /v3/workspaces/{ws}/workbooks/{wb}` — workspace-scoped read
- `PATCH /v3/workspaces/{ws}/workbooks/{wb}` — workspace-scoped update
- `DELETE /v3/workspaces/{ws}/workbooks/{wb}` — workspace-scoped delete
