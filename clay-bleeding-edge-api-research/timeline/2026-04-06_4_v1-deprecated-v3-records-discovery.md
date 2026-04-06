# v1 API Deprecated + v3 Records Endpoint Discovery

**Date**: 2026-04-06
**Investigation**: INV-011
**Trigger**: Agent test failed — clay_write_rows returned 404 on v3-created tables

## Critical Finding: v1 API is FULLY DEPRECATED

**Every v1 endpoint returns 404/deprecated:**

| Base URL | Path | Result |
|---|---|---|
| `api.clay.com` | `/api/v1/tables/{id}/rows` | 404 (Express HTML: "Cannot GET/POST") |
| `api.clay.com` | `/api/v1/tables/{id}` | 404 |
| `api.clay.com` | `/api/v1/tables/{id}/trigger` | 404 |
| `api.clay.com` | `/api/v1/sources` | 404 |
| `api.clay.run` | `/v1/tables/{id}/rows` | 404 `{"success":false,"message":"deprecated API endpoint"}` |
| `api.clay.run` | `/v1/tables/{id}` | 404 deprecated |
| `api.clay.run` | `/v1/sources` | 404 deprecated |

Tested with:
- Bearer token auth (apiToken from /v3/me)
- x-api-key header
- Session cookie auth
- All return the same 404

**Impact**: All three v1 tools in the backend (`clay_read_rows`, `clay_write_rows`, `clay_trigger_enrichment`) are non-functional. They need to be rewritten to use v3 endpoints.

## Discovery: v3 Row CRUD via `/v3/tables/{id}/records`

### POST /v3/tables/{id}/records — CREATE ROWS

**Request**:
```json
POST /v3/tables/{tableId}/records
Cookie: claysession=...

{
  "records": [
    {
      "cells": {
        "f_fieldId1": "value1",
        "f_fieldId2": "value2"
      }
    }
  ]
}
```

**Response** (200):
```json
{
  "records": [
    {
      "id": "r_0td1u7wWKGatXSU7JGe",
      "tableId": "t_0td1u7viWWFFjXgxyzE",
      "cells": {
        "f_fieldId1": {"value": "value1"},
        "f_created_at": {"value": "2026-04-06T01:45:32.189Z", "metadata": {"isCoerced": true}},
        "f_updated_at": {"value": "2026-04-06T01:45:32.189Z", "metadata": {"isCoerced": true}}
      },
      "recordMetadata": {},
      "createdAt": "2026-04-06T01:45:32.203Z",
      "updatedAt": "2026-04-06T01:45:32.203Z",
      "deletedBy": null,
      "dedupeValue": null
    }
  ]
}
```

**Key format rules**:
- `cells` keys MUST be field IDs (`f_xxx`), not field names
- Values are plain strings/numbers — NOT nested `{value: "..."}` objects (that causes `coercionErrorCode: INVALID_VALUE`)
- `cells: {}` creates an empty row (only system fields populated)
- Multiple records can be created in one call

### PATCH /v3/tables/{id}/records — UPDATE ROWS

Returns `{"records":[],"extraData":{"message":"Record updates enqueued"}}` — updates are async.

### DELETE /v3/tables/{id}/records — DELETE ROWS

```json
{"recordIds": ["r_xxx", "r_yyy"]}
```

Returns `{}` on success.

### GET /v3/tables/{id}/records — DOES NOT EXIST

Returns 404. Row reading likely uses a different endpoint or query mechanism. Needs further investigation.

## Webhook-Based Row Insertion (Alternative)

For external integrations, webhook sources provide a simpler path:

1. Create webhook source: `POST /v3/sources` with `type: "webhook"`
2. Get URL from response: `state.url`
3. POST JSON directly to that URL (no auth required): returns 200 "OK"
4. Each POST creates one record; arrays NOT supported (posts 1 record per webhook call)
5. Source `state.numSourceRecords` reflects the count

## Impact on Backend

The following tools need to be migrated from v1 to v3:

| Tool | Current (broken) | New endpoint |
|---|---|---|
| `clay_read_rows` | `GET /api/v1/tables/{id}/rows` | TBD (need to find v3 read endpoint) |
| `clay_write_rows` | `POST /api/v1/tables/{id}/rows` | `POST /v3/tables/{id}/records` |
| `clay_trigger_enrichment` | `POST /api/v1/tables/{id}/trigger` | `PATCH /v3/tables/{id}/run` |

The preflight probe that used `GET /api/v1/sources` for v1 API key validation is also broken — this was already patched to skip v1 validation.
