# System Design: Proprietary Clay API Layer

Last updated: 2026-04-05

## Overview

A four-layer access stack that gives the Lele agent full programmatic read/write/configure access to Clay tables. Each layer covers different capabilities and has different auth/stability tradeoffs.

## Architecture

```
┌─────────────────────────────────────────────────┐
│              Clay Operator Agent                 │
│         (backend/agents/clay_operator/)          │
└─────────────┬───────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────┐
│              Clay API Router                     │
│         (backend/src/clay_api.rs)                │
│                                                  │
│  Selects the appropriate layer for each          │
│  operation. Falls back to lower layers           │
│  on failure.                                     │
└──┬──────────┬──────────┬──────────┬─────────────┘
   │          │          │          │
   ▼          ▼          ▼          ▼
┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
│Layer 1 │ │Layer 2 │ │Layer 3 │ │Layer 4 │
│Official│ │Internal│ │Play-   │ │CDP     │
│v1 API  │ │v3 API  │ │wright  │ │Discov. │
│        │ │Bridge  │ │DOM     │ │        │
│API key │ │Session │ │Session │ │Session │
│auth    │ │cookie  │ │cookie  │ │cookie  │
└────────┘ └────────┘ └────────┘ └────────┘
```

## Layer 1: Official v1 API

**Auth**: API key (from credential store)
**Stability**: High (official, documented)
**Scope**: Row CRUD, enrichment triggers, table metadata

| Operation | Endpoint | Status |
|-----------|----------|--------|
| Read rows | `GET /api/v1/tables/{id}/rows` | Available |
| Add rows | `POST /api/v1/tables/{id}/rows` | Available |
| Trigger enrichment | `POST /api/v1/tables/{id}/trigger` | Available |
| Read table metadata | `GET /api/v1/tables/{id}` | Available |

**Implementation**: Currently uses generic `http_request` tool with auto-injected auth. Target: dedicated typed methods in `clay_api.rs` with proper error handling, retry logic, and rate limiting.

## Layer 2: Internal v3 API Bridge

**Auth**: Session cookies (from session manager)
**Stability**: Medium (internal API, used by Claymate Lite)
**Scope**: Schema CRUD, source management, full structural operations

| Operation | Endpoint | Status |
|-----------|----------|--------|
| Read full table schema | `GET /v3/tables/{tableId}` | **Confirmed** |
| Create column | `POST /v3/tables/{tableId}/fields` | **Confirmed** |
| Update column | `PATCH /v3/tables/{tableId}/fields/{fieldId}` | **Confirmed** (INV-007) |
| Delete column | `DELETE /v3/tables/{tableId}/fields/{fieldId}` | **Confirmed** (INV-007) |
| Read source details | `GET /v3/sources/{sourceId}` | **Confirmed** |
| Create source | `POST /v3/sources` | **Confirmed** |
| Update source | `PATCH /v3/sources/{sourceId}` | **Confirmed** (INV-006) |
| Delete source | `DELETE /v3/sources/{sourceId}` | **Confirmed** (INV-006) |
| Create table | `POST /v3/tables` | **Confirmed** (INV-007) — `{workspaceId, type, name}` |
| Delete table | `DELETE /v3/tables/{tableId}` | **Confirmed** (INV-007) |
| Rename table | `PATCH /v3/tables/{tableId}` | **Confirmed** (INV-007) |
| List tables | `GET /v3/workspaces/{id}/tables` | **Confirmed** (INV-007) |
| Trigger enrichment | `PATCH /v3/tables/{tableId}/run` | **Confirmed** (INV-006) — payload known |
| List actions/providers | `GET /v3/actions?workspaceId=` | **Confirmed** (INV-007) |
| Get user info | `GET /v3/me` | **Confirmed** (INV-007) |
| Get workspace details | `GET /v3/workspaces/{id}` | **Confirmed** (INV-007) |
| List sources | `GET /v3/sources?workspaceId=` | **Confirmed** (INV-007) |
| List imports | `GET /v3/imports?workspaceId=` | **Confirmed** (INV-007) |
| Get frontend version | `GET /v3` | **Confirmed** (INV-006) — no auth needed |
| List auth accounts | `GET /v3/app-accounts` | **Confirmed** (INV-010) — returns all 111 auth accounts |

