# Session 5: Deep Scan Investigation

**Date**: 2026-04-06
**Duration**: ~15 minutes (2 parallel investigation scripts, 130+ endpoint probes)
**Investigations**: INV-018, INV-019

## Summary

Probed 130+ endpoint/parameter combinations across 17 feature-flag-hinted API families. Discovered 7 new confirmed endpoints and resolved the view filter/sort question definitively.

## New Endpoints Confirmed (7)

| Method | Path | Response | Notes |
|--------|------|----------|-------|
| GET | `/v3/workspaces/{id}/signals` | `{signals: [...]}` | Signal monitoring configs with actionPackageId, monitorType |
| GET | `/v3/workspaces/{id}/resource-tags` | `[]` | Tag system exists, currently empty |
| GET | `/v3/workspaces/{id}/users` | `{users: [...]}` | All workspace members with roles, emails, profile pics |
| GET | `/v3/workspaces/{id}/permissions` | `{userPermissions: [...]}` | Role-based permissions per user |
| GET | `/v3/attributes` | `{attributeDescriptionsMap: {...}}` | Waterfall attribute catalog (person/company enrichment fields) |
| GET | `/v3/exports/{jobId}` | Export job status with `uploadedFilePath` | **Completes the export flow** |
| DELETE | `/v3/tables/{id}/views/{viewId}` | `{}` | View deletion confirmed |

## Export Flow — FULLY DOCUMENTED

The complete async export lifecycle:
1. `POST /v3/tables/{id}/export` → `{id: "ej_xxx", status: "ACTIVE", uploadedFilePath: null}`
2. Poll: `GET /v3/exports/ej_xxx` → `{status: "FINISHED", uploadedFilePath: "ws1080480/filename.csv"}`
3. Download: The `uploadedFilePath` is a relative path (likely S3). Download mechanism TBD — `GET /v3/exports/download/{jobId}` returns 404.

## Table Settings — CONFIRMED WRITABLE

`PATCH /v3/tables/{id}` with `tableSettings` object:
- `autoRun: boolean` — enable/disable automatic enrichment runs
- `dedupeFieldId: "f_xxx"` — set deduplication key field
- `HAS_SCHEDULED_RUNS: boolean` — system property (read-only?)

## View Filter/Sort — DEFINITIVELY NOT AVAILABLE VIA REST API

Tested 7 different filter payload formats and 4 sort formats. All return 200 but filter/sort remain `null` in the response. Even creating a new view with filter baked in → `filter: null`. The preconfigured views ("Errored rows") get their filters server-side via `typeSettings.preconfiguredType`. **View filtering/sorting is managed by a different mechanism** — likely WebSocket-based UI state sync or a completely separate endpoint family we haven't found.

## View Field Visibility/Order — NOT PERSISTING

PATCH with `fields` map (containing `isVisible`, `order`, `width`) returns 200 but field values don't change. Same non-persistence issue as filter/sort.

## Admin-Only Endpoints

| Endpoint | Response |
|----------|----------|
| `GET /v3/presets` | 403 — requires admin |
| `GET /v3/users` | 403 — requires admin |
| `GET /v3/exports` | 403 — requires admin |

## Import Creation

`POST /v3/imports` → 500 Internal Server Error (endpoint exists but our payload was incomplete).

## Attributes Catalog

`GET /v3/attributes` returns a rich waterfall attribute catalog:
- `attributeDescriptionsMap.waterfallAttributes` contains person and company fields
- Each attribute has: `enum`, `entityType`, `displayName`, `icon`, `dataTypeSettings`, `isPopular`, `actionIds`
- Examples: `person/workEmail`, `person/fullName`, `company/domain`
- This is Clay's enrichment field taxonomy

## API Keys

Only `resourceType=user` is valid. `workspace` and `table` return 400 with "Invalid enum value. Expected 'user'".

## Endpoints Confirmed NOT Available (404)

Folders, recipes, audiences/segments, scheduled sources/cron, CRM integrations, website tracking, notifications, search, claygent, workflows, message-drafts, activity/audit-log, billing, quotas, limits, access, individual workbook CRUD via workspace path.
