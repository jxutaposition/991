# Table History / Restore / Snapshots

**Status**: NO ENDPOINTS EXIST
**Investigated**: INV-016 (Session 4), INV-018 (Session 5)
**Note**: Feature flag `restoreHistoryLimit: 30` exists, so the feature is real — just UI-only.

## Paths Tested (All 404)
- `GET /v3/tables/{id}/history`
- `GET /v3/tables/{id}/versions`
- `GET /v3/tables/{id}/snapshots`
- `GET /v3/tables/{id}/restore`
- `GET /v3/tables/{id}/activity`
- `GET /v3/tables/{id}/runs`
- `GET /v3/tables/{id}/jobs`
- `GET /v3/tables/{id}/stats`
- `GET /v3/tables/{id}/settings`
- `GET /v3/tables/{id}/dedupe`
- `GET /v3/tables/{id}/dedupe-settings`
