# INV-028: API-key auth for `postWebhookBatch` + productized inbound webhook channel

**Status**: completed (GAP-036 closed as "resolved-by-elimination", see findings)
**Priority**: P2
**Gap**: GAP-036
**Date started**: 2026-04-07
**Date completed**: 2026-04-07

## Hypothesis

INV-027 found that `POST /v3/tc-workflows/streams/{streamId}/webhook/batch`
returned `403 "You must be logged in"` under session-cookie auth, despite
the canonical body shape from the bundle (`{items:[{entityId?,backfillId?,
requestData}]}`). Hypothesis: the batch variant is Clay's
productized, API-key-authenticated high-throughput inbound channel and we
just need to mint a workspace API key and bearer it. Secondary hypothesis:
the non-`/v3` `webhookUrl` form (`https://api.clay.com/tc-workflows/streams/
{id}/webhook`) — which INV-027 only probed under cookies and got 404 — is
where API-key auth routes.

Both hypotheses turned out to be **wrong in interesting ways**. See Findings.

## Method

### 1. Bundle scan for API-key management

Bundle hash unchanged since INV-027: `index-BS8vlUPJ.js` (resolved from
`https://app.clay.com/` HTML). Scanned for
`apiKey|api_key|createApiKey|getApiKeys|deleteApiKey|Bearer|x-api-key|
x-clay-api-key|accessToken|personalAccessToken`.

Hits (first positions, offsets in bundle):

| Token | Count | Notes |
|---|---|---|
| `apiKey` | 28 | mostly the `CRe` response type `qb.extend({apiKey:v_})` |
| `createApiKey` | 4 | router def + SWR hook + form handler |
| `getApiKeys` | 5 | router def + SWR hook + modal |
| `deleteApiKey` | 4 | router def + SWR hook |
| `ApiKey` | 41 | component names, type refs |
| `clay-api-key` | 1 | feature flag `enable-new-clay-api-keys` (not a header) |
| `x-api-key` / `x-clay-api-key` | 0 | **not in bundle** |
| `accessToken` | 3 | unrelated (impersonation token logic) |
| `personalAccessToken` | 0 | **not in bundle** |
| `Bearer` | 3 | Segment analytics, not API auth |

### 2. API-key router extracted

Router object `TRe` at offset ~512020, mounted as `apiKeys:TRe` in the
client router map (offset ~838019). All routes under global base
`https://api.clay.com/v3`:

```ts
TRe = {
  getApiKeys: {
    method: 'GET', path: '/api-keys',
    query: { resourceType: Gb, resourceId: string },
    200: ApiKey[],
  },
  createApiKey: {
    method: 'POST', path: '/api-keys',
    body: {
      resourceType: Gb,                // enum: Gb.User = 'user'  (ONLY value)
      resourceId: string,              // user id as string
      name: string,
      scope: {
        routes: Kb[],                  // scope enum below
        workspaceId?: number,
      },
    },
    200: ApiKey & { apiKey: string },  // plaintext key returned ONCE
  },
  updateApiKey: {
    method: 'PATCH', path: '/api-keys/:apiKeyId',
    body: { name?: string, workspaceId?: number|null },
  },
  deleteApiKey: {
    method: 'DELETE', path: '/api-keys/:apiKeyId',
    body: {},
    200: { success: boolean },
  },
}

Gb = { User: 'user' }   // the only resourceType

Kb (scope enum) = 'all' | 'endpoints:run-enrichment'
               | 'endpoints:prospect-search-api' | 'terracotta:cli'
               | 'terracotta:code-node' | 'terracotta:mcp'
               | 'public-endpoints:all'
```

The UI `CreateApiKeyModal` (offset 8143500) submits:

```ts
createApiKey.mutate({
  body: {
    name,
    resourceType: 'user',
    resourceId: String(user.id),
    scope: { routes: selectedScopes, workspaceId: Number(workspaceId) },
  },
})
```

UI exposes only 3 scope checkboxes: `all`, `endpoints:prospect-search-api`,
`public-endpoints:all`. The `terracotta:*` scopes are defined in the
backend enum but have no UI checkbox — they're mintable via direct API
call but not via the product surface.

### 3. Verification scripts

**Pass 1** — `harness/scripts/verify-webhook-batch-auth.ts`
(result: `harness/results/inv-028-key-auth-1775600096405.json`)

1. Mint a scratch API key: `POST /v3/api-keys` with
   `{name, resourceType:'user', resourceId:<userId>, scope:{routes:['all',
   'public-endpoints:all','endpoints:run-enrichment'], workspaceId:1080480}}`.
