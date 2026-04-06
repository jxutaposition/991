# Clay Programmatic Access Landscape

Last updated: 2026-04-05

## What Clay Is

Clay (clay.com) is a GTM data enrichment and prospecting platform. Users build "workbooks" containing "tables" with columns that can be text inputs, formulas (JavaScript), enrichment actions (calling external providers like Apollo, ZoomInfo, Hunter, OpenAI), lookups (cross-table joins), send-to-table routing, and HTTP action columns (webhook POSTs to external systems).

Clay is **not** the personal CRM product at clay.earth (which has its own MCP server `@clayhq/clay-mcp`). The GTM platform and the personal CRM are completely separate products with separate codebases and APIs.

## Official Programmatic Access

Clay's explicit position (from [university.clay.com](https://university.clay.com/docs/using-clay-as-an-api), confirmed as of April 2026): "Clay doesn't have a traditional API."

### What's Officially Supported

| Layer | Direction | Auth | Scope | Limits |
|-------|-----------|------|-------|--------|
| **Table webhooks** | Inbound (into Clay) | Optional token (shown once) | Per-table | 50,000 submissions per webhook; enterprise unlocks auto-delete for unlimited |
| **HTTP API action columns** | Outbound (Clay calls you) | Configured per column | Per-column, per-row | Fires when enrichment completes or on trigger |
| **v1 REST API** | Bidirectional | API key (`Authorization: Bearer`) | Per-account (all workspaces) | Row CRUD, enrichment triggers, table metadata |
| **Enterprise People/Company API** | Read-only | Enterprise API key | Basic lookups only | No deep enrichment (emails, phones, revenue) |
| **HTTP API as Source** | Inbound (import) | N/A | Table creation | New feature (Q1 2026); create table from API response; no pagination |

### What's NOT Officially Supported

- Creating tables programmatically
- Creating/configuring columns programmatically
- Managing enrichment providers or their configurations
- Managing webhooks or webhook settings
- Reading table schemas (beyond basic v1 metadata)
- Workbook-level operations
- Bulk operations across tables
- Formula debugging or error state access

## Unofficial / Bleeding-Edge Access

### Internal v3 API (Reverse-Engineered)

Clay's own React frontend uses an internal REST API at `https://api.clay.com/v3`. This API supports full structural CRUD but requires browser session cookies for authentication (not API keys).

**Source**: Reverse-engineered from Claymate Lite Chrome extension source code.

**Confirmed endpoints (37 total as of INV-006 + INV-007)**:

Core CRUD (all confirmed working with live API calls):
- `POST /v3/tables` -- **create tables** with `{workspaceId, type: spreadsheet|company|people|jobs, name}`
- `DELETE /v3/tables/{tableId}` -- **delete tables**
- `PATCH /v3/tables/{tableId}` -- **update/rename tables**
- `GET /v3/tables/{tableId}` -- full table schema with fields and views
- `POST /v3/tables/{tableId}/fields` -- create columns
- `PATCH /v3/tables/{tableId}/fields/{fieldId}` -- **update/rename columns**
- `DELETE /v3/tables/{tableId}/fields/{fieldId}` -- **delete columns**
- `GET /v3/sources/{sourceId}` -- source details
- `POST /v3/sources` -- create sources
- `PATCH /v3/sources/{sourceId}` -- **update sources**
- `DELETE /v3/sources/{sourceId}` -- **delete sources**
- `GET /v3/workspaces/{id}/tables` -- **list all tables in workspace**
- `PATCH /v3/tables/{tableId}/run` -- **trigger enrichment runs** with `{runRecords, fieldIds, forceRun}`
- `GET /v3/actions?workspaceId=` -- **list all enrichment providers with schemas**
- `GET /v3/me` -- current user info (including API token)
- `GET /v3` -- public status (returns frontend version, no auth needed)
- Plus import/export endpoints, source listing, and more

**Confirmed NOT available**: workbook CRUD (`/v3/workbooks` returns 404 — workbooks are auto-created with tables)

**Auth**: Session cookie named `claysession` on `.api.clay.com`. Express session format, 7-day lifetime. See [authentication.md](authentication.md).

See [internal-v3-api.md](internal-v3-api.md) for full details. See `registry/endpoints.jsonl` for the canonical endpoint list.

### Claymate Lite (Chrome Extension)

Open-source Chrome extension by [GTM-Base](https://github.com/GTM-Base/claymate-lite) that exports/imports Clay table schemas as portable JSON. MIT licensed, 22+ stars.

- Uses the v3 API with browser session cookies
- Converts internal field IDs to portable `{{@Column Name}}` references
- Supports full schema roundtrip: export -> modify -> import
- Handles dependency-sorted column creation (formulas referencing other columns)

See [claymate-analysis.md](claymate-analysis.md) for full source analysis.

### Playwright DOM Automation

Clay is a React SPA. Every piece of state lives in the DOM. Instead of screenshot-based computer use (which fails because narrow cells render values, not formulas), Playwright can:

- Click cells and read formula text from the formula bar DOM element
- Detect error states via CSS classes or aria attributes
- Navigate workbooks and tables via URL patterns
- Extract column configurations by reading the DOM structure

See [clay-dom-structure.md](clay-dom-structure.md) for known selectors.

### CDP Network Interception

Chrome DevTools Protocol can intercept all requests Clay's frontend makes to its backend. This reveals the full internal API surface -- far more endpoints than what Claymate Lite uses. This is the primary research method for expanding v3 coverage.

### n8n Callback Pattern

The established pattern for async Clay orchestration:
1. POST to Clay webhook with `$execution.resumeUrl` from n8n
2. Clay runs enrichments (takes seconds to minutes)
3. Final HTTP action column in Clay POSTs to that resume URL
4. n8n resumes execution

This turns Clay into a synchronous step in an agentic workflow.

## Product Disambiguation

| Product | URL | What it is | API Status |
|---------|-----|-----------|------------|
| **Clay GTM** | clay.com / app.clay.com | Data enrichment, prospecting, table automation | No public structural API; v1 for rows; v3 internal |
| **Clay Personal CRM** | clay.earth / web.clay.earth | Personal contact/relationship management | Official MCP server (`@clayhq/clay-mcp`), hosted at `mcp.clay.earth/mcp` |
| **Clay Chrome Extension** (official) | Via Clay app | In-browser lead capture workflows | Part of Clay GTM product |
| **Claymate Lite** | github.com/GTM-Base/claymate-lite | Community schema export/import extension | Uses v3 internal API |

The `@clayhq/clay-mcp` npm package and `mcp.clay.earth` MCP server are for the **personal CRM** -- contacts, notes, groups, events. That is a completely different product from the GTM platform we're targeting.
