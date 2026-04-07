# Security Backlog

> Generated 2026-04-01. Do not commit this file to a public repo.

---

## SEC-001: Replace string-interpolated SQL with parameterized queries
**Priority:** Critical
**Component:** backend/src/credentials.rs, backend/src/oauth.rs
**Risk:** SQL injection — all credential and OAuth queries use `format!()` with manual `'` escaping instead of prepared statements.
**Affected functions:**
- `credentials.rs`: `upsert_credential()`, `list_credentials()`, `delete_credential()`, `load_credentials_for_client()`
- `oauth.rs`: `start_authorize()`, `handle_callback()`, `refresh_if_needed()`
**Fix:** Switch to sqlx parameterized queries (`$1`, `$2` bindings) or use the `query!` / `query_as!` macros. This is a drop-in replacement — same logic, safe bindings.
**Effort:** Medium (1-2 days)

---

## SEC-002: Per-client key derivation from master key
**Priority:** High
**Component:** backend/src/credentials.rs
**Risk:** Single `CREDENTIAL_MASTER_KEY` decrypts all clients' credentials. A leak compromises every client.
**Fix:** Derive a per-client encryption key: `client_key = HMAC-SHA256(master_key, client_id)`. Use `client_key` for encrypt/decrypt instead of master_key directly. Requires a one-time re-encryption migration.
**Effort:** Medium (1-2 days + migration script)

---

## SEC-003: Master key rotation support
**Priority:** High
**Component:** backend/src/credentials.rs
**Risk:** No way to rotate the master key without losing access to all encrypted credentials.
**Fix:** Add a `key_version` column to `client_credentials`. On rotation: new credentials use new key, background job re-encrypts old credentials. Support decrypting with either key during transition.
**Effort:** Medium-High (2-3 days)

---

## SEC-004: Move master key to a secret manager
**Priority:** High
**Component:** deployment / infrastructure
**Risk:** `CREDENTIAL_MASTER_KEY` lives in `.env` on disk. If the server is compromised, the key and DB are co-located.
**Fix:** Store in AWS Secrets Manager, HashiCorp Vault, or GCP Secret Manager. Fetch at boot time. Rotate via secret manager's built-in rotation.
**Effort:** Low-Medium (0.5-1 day, depends on infra)

---

## SEC-005: Restrict CORS to known origins
**Priority:** High
**Component:** backend/src/main.rs
**Risk:** `CorsLayer::permissive()` allows any website to make authenticated API calls if a user's token is stolen via XSS.
**Fix:** Replace with explicit allowed origins matching your frontend domain(s). Example: `CorsLayer::new().allow_origin("https://app.lele.dev".parse())`.
**Effort:** Low (30 min)

---

## SEC-006: Move JWT from localStorage to HttpOnly cookies
**Priority:** Medium
**Component:** frontend/src/lib/auth-context.tsx, backend/src/routes.rs (auth middleware)
**Risk:** localStorage is accessible to any JavaScript on the page. An XSS vulnerability would leak the auth token.
**Fix:** Set JWT as `HttpOnly; Secure; SameSite=Strict` cookie from the backend. Remove `localStorage.setItem("99percent_token", ...)` from frontend. Auth middleware reads from cookie header instead of `Authorization` header.

**Credential rotation (2026):** Supabase URLs/keys and a Clay API key were once committed in `backend/tools/lovable/lovable-skill.md` (removed). Rotate those Supabase and Clay credentials if that revision was ever pushed or shared.
**Effort:** Medium (1 day — touches both frontend and backend auth flow)

---

## SEC-007: Add credential access audit logging
**Priority:** Medium
**Component:** backend/src/credentials.rs, backend/src/agent_runner.rs
**Risk:** No visibility into who decrypted which credentials and when. Cannot detect unauthorized access or investigate breaches.
**Fix:** Log (to DB or structured log) every `load_credentials_for_client()` call with: timestamp, client_id, integration_slugs accessed, calling context (agent execution node_id or API route). Do NOT log decrypted values.
**Effort:** Low (0.5 day)

---

## SEC-008: Enforce HTTPS with Strict-Transport-Security
**Priority:** Medium
**Component:** backend/src/main.rs (middleware)
**Risk:** API keys sent over HTTP in dev/staging could be intercepted.
**Fix:** Add `Strict-Transport-Security: max-age=31536000; includeSubDomains` response header in production. Optionally reject non-HTTPS requests at the app level.
**Effort:** Low (30 min)

---

## SEC-009: Rate-limit credential endpoints
**Priority:** Low
**Component:** backend/src/routes.rs
**Risk:** No rate limiting on credential storage/retrieval endpoints. Brute-force or credential stuffing attacks possible.
**Fix:** Add rate limiting middleware (e.g., `tower::limit`) on `/api/clients/*/credentials` and `/api/oauth/*` routes. Suggested: 10 req/min per client.
**Effort:** Low (1 hour)

---

## SEC-010: Credential value size validation
**Priority:** Low
**Component:** backend/src/routes.rs (set_credential handler)
**Risk:** No validation on credential value size. Extremely large payloads could cause memory issues during encryption.
**Fix:** Validate credential value length (max 10KB) before encrypting. Return 400 if exceeded.
**Effort:** Low (30 min)
