# Agent Deployment Instructions

Read this file first when deployed into the Clay Bleeding-Edge API Research project.

## Context

Clay (clay.com) is a GTM data enrichment platform. It has **no official public API** for structural operations (creating tables, adding columns, configuring enrichments, managing webhooks). The only official programmatic access is:

- **Webhooks**: POST JSON into a table (inbound only, 50k limit)
- **HTTP API action columns**: Clay pushes data to your endpoint (outbound only)
- **v1 API** (API key): Read/write rows, trigger enrichments, read table metadata
- **Enterprise People/Company API**: Basic person/company lookups only

We are building a proprietary API layer by reverse-engineering Clay's internal v3 API (used by Clay's own frontend) and supplementing with Playwright DOM automation for operations the API doesn't cover.

## Your Tools

- **Playwright** (available in `../e2e/`): Browser automation for Clay's React SPA
- **CDP (Chrome DevTools Protocol)**: Network interception for API discovery
- **HTTP requests**: Direct calls to `api.clay.com/v1` and `api.clay.com/v3`
- **Harness scripts** (in `harness/scripts/`): Pre-built Playwright scripts for common operations
- **Web search**: For finding new community tools, forum posts, documentation updates

## CRITICAL: Credit Usage

**Clay charges credits for enrichment execution. Do NOT waste credits in investigation scripts.**

Read `exhaustively_searched/credit-usage-patterns.md` before writing any script. Key rules:
- Table/column/row/view CRUD = FREE. Schema reads = FREE. Export jobs = FREE.
- `PATCH /run` (enrichment trigger) = **COSTS CREDITS** (1+ per row × field)
- `tableSettings.autoRun: true` + inserting rows = **COSTS CREDITS** per enrichment column
- Creating enrichment columns on tables with existing rows = **MAY COST CREDITS**
- Use 1-2 rows max when testing enrichments. Use `forceRun: false` to avoid re-running succeeded cells.

## Formula Language

Clay formulas are **JavaScript expressions**. All standard JS works: optional chaining (`?.`), ternary, arrow functions, `JSON.parse()`, RegExp, `.map()`, `.filter()`, `.join()`, `Math.*`, `parseInt()`. Clay-specific: `UPPER()`, `LOWER()`, `LEN()`, `DOMAIN()`, `Clay.formatForJSON()`. `typeof` does NOT work. All results coerced to strings.

**Always validate field IDs** before creating formulas — Clay accepts invalid references at 200 (errors only surface at runtime).

## Your Workflow

1. **Read the current state**: Check `registry/gaps.md` for prioritized open questions, `registry/capabilities.md` for what's already known
2. **Pick a gap**: Choose the highest-priority gap you can investigate
3. **Probe it**: Use harness scripts, Playwright, CDP, or direct HTTP as appropriate
4. **Write findings**: Create or update an `investigations/INV-XXX_*.md` file
5. **Update the registry**:
   - Add new endpoints to `registry/endpoints.jsonl`
   - Update `registry/capabilities.md` with new confirmed/denied capabilities
   - Remove resolved gaps from `registry/gaps.md`
   - Add a timestamped entry to `registry/changelog.md`
6. **Update knowledge**: If findings are significant, update the relevant `knowledge/*.md` file

## Investigation File Format

```markdown
# INV-XXX: Title

**Status**: in-progress | completed | blocked
**Priority**: P0 | P1 | P2
**Gap**: Which gap from gaps.md this addresses
**Date started**: YYYY-MM-DD
**Date completed**: YYYY-MM-DD

## Hypothesis

What we expect to find.

## Method

How we're investigating (CDP interception, direct API probing, DOM inspection, etc.).

## Findings

What we actually found. Include request/response examples.

## New Endpoints Discovered

List any new endpoints added to endpoints.jsonl.

## Implications

What this means for the proprietary API layer design.

## Next Steps

What should be investigated next based on these findings.
```

## Endpoint Registry Format

Each line in `registry/endpoints.jsonl` is a JSON object:

```json
{
  "method": "GET",
  "path": "/v3/tables/{tableId}",
  "auth": "session_cookie",
  "source": "claymate-lite",
  "status": "confirmed",
  "request_shape": null,
  "response_shape": {"fields": "Field[]", "gridViews": "GridView[]"},
  "notes": "Returns full table data including all fields and views",
  "discovered": "2026-04-05"
}
```

**Fields**:
- `method`: HTTP method
- `path`: URL path (use `{param}` for path params)
- `auth`: `session_cookie` | `api_key` | `none`
- `source`: How we know about this (`claymate-lite` | `cdp-discovery` | `manual-probe` | `official-docs`)
- `status`: `confirmed` | `suspected` | `untested` | `deprecated`
- `request_shape`: Abbreviated shape of request body (null for GET)
- `response_shape`: Abbreviated shape of response
- `notes`: Human-readable description
- `discovered`: ISO date

## Safety Rules

1. **Rate limiting**: Wait at least 150ms between API calls (matches Claymate Lite's conservative delays). Use exponential backoff on errors.
2. **Don't modify production tables**: Always test on scratch/disposable tables. Create a test table first, probe against it, delete it when done.
3. **Session cookie handling**: Never log or write raw session cookies to investigation files. Reference them as `[SESSION_COOKIE]` in examples. Cookie file at `harness/results/.session-cookies.json` is in `.gitignore`.
4. **Error tolerance**: If you get a 429 (rate limit) or 403 (auth failure), stop and document. Don't retry aggressively.
5. **v3 API instability**: These are internal endpoints. If something breaks, document the failure mode and move on. Don't assume it's permanent.
6. **No data exfiltration**: Don't read or copy actual customer data from Clay tables. Only read schema/structural information for research purposes.
7. **Keep ALL files in sync**: When you make a discovery, update ALL relevant files — not just one. The canonical endpoint list is `registry/endpoints.jsonl`. All other files (knowledge/, architecture/, registry/) must align with it. Stale claims like "suspected" or "unknown" for endpoints that are actually confirmed create confusion for future agents. Check `registry/capabilities.md` and `registry/gaps.md` too.

## Key Files to Know

| File | Purpose |
|------|---------|
| `knowledge/internal-v3-api.md` | Everything known about the v3 API |
| `knowledge/claymate-analysis.md` | How Claymate Lite interfaces with Clay |
| `registry/endpoints.jsonl` | Machine-readable endpoint catalog |
| `registry/gaps.md` | What we still need to investigate |
| `architecture/system-design.md` | The four-layer API architecture we're building toward |
| `harness/scripts/intercept-clay-api.ts` | CDP interception script |
| `harness/scripts/extract-session.ts` | Session cookie extraction |