> **UPDATE (INV-010)**: `GET /v3/app-accounts` provides full enumeration of all auth accounts (authAccountId values). These are no longer per-column-only — agent can look up the correct `authAccountId` for any enrichment provider before creating action columns.

**Implementation**: New `clay_api.rs` module with:
- Typed request/response structs for each endpoint
- Session cookie management (from `clay_session.rs`)
- Automatic retry with cookie refresh on 401
- 150ms minimum delay between calls — **UPDATE (INV-008, INV-009): Zero rate limiting observed at 50 req/s. 150ms baseline was unnecessarily conservative. Use 50ms for safety or remove delays entirely.**
- Fallback to Layer 3 when v3 calls fail

## Layer 3: Playwright DOM Automation

**Auth**: Authenticated browser session
**Stability**: Low (DOM selectors can change)
**Scope**: UI-only operations, formula debugging, error detection

| Operation | Method | Status |
|-----------|--------|--------|
| Read formula from cell | Click cell, read formula bar | Needs selector verification |
| Detect error states | Scan for error CSS classes/aria | Needs selector verification |
| Navigate workbooks | URL-based navigation | Working (URL patterns known) |
| Create workbook | UI automation | Needs investigation |
| Configure enrichment providers | UI automation | Needs investigation |

**Implementation**: New `clay_playwright.rs` module (or TypeScript helper invoked from Rust) that:
- Maintains a persistent browser context with authenticated session
- Exposes high-level operations (read_formula, scan_errors, create_workbook)
- Uses the e2e/ Playwright infrastructure

## Layer 4: CDP Discovery

**Auth**: Authenticated browser session
**Stability**: N/A (research tool)
**Scope**: Discovering new v3 endpoints

Not a production layer -- this is the research harness for expanding Layers 1-3. Instruments a browser session to intercept all API calls, catalogs endpoints, and feeds findings into the endpoint registry.

## Fallback Chain

When the agent needs to perform an operation:

```
1. Try v1 API (if the operation is supported)
   ├── Success → done
   └── Not supported → try v3
2. Try v3 API (if we have a session and the endpoint exists)
   ├── Success → done
   ├── 401 → refresh session, retry once
   └── Not supported → try Playwright
3. Try Playwright automation (if browser context is available)
   ├── Success → done
   └── Failed → fall back to user action
4. Fall back to request_user_action
   └── Agent provides structured instructions for the user to do it manually
```

The key design principle: **never block the agent on a capability gap**. If automated access fails, the agent gracefully degrades to structured human instructions (the current behavior).

## Data Flow

```
┌──────────┐    ┌──────────┐    ┌──────────┐
│ v1 API   │    │ v3 API   │    │Playwright│
│ (rows)   │    │ (schema) │    │ (UI ops) │
└────┬─────┘    └────┬─────┘    └────┬─────┘
     │               │               │
     ▼               ▼               ▼
┌─────────────────────────────────────────┐
│            Clay API Router              │
│                                         │
│  Unified interface for all Clay ops:    │
│  - list_tables()                        │
│  - get_table_schema()                   │
│  - create_field()                       │
│  - read_rows()                          │
│  - write_rows()                         │
│  - trigger_enrichment()                 │
│  - export_schema()                      │
│  - import_schema()                      │
│  - read_formula()                       │
│  - scan_errors()                        │
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│          Clay Operator Agent            │
│                                         │
│  Uses unified Clay API for operations.  │
│  Falls back to request_user_action      │
│  only for truly manual-only tasks.      │
└─────────────────────────────────────────┘
```

## Module Structure (Target)

```
backend/src/
├── clay_api.rs          # Unified Clay API client (v1 + v3)
├── clay_session.rs      # Session cookie management
├── clay_playwright.rs   # Playwright automation layer
└── ...

backend/tools/clay/
├── tool.toml            # Updated tool definition
├── actions.toml         # Updated with new Clay-specific actions
└── ...
```

## Dependencies

- **reqwest** (already in Cargo.toml): For HTTP requests to v1 and v3 APIs
- **Playwright** (already in e2e/): For browser automation and session extraction
- **tokio** (already in Cargo.toml): Async runtime for concurrent operations
- No new external dependencies required for the core implementation