2. Build inert tc-workflow + webhook stream (INV-027 pattern).
3. POST `postWebhookBatch` (`/v3/.../webhook/batch`) under 6 auth schemes:
   bearer, `x-api-key`, `x-clay-api-key`, `apikey`, no-auth, cookie-only.
4. POST against non-`/v3` form (`/tc-workflows/.../webhook/batch`) under
   same 6 schemes.
5. POST single `postWebhook` non-`/v3` form under same 6 schemes.
6. Body-shape iteration (`{events}`, `{records}`, bare array,
   canonical) under both cookie and bearer.
7. Poll `streams/{id}/runs` (expecting N runs from batch ingestion).
8. Cleanup: stream, workflow, scratch key. Wipe `.api-keys.json`.

**Pass 2** — `harness/scripts/verify-webhook-batch-auth-2.ts`
(result: `harness/results/inv-028-p2-1775600207001.json`)

Exhaust remaining combinations:
- Mint 4 keys with different scope sets: `['terracotta:cli']`,
  all `terracotta:*`, `['all']`, and everything.
- Per key, probe `postWebhookBatch` with 9 header forms + 2 query-param
  forms (`?apiKey=`, `?api_key=`).
- Sanity: single `postWebhook` with Bearer and with **no auth at all**.
- v1 namespace: `/v1/tc-workflows/streams/{id}/webhook[/batch]` +
  `/v1/webhooks/{id}`.

Credit delta (pass 1 + pass 2): **zero**.

## Findings

### 1. Found & minted API key via `POST /v3/api-keys` (FIRST TIME)

This was a breakthrough — full API-key CRUD lives at global `/v3/api-keys`
(not workspace-scoped), confirmed end-to-end:

```
POST /v3/api-keys  (cookie)
  body: {name, resourceType:'user', resourceId:'1282581',
         scope:{routes:['all','public-endpoints:all','endpoints:run-enrichment'],
                workspaceId:1080480}}
-> 200 {id:'ak_...', apiKey:'[REDACTED_40+_CHAR_KEY]', name, resourceType,
        resourceId, keyData:{scopes:[...]}, scope:{routes,workspaceId},
        createdAt, updatedAt}

DELETE /v3/api-keys/ak_...  (cookie)  -> 200 {success:true}
```

Confirmed for all four scope sets in pass 2 (`terracotta:cli`, all three
`terracotta:*`, `['all']`, and the full 7-scope union). `GET /v3/api-keys
?resourceType=user&resourceId=<uid>` lists the user's keys (200, array).
`GET /v3/api-keys?resourceType=workspace&resourceId=...` → **400** — the
enum has only `user`. Key id prefix is `ak_`.

