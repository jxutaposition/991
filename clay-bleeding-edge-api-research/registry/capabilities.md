# Clay Capability Matrix

Last updated: 2026-04-06 (INV-008 boundary exploration)

## Legend

- **yes**: Confirmed working with response shape documented
- **partial**: Works with limitations
- **untested**: Endpoint exists (401 response), not yet tested with auth
- **no**: Confirmed not possible via this layer (404)
- **n/a**: Not applicable to this layer

## Data Operations

| Capability | Official v1 | Internal v3 | Status |
|---|---|---|---|
| Read table rows | yes (API key) | **no** (404 confirmed) | **v1 only** |
| Write table rows | yes (API key) | **no** (404 confirmed) | **v1 only** |
| Trigger enrichments | yes (API key, blanket) | yes (targeted, fieldIds + runRecords) | **both work** |
| Read table metadata | yes (basic) | yes (full schema) | **working** |
| Bulk row operations | unknown | **no** | needs v1 investigation |
| Row deletion | unknown | **no** | needs v1 investigation |

## Schema Operations

| Capability | Official v1 | Internal v3 | Status |
|---|---|---|---|
| Read full table schema | partial (metadata only) | yes (fields + views + abilities) | **working** |
| Create text columns | no | yes | **working** |
| Create formula columns | no | yes | **working** |
| Create action columns | no | yes | **working** |
| Create source columns | no | yes (two-step) | **working** |
| Update/rename columns | no | yes (PATCH) | **working** |
| Delete columns | no | yes (DELETE) | **working** |
| Reorder columns | no | unknown | needs investigation |
| Export schema | no | yes (via get_table + transform) | **implementable** |
| Import schema | no | yes (via create_field + resolution) | **implementable** |

## Table Lifecycle

| Capability | Official v1 | Internal v3 | Status |
|---|---|---|---|
| List tables in workspace | no | yes (`GET /v3/workspaces/{id}/tables`) | **working** |
| Create new table | no | yes (`POST /v3/tables`) | **working** |
| Rename/update table | no | yes (`PATCH /v3/tables/{id}`) | **working** |
| Delete table | no | yes (`DELETE /v3/tables/{id}`) | **working** |
| Duplicate table | no | unknown | needs investigation |

## Source/Webhook Management

| Capability | Official v1 | Internal v3 | Status |
|---|---|---|---|
| Create source | no | yes (`POST /v3/sources`) | **working** |
| Read source details | no | yes (`GET /v3/sources/{id}`) | **working** |
| List all sources | no | yes (`GET /v3/sources?workspaceId=`) | **working** |
| Update source | no | yes (`PATCH /v3/sources/{id}`) | **working** |
| Delete source | no | yes (`DELETE /v3/sources/{id}`) | **working (INV-009)** |
| Read webhook URL | no | not in manual sources | needs webhook-type source test |

## Enrichment Configuration

| Capability | Official v1 | Internal v3 | Status |
|---|---|---|---|
| List enrichment actions | no | yes (1,191 actions, 170+ providers) | **working** |
| Create action package | no | yes (`POST /v3/actions`) | **endpoint confirmed** |
| List connected auth accounts | no | **yes** (`GET /v3/app-accounts`) | **working (INV-010)** |
| Read authAccountId | no | **yes** (id field from /v3/app-accounts) | **working (INV-010)** |
| Targeted enrichment trigger | no | yes (`PATCH /v3/tables/{id}/run`) | **working** |

## Workspace/Account

| Capability | Official v1 | Internal v3 | Status |
|---|---|---|---|
| Get workspace details | no | yes (billing, credits, features, abilities) | **working** |
| List all workspaces | no | no (requires admin, 403) | **not available for regular users** |
| Get current user | no | yes (`GET /v3/me`, includes API token) | **working** |
| Import history | no | yes (`GET /v3/imports?workspaceId=`) | **working** |
| CSV export | no | untested (async job model?) | needs investigation |

## Authentication

| Capability | Method | Status |
|---|---|---|
| API key auth (v1) | `Authorization: Bearer <key>` | **working** |
| Session cookie auth (v3) | `Cookie: claysession=<value>` | **working** |
| Session auto-refresh | Cookie refreshes via set-cookie on every call | **confirmed** |
| Frontend version header | Optional (all calls succeed without it) | **confirmed optional** |

## Rate Limits

| Observation | Value |
|---|---|
| Tested rate | 20 requests, zero delay |
| 429 responses | 0 out of 20 |
| Rate-limit headers | None observed |
| Average latency | 21ms |
| Recommended pacing | None required (50ms for safety margin) |
