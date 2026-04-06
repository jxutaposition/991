# Per-Action Credit Tracking

**Status**: NO ENDPOINTS EXIST
**Investigated**: INV-017 (Session 4), INV-018 (Session 5)

## What Works
- `GET /v3/workspaces/{id}` → `credits: {basic: N, actionExecution: N}` — aggregate balance only

## Paths Tested (All 404)
- `GET /v3/workspaces/{id}/credits`
- `GET /v3/workspaces/{id}/credit-usage`
- `GET /v3/workspaces/{id}/billing`
- `GET /v3/workspaces/{id}/usage`
- `GET /v3/credits`
- `GET /v3/billing`

## Workaround
Read workspace credits before and after an enrichment run, calculate the delta.
