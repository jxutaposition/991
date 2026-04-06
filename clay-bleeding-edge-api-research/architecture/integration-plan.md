# Integration Plan: Research to Production

Last updated: 2026-04-05

## Overview

This document maps how findings from the research project get promoted into the main Lele codebase. The research folder is self-contained and does not modify production code until findings are validated and ready.

## Promotion Criteria

A finding is ready for promotion when:
1. The endpoint/capability is confirmed working (status: `confirmed` in endpoints.jsonl)
2. It has been tested against at least 2 different tables/workspaces
3. Error handling behavior is documented (what happens on bad input, auth failure, rate limit)
4. It has a corresponding entry in the capability matrix
5. The investigation is marked `completed` with full findings

## Target Files in Main Codebase

### Backend: Clay API Client

**New file**: `backend/src/clay_api.rs`

Unified Clay API client that wraps both v1 and v3 endpoints.

```rust
// Rough structure
pub struct ClayClient {
    api_key: Option<String>,        // For v1 calls
    session_cookies: Option<String>, // For v3 calls
    clay_version: Option<String>,    // For v3 header
    http_client: reqwest::Client,
}

impl ClayClient {
    pub async fn get_table_schema(&self, table_id: &str) -> Result<TableSchema>;
    pub async fn create_field(&self, table_id: &str, field: FieldConfig) -> Result<Field>;
    pub async fn create_source(&self, config: SourceConfig) -> Result<Source>;
    pub async fn read_rows(&self, table_id: &str, params: RowQuery) -> Result<Vec<Row>>;
    pub async fn write_rows(&self, table_id: &str, rows: Vec<Row>) -> Result<usize>;
    pub async fn trigger_enrichment(&self, table_id: &str) -> Result<()>;
    pub async fn export_schema(&self, table_id: &str) -> Result<PortableSchema>;
    pub async fn import_schema(&self, table_id: &str, schema: PortableSchema) -> Result<ImportResult>;
}
```

### Backend: Session Manager

**New file**: `backend/src/clay_session.rs`

Manages v3 session cookies.

```rust
pub struct ClaySessionManager {
    pool: PgPool,
    credential_key: [u8; 32],
}

impl ClaySessionManager {
    pub async fn get_session(&self, client_id: Uuid) -> Result<ClaySession>;
    pub async fn refresh_session(&self, client_id: Uuid) -> Result<ClaySession>;
    pub async fn store_session(&self, client_id: Uuid, cookies: Vec<Cookie>) -> Result<()>;
}
```

### Backend: Tool Definitions

**Modify**: `backend/tools/clay/actions.toml`

Add new Clay-specific actions (see tool-specifications.md for full list).

**Modify**: `backend/tools/clay/tool.toml`

Update tradeoffs:
```toml
[tradeoffs]
automation = "high"          # was "partial"
api_access = "v1_official_v3_internal"  # was "limited"
```

### Backend: Clay Operator Agent

**Modify**: `backend/agents/clay_operator/prompt.md`

Update the opening statement from:
> You have **no API access** to Clay for structural changes

To something like:
> You have **partial API access** to Clay for structural changes via the v3 internal API. Use Clay API tools for column creation, schema export/import, and source management. Fall back to `request_user_action` only for operations not covered by the API (workbook creation, enrichment provider configuration, manual auth setup).

**Modify**: `backend/agents/clay_operator/tools.toml`

Add references to new tools.

**Modify**: `backend/agents/clay_operator/knowledge/clay-reference.md`

Add v3 API reference section and update the "API Access" section to reflect expanded capabilities.

### Backend: Configuration

**Modify**: `backend/src/config.rs`

Add Clay session configuration:
```rust
pub struct ClaySessionConfig {
    pub browser_path: Option<String>,  // Playwright browser binary
    pub login_email: Option<String>,   // For automated login
    pub login_password: Option<String>,
    pub login_method: String,          // "email", "google_sso", "manual"
}
```

### Backend: Credential System

**Modify**: `backend/src/routes.rs`

Add `clay_session` to the integration metadata so the settings UI can display session status.

### Frontend

**Modify**: Settings/integrations page

Add a "Clay Session" section showing:
- Session status (active/expired/not configured)
- Last refresh time
- Manual session seeding option (paste cookies)
- "Refresh session" button

## Promotion Sequence

### Phase 1: Read-Only v3 (Low Risk)

1. Implement `clay_api.rs` with `get_table_schema()` and `export_schema()`
2. Add `clay_get_table` and `clay_export_schema` tools
3. Update clay_operator to use these for reading table structure
4. No session management needed yet -- manual cookie seeding only

### Phase 2: Write v3 (Medium Risk)

1. Add `create_field()`, `create_source()`, `import_schema()` to clay_api.rs
2. Add corresponding tools
3. Implement session management (cookie extraction, storage, refresh)
4. Update clay_operator to use write tools with fallback chain
5. Extensive testing on scratch tables

### Phase 3: Playwright Layer (Higher Risk)

1. Implement `clay_playwright.rs` for DOM operations
2. Add `clay_read_formula` and `clay_scan_errors` tools
3. Only if v3 + v1 prove insufficient for formula debugging

### Phase 4: Full Integration

1. Update clay_operator prompt to reflect full capability
2. Remove most `request_user_action` calls for structural operations
3. Add monitoring for v3 API stability (integration tests)
4. Document the full capability matrix for the team

## What Stays in Research

- Harness scripts and prompts (for ongoing discovery)
- Investigation logs (historical research record)
- CDP interception tooling (for discovering new endpoints)
- Sample schemas and fixtures (test data)

## What Gets Deleted After Promotion

Nothing -- the research folder remains as the canonical reference for the reverse-engineering effort. It continues to serve as:
- The investigation harness for discovering new endpoints
- The tracking system for capability gaps
- The documentation hub for the internal API
