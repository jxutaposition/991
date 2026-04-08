# Clay CSV Export

Async export job model. POST creates a job; the file becomes available via a separate poll endpoint.

## Endpoints

| Method | Path | Tool | Notes |
|---|---|---|---|
| POST | `/v3/tables/{tableId}/export` | `clay_export_table` | Body `{format?: string}` (default `'csv'`). Returns `{id (ej_…), workspaceId, tableId, viewId, fileName, status: 'ACTIVE', uploadedFilePath: null}` |
| GET | `/v3/exports/{exportJobId}` | `clay_get_export` | Poll. Returns the same shape; status transitions `ACTIVE → FINISHED`; `uploadedFilePath` populates when complete (e.g. `'ws1080480/filename.csv'`). |

## Flow

1. Call `clay_export_table` with the `table_id`. Save the returned `id` (export job id, prefixed `ej_…`).
2. Poll `clay_get_export` with that `id` until `status === 'FINISHED'`. INV-017 saw the first poll after ~2s already return `FINISHED` for a small table; larger exports take longer.
3. The `uploadedFilePath` field gives you a relative S3 path. The actual download mechanism (signed URL) was not fully reverse-engineered as of INV-017 — if you need the file body, use `request_user_action` to ask the user to download it from the Clay UI exports panel, OR use the relative path with the workspace's known S3 bucket if you have the right credentials.

## Gotchas

- The endpoint `GET /v3/exports/csv` does NOT mean "export as CSV" — it 404s with "Export job csv not found". The `csv` is being parsed as a job ID. Always pass the real `ej_…` ID.
- Each export pins to a specific `viewId` (filtering applied by that view). To export the full table, pass the `'All rows'` view.
- The job is async — do NOT block the agent on it. Kick off the export, do other work, poll periodically.
