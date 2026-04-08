# Clay Authentication Reference

Last updated: 2026-04-05

## Authentication Layers

Clay has two distinct authentication mechanisms for its two API surfaces:

| API Surface | Auth Method | Token Type | Scope | Lifetime |
|-------------|-------------|------------|-------|----------|
| v1 API (`api.clay.com/v1`) | API key | Static bearer token | Account-wide (all workspaces) | Permanent until revoked |
| v3 API (`api.clay.com/v3`) | Session cookie (`claysession`) | Express signed session on `.api.clay.com` | Account-wide | **7 days**, auto-refreshes on every call (confirmed INV-007, INV-008) |

## v1 API Key Authentication

> **UPDATE (INV-028, 2026-04-07)**: The v1 API itself is fully deprecated
> (all `api.clay.com/v1/*` paths return 404 "deprecated API endpoint" or
> 503). The `Authorization: Bearer <key>` header still has a live
> middleware on some v3 routes (specifically `Clay-API-Key` returns 403
> vs the universal 401, meaning it's being parsed), but INV-028 could
> not find any v3 route that actually accepts a session-minted key as
> authentication. Use session-cookie auth for everything.

### Obtaining the Key

**Via UI**: Navigate to [app.clay.com/settings](https://app.clay.com/settings) and copy the API key.

**Via API (new, INV-028)**: You can mint API keys directly via the
`POST /v3/api-keys` endpoint under session-cookie auth — no need to
drive the UI. See `knowledge/internal-v3-api.md` → "Clay API Key CRUD"
for the full router (GET/POST/PATCH/DELETE at `/v3/api-keys`). Scopes
include the non-UI-exposed `terracotta:cli`, `terracotta:code-node`,
and `terracotta:mcp` (the last of which hints at an MCP server surface —
GAP-038). Keys are user-owned (`resourceType: 'user'` is the only
enum value); `scope.workspaceId` constrains which workspace the key
can act in.

### Using the Key

```
Authorization: Bearer {CLAY_API_KEY}
```

### In the Lele Backend

The credential system auto-injects the key for any request to `api.clay.com`:

```
URL contains "api.clay.com" → Header: Authorization: Bearer {key}
```

Stored encrypted in `client_credentials` with `integration_slug = 'clay'` and `credential_type = 'api_key'`.

### Validation

On save, the backend validates the key:
```
GET https://api.clay.com/v1/sources
Authorization: Bearer {key}
```

Success = valid key. 401/403 = invalid.

## v3 Session Cookie Authentication

### How Sessions Are Established

1. User navigates to `app.clay.com`
2. User logs in (email/password, Google SSO, or other method)
3. Browser receives session cookies
4. All subsequent requests include cookies via `credentials: 'include'`

### Required Headers

```javascript
{
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'X-Clay-Frontend-Version': window.clay_version || 'unknown',
  // Cookie header set automatically by browser
}
```

The `X-Clay-Frontend-Version` header may be used for API versioning or compatibility checks. Clay may reject requests without it, or it may be optional. Needs testing.

### Server-Side Session Extraction

To use the v3 API from a server, we need to extract session cookies from an authenticated browser session:

1. Launch Playwright (headless or headed)
2. Navigate to `app.clay.com`
3. Authenticate (enter credentials, handle 2FA if needed)
4. Extract cookies via `context.cookies()`
5. Store cookies encrypted (same credential system as API keys)
6. Replay cookies in server-side HTTP requests
7. Re-authenticate when cookies expire (detect via 401 response)

### Cookie Storage Design

Extend the existing credential system:

```
client_credentials:
  integration_slug = 'clay_session'
  credential_type = 'session_cookie'
  encrypted_value = {serialized cookie jar}
  metadata = {
    "extracted_at": "2026-04-05T12:00:00Z",
    "expires_estimate": "...",
    "workspace_id": "12345",
    "user_agent": "..."
  }
```

### Confirmed Answers (INV-007)

1. **Cookie lifetime**: **7 days** from issuance, auto-refreshes on every API call via `set-cookie` header (confirmed INV-007, INV-008). Effectively unlimited with regular usage.
2. **Cookie composition**: Only `claysession` on `.api.clay.com` is required. No other cookies needed.
3. **IP binding**: **NOT IP-bound**. Cookie extracted from user's browser works from AWS server.
4. **Frontend version check**: `X-Clay-Frontend-Version` header is **optional** for most endpoints. Tested without it.
5. **Cookie name/domain**: `claysession` on `.api.clay.com` (NOT `.clay.com` or `app.clay.com`).
6. **Cookie format**: Express/connect-session signed cookie: `s%3A<session_id>.<signature>`.

### Remaining Open Questions

1. ~~**Cookie refresh**: Does the 7-day timer reset on activity, or is it fixed from issuance?~~ **RESOLVED (INV-008)**: Timer resets on every API call via `set-cookie` header. Effectively unlimited lifetime with regular usage.
2. **Multi-session**: Can multiple sessions be active simultaneously?
3. **2FA/SSO handling**: Google 2FA (phone push) blocks full automation. App passwords may work.
4. ~~**Rate limiting per session**: Untested. Using 150ms conservative baseline.~~ **RESOLVED (INV-008, INV-009)**: No rate limiting observed at 50 req/s. The 150ms conservative delay has been proven unnecessary.

These are tracked in `investigations/INV-004_session-durability.md`.

## Webhook Token Authentication

Table webhooks have optional auth tokens:

- Set during webhook creation in the Clay UI
- Token shown only once -- cannot be retrieved later
- Sent as a header in POST requests to the webhook URL
- Per-webhook (not per-account)

Exact header name and format need verification (may be `Authorization: Bearer {token}` or a custom header).
