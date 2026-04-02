# n8n Code Nodes — Overview & Decision Guide

## When to Use Code vs Other Nodes

| Your Goal | Use |
|-----------|-----|
| Complex multi-step logic | Code node |
| Custom calculations or business logic | Code node |
| Data aggregation across items | Code node |
| Recursive operations or API response parsing | Code node |
| Simple field mapping | Set node |
| Basic filtering | Filter node |
| Simple conditionals | IF or Switch node |
| HTTP requests only | HTTP Request node |

---

## JavaScript (preferred — 95% of use cases)

### Mode Selection

**Run Once for All Items** (default, recommended):
- Code executes **once** regardless of input count
- Data access: `$input.all()`
- Best for: aggregation, filtering, batch transforms, sorting, deduplication
- Performance: faster for multiple items

**Run Once for Each Item** (specialized):
- Code executes **separately** per input item
- Data access: `$input.item`
- Best for: per-item API calls, independent validation, item-specific transforms
- Performance: slower for large datasets

**Decision shortcut**: Need to look at multiple items? → All Items. Each item independent? → Each Item. Not sure? → All Items.

### Return Shape (CRITICAL)
Must return array of `{ json: { ... } }`:
```javascript
// ✅ Correct
return [{json: {result: 'success'}}];
return items.map(item => ({json: {...item.json, processed: true}}));
return [];  // valid empty

// ❌ Wrong
return {json: {result: 'success'}};    // missing array wrapper
return [{result: 'success'}];          // missing json key
return "processed";                    // wrong type
```

### Data Access Patterns (by frequency)
1. `$input.all()` (26%) — batch operations, aggregation
2. `$input.first()` (25%) — single item, API responses
3. `$input.item` (19%) — Each Item mode only
4. `$node["NodeName"].json` — reference specific nodes
5. `$json` — direct current item (legacy, prefer `$input`)

### Webhook Data in Code
```javascript
// ❌ WRONG
const name = $json.name;           // undefined
// ✅ CORRECT
const name = $json.body.name;      // webhook wraps under .body
const body = $input.first().json.body;
```

### Built-in Functions
- `$helpers.httpRequest({method, url, headers, body, qs})` — async HTTP from Code
- `DateTime` — Luxon date/time library
- `$jmespath(data, 'query')` — JSON path queries
- `$getWorkflowStaticData()` — persist data across executions
- Standard: Math, JSON, Object, Array methods, crypto, Buffer, URL

### No External Packages
❌ axios, lodash, moment, request, any npm package
✅ Use `$helpers.httpRequest()` for HTTP, DateTime for dates

---

## Python (Beta)

**Use Python only when**: you need specific stdlib functions, or are significantly more comfortable with Python syntax.

### Key Differences from JavaScript
- Variables prefixed with underscore: `_input`, `_json`, `_node`, `_now`
- Dictionary access: use `.get()` for safety (avoids KeyError)
- Return shape: `[{"json": {...}}]` (same structure)
- **NO external libraries** — biggest limitation
- No `$helpers.httpRequest()` equivalent — use HTTP Request node before Code node

### Allowed Standard Library
json, datetime, re, base64, hashlib, urllib.parse, math, random, statistics, collections

### NOT Available (ModuleNotFoundError)
requests, pandas, numpy, beautifulsoup4, selenium, psycopg2, pymongo, sqlalchemy, flask, fastapi, pillow, openpyxl

### Workarounds for Missing Libraries
- **HTTP (no requests)** → HTTP Request node before Code, or switch to JavaScript
- **Data analysis (no pandas)** → list comprehensions + statistics module
- **Databases (no drivers)** → n8n database nodes (Postgres, MySQL, MongoDB)
- **Web scraping (no bs4)** → HTML Extract node + HTTP Request node

### Python Modes
- **Python (Beta)** — recommended: `_input`, `_json`, `_node`, `_now`, `_jmespath()` helpers
- **Python (Native)** — limited: `_items`, `_item` only, no helpers

---

## Quick Checklist Before Deploy

- [ ] Code is not empty
- [ ] Return statement exists on all paths
- [ ] Return format: `[{json: {...}}]`
- [ ] No `{{ }}` expressions (use direct JS/Python)
- [ ] Null checks for optional fields (?.  or .get())
- [ ] Webhook data via `.body`
- [ ] Mode selection correct (All Items vs Each Item)
- [ ] No external imports (Python)
- [ ] console.log() for debugging (browser F12)
