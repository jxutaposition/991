# Error System Design

## Architecture

Two-layer error model with a clear internal/public boundary.

### Layer 1: InternalError (backend only)
- Carries the full causal chain for debugging
- Logged via `tracing::error!` with structured fields
- NEVER sent to the frontend
- Wraps an `ApiError` (public face) + optional `anyhow::Error` (internal cause)

### Layer 2: ApiError (public envelope)
- The ONLY shape the frontend ever receives
- Always JSON: `{"code": "...", "error": "...", "details": ...}`
- `code`: stable machine-readable string (e.g. "preflight_failed") — frontend switches on this
- `error`: human-readable message safe to display to end users
- `details`: optional structured JSON metadata (field errors, failed integrations, etc.)

### The Boundary

`IntoResponse` is the conversion boundary. When axum serializes `InternalError`:
1. The full internal chain is logged (`tracing::error!`)
2. Only the `ApiError` envelope is returned as the HTTP response

```
Internal world                    Public world
─────────────                     ────────────
anyhow::Error ──▶ InternalError ──▶ tracing::error!(full chain)
                  {                  HTTP response:
                    public: ApiError   {"code": "...",
                    source: anyhow      "error": "...",
                  }                     "details": {...}}
```

### Source code

All types, traits, and macros are in `backend/src/error.rs`.

## Rules

### R1: Never leak internals to the frontend

- DB connection details, file paths, stack traces, internal state → NEVER in `ApiError.message`
- Use generic messages for 500s: "An internal error occurred"
- Specific messages only for client errors (400, 404, 422) where the user can act on it

### R2: Every error has a stable `code`

- Codes are `snake_case` strings: "not_found", "preflight_failed", "invalid_input"
- Codes are part of the API contract — don't rename them without frontend coordination
- Frontend uses `code` for programmatic handling (showing specific UI, retry logic, etc.)

### R3: Use the right pattern for the situation

| Situation | Pattern | Example |
|-----------|---------|---------|
| User sent bad input | `ApiError::bad_request(...)` | Missing required field |
| Resource doesn't exist | `ApiError::not_found(...)` | Agent slug not in catalog |
| Validation failed with details | `ApiError::unprocessable(...).with_details(json!({...}))` | Preflight probe failures |
| Internal code failed | `?` operator (auto-converts `anyhow::Error`) | DB query, LLM call, file I/O |
| Internal failure with custom public msg | `InternalError::new(ApiError::new(...), source)` | LLM timeout -> "Agent execution timed out" |
| Quick early return | `api_bail!(STATUS, "code", "message")` | Guard clauses |

### R4: Log at the boundary, not at every call site

- `InternalError::into_response()` handles logging automatically
- Do NOT manually log errors that will be returned as `InternalError` — it causes duplicate logs
- DO log errors in fire-and-forget/background contexts (work_queue, event handlers) where there is no HTTP response boundary

### R5: `details` is for structured, actionable metadata

- Field validation errors: `{"fields": {"email": "required", "name": "too_long"}}`
- Preflight failures: `{"failed_integrations": [{"slug": "apollo", "hint": "..."}]}`
- Rate limits: `{"retry_after_seconds": 30}`
- Do NOT dump raw error objects into details

### R6: Error codes are namespaced by domain when useful

- General: "not_found", "bad_request", "unauthorized", "internal_error"
- Execution: "preflight_failed", "agent_not_found", "execution_timeout"
- Auth: "token_expired", "session_revoked", "invalid_credentials"
- Credentials: "credential_missing", "credential_invalid", "encryption_unavailable"

## Error Code Catalog

| Code | Status | When | Public message guidance |
|------|--------|------|------------------------|
| `not_found` | 404 | Resource doesn't exist | "Agent '{slug}' not found" |
| `bad_request` | 400 | Malformed input | Describe what's wrong specifically |
| `invalid_input` | 400 | Input fails validation | Include which field and why |
| `unauthorized` | 401 | Missing/invalid auth | "Authentication required" |
| `token_expired` | 401 | JWT expired | "Session expired, please sign in again" |
| `forbidden` | 403 | Insufficient permissions | "You don't have access to this resource" |
| `validation_failed` | 422 | Business logic validation | Describe what failed + details |
| `preflight_failed` | 422 | Credential probes failed | "Credential checks failed" + details with per-integration hints |
| `credential_missing` | 422 | Required cred not configured | "Required integration '{slug}' is not configured" |
| `execution_timeout` | 504 | Agent/tool took too long | "Execution timed out" |
| `unavailable` | 503 | Service not configured | "Credential encryption not configured" |
| `internal_error` | 500 | Catch-all for unexpected failures | "An internal error occurred" (never more specific) |

