# Clay Gotchas

- **v1 API is dead.** All v1 endpoints (`api.clay.com/api/v1/*`) return "deprecated API endpoint". Use v3 exclusively.
- **Row reading requires a view ID.** There is no `GET /v3/tables/{id}/records` — you must use `GET /v3/tables/{id}/views/{viewId}/records`. Get view IDs from `clay_get_table_schema` → `views[]`.
- **No pagination.** `offset` parameter is accepted but silently ignored. `limit` works. No hasMore/nextCursor in responses.
- **Row updates are async.** `PATCH /v3/tables/{id}/records` enqueues updates — they may not be immediately visible.
- **Trailing slashes in URLs** cause lookup mismatches. LinkedIn URLs must NOT end with `/`. A Formula column that appends `/` to a URL already ending in `/` produces `//` which breaks matching.
- **"Force run all rows" vs "Run empty or out-of-date rows"**: the latter does NOT re-run rows with "No Record Found" results. Use "Force run all" after adding new reference data.
- **Enrichment credits are finite.** Always warn about credit consumption and test on a single row before bulk runs. Check balance with `clay_get_workspace`.
- **Row unit matters.** Define it before building any table. If the row unit doesn't match the data (e.g., enrichment is per-post but the row is per-expert), restructure first. Wrong row unit compounds into broken outputs.
- **Route-row ordering**: the destination table must exist before creating a route-row column pointing to it. Route-row auto-creates source fields on target tables.
- **Action columns** send data to external systems via webhooks or API calls. They fire based on configurable conditions.
- **URL normalization** between Clay and other systems (Supabase, n8n) is a common source of mismatches.
- **Field references** in formulas and API calls use internal IDs (`{{f_abc123}}`), not column names.
- **No rate limiting detected.** No inter-call delays needed (the old 150ms recommendation was a courtesy, not a requirement).
