# Clay Official v1 API Reference

Last updated: 2026-04-06

## ⚠ V1 API IS FULLY DEPRECATED (confirmed 2026-04-06, INV-011)

The entire v1 REST API is non-functional:
- `api.clay.run/v1/*` returns `{"success":false,"message":"deprecated API endpoint"}`
- `api.clay.com/api/v1/*` routes are not registered (Express 404)
- Both the `apiToken` from /v3/me AND proper UUID API keys from /v3/api-keys receive 404
- Community reports confirm this deprecation

**Replacement endpoints (all on api.clay.com, session cookie auth):**
- Row creation: `POST /v3/tables/{id}/records` with `{records: [{cells: {f_fieldId: "value"}}]}`
- Row update: `PATCH /v3/tables/{id}/records` (async, enqueued)
- Row deletion: `DELETE /v3/tables/{id}/records` with `{recordIds: [...]}`
- Enrichment trigger: `PATCH /v3/tables/{id}/run` with `{fieldIds: [...], runRecords: {recordIds: [...]}}`
- Data ingestion (external): Webhook sources — POST JSON to `state.url` (no auth needed)

The v1 endpoint documentation below is preserved for historical reference only.

## Overview

Clay's official REST API lives at `https://api.clay.com` and uses API key authentication. The key is account-scoped (covers all workspaces within a Clay account). Obtain it from [app.clay.com/settings](https://app.clay.com/settings).

## Authentication

```
Authorization: Bearer {CLAY_API_KEY}
```

The API key is a static token. No OAuth flow, no refresh mechanism. One key per account.

In the Lele backend, Clay API key injection is handled automatically by the credential system for any request to `api.clay.com` (see `SD-002_integrations_and_credentials.md`).

## Confirmed Endpoints

### Read Table Metadata

```
GET /api/v1/tables/{table_id}
Authorization: Bearer {key}
```

Returns table metadata. Exact response shape needs empirical verification (the official docs are sparse).

### Read Rows

```
GET /api/v1/tables/{table_id}/rows
Authorization: Bearer {key}
```

Returns rows from a table. Pagination mechanics are undocumented publicly. Response includes row data with column values.

### Add Rows

```
POST /api/v1/tables/{table_id}/rows
Authorization: Bearer {key}
Content-Type: application/json

{
  "rows": [
    {"Column Name": "value", "Another Column": "value"}
  ]
}
```

Adds rows to a table. Column references may be by name or by ID -- needs verification.

### Trigger Enrichment

```
POST /api/v1/tables/{table_id}/trigger
Authorization: Bearer {key}
```

Triggers enrichment runs on a table. Exact parameters (which columns, which rows, run conditions) need empirical verification.

## Validation Endpoint

Used by the Lele credential system to verify API keys on save:

```
GET /api/v1/sources
Authorization: Bearer {key}
```

A successful response confirms the key is valid. Used in `backend/src/routes.rs` integration validation.

## Table Webhooks (Inbound)

Each Clay table can expose a unique webhook URL for receiving data via HTTP POST.

**Setup**: Done in the Clay UI (cannot be created via API). Copy the URL and optional auth token from the table settings.

**Usage**:
```
POST {webhook_url}
Content-Type: application/json

{"field_name": "value", "another_field": "value"}
```

**Limits**:
- 50,000 submissions per webhook endpoint (persists even after deleting rows)
- Enterprise: auto-delete/passthrough mode for unlimited flow-through
- Auth token shown only once at setup -- store immediately
- Inbound only -- cannot read data back via webhook

**Cleanup**: After hitting the 50k limit, you need a new webhook (new table or new webhook on the same table if supported).

## HTTP API Action Columns (Outbound)

Configured as a column type in the Clay UI. When a row's enrichments complete (or on manual trigger), Clay makes an HTTP request to your specified endpoint.

**Configuration** (in Clay UI):
- Method: POST, GET, PUT, DELETE
- URL: your endpoint
- Headers: `Content-Type: application/json`, custom auth headers
- Body: JSON template using `{{column_name}}` for column value references
- Run condition: on row match, manual trigger, or schedule

This is how Clay "pushes" enriched data back to your system. It's the primary mechanism for getting data OUT of Clay programmatically.

## Enterprise People & Company API

Available only on Enterprise plans. Provides fast lookups for basic person/company data.

- Send an email or LinkedIn URL to get basic person details
- Send a domain to get company info
- Does NOT include deep enrichment (emails, phones, revenue, tech stack, etc.)
- Contact Clay's GTM engineers for access

## What the Official API Does NOT Support

- Table creation or deletion
- Column/field creation, modification, or deletion
- Enrichment provider configuration
- Webhook creation or management
- Workbook operations
- Formula reading or modification
- Schema export/import
- Connected account management
- Workspace listing or management
- Bulk operations across tables

These are the gaps the v3 internal API and Playwright automation aim to fill.

## Credit System

Clay operations consume credits. Key rules from the Terms of Service:
- Credits cannot be sold or transferred to other users
- Data obtained from Clay cannot be re-sold
- Always test enrichments on 1 row before bulk runs
- "Force run all rows" re-runs even previously found results (costs more credits)
- "Run empty or out-of-date" skips rows with existing data but does NOT re-run "No Record Found" results
