# Session 12: Route-Row + Enrichment Extraction Breakthroughs

**Date**: 2026-04-06
**Investigation**: INV-029
**Credit cost**: 1 (one normalize-company-name)

## THREE MAJOR BREAKTHROUGHS

### 1. Route-Row Column Creation — SOLVED (TODO-038, TODO-055)

The correct payload:
```json
POST /v3/tables/{sourceTableId}/fields
{
  "name": "Send to Target",
  "type": "action",
  "typeSettings": {
    "actionKey": "route-row",
    "actionPackageId": "b1ab3d5d-b0db-4b30-9251-3f32d8b103c1",
    "inputsBinding": [
      {"name": "tableId", "formulaText": "\"t_targetTableId\""},
      {"name": "rowData", "formulaMap": {
        "Company Name": "{{f_companyField}}",
        "Website": "{{f_websiteField}}"
      }}
    ],
    "dataTypeSettings": {"type": "json"}
  },
  "activeViewId": "gv_xxx"
}
```

**What auto-happens on Table B**: Clay immediately creates:
- A source column: `Rows from: {source table name}` (type: source)
- Formula columns for each `rowData` key: `Company Name(formula)`, `Website(formula)`

**The previous Session 10 failure** was because we used different actionPackageId. The correct one is `b1ab3d5d-b0db-4b30-9251-3f32d8b103c1` (from the actions catalog).

**Route-row input schema** (from catalog):
- `type` (optional): Method — "list" for one-to-many
- `tableId` (required): Target table ID as string literal
- `rowData` (required): Key-value map of data to send
- `nestedData` (optional): Nested data structures
- `listData` (optional): Array data for list mode

### 2. Enrichment Results Are Structured Objects in Formulas (TODO-052)

The cell DISPLAYS a preview string (`"✅ Anthropic"`) but in formula context it's a **full JSON object**:

| Formula | Result |
|---------|--------|
| `{{f_enrichCol}}` | `{"original_name":"Anthropic","normalized_name":"Anthropic"}` |
| `JSON.stringify({{f_enrichCol}})` | `{"normalized_name":"Anthropic","original_name":"Anthropic"}` |
| `{{f_enrichCol}}?.original_name` | `"Anthropic"` |
| `{{f_enrichCol}}?.normalized_name` | `"Anthropic"` |
| `Object.keys({{f_enrichCol}} \|\| {})` | `["original_name","normalized_name"]` |

**This means**: Any enrichment result can be decomposed into individual text columns using formulas. The `attributeProviderPathMap` from the attributes catalog gives the exact JSON paths for each provider's output format.

### 3. use-ai Action Has MCP Support

The `use-ai` action (Clay's built-in LLM) has 24 input parameters including:
- `mcpSettings(object?)` — Model Context Protocol tool integration
- `contextDocumentIds(array?)` — document context
- `browserbaseContextId(text?)` — browser context for web-aware AI
- `reasoningLevel(text?)`, `reasoningBudget(undefined?)` — reasoning control
- `width`, `height`, `aspectRatio`, `referenceImageURL` — image generation?

This suggests Clay's AI can use MCP servers, reference uploaded documents, and potentially generate images.

## Actions Catalog Full Schemas

### scrape-website outputs (11 fields):
`title`, `keywords`, `description`, `favicon`, `socialLinks`, `extractedKeywords`, `links`, `emails`, `phoneNumbers`, `images`, `bodyText`

### search-google outputs (8 fields):
`search_results`, `related_searches`, `related_questions`, `knowledge_graph`, `link_to_google_search`, `ad_results`, `google_search_result_count`, `results_returned_count`

### http-api-v2
Requires `http-api` auth (but many Clay-managed shared accounts exist). Full HTTP method/url/body/headers/retry control.
