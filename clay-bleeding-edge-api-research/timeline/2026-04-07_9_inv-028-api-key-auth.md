# 2026-04-07 (9) — INV-028: Clay API-key CRUD + `postWebhookBatch` auth dead end + unauth webhook breakthrough

**Context**: INV-027 closed GAP-033 (tc-workflows streams + webhook ingestion)
but left a dangling thread: `POST /v3/tc-workflows/streams/{id}/webhook/batch`
returned 403 "You must be logged in" under session cookies with the canonical
body shape. Hypothesis filed as GAP-036: "batch ingestion is the API-key-authed
productized inbound channel — mint a key and re-test." INV-028 was the
follow-up.

## What I investigated

1. **Bundle scan** (`index-BS8vlUPJ.js`, unchanged since INV-027) for API-key
   management: `apiKey`, `api_key`, `accessToken`, `createApiKey`, `getApiKeys`,
   `deleteApiKey`, `Bearer`, `x-clay-api-key`.
2. **Extract the `TRe` router** (mounted as `apiKeys:TRe` at offset 838019) and
   the `Kb` scope enum + `Gb` resourceType enum from the ts-rest contract
   (offset 511920).
3. **Mint scratch API keys** via `POST /v3/api-keys` with 4 different scope
   sets and use them to probe `postWebhookBatch` under 11 header forms +
   2 query-param forms + no-auth + cookie.
4. **Re-probe the single `postWebhook` endpoint** (INV-027 only tested it under
   cookies) with zero auth headers to see if it's actually public.
5. **Probe the non-`/v3` `webhookUrl` form** Clay returns in stream-create
   responses.

Two scripts — `harness/scripts/verify-webhook-batch-auth.ts` (pass 1, 6 auth
schemes × 2 URL forms + body-shape iteration) and `verify-webhook-batch-auth-2.ts`
(pass 2, 4 scope sets × 11 header forms + v1 namespace + noauth sanity).

## Findings

### Breakthrough 1 — Full API-key CRUD router discovered

`TRe = apiKeys` at `/v3/api-keys` (global, not workspace-scoped):

