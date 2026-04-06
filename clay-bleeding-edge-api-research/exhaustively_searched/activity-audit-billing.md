# Activity Log / Audit / Billing / Quotas / Limits / Access

**Status**: NO ENDPOINTS EXIST (or admin-only)
**Investigated**: INV-018 (Session 5)

## Paths Tested (All 404)
- `GET /v3/workspaces/{id}/activity`
- `GET /v3/activity`
- `GET /v3/workspaces/{id}/audit-log`
- `GET /v3/workspaces/{id}/usage`
- `GET /v3/workspaces/{id}/billing`
- `GET /v3/workspaces/{id}/quotas`
- `GET /v3/workspaces/{id}/limits`
- `GET /v3/workspaces/{id}/access`

## Admin-Only (403)
- `GET /v3/presets` — "You must be logged in as an admin"
- `GET /v3/presets?workspaceId=` — same
- `GET /v3/users` — "You must be logged in as an admin"
- `GET /v3/exports` — "You must be logged in as an admin"

## What DOES Work for These Categories
- Billing/credits: `GET /v3/workspaces/{id}` → `credits`, `creditBudgets`, `billingPlanType`
- Users: `GET /v3/workspaces/{id}/users` (workspace-scoped, not admin)
- Permissions: `GET /v3/workspaces/{id}/permissions` (workspace-scoped)
