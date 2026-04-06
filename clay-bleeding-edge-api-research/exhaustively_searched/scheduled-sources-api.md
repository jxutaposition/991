# Scheduled Sources / Cron API

**Status**: NO ENDPOINTS EXIST
**Investigated**: INV-018 (Session 5)
**Note**: Feature flag `scheduledSourcesLimit: 100` exists. Scheduling is likely managed via source `typeSettings` or table `tableSettings.HAS_SCHEDULED_RUNS`, not dedicated endpoints.

## Paths Tested (All 404)
- `GET /v3/schedules`, `GET /v3/schedules?workspaceId=`
- `GET /v3/workspaces/{id}/schedules`
- `GET /v3/scheduled-sources`, `GET /v3/workspaces/{id}/scheduled-sources`
- `GET /v3/cron`, `GET /v3/workspaces/{id}/cron-jobs`
