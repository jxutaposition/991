# Clay Internal v3 API Reference

Last updated: 2026-04-05 (post INV-006 + INV-007)
Source: Originally reverse-engineered from Claymate Lite. Expanded via unauthenticated enumeration (INV-006) and authenticated validation (INV-007).

**Canonical endpoint registry**: `registry/endpoints.jsonl` (38 entries). This file documents the most important endpoints in detail. For the full list, always check the registry.

## Overview

Clay's React frontend communicates with its backend via an internal REST API at `https://api.clay.com/v3`. This API is not publicly documented but is stable enough for the Claymate Lite Chrome extension (22+ stars, MIT licensed) to ship against.

The v3 API supports **full table lifecycle CRUD** including table creation/deletion, column creation/update/deletion, source management, enrichment triggering, table listing, actions catalog, and import/export — none of which the official v1 API provides.

## Authentication

**Method**: Session cookie named `claysession` on `.api.clay.com`

**Cookie details** (confirmed in INV-007):
- **Name**: `claysession`
- **Domain**: `.api.clay.com` (NOT `.clay.com` or `app.clay.com`)
- **Format**: Express/connect-session signed cookie: `s:<session_id>.<signature>` (URL-encoded as `s%3A...`)
- **Lifetime**: 7 days from issuance
- **Flags**: HttpOnly, Secure, SameSite=None

**Browser usage** (how Claymate does it):
```javascript
fetch(`${API_BASE}${endpoint}`, {
  ...options,
  credentials: 'include',  // sends claysession cookie
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'X-Clay-Frontend-Version': window.clay_version || 'unknown',
    ...options.headers
  }
});
```

**Server-side usage** (confirmed working):
```bash
curl -H "Cookie: claysession=s%3A<session_id>.<signature>" \
     -H "Accept: application/json" \
     "https://api.clay.com/v3/me"
```

Key points:
- Only the `claysession` cookie is required — no other cookies needed
- `X-Clay-Frontend-Version` header is optional for most endpoints (confirmed by testing without it)
- Current frontend version discoverable via `GET /v3` (no auth needed)
- Sessions established by logging into `app.clay.com` via Google SSO (or email/password)

**Extracting the cookie**: In browser DevTools → Application → Cookies → filter by `api.clay.com` (not `app.clay.com`) → copy `claysession` value. See `timeline/2026-04-05_breakthrough-session.md` for detailed instructions.

## Confirmed Endpoints

### GET /v3/tables/{tableId}

Returns the full table data including all fields and grid views.

**Request**:
```
GET https://api.clay.com/v3/tables/t_abc123
Cookie: [SESSION_COOKIES]
X-Clay-Frontend-Version: ...
```

**Response** (abbreviated):
```json
{
  "fields": [
    {
      "id": "f_abc123",
      "name": "Website",
      "type": "text",
      "typeSettings": {
        "dataTypeSettings": {"type": "url"}
      }
    },
    {
      "id": "f_def456",
      "name": "Domain",
      "type": "formula",
      "typeSettings": {
        "formulaText": "DOMAIN({{f_abc123}})",
        "formulaType": "text",
        "dataTypeSettings": {"type": "text"}
      }
    }
  ],
  "gridViews": [
    {
      "id": "gv_xyz789",
      "fieldOrder": ["f_abc123", "f_def456"]
    }
  ]
}
```

**Notes**:
- Field references use internal IDs like `{{f_abc123}}` (not column names)
- `typeSettings` contains the full configuration: formulas, enrichment actions, data types
- `gridViews` define column ordering per view
- System fields `f_created_at` and `f_updated_at` are present but typically skipped
- May also include `table.fields` or `table.gridViews` nested under a `table` key

### POST /v3/tables/{tableId}/fields

Creates a new column/field on a table.

**Request**:
```
POST https://api.clay.com/v3/tables/t_abc123/fields
Cookie: [SESSION_COOKIES]
Content-Type: application/json

{
  "name": "Company Name",
  "type": "formula",
  "activeViewId": "gv_xyz789",
  "attributionData": {"created_from": "claymate_free_extension"},
  "typeSettings": {
    "formulaText": "{{f_enrichment_col}}?.name",
    "formulaType": "text",
    "dataTypeSettings": {"type": "text"}
  }
}
```

**Response** (abbreviated):
```json
{
  "field": {
    "id": "f_new123",
    "name": "Company Name",
    "type": "formula",
    "typeSettings": {...}
  }
}
```

**Type-specific payload requirements**:

**Text columns**:
```json
{
  "name": "Website",
  "type": "text",
  "typeSettings": {
    "dataTypeSettings": {"type": "text"}
  }
}
```

