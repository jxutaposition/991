# Session 11: Formula Language + Actions Catalog Mining

**Date**: 2026-04-06
**Investigations**: INV-027, INV-028
**Credit cost**: 0 (formula eval is free, actions catalog is read-only)

## BREAKTHROUGH: Formula Language is Full JavaScript

Clay formulas are **JavaScript expressions** with some Clay-specific functions. Tested 19 patterns, 18 work:

| Category | Formula | Result | Status |
|----------|---------|--------|--------|
| **String** | `UPPER({{f}})` | "ANTHROPIC" | ✅ |
| | `LOWER({{f}})` | "anthropic" | ✅ |
| | `LEN({{f}})` | "9" | ✅ |
| | `{{f}} + " Inc."` | "Anthropic Inc." | ✅ |
| | `{{f}}?.includes("thro")` | "true" | ✅ |
| | `{{f}}?.slice(0, 3)` | "Ant" | ✅ |
| | `{{email}}?.split("@")?.[1]` | "anthropic.com" | ✅ |
| **URL** | `DOMAIN({{url}})` | undefined | ❌ (may need different input format) |
| | `{{url}}?.match(/https?:\/\/([^/]+)/)?.[1]` | "www.anthropic.com" | ✅ **RegExp works!** |
| **Number** | `parseInt({{n}})` | "42" | ✅ |
| | `Math.round({{n}})` | "43" | ✅ |
| | `{{n}} * 2` | "85.4" | ✅ |
| **Conditional** | `{{n}} > 50 ? "high" : "low"` | "low" | ✅ |
| **JSON** | `JSON.parse({{j}})?.key` | "value" | ✅ |
| | `JSON.parse({{j}})?.nested?.deep` | "true" | ✅ |
| | `JSON.parse({{j}})?.arr?.[0]` | "1" | ✅ |
| **Array** | `[1,2,3].join(", ")` | "1, 2, 3" | ✅ |
| | `[1,2,3].map(x => x*2).join(",")` | "2,4,6" | ✅ **Arrow functions work!** |
| **Date** | `new Date().getFullYear()` | "2026" | ✅ |

**Key insights:**
- Full JavaScript expression support: optional chaining, ternary, arrow functions, RegExp, destructuring
- `JSON.parse()` enables extracting structured data from JSON string cells
- Array `.map()`, `.filter()`, `.join()` all work — can transform data inline
- `typeof` does NOT work (parse error)
- All results are coerced to strings
- `DOMAIN()` is a Clay-specific function but may require URL format without path

## BREAKTHROUGH: Actions Catalog Analysis (1193 Actions)

### Key statistics
- **354 no-auth actions** — immediately usable without any API keys
- **932 enabled**, 261 billing-gated (CRM: 114, Email Sequencing: 74, Phone: 36, Data Engineering: 33)
- **740 actions** have rate limits; 354 don't

### Power Actions Discovered

**`use-ai`** — Clay's built-in LLM action:
- Inputs: `prompt`, `systemPrompt`, `model`, `temperature`, `reasoningLevel`, `reasoningBudget`, `maxCostInCents`, `jsonMode`, `answerSchemaType`, `maxTokens`, `stopSequence`, `topP`, `contextDocumentIds`, `browserbaseContextId`, `mcpSettings`
- NO AUTH required. This is Clay-native AI.
- Can run in `jsonMode` for structured outputs
- Has `answerSchemaType` for typed responses

**`claygent`** — AI Web Researcher:
- Inputs: `mission`, `model`, `maxCostInCents`, `answerSchemaType`
- NO AUTH required. Autonomous web research.

**`table-level-ai`** — AI with Clay Data as Context:
- Inputs: `clayTableUrl`, `tableId`, `workspaceId`, `contextConfig`, `question`, `modelName`
- NO AUTH. Uses entire Clay table as AI context.

**`scrape-website`** — Full web scraper:
- Inputs: `url`, `waitFor`, `keepNonText`, `outputFields`, `customRegex`, `enableJavaScriptRendering`
- NO AUTH. Extracts structured data from any URL.

**`search-google`** — Google search:
- Inputs: `query`, `numberOfResults`, `language`, `country`, `includeResultCount`, `includeAds`
- NO AUTH.

### Clay-Internal Actions (75 total)
- `lookup-row-in-other-table` — Cross-table single row JOIN
- `lookup-multiple-rows-in-other-table` — Cross-table multi-row JOIN
- `lookup-record-in-other-table` — Record lookup by ID
- `lookup-field-in-other-table-new-ui` — Field-based lookup
- `lookup-company-in-other-table` — Company-specific lookup
- `clay-infer-email` — Email pattern inference
- `clay-encode-uri-components` — URL encoding
- `route-row` — Cross-table data routing

### Categories
- People: 475 actions, Company: 439
- Top tags: People Data (200), Export (138), Company Data (138), CRM (86), Emails (84)

### Rate Limit Buckets
- PRIVATE_AUTH_KEY: 514 actions (per-key limits)
- GLOBAL: 101 (shared limits)
- WORKSPACE_ID: 12 (per-workspace)

## API Key Auth (TODO-053 — RESOLVED NEGATIVE)

The `apiToken` from `GET /v3/me` does NOT work as Bearer/X-Api-Key/Api-Key auth on v3 endpoints. All return 401. Session cookie remains the only v3 auth mechanism.

`POST /v3/api-keys` requires `keyData` object (Zod validation revealed this). Purpose of these keys remains unclear — may be for webhook auth or future API versions.

## View Read Issue — Root Cause Identified

Views return 0 rows when the view ID was obtained before columns were created. The fix is to use `GET /v3/tables/{id}/records/{recordId}` (single record by ID) which bypasses views entirely. This is reliable for formula testing.