- `GET /v3/api-keys?resourceType=user&resourceId=<uid>` — list user keys
  (upgrade of INV-017's suspected placeholder to fully confirmed).
- `POST /v3/api-keys` body `{name, resourceType:'user', resourceId:<uid>,
  scope:{routes:Kb[], workspaceId?:number}}` → 200 with **plaintext `apiKey`
  field exposed once** (matches the UI modal "will not be displayed again"
  copy). Key ids are `ak_`-prefixed.
- `PATCH /v3/api-keys/{id}` `{name?, workspaceId?}` — bundle-confirmed, not
  exercised (delete+recreate was simpler).
- `DELETE /v3/api-keys/{id}` `{}` → `{success:true}`. Verified end-to-end
  across 5 scratch keys, all deleted cleanly.

**Scope enum (`Kb`) has 7 values; Clay's UI exposes only 3**:
`all`, `endpoints:prospect-search-api`, `public-endpoints:all` are the UI
checkboxes. The `terracotta:cli`, `terracotta:code-node`, `terracotta:mcp`,
and `endpoints:run-enrichment` scopes are mintable only via direct API call.
The `terracotta:mcp` one is particularly interesting — strongly implies Clay
has or is building an MCP (Model Context Protocol) server surface. Filed
as **GAP-038**.

**Resource enum (`Gb`) has ONLY `'user'`**. Keys are user-owned; the
`scope.workspaceId` field constrains which workspace they can act in.
Attempting `?resourceType=workspace&resourceId=...` returns 400.

Credit cost of API-key CRUD: **zero**. Minted 5 keys, deleted 5 keys, no
meter movement.

### Dead end — `postWebhookBatch` is not user-facing

Probed `POST /v3/tc-workflows/streams/{id}/webhook/batch` with the canonical
body `{items:[{requestData}]}` under an exhaustive matrix:

- 4 scope sets: `['terracotta:cli']`, all three `terracotta:*`, `['all']`, full
  7-scope union.
- 11 header forms per scope set: `Authorization: Bearer/bearer/Basic`,
  `X-Api-Key`, `X-Clay-API-Key`, `Clay-API-Key`, `clay-api-token`, `Token`,
  `x-auth-token`, query-param `?apiKey=`, `?api_key=`.
- Plus no-auth, cookie-only, and the `/v1/tc-workflows/streams/{id}/webhook[/batch]`
  legacy namespace.

Result: **every combination rejected**. 401 Unauthorized or 403 Forbidden
across the board. `Clay-API-Key` is the only header that produces 403 instead
of 401, meaning there's a middleware parsing it but rejecting the minted
`ak_*` keys — probably bound to the deprecated v1 key format. Zod validation
DOES run before auth (wrong body shapes return 400 with `items Required`),
proving the handler is reached. `/v1/*` namespace fully dead: 404 "deprecated".

**Critical observation**: the bundle contains NO frontend caller for
`postWebhookBatch` — only the router contract definition. Contrast with
`postWebhook` (single) which the Workflows editor calls directly. Combined
with the body shape (`entityId`, `backfillId`, `requestData` — consistent with
a backfill worker iterating over source rows), the conclusion is:
**`postWebhookBatch` is internal-only, reserved for Clay's own async workers
pushing backfill events into tc-workflow streams.** Not externalizable.

GAP-036 closed "by elimination". The workaround for high-throughput ingestion:
loop the single-event `postWebhook` endpoint (no batch-size limits observed in
INV-027).

### Breakthrough 2 — `postWebhook` (single) is completely unauthenticated

Pass 2 sanity check. INV-027 assumed the single-webhook endpoint required
cookies because that's how the script sent it. But `POST /v3/tc-workflows/
streams/{streamId}/webhook` with ZERO auth headers:

```
-> 202 {"success":true,
        "workflowRunId":"wfr_0td59w8HZxk3CMfmz22",
        "message":"Webhook request accepted and queued for processing"}
```

The streamId itself is the bearer token — same security model as Clay table
webhook URLs or Slack incoming webhooks. This IS the productized inbound
channel we were hunting for, and it was hiding in plain sight. Reclassified
the endpoint in `endpoints.jsonl` from `auth:session_cookie` to `auth:none`.
Updated capabilities.md to reflect the unauthenticated nature. This was the
main missing half of GAP-036.

### Minor backend bug — `webhookUrl` field is wrong

Clay's stream-create response returns
`webhookUrl: "https://api.clay.com/tc-workflows/streams/{id}/webhook"` (no
`/v3` prefix). That URL form returns 404 HTML ("Cannot POST
/tc-workflows/...") under every auth scheme. Only the `/v3`-prefixed form
routes. **Consumers must rewrite `webhookUrl` to prepend `/v3` before using
it.** Filed in INV-028 implications and capabilities.md notes.

## What changed

- **3 new confirmed endpoints**: `POST/PATCH(suspected)/DELETE /v3/api-keys[/{id}]`. Plus `GET /v3/api-keys` upgraded from suspected to fully confirmed.
- **Reclassified** `POST /v3/tc-workflows/streams/{id}/webhook` to `auth:none` (productized inbound channel).
- **Reclassified** `POST /v3/tc-workflows/streams/{id}/webhook/batch` to `auth:internal-only` with full INV-028 auth matrix documented.
- **Total endpoints: 120** (up from 117).
- **GAP-036 closed** by elimination.
- **GAP-038 opened**: `terracotta:mcp` scope, does Clay ship an MCP server?

## Files updated

- `investigations/INV-028_api-key-auth.md` (new)
- `investigations/_index.md`
- `harness/scripts/verify-webhook-batch-auth.ts` (new)
- `harness/scripts/verify-webhook-batch-auth-2.ts` (new)
- `harness/results/inv-028-key-auth-1775600096405.json` (new)
- `harness/results/inv-028-p2-1775600207001.json` (new)
- `registry/endpoints.jsonl`
- `registry/capabilities.md`
- `registry/gaps.md` (GAP-036 resolved, GAP-038 opened)
- `registry/changelog.md`
- `knowledge/internal-v3-api.md` (API-key CRUD section + webhook auth corrections)
- `knowledge/authentication.md` (session-minted API keys note + v1 deprecation update)
- `.gitignore` (+`harness/results/.api-keys.json`)
- `timeline/2026-04-07_9_inv-028-api-key-auth.md` (this file)

## Next iteration

1. **GAP-038** — probe `terracotta:mcp` scope. Mint a key, hit plausible MCP
   paths (`/mcp`, `/v3/mcp`, `.well-known/mcp`), bundle-scan for `mcp` /
   `modelcontextprotocol`, check the `tc-workflows` tree for MCP-shaped verbs
   (`resources/list`, `tools/list`, `prompts/list`). High upside if real.
2. Document the `webhookUrl` backend bug in `exhaustively_searched/` so
   future integrators don't hit the 404.
3. Exercise `PATCH /v3/api-keys/{id}` (not yet run).
4. Carry forward GAP-034 (default-LLM credit metering), GAP-035 (HITL
   happy path), GAP-037 (agent_action / workflow_action stream configs).
