# Session Management Design

Last updated: 2026-04-05 (post INV-007 — session cookie confirmed)

## Problem

The v3 internal API requires browser session cookies, not API keys. To use v3 from the server, we need to:
1. Authenticate to Clay in a browser
2. Extract session cookies
3. Store them securely
4. Replay them in server-side HTTP requests
5. Detect expiration and re-authenticate

## Session Lifecycle

```
┌────────────────────────────────────────────────────────┐
│  1. AUTHENTICATE                                        │
│                                                         │
│  Playwright launches headless browser                   │
│  → Navigate to app.clay.com                             │
│  → Enter email/password (or SSO flow)                   │
│  → Handle 2FA if needed                                 │
│  → Wait for dashboard to load                           │
│  → Extract cookies via context.cookies()                │
│  → Capture window.clay_version                          │
└────────────────────┬───────────────────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────────────────┐
│  2. STORE                                               │
│                                                         │
│  Serialize cookie jar to JSON                           │
│  Encrypt with AES-256-GCM (same CREDENTIAL_MASTER_KEY) │
│  Store in client_credentials:                           │
│    integration_slug = 'clay_session'                    │
│    credential_type = 'session_cookie'                   │
│    encrypted_value = {serialized cookies}               │
│    metadata = {                                         │
│      extracted_at, clay_version, workspace_id,          │
│      login_method, user_agent                           │
│    }                                                    │
└────────────────────┬───────────────────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────────────────┐
│  3. USE                                                 │
│                                                         │
│  Load cookies from credential store                     │
│  Attach to HTTP requests:                               │
│    Cookie: {serialized cookies}                         │
│    X-Clay-Frontend-Version: {clay_version from metadata}│
│    Accept: application/json                             │
│    Content-Type: application/json                       │
└────────────────────┬───────────────────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────────────────┐
│  4. REFRESH                                             │
│                                                         │
│  On 401 response from v3 API:                           │
│    → Mark current session as expired                    │
│    → Re-run authentication flow                         │
│    → Store new cookies                                  │
│    → Retry the failed request once                      │
│                                                         │
│  Proactive refresh (cookie lifetime = 7 days):          │
│    → Check metadata.cookie_expires                      │
│    → Refresh before expiry (1 hour buffer)              │
│                                                         │
│  UPDATE (INV-008): Session cookie auto-refreshes on     │
│  every API call via set-cookie header. Proactive        │
│  refresh is unnecessary — just use cookies normally     │
│  and handle 401 as fallback.                            │
└────────────────────────────────────────────────────────┘
```

## Cookie Storage Schema

Extends the existing `client_credentials` table:

```sql
-- No migration needed -- reuses existing table structure
-- Just a new integration_slug value

INSERT INTO client_credentials (
  client_id,
  integration_slug,    -- 'clay_session'
  credential_type,     -- 'session_cookie'
  encrypted_value,     -- AES-256-GCM encrypted cookie jar JSON
  metadata             -- JSONB with session metadata
) VALUES (...);
```

Metadata structure:
```json
{
  "extracted_at": "2026-04-05T12:00:00Z",
  "clay_version": "v20260403_221301Z_9894a0108e",
  "workspace_id": "1080480",
  "login_method": "google_sso",
  "cookie_name": "claysession",
  "cookie_domain": ".api.clay.com",
  "cookie_lifetime_days": 7,
  "cookie_expires": "2026-04-12T23:45:57Z",
  "notes": "Only claysession cookie needed. Express session format: s%3A<id>.<sig>. HttpOnly+Secure+SameSite=None."
}
```

## Authentication Methods

### Email/Password (Simplest)

```typescript
await page.goto('https://app.clay.com');
await page.fill('input[type="email"]', email);
await page.fill('input[type="password"]', password);
await page.click('button[type="submit"]');
await page.waitForURL('**/workspaces/**');
```

Requires storing Clay login credentials separately from the API key. Could use:
- Environment variables (`CLAY_EMAIL`, `CLAY_PASSWORD`)
- Additional credential entry in `client_credentials` with `integration_slug = 'clay_login'`

### Google SSO

More complex -- requires handling the Google OAuth redirect:

```typescript
await page.goto('https://app.clay.com');
await page.click('button:has-text("Sign in with Google")');
// Google OAuth page
await page.fill('input[type="email"]', googleEmail);
await page.click('button:has-text("Next")');
await page.fill('input[type="password"]', googlePassword);
await page.click('button:has-text("Next")');
// May require 2FA handling
await page.waitForURL('**/workspaces/**');
```

### Manual Session Seeding

Fallback for complex auth flows (hardware 2FA, SSO with custom IdP):

1. User logs into Clay in a real browser
2. User exports cookies (via browser DevTools or extension)
3. User pastes cookies into Lele settings UI
4. Backend stores and uses them like any other credential

## Credential Relationship

Each Clay account can have TWO credentials:

| Slug | Type | Purpose |
|------|------|---------|
| `clay` | `api_key` | v1 API access (existing) |
| `clay_session` | `session_cookie` | v3 API access (new) |

The Clay API router checks both:
- v1 operations use the `clay` API key credential
- v3 operations use the `clay_session` cookie credential
- If only the API key exists, v3 operations fall back to Playwright or `request_user_action`

## Session Health Check

Before using stored cookies, check if they're still valid:

```rust
async fn check_session_health(cookies: &CookieJar) -> SessionStatus {
    let response = clay_v3_request(
        Method::GET,
        "/v3/tables/t_any_known_table",
        cookies
    ).await;
    
    match response.status() {
        200 => SessionStatus::Valid,
        401 | 403 => SessionStatus::Expired,
        _ => SessionStatus::Unknown,
    }
}
```

Problem: This requires knowing a table ID. Alternative: probe a lightweight endpoint like the workspace list (once we discover it via CDP).

## Concurrency and Session Sharing

- Multiple agent runs for the same client can share the same session cookies
- Cookie reads are non-destructive -- multiple concurrent v3 requests using the same cookies should work
- Session refresh should be serialized (only one refresh at a time per client)
- Use a mutex or database-level lock to prevent concurrent refresh attempts

## Open Questions for Investigation

1. What cookies does Clay set? Names, domains, paths, expiry times?
2. Are sessions IP-bound? Will cookies extracted on one machine work on another?
3. What's the actual session lifetime? Hours, days, weeks?
   **RESOLVED (INV-008)**: Cookie has a 7-day expiry but auto-refreshes on every API call via `set-cookie` response header. Effectively indefinite lifetime as long as the session is used regularly.
4. Does Clay rotate session tokens? If so, do we get new cookies in response headers?
   **RESOLVED (INV-008)**: Yes — every API response includes a `set-cookie` header with a refreshed expiry. The session token value stays the same; only the expiry is extended.
5. Is there a "remember me" mechanism that extends session life?
   **RESOLVED (INV-008)**: The auto-refresh behavior on every call serves this purpose. No separate "remember me" mechanism needed.
6. What happens with concurrent sessions from the same account?
7. Does the `X-Clay-Frontend-Version` header affect session validity?
8. Can we use a lightweight v3 endpoint for health checks without knowing table IDs?
