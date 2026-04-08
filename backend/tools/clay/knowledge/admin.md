# Clay Workspace Admin

Workspace-level metadata: credits, users, billing, features. Most of this is read-only from a regular session cookie.

## Credits and billing

The same `clay_get_workspace` tool you already use returns billing + credit balance inline. Look at `credits.basic` and `credits.actionExecution` on the response. These are real-time — refreshed on every call.

There is no separate `/v3/credits` or `/v3/billing` endpoint that returns more detail than what `clay_get_workspace` already provides. INV-018 confirmed regular session cookies are scoped to one workspace and cannot list credit history.

## Users

| Method | Path | Tool | Notes |
|---|---|---|---|
| GET | `/v3/workspaces/{wsId}/users` | `clay_list_users` | Returns `{users: [{id, username, email, name, profilePicture, fullName, role: {id, name}}]}`. Workspace-scoped — works for regular users (the un-scoped `/v3/users` requires admin auth and 403s). |
| GET | `/v3/me` | (no tool) | Returns the current user record including the API token. Use for credential validation in preflight. |

Use cases for `clay_list_users`:
- Resolving user IDs when assigning resources (table owner, workflow creator, etc.)
- Building handoff messages ("I assigned this to {fullName}…")
- Checking who has access before recommending a sharing action

## Tags (signals & resource tagging)

Clay has a tags subsystem (`/v3/tags`, `/v3/resource-tags`) that powers signals and pivot tables. This is **not yet fully reverse-engineered**. The bundle confirms the routes exist but the request/response shapes haven't been documented in the registry. If a task requires tagging, fall back to `request_user_action` with a manual instruction or use `http_request` against the bundle-discovered paths once they're verified.

A tier-1 placeholder tool (`clay_list_tags`) is registered to surface the capability to the agent, but the implementation is a thin wrapper that may return 404 until the paths are confirmed. Treat its output as advisory.

## Permissions

Workspace permission management (`/v3/permissions`, `/v3/workspaces/{ws}/permissions`) exists in the bundle but most endpoints require admin auth. Regular session cookies cannot grant or revoke permissions. For permission changes, use `request_user_action` to ask the workspace owner to make the change in the Clay UI.

## API key management (informational, not yet wrapped)

`GET/POST/PATCH/DELETE /v3/api-keys[/{id}]` is fully working under session cookie auth (INV-028). Create body: `{name, resourceType: 'user', resourceId: <userId>, scope: {routes: [...], workspaceId?}}`. Returns the plaintext `apiKey` ONCE on create. Scope enum includes `terracotta:cli`, `terracotta:code-node`, `terracotta:mcp`, `endpoints:run-enrichment`, `endpoints:prospect-search-api`, `public-endpoints:all`, `all`. The UI only exposes 3 of 7 scopes — the `terracotta:*` family is direct-API-only.

No tool wrapper today. If a task needs to mint an API key, use `http_request` POST to `/v3/api-keys` and capture the plaintext from the response immediately.

## Import history

`GET /v3/imports?workspaceId={id}` lists past CSV import jobs. Useful for diagnosing "why isn't my data showing up" — the import status tells you if a job failed, succeeded, or is still pending. No tool wrapper today; use `http_request` if needed.