**Formula columns**:
```json
{
  "name": "Domain",
  "type": "formula",
  "typeSettings": {
    "formulaText": "DOMAIN({{f_abc123}})",
    "formulaType": "text",
    "dataTypeSettings": {"type": "text"}
  }
}
```

**Action (enrichment) columns**:
```json
{
  "name": "Company Data",
  "type": "action",
  "typeSettings": {
    "dataTypeSettings": {"type": "json"},
    "actionKey": "provider-action-name",
    "actionVersion": 1,
    "actionPackageId": "uuid-of-package",
    "useStaticIP": false,
    "inputsBinding": [
      {"name": "domain", "formulaText": "{{f_domain_col}}"}
    ],
    "authAccountId": "aa_account_id",
    "conditionalRunFormulaText": "{{f_score}}?.value > 50 && !!{{f_email}}"
  }
}
```

**Source columns**:
```json
{
  "name": "Webhook Source",
  "type": "source",
  "typeSettings": {
    "sourceIds": ["s_source_id"],
    "canCreateRecords": true
  }
}
```

**Notes**:
- `activeViewId` is required (the current grid view ID)
- `attributionData` is optional metadata
- Field references in formulas must use internal `{{f_xxx}}` IDs, not column names
- The response includes the newly created field's `id` which must be tracked for subsequent references
- Claymate Lite uses 150ms delays between field creation calls

### GET /v3/sources/{sourceId}

Reads details about a data source (webhook, find-people action, etc.).

**Request**:
```
GET https://api.clay.com/v3/sources/s_abc123
Cookie: [SESSION_COOKIES]
```

**Response** (abbreviated):
```json
{
  "id": "s_abc123",
  "name": "Webhook",
  "type": "webhook",
  "dataFieldId": "f_source_data",
  "typeSettings": {
    "hasAuth": false,
    "iconType": "Webhook"
  }
}
```

**Notes**:
- `dataFieldId` links the source to the field that receives source data
- `type` can be `webhook`, `v3-action`, and likely others
- Source details include `typeSettings` which vary by source type

### POST /v3/sources

Creates a new data source on a table.

**Request**:
```
POST https://api.clay.com/v3/sources
Cookie: [SESSION_COOKIES]
Content-Type: application/json

{
  "workspaceId": 12345,
  "tableId": "t_abc123",
  "name": "Webhook",
  "type": "v3-action",
  "typeSettings": {
    "hasAuth": false,
    "iconType": "Webhook"
  }
}
```

**Response**:
```json
{
  "id": "s_new123",
  "dataFieldId": "f_new_data",
  ...
}
```

**Notes**:
- `workspaceId` is a numeric ID (not a string prefix)
- `type` defaults to `v3-action` in Claymate Lite
- The response may nest under a `source` key
- `dataFieldId` may not be immediately available -- Claymate Lite does a follow-up GET to retrieve it

## URL Patterns

Clay's frontend URLs encode entity IDs:

| Entity | URL Pattern | ID Format |
|--------|-------------|-----------|
| Table | `/tables/t_abc123` | `t_` prefix + alphanumeric |
| View | `/views/gv_abc123` | `gv_` prefix + alphanumeric |
| Workspace | `/workspaces/12345` | Numeric |
| Field (internal) | N/A (not in URL) | `f_` prefix + alphanumeric |
| Source (internal) | N/A (not in URL) | `s_` prefix + alphanumeric |

## Field Reference System

Clay uses two reference systems:

**Internal references** (used in API calls):
- `{{f_abc123}}` -- reference a field by ID
- Used in `formulaText`, `inputsBinding`, `conditionalRunFormulaText`

**Portable references** (used by Claymate for export/import):
- `{{@Column Name}}` -- reference a field by name
- `{{@source:Source Name}}` -- reference a source's data field by source name
- Claymate converts between formats during export/import

## Data Type Settings

The `dataTypeSettings.type` field controls display:
- `text` -- plain text
- `url` -- clickable link
- `email` -- email format
- `number` -- numeric
- `boolean` -- checkbox
- `json` -- JSON object (for enrichment results)
- `select` -- dropdown options

## Rate Limiting

**CONFIRMED: No rate limiting observed (INV-008, INV-009)**

Empirical testing:
- 20 rapid-fire requests with zero delays: 0 out of 20 rate-limited (INV-008)
- 50 rapid-fire requests with zero delays: 0 out of 50 rate-limited (INV-009)
- Average latency: 20-21ms
- No `X-RateLimit` or `Retry-After` headers observed
- The 150ms Claymate baseline was a courtesy delay, not a requirement
- Safe to remove inter-call delays entirely for production use

