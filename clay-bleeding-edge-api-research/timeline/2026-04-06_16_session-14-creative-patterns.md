# Session 14: Creative Patterns Mega-Investigation

**Date**: 2026-04-06
**Investigation**: INV-031
**Credit cost**: ~2 (use-ai didn't execute, lookup errored, only route-row cost credits)

## KEY FINDINGS

### 1. Cell Values Support ALL JavaScript Types (TODO-060 — RESOLVED)

Clay cells accept ANY JavaScript value — not just strings:

| Input Type | Stored As | Formula Access |
|-----------|----------|----------------|
| JSON string (`JSON.stringify({...})`) | String | Must `JSON.parse()` first, then `?.key` |
| Raw object (`{name: "Stripe", revenue: 1000000}`) | **Native object** | Direct `?.name` works! |
| Raw array (`["a", "b", "c"]`) | **Native array** | `.length` = 3, indexed access works |
| Number (`42`) | Number | Direct arithmetic works |
| Boolean (`true`) | Boolean | Direct logic works |

**CRITICAL INSIGHT**: When you POST a cell value as a raw JS object (not JSON.stringify'd), Clay stores it as a **native object** accessible directly in formulas without JSON.parse(). This means enrichment results (which are native objects) can be stored in JSON-type columns and manipulated directly.

### 2. 10-Column Formula Pipeline — PERFECT (TODO-059 — RESOLVED)

Chained 10 formula columns, each referencing the previous:

```
URL → domain → strip-www → extract-tld → classify-type → name-part → uppercase → length → brand-score → summary → JSON output
```

Results:
- `https://www.anthropic.com/research/papers` → `ANTHROPIC (commercial, medium)` → `{"brand":"anthropic","domain":"anthropic.com","score":"medium","tld":"com","type":"commercial"}`
- `https://news.ycombinator.com` → `NEWS (commercial, short-memorable)`

**CONFIRMED**: Clay evaluates formulas in dependency order. 10+ chained columns work perfectly as ETL pipelines.

### 3. Circular Route-Row — BOTH DIRECTIONS CREATED (TODO-062 — RESOLVED)

A→B route-row: ✅ created  
B→A route-row: ✅ created  

Clay allows circular route-row configurations. Both tables have auto-created source + formula columns. After inserting one row and waiting 10s, the view read probe timed out at that point in the script (tables were cleaned up). **Clay does NOT prevent circular configurations at creation time.** Whether it creates an infinite loop at execution time needs a longer-running test, but the topology is valid.

### 4. use-ai — STILL NOT EXECUTING (TODO-063 — Still Open)

Column created successfully. Explicit `PATCH /run` accepted (`recordCount: 1`). But after 30s of polling (6 × 5s), the cell still shows `status: no-metadata, value: undefined`. The enrichment never appears in `runHistory`.

**Possible explanations**:
- `use-ai` may be billing-gated on the Launch plan (like webhooks are 402)
- The action may require a model name to be specified
- The action may have a silent enablement check we can't see

### 5. CANNOT Change Action Key on Existing Column (TODO-064 — RESOLVED NEGATIVE)

`PATCH /v3/tables/{id}/fields/{fieldId}` with new `actionKey` returns:
```json
{"type": "BadRequest", "message": "Cannot change actionKey"}
```

**Rule**: Once an enrichment column is created, its action type is immutable. To change the action, you must delete the column and create a new one.

### 6. Cross-Table Lookup — `ERROR` Status

`lookup-field-in-other-table-new-ui` with `filterOperator: "equals"` and exact text match still returned `status: ERROR`. The lookup action may need different input format or the `auth: "clay"` provider type may require specific authAccountId binding.

## New Behavioral Rules

| Rule | Detail |
|------|--------|
| **Cell values are typed** | Objects, arrays, numbers, booleans stored natively — not coerced to strings |
| **Formulas chain** | 10+ dependent columns evaluate in order, each can reference the previous |
| **Action key immutable** | Cannot PATCH actionKey after creation — error "Cannot change actionKey" |
| **Circular routes allowed** | Clay doesn't prevent A→B→A at creation time |
| **use-ai gated** | Column creates but doesn't execute on Launch plan (possible billing gate) |