The plaintext `apiKey` is returned ONLY in the create response (matches
the UI modal copy: "For security reasons, this API Key will not be
displayed again").

This is a new capability the registry didn't previously track —
INV-028's first concrete output.

### 2. `postWebhookBatch` is **not authenticable** with a session-minted key

Under every combination tested (4 scope sets × 11 header forms × canonical
body = 44 attempts), `POST /v3/tc-workflows/streams/{streamId}/webhook/batch`
returned:

| Auth scheme | Status | Body |
|---|---|---|
| no headers | 401 | `{type:'Unauthorized', message:'You must be logged in'}` |
| `Authorization: Bearer <key>` | 401 | same |
| `Authorization: bearer <key>` | 401 | same |
| `Authorization: Basic <base64>` | 401 | same |
| `X-Api-Key: <key>` | 401 | same |
| `X-Clay-API-Key: <key>` | 401 | same |
| `Clay-API-Key: <key>` | **403** | `{type:'Forbidden', message:'You must be logged in'}` |
| `clay-api-token: <key>` | 401 | same |
| `Token: <key>` | 401 | same |
| `x-auth-token: <key>` | 401 | same |
| `?apiKey=<key>` | 401 | same |
| `?api_key=<key>` | 401 | same |
| session cookie (canonical body) | **403** | same |
| session cookie (wrong body shape) | **400** | Zod validation error — body IS parsed |

Key signals:

- **Zod validation runs BEFORE auth**. Sending `{events:[...]}` /
  `{records:[...]}` / bare array all return 400 "Field items — Required",
  meaning the request is reaching the route handler. The canonical body
  then gets rejected by the downstream auth/middleware layer.
- **`Clay-API-Key` is the only header that produces a different
  status code (403 vs the universal 401)**. This header is being recognized
  by *some* middleware that then rejects the minted key as
  "authenticated-but-forbidden". My hypothesis: `Clay-API-Key` is the
  v1-legacy bearer header, and that middleware only trusts the
  **deprecated v1 key format**, not the new `ak_*` keys the `/v3/api-keys`
  router mints. Or, the middleware trusts the key identity but the
  scope doesn't cover tc-workflow batch ingestion.
- **`x-clay-api-key`/`x-api-key`/`Bearer` all 401 identically** — these
  aren't even parsed.
- **None of the `terracotta:*` scopes helped**. A key with
  `['terracotta:cli','terracotta:code-node','terracotta:mcp']` gets
  exactly the same response as a key with `['all']` or with no
  tc-specific scope. Whatever auth route is checking isn't consulting
  the key's scope at all — it's failing at the "is this key trusted"
  step first.
- **v1 namespace is fully dead**: `POST /v1/tc-workflows/streams/{id}/
  webhook[/batch]` → 404 `{success:false, message:'deprecated API endpoint'}`;
  `POST /v1/webhooks/{id}` → 503 `endpoints deprecated; please reach out`.
  The legacy v1 API key workflow no longer has a mountable endpoint here.

**Conclusion**: `postWebhookBatch` is not reachable from a user-minted
workspace API key. The auth surface is almost certainly **internal-only
mTLS / inter-service JWT / worker-signed token** — Clay's own async job
runners pushing backfill events. Three supporting signals:

1. The frontend bundle (`uKe` router consumers) never calls
   `postWebhookBatch` anywhere — only the router definition exists,
   no SWR hook, no React component references it. Contrast with
   `postWebhook` (single) which the Workflows editor calls directly.
2. The body shape (`entityId`, `backfillId`, `requestData`) is exactly
   the shape a worker ingesting from an external system would emit — a
   backfill job iterating over rows.
3. The single-event endpoint is **completely public** (see finding 3),
   so there's no reason to bolt API-key auth onto the batch variant
   for external use — the external surface is already the single-event
   form.

### 3. BREAKTHROUGH: `postWebhook` (single) is **completely unauthenticated**

Pass 2 sanity check: `POST /v3/tc-workflows/streams/{streamId}/webhook`
with **zero auth headers** returned:

```
202 {"success":true,"workflowRunId":"wfr_0td59w8HZxk3CMfmz22",
     "message":"Webhook request accepted and queued for processing"}
```

INV-027 assumed the single-webhook endpoint required session cookies
because that's how the script happened to send it. It doesn't. The
streamId itself is the bearer token — globally-unique `wfrs_*` opaque
id, same security model as a Clay table webhook URL or a Slack
incoming-webhook URL. This is **the productized inbound channel** —
you register a webhook stream, get back a URL, and **anyone who has
that URL can POST events into it**. No API key required.

This resolves a second half of GAP-036 ("the productized inbound
webhook channel") that we were hunting for via API-key auth — it was
hiding in plain sight as the single-event route.

Also confirmed: the endpoint accepts `Authorization: Bearer <key>` (202)
and `Cookie: claysession=...` (202). It tolerates any or no auth — the
auth header (if present) is not validated at all. Only the streamId
matters.

### 4. Non-`/v3` webhookUrl form is 404 everywhere

`POST https://api.clay.com/tc-workflows/streams/{id}/webhook` (the exact
URL Clay returns in `stream.webhookUrl`) returns **404 HTML "Cannot POST"**
under every auth scheme, including no-auth. The `/v3` form is the only
one that works. The `webhookUrl` field in the `streamCreate` response is
**incorrect / misleading** — Clay's backend returns a URL that doesn't
actually route. Probable cause: Clay plans to host the public form on a
separate subdomain or gateway (e.g., `webhooks.clay.com` or a
CloudFront/API Gateway rewrite rule) but hasn't shipped that yet. For
now, consumers must rewrite `webhookUrl` to prepend `/v3` before using it.

This is a minor bug in Clay's backend worth documenting, since anyone
integrating against the returned URL as-is will get a 404.

### 5. Credit delta

Both passes ran on the same workspace. Credits before/after (top-level
`credits` on `GET /v3/workspaces/{wsId}`): unchanged. API key CRUD is
free. Minted-and-revoked 5 keys total without any meter movement.

## New Endpoints Discovered

| Endpoint | Auth | Status | Source |
|---|---|---|---|
| `GET /v3/api-keys?resourceType=user&resourceId=<id>` | session_cookie | confirmed | INV-028 |
| `POST /v3/api-keys` | session_cookie | confirmed | INV-028 |
| `PATCH /v3/api-keys/{apiKeyId}` | session_cookie | suspected (not exercised) | bundle |
| `DELETE /v3/api-keys/{apiKeyId}` | session_cookie | confirmed | INV-028 |

Also **reclassified** the existing `POST /v3/tc-workflows/streams/{streamId}/webhook`
entry: it's `auth: none` (publicly callable), not `session_cookie` as INV-027
had it. INV-027's entry was correct that cookies work, but it missed that
NO auth is required at all.

And `POST /v3/tc-workflows/streams/{streamId}/webhook/batch` remains
`suspected` in the registry but with updated notes: the route is
reachable and its body shape is validated, but no user-facing auth
scheme unlocks it. Almost certainly internal-worker-only.

## Implications

1. **The proprietary API layer now has first-class API key management.**
   We can offer "rotate your Clay API key from our UI" as a feature —
   mint via `POST /v3/api-keys`, store encrypted, list/revoke via the
   CRUD routes. This is parity with what Clay's own settings UI offers,
   but accessible from a session-cookie integration.
2. **There is no server-side way to mint a key that unlocks
   `postWebhookBatch`.** Stop hunting for it. If we need batch ingestion,
   we have three options that already work:
   - Use the single-webhook endpoint and loop (1 POST per event) — works
     identically, no batch-size limits observed in INV-027.
   - Use the `csv_import`-backed batches path (INV-024) for
     large-scale workloads.
   - Use direct runs (INV-026) for synchronous small-batch invocation.
3. **The productized inbound channel is already usable with zero
   credentials.** `POST /v3/tc-workflows/streams/{streamId}/webhook` is
   the public surface — streamId is the bearer, no auth header needed.
   This is the simplest possible integration model: create a stream,
   email/paste the URL to a partner, events start flowing in. The
   Lele webhook-trigger UX can follow this exact pattern.
4. **Clay's `webhookUrl` response field is buggy** — it returns a URL
   form (without `/v3`) that 404s. Anyone building against it must
   rewrite. Worth flagging in our integration-layer docs so users
   don't hit it.
5. **`Clay-API-Key` as a distinct auth-aware header is a new datapoint.**
   Only that specific header variant (correct capitalization,
   hyphenated) produced a 403 where every other variant produced 401 —
   meaning there's a middleware somewhere in Clay's stack that parses
   it. Keys minted via `/v3/api-keys` aren't accepted by it, suggesting
   either it's bound to the deprecated v1 format (`ck_` or similar),
   or it only trusts keys with specific legacy metadata. Not actionable
   for us right now but good to file away.
6. **Clay's API-key scope system is richer than the UI.** The backend
   enum includes `terracotta:cli`, `terracotta:code-node`, `terracotta:mcp`
   — scopes that have no UI checkbox. `terracotta:mcp` is particularly
   interesting: it implies an MCP (Model Context Protocol) server
   surface that's either already shipped or in development. Worth a
   separate investigation (opens **GAP-038**).

## Files Updated

- `investigations/INV-028_api-key-auth.md` (this file, new)
- `investigations/_index.md` (added INV-028 row)
- `harness/scripts/verify-webhook-batch-auth.ts` (new)
- `harness/scripts/verify-webhook-batch-auth-2.ts` (new)
- `harness/results/inv-028-key-auth-1775600096405.json` (new)
- `harness/results/inv-028-p2-1775600207001.json` (new)
- `registry/endpoints.jsonl` (+4 api-keys endpoints; reclassified
  `postWebhook` to `auth:none`; updated `postWebhookBatch` notes)
- `registry/capabilities.md` (api keys row; reclassified webhook
  ingestion as unauthenticated)
- `registry/gaps.md` (closed GAP-036 with "resolved by elimination";
  opened GAP-038 for `terracotta:mcp` scope)
- `registry/changelog.md` (2026-04-07 INV-028 entry)
- `knowledge/internal-v3-api.md` (api keys section; webhook ingestion
  auth correction)
- `knowledge/authentication.md` (added session-auth API-key CRUD note)
- `.gitignore` (added `harness/results/.api-keys.json`)
- `timeline/2026-04-07_9_inv-028-api-key-auth.md` (new, REQUIRED)

## Next Steps

1. **GAP-038 (new): `terracotta:mcp` scope — does Clay ship an MCP
   server?** Bundle enum includes it as a mintable API key scope. Probe
   for MCP-style endpoints (`/mcp`, `/v3/mcp`, `/.well-known/mcp`),
   search bundle for `mcp` / `modelcontextprotocol`. If real, this is
   potentially huge — a Claude-compatible interface into Clay workflows.
2. **GAP-037 still open**: `agent_action` and `workflow_action` stream
   config shapes. Follow up with bundle scan + CDP interception.
3. **Carry forward GAP-034 (default-LLM credit metering) and GAP-035
   (HITL happy path)**.
4. **Document the Clay `webhookUrl` response bug** (returns URL without
   `/v3` that 404s) in `exhaustively_searched/` as a known-footgun for
   future integrators.
5. **Consider exercising `updateApiKey`** (PATCH /api-keys/:id) — not
   run in INV-028, but the route is in the bundle. Low priority since
   delete + recreate works.
