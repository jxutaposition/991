# SD-002: Integrations and Credentials

## Decision

External integrations (Clay, n8n, HubSpot, Notion, etc.) are the connective tissue of every automation stack Lele builds. Credentials for these integrations must be:

- **Per-client isolated** — each workspace gets its own set of keys
- **Encrypted at rest** — AES-256-GCM, never stored in plaintext
- **Validated on save** — bad keys are rejected before storage
- **Ownership-tracked** — distinguish agency-provided (temporary) keys from client-owned (permanent) keys
- **Handoff-ready** — a client can take full ownership of their automation stack without depending on Lele's keys

## Integration Registry

Every supported integration is defined in `integration_metadata()` in `backend/src/routes.rs` and served via `GET /api/integrations`.

| Slug | Name | Auth Method | Validation Endpoint | Key Scope | Key URL | OAuth Possible? |
|------|------|-------------|---------------------|-----------|---------|-----------------|
| `tavily` | Tavily | API key | `GET api.tavily.com/usage` | Per-account | [app.tavily.com/home](https://app.tavily.com/home) | No |
| `apollo` | Apollo | API key | `GET api.apollo.io/v1/auth/health` | Per-org | [developer.apollo.io/keys](https://developer.apollo.io/keys/) | No |
| `clay` | Clay | API key | `GET api.clay.com/v1/sources` | Per-account (all workspaces) | [app.clay.com/settings](https://app.clay.com/settings) | No |
| `n8n` | n8n | API key | `GET {base_url}/api/v1/workflows?limit=1` | Per-instance | _(instance-specific)_ | No |
| `tolt` | Tolt | API key | `GET api.tolt.com/v1/programs` | Per-org | [app.tolt.io/settings?tab=integrations](https://app.tolt.io/settings?tab=integrations) | No |
| `supabase` | Supabase | API key | `GET {project_url}/rest/v1/` | Per-project | [supabase.com/dashboard/projects](https://supabase.com/dashboard/projects) | No |
| `notion` | Notion | OAuth2 | `GET api.notion.com/v1/users/me` | Per-authorized-workspace | [notion.so/profile/integrations](https://www.notion.so/profile/integrations) | Yes |
| `hubspot` | HubSpot | OAuth2 | `GET api.hubapi.com/crm/v3/objects/contacts?limit=1` | Per-authorized-portal | [app.hubspot.com/private-apps](https://app.hubspot.com/private-apps/) | Yes |
| `google` | Google | OAuth2 | _(via OAuth flow)_ | Per-authorized-account | [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials) | Yes |
| `meta` | Meta Ads | OAuth2 | _(via OAuth flow)_ | Per-authorized-account | [developers.facebook.com/apps](https://developers.facebook.com/apps/) | Yes |
| `slack` | Slack | OAuth2 | _(via OAuth flow)_ | Per-authorized-workspace | [api.slack.com/apps](https://api.slack.com/apps) | Yes |

### Extra fields

Some integrations require additional non-secret metadata alongside the API key:

- **n8n**: `base_url` — the URL of the self-hosted or cloud n8n instance
- **Supabase**: `project_url` — the Supabase project URL (e.g. `https://abc.supabase.co`)

These are declared via `extra_fields` in the integration registry and stored in the credential's `metadata` JSONB column.

## Auth Methods

### Tier 1: OAuth2 (1-click connect)

Supported for: Notion, HubSpot, Google, Meta, Slack.

The user clicks "Connect {Service}", is redirected to the service's authorization page, grants access, and is bounced back. No manual key handling.

**Requirements to enable:**
1. Register a public/developer app with the service
2. Set the redirect URI to `{OAUTH_REDIRECT_BASE_URL}/api/oauth/{provider}/callback`
3. Set `{PROVIDER}_OAUTH_CLIENT_ID` and `{PROVIDER}_OAUTH_CLIENT_SECRET` env vars

**Flow:**
```
User clicks "Connect Notion"
  → Backend generates authorize URL with state token (CSRF protection)
  → Browser redirects to api.notion.com/v1/oauth/authorize
  → User grants access, picks workspace/pages
  → Notion redirects to /api/oauth/notion/callback?code=xxx&state=yyy
  → Backend exchanges code for access_token + refresh_token
  → Tokens encrypted and stored in client_credentials
  → User redirected back to settings page with ?status=connected
```

**Token refresh:** `oauth::refresh_if_needed()` runs before every agent execution. Tokens are refreshed 5 minutes before expiry. New refresh tokens (if issued) are stored automatically.

**OAuth fallback:** When OAuth env vars are not configured, the UI falls back to a manual token paste input with a link to the service's integration creation page. The backend sets `oauth_configured: false` in the integration metadata, and the frontend renders the paste UI instead of the connect button.

### Tier 2: API key paste

Used for: Tavily, Apollo, Clay, n8n, Tolt, Supabase.

These services only offer static API keys — there is no OAuth authorization server to redirect to. The user pastes their key, the backend validates it against the service, encrypts it, and stores it.

## Credential Lifecycle

### Storage

```
client_credentials
├── id              UUID (PK)
├── client_id       UUID (FK → clients, CASCADE delete)
├── integration_slug TEXT
├── credential_type  TEXT ('api_key' | 'oauth2' | 'basic_auth' | 'bearer_token')
├── encrypted_value  BYTEA (AES-256-GCM: 12-byte nonce || ciphertext || 16-byte tag)
├── metadata         JSONB (non-secret: scopes, account name, expiry, project_url, etc.)
├── created_at       TIMESTAMPTZ
├── updated_at       TIMESTAMPTZ
└── UNIQUE(client_id, integration_slug)
```

Encryption uses a 256-bit master key (`CREDENTIAL_MASTER_KEY` env var, 64 hex chars). Each credential gets a random 12-byte nonce. Decryption happens in-memory at agent runtime — plaintext never hits disk or logs.

### Validation on save

When a key is submitted via `POST /api/clients/:slug/credentials`, the backend makes a lightweight read-only API call to the service before storing. Three outcomes:

| Result | HTTP Response | What happens |
|--------|--------------|--------------|
| **Validated** | `200 {"ok": true, "validated": true}` | Key verified, encrypted, stored. UI shows "Verified" badge. |
| **Skipped** | `200 {"ok": true, "validated": false}` | Key stored but could not be verified (e.g. n8n with no base_url). UI shows "Unverified" badge. |
| **Failed** | `422 {"error": "Invalid Clay API key"}` | Key rejected, not stored. UI shows error message. |

Validation is skipped (not failed) when:
- The integration slug has no known validation endpoint (future integrations)
- A required URL is missing (n8n without `base_url`, Supabase without `project_url`)

### OAuth token refresh

For `credential_type = 'oauth2'`, the agent runner calls `oauth::refresh_if_needed()` before each execution:
1. Checks `metadata.refreshed_at` + `metadata.expires_in` against current time
2. If token expires within 5 minutes, calls the provider's token URL with the stored refresh token
3. Stores the new access token (and new refresh token if issued) back to the database
4. If no refresh token exists or refresh fails, logs a warning and proceeds with the existing token

### Deletion

- Manual: user clicks "Disconnect" → `DELETE /api/clients/:slug/credentials/:integration_slug`
- Cascade: deleting a client (`DELETE FROM clients`) cascades to all its credentials

### Credential injection at runtime

In `tools::execute_tool`, the `http_request` tool auto-injects credentials based on URL pattern matching:

| URL contains | Header injected |
|-------------|-----------------|
| `api.hubapi.com` | `Authorization: Bearer {token}` |
| `api.notion.com` | `Authorization: Bearer {token}`, `Notion-Version: 2022-06-28` |
| `api.clay.com` | `Authorization: Bearer {key}` |
| `supabase.co` | `apikey: {key}`, `Authorization: Bearer {key}` |
| `api.tolt.io` | `Authorization: Bearer {key}` |
| `*.n8n.*` | `X-N8N-API-KEY: {key}` |
| `graph.facebook.com` | `Authorization: Bearer {token}` |
| `googleapis.com` | `Authorization: Bearer {token}` |
| `slack.com/api` | `Authorization: Bearer {token}` |
| `api.apollo.io` | `x-api-key: {key}` |

For OAuth2 credentials, the token is extracted from the JSON value (`{"access_token": "...", "refresh_token": "..."}`). For API keys, the value is used directly.

Agent-provided `Authorization` headers are never overwritten — the auto-injection only fires when the agent did not set its own auth header.

## Credential Ownership Model

> **Status: Planned — not yet implemented.**

### Problem

During the build phase, Lele uses their own keys (Clay, Tavily, Apollo) alongside client-specific keys (Supabase, OAuth grants). At handoff, the client needs to replace agency keys with their own. Today there is no way to tell which keys belong to whom.

### Solution

Add an `owner` column to `client_credentials`:

```sql
ALTER TABLE client_credentials
  ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT 'agency';
-- 'agency' = Lele-provided key (temporary, needs replacement at handoff)
-- 'client' = client's own key (permanent, safe to keep)
```

Rules:
- When an `admin`-role user saves a credential, `owner` defaults to `'agency'` (can be overridden)
- When a `member`-role user saves a credential, `owner` is forced to `'client'`
- OAuth2 grants are always `owner = 'client'` (the client authorized their own account)

### Global env-var fallback

Agency-level keys that are used across all clients should live in `.env`, not be pasted per-workspace:

| Env var | Service | Purpose |
|---------|---------|---------|
| `TAVILY_API_KEY` | Tavily | Web search (already implemented) |
| `CLAY_API_KEY` | Clay | Data enrichment during build |
| `APOLLO_API_KEY` | Apollo | Contact lookup during build |

The credential loading path (`load_credentials_for_client`) checks the client-specific credential first. If none exists, it falls back to the env var. This means:
- During build: agency keys from `.env` are used automatically — no per-client paste needed
- At handoff: client pastes their own key, which takes precedence over the env var

## Handoff Flow

> **Status: Planned — not yet implemented.**

```
┌─────────────────────────────────────────────────────┐
│  Build Phase                                         │
│  ├─ Agency keys from .env (Clay, Tavily, Apollo)    │
│  ├─ Client's Supabase project key                   │
│  └─ Client's OAuth grants (Notion, HubSpot)         │
└────────────────────┬────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────┐
│  Handoff Check: GET /api/clients/:slug/handoff-status│
│  ├─ agency_owned: ["clay", "tavily"]                │
│  ├─ client_owned: ["supabase", "notion", "hubspot"] │
│  ├─ missing: []                                     │
│  └─ ready: false                                    │
└────────────────────┬────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────┐
│  Client Replaces Agency Keys                         │
│  ├─ Client pastes their own Clay key → owner=client │
│  ├─ Client pastes their own Tavily key → owner=client│
│  └─ All credentials now owner=client                │
└────────────────────┬────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────┐
│  Handoff Complete                                    │
│  └─ ready: true — client operates independently     │
└─────────────────────────────────────────────────────┘
```

The handoff-status endpoint returns:

```json
{
  "ready": false,
  "total_integrations": 6,
  "client_owned": 4,
  "agency_owned": 2,
  "agency_credentials": ["clay", "tavily"],
  "missing": []
}
```

The frontend shows a banner: "2 of 6 integrations use agency keys — not ready for handoff" with each agency-owned credential highlighted in amber.

## Role-Based Access

> **Status: Planned — not yet implemented. `check_client_role` exists in `auth.rs` but is not wired to credential routes.**

### Roles (from `user_client_roles` table)

| Role | Level | Credential permissions |
|------|-------|----------------------|
| `admin` | 3 | Full CRUD. Can set `owner` to either `'agency'` or `'client'`. Sees all credentials. |
| `member` | 2 | Can save and delete credentials. `owner` forced to `'client'`. Cannot see decrypted value of agency-provided keys. |
| `viewer` | 1 | Read-only. Can see which integrations are connected. Cannot modify or view key values. |

### Route protection

Credential CRUD routes must be moved behind `auth_middleware`. Current state: they are **not** behind JWT auth (see `main.rs` lines 152-155).

Required changes:
- `GET /api/clients/:slug/credentials` → requires `viewer` role
- `POST /api/clients/:slug/credentials` → requires `member` role
- `DELETE /api/clients/:slug/credentials/:slug` → requires `member` role
- `GET /api/clients/:slug/credential-check` → requires `viewer` role
- `GET /api/clients/:slug/handoff-status` → requires `viewer` role
- `GET /api/oauth/:provider/authorize` → requires `member` role
- `GET /api/oauth/:provider/callback` → no auth (incoming redirect from provider)

## Service-Specific Notes

### n8n
Self-hosted or n8n Cloud. No fixed URL — `base_url` is a required extra field (e.g. `https://my-company.app.n8n.cloud`). Without it, validation is skipped (key is stored unverified). The credential value may be a JSON blob: `{"api_key": "...", "base_url": "..."}`.

### Supabase
Each client gets their own Supabase project. `project_url` is a required extra field. The API key is the `anon`/`service_role` key from the project's API settings. Credential injection matches any URL containing `supabase.co`.

### Clay
Account-scoped key — one key covers all workspaces within a Clay account. No OAuth support. No workspace selection after connection. If an agency and client both need access, each needs their own Clay account.

### Notion
Supports OAuth2 **only via public integrations**. Internal integrations (the default when you create one) only produce a static token — they cannot be used for the OAuth redirect flow. To enable 1-click OAuth, create a **public** integration at [notion.so/profile/integrations](https://www.notion.so/profile/integrations) and set `NOTION_OAUTH_CLIENT_ID` / `NOTION_OAUTH_CLIENT_SECRET`.

### Tavily
Has a global env-var fallback (`TAVILY_API_KEY`). This is the only integration where the global fallback is currently implemented. The credential check endpoint special-cases Tavily: if the env var is set, Tavily is not reported as "missing" even without a client-specific key.

## Env Vars Reference

### Encryption and routing

| Var | Required? | Description |
|-----|-----------|-------------|
| `CREDENTIAL_MASTER_KEY` | Yes (for credentials) | 64 hex chars (32 bytes). AES-256-GCM key for encrypting stored credentials. |
| `OAUTH_REDIRECT_BASE_URL` | Yes (for OAuth) | Base URL of the backend (e.g. `https://api.lele.dev`). Used to construct callback URLs: `{base}/api/oauth/{provider}/callback`. |
| `JWT_SECRET` | Yes (for auth) | Secret for signing JWT tokens. If unset, auth middleware passes through unauthenticated. |

### OAuth provider credentials

| Var | Service |
|-----|---------|
| `NOTION_OAUTH_CLIENT_ID` / `NOTION_OAUTH_CLIENT_SECRET` | Notion |
| `HUBSPOT_OAUTH_CLIENT_ID` / `HUBSPOT_OAUTH_CLIENT_SECRET` | HubSpot |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Google |
| `META_OAUTH_CLIENT_ID` / `META_OAUTH_CLIENT_SECRET` | Meta (Facebook) |
| `SLACK_OAUTH_CLIENT_ID` / `SLACK_OAUTH_CLIENT_SECRET` | Slack |

When a pair is unset, the corresponding integration falls back to manual token paste in the UI.

### Global agency key fallbacks

| Var | Service | Status |
|-----|---------|--------|
| `TAVILY_API_KEY` | Tavily | Implemented |
| `CLAY_API_KEY` | Clay | Planned |
| `APOLLO_API_KEY` | Apollo | Planned |

These are used when no client-specific credential exists. Client-specific credentials always take precedence.

## API Endpoints

| Method | Path | Auth | Role | Description |
|--------|------|------|------|-------------|
| `GET` | `/api/integrations` | None | — | List all integrations with metadata, key URLs, OAuth status |
| `GET` | `/api/clients/:slug/credentials` | JWT | viewer | List connected credentials for a workspace (no secret values) |
| `POST` | `/api/clients/:slug/credentials` | JWT* | member | Save a credential (validates, encrypts, stores) |
| `DELETE` | `/api/clients/:slug/credentials/:integration` | JWT* | member | Disconnect an integration |
| `GET` | `/api/clients/:slug/credential-check?agents=...` | JWT* | viewer | Check which agents have missing credentials |
| `GET` | `/api/clients/:slug/handoff-status` | JWT | viewer | Handoff readiness summary (planned) |
| `GET` | `/api/oauth/:provider/authorize` | JWT* | member | Generate OAuth authorize URL, redirect user |
| `GET` | `/api/oauth/:provider/callback` | None | — | OAuth callback from provider (exchanges code for token) |

_* Currently not behind auth middleware — migration planned._

## Acceptance Criteria

### Implemented

- [x] Per-client credential isolation (`UNIQUE(client_id, integration_slug)`)
- [x] AES-256-GCM encryption at rest with random nonces
- [x] OAuth2 authorize/callback flow (Notion, HubSpot, Google, Meta, Slack)
- [x] Automatic OAuth token refresh before agent runs
- [x] API key validation on save (per-service health check calls)
- [x] Validated / Unverified badge in UI
- [x] Direct "get your key" links per service in the settings UI
- [x] OAuth fallback to manual token paste when env vars not configured
- [x] Global Tavily key fallback via `TAVILY_API_KEY` env var

### Deferred

- [ ] `owner` column on `client_credentials` (agency vs client) — deferred, no timeline
- [ ] Handoff readiness endpoint (`GET /api/clients/:slug/handoff-status`) and UI banner — deferred
- [ ] Role-based access control on credential routes — **security gap**: credential CRUD routes are still not behind auth middleware (see note in Route protection section)
- [ ] Global env-var fallback for Clay (`CLAY_API_KEY`) and Apollo (`APOLLO_API_KEY`) — deferred, only Tavily has this
- [ ] `extra_fields` UI inputs (project_url for Supabase, base_url for n8n) — deferred
- [ ] Client self-serve credential management (member-role access) — deferred