## Additional Confirmed Endpoints (INV-006 + INV-007)

All confirmed working via authenticated API calls:

### GET /v3 — Public Status (no auth required)
Returns current frontend version and CASL auth abilities: `{"status":"ok","version":"v20260403_221301Z_9894a0108e",...}`

### POST /v3/tables — Table Creation
```json
{"workspaceId": 1080480, "type": "spreadsheet", "name": "My Table"}
```
Types: `spreadsheet`, `company`, `people`, `jobs`. Auto-creates a workbook. Returns full table with fields, views.

### DELETE /v3/tables/{tableId} — Table Deletion
Returns deleted table with `deletedAt` timestamp.

### PATCH /v3/tables/{tableId} — Table Update/Rename
```json
{"name": "New Name"}
```

### PATCH /v3/tables/{tableId}/fields/{fieldId} — Field Update/Rename
```json
{"name": "Renamed Column"}
```

### DELETE /v3/tables/{tableId}/fields/{fieldId} — Field Deletion
Returns `{}` on success. Note: `PUT` does NOT exist (404).

### PATCH /v3/tables/{tableId}/run — Trigger Enrichment Runs
```json
{"runRecords": {"recordIds": ["r_xxx"]}, "fieldIds": ["f_xxx"], "forceRun": true, "callerName": "optional"}
```

### GET /v3/workspaces/{id}/tables — List Tables in Workspace
Returns `{results: [{id, name, type, workbookId, abilities, ...}]}`.

### GET /v3/workspaces/{id} — Workspace Details
Returns workspace name, billing plan, and ~150 feature flags.

### GET /v3/me — Current User Info
Returns user profile, API token, auth strategy, last workspace ID.

### GET /v3/actions?workspaceId={id} — Enrichment Actions Catalog
Returns all available actions with input/output schemas, rate limits, auth requirements.

### GET /v3/sources?workspaceId={id} — Source Listing
Returns all sources with IDs, types, states, record counts.

### PATCH /v3/sources/{sourceId} — Source Update
### DELETE /v3/sources/{sourceId} — Source Deletion

### GET /v3/imports?workspaceId={id} — Import History (confirmed INV-008)
Returns array of import records with config and column mapping details.

**Note**: `/v3/imports/csv` and `/v3/imports/webhook` are NOT separate endpoints (INV-009). "csv" and "webhook" are treated as import job IDs. The real pattern is `/v3/imports/{jobId}`.

### Export Endpoints (Async Job Model)
`GET /v3/exports/csv?tableId=` returns 404 "Export job csv not found". Exports are likely async (POST to create job, GET to download). Not fully documented.

### POST /v3/actions — Action Package Creation
```json
{"workspaceId": 1080480, "actionPackageId": "string", "actionPackageDefinition": "serialized JSON string"}
```

### GET /v3/app-accounts — Auth Account Enumeration (BREAKTHROUGH, INV-010)
Returns ALL auth accounts (Clay-managed + user-owned) for the authenticated user.

**Request**:
```
GET https://api.clay.com/v3/app-accounts
Cookie: [SESSION_COOKIE]
```

**Response** (abbreviated):
```json
[
  {
    "id": "aa_ZR72u7bn5qmS",
    "name": "Clay-managed ElevenLabs account",
    "appAccountTypeId": "elevenlabs",
    "isSharedPublicKey": true,
    "userOwnerId": null,
    "workspaceOwnerId": 4515,
    "defaultAccess": "can_use",
    "abilities": {"canUpdate": false, "canDelete": false, "canAccess": true}
  }
]
```

**Usage**: The `id` field is the `authAccountId` required in enrichment column `typeSettings`. Match `appAccountTypeId` to `auth.providerType` from the actions catalog to find the right account.

**Also accessible via**: `GET /v3/workspaces/{id}/app-accounts` (returns same results).

111 accounts returned for test workspace (all Clay-managed shared accounts).

## Confirmed Non-Existent Endpoints

These return 404 (NoMatchingURL) — definitively do not exist:
`/v3/workbooks`, `/v3/fields`, `/v3/rows`, `/v3/columns`, `/v3/webhooks`, `/v3/views`, `/v3/enrichments`, `/v3/integrations`, `/v3/accounts`, `/v3/billing`, `/v3/credits`, `/v3/formulas`, `/v3/providers`, `/v3/connectors`, `/v3/folders`, `/v3/people`, `/v3/companies`, `/v3/notifications`, `/v3/templates`, `/v3/settings`, `/v3/graphql`, `/v3/auth-accounts`, `/v3/authAccounts`, `/v3/connected-accounts`