## Usage Examples

### Pattern 1: Public error — user did something wrong

```rust
async fn get_agent(...) -> Result<Json<Value>, InternalError> {
    let agent = catalog.get(&slug)
        .ok_or_else(|| ApiError::not_found(format!("Agent '{slug}' not found")))?;
    //             ^ ApiError auto-converts to InternalError via From
    Ok(Json(json!({...})))
}
```

### Pattern 2: Internal error — something broke, generic public message

```rust
async fn create_session(...) -> Result<Json<Value>, InternalError> {
    let plan = planner::plan_execution(&req, &catalog, &key, &model)
        .await?;  // anyhow::Error auto-converts to InternalError (500)
    Ok(Json(json!({...})))
}
```

### Pattern 3: Internal error with custom public message

```rust
async fn approve_execution(...) -> Result<Json<Value>, InternalError> {
    let probes = preflight::probe_integrations(&creds, Some(&settings)).await;
    let failed: Vec<_> = probes.iter().filter(|p| !p.success()).collect();
    if !failed.is_empty() {
        return Err(InternalError::from(
            ApiError::unprocessable("Credential checks failed for required integrations")
                .with_details(json!({
                    "failed": failed.iter().map(|p| json!({
                        "integration": p.integration_slug,
                        "status": p.status.as_str(),
                        "hint": p.hint,
                    })).collect::<Vec<_>>()
                }))
        ));
    }
    Ok(Json(json!({...})))
}
```

### Pattern 4: api_bail! macro for quick returns

```rust
async fn update_agent(...) -> Result<Json<Value>, InternalError> {
    if slug.is_empty() {
        api_bail!(BAD_REQUEST, "invalid_slug", "Agent slug cannot be empty");
    }
    // ...
}
```

### Pattern 5: Internal error with custom public message and source chain

```rust
async fn run_llm(...) -> Result<Json<Value>, InternalError> {
    let resp = client.messages(...).await.map_err(|e| {
        InternalError::new(
            ApiError::new(StatusCode::BAD_GATEWAY, "llm_failed", "LLM call failed"),
            e,
        )
    })?;
    Ok(Json(json!({...})))
}
```

## Anti-patterns

- `return Err(StatusCode::INTERNAL_SERVER_ERROR)` — no error body, frontend can't handle it
- `return Err((StatusCode::BAD_REQUEST, Json(json!({"error": e.to_string()}))))` — leaks internal errors, inconsistent shape
- `tracing::error!(...); return Err(InternalError::new(...))` — double logging (IntoResponse already logs)
- `.unwrap()` in route handlers — panics crash the request with no error response
- Error codes with spaces or mixed case — always `snake_case`

## Adding a New Error Code

1. Add the code to the catalog table above
2. Use it in the route handler via `ApiError::new(status, "your_code", message)`
3. Coordinate with frontend if they need to handle it programmatically
4. If it's a common pattern, add a convenience constructor on `ApiError`

## Logging Level Strategy

| Level | When | Example |
|-------|------|---------|
| `error!` | Data loss possible, requires attention | DB write failure, credential decryption failure |
| `warn!` | Unexpected but recoverable | LLM call retry, critic/judge failed, stale node recovery |
| `info!` | Significant business events, 1 per stage | Node started/completed, tool invoked, session completed |
| `debug!` | Operational detail for debugging | Prompt length, credential slugs, HTTP response details |
| `trace!` | Very fine-grained, per-module enable | SSE events, message persistence, DB query timings |

### Environment variable

```bash
# Default (development)
RUST_LOG=lele2_backend=debug,tower_http=info

# Production (quiet)
RUST_LOG=lele2_backend=info,tower_http=warn

# Debugging a specific module
RUST_LOG=lele2_backend::agent_runner=trace,lele2_backend=info
```
