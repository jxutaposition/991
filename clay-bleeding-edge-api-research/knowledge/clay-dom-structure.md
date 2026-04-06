# Clay DOM Structure Reference

Last updated: 2026-04-05

## Overview

Clay's frontend is a React Single Page Application (SPA) at `app.clay.com`. Every piece of state lives in the DOM and in React's internal fiber tree. This makes it amenable to Playwright automation as an alternative to screenshot-based agent interaction.

## Why DOM Automation Beats Screenshots

Screenshot-based computer use agents fail on Clay because:
1. **Narrow cells render values, not formulas** -- the formula text only appears in a formula bar after clicking the cell
2. **Expensive iteration** -- screenshot -> infer -> click -> screenshot again to trace a single formula
3. **Huge search space** -- "is this broken?" requires traversing every column, row, and dependency
4. **Ambiguity** -- visual rendering doesn't distinguish between similar-looking but structurally different elements

DOM automation bypasses all of this by reading structured data directly.

## Known DOM Selectors

### URL-Based Context (from Claymate Lite)

```javascript
// Extract table ID
url.match(/tables\/(t_[a-zA-Z0-9]+)/);

// Extract view ID
url.match(/views\/(gv_[a-zA-Z0-9]+)/);

// Extract workspace ID
url.match(/workspaces\/(\d+)/);
```

### Column Headers

Selected columns have a `text-white` class applied:
```javascript
document.querySelectorAll('[class*="text-white"]');
// Filter: text length < 50, vertical position 100-200px (header region)
```

This is a heuristic used by Claymate Lite. The exact class name may change with Clay UI updates.

### Column Data Attributes (Suspected)

Clay likely uses `data-col-id` or similar attributes on column elements:
```javascript
// Suspected (needs verification via CDP/DOM inspection)
document.querySelector(`[data-col-id="${colId}"] .cell-value`);
```

### Formula Bar

After clicking a cell, the formula text appears in a formula bar element:
```javascript
// Click a cell to select it
await page.click(`[data-col-id="${colId}"]`);

// Read the formula bar content
const formulaText = await page.textContent('.formula-bar-input');
```

**Note**: The exact selector `.formula-bar-input` needs verification. The formula bar is a distinct UI element that shows the raw formula/expression behind a cell's displayed value.

### Error States (Suspected)

Clay likely indicates error states via:
- CSS classes (e.g., `error`, `failed`, `warning`)
- ARIA attributes (e.g., `aria-invalid`, `aria-errormessage`)
- Error icon elements within cells
- Tooltip content on hover

These need systematic mapping via DOM inspection. See `investigations/INV-001_v3-endpoint-catalog.md`.

## React Fiber Tree Access

Clay's React state can be accessed via Playwright's `page.evaluate()`:

```javascript
// Access React's internal state (advanced technique)
const fiberData = await page.evaluate(() => {
  // Find a React fiber node
  const element = document.querySelector('.some-clay-element');
  const fiberKey = Object.keys(element).find(key => 
    key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')
  );
  const fiber = element[fiberKey];
  // Navigate the fiber tree to extract state
  return fiber?.memoizedProps;
});
```

This technique can extract:
- Column configurations directly from React state
- Formula ASTs
- Error states and validation results
- Enrichment status per cell

**Caution**: React internals are highly version-dependent. This approach is fragile and should only be used when the v3 API and standard DOM selectors are insufficient.

## Page Structure (Needs Verification)

Expected high-level DOM structure of a Clay table page:

```
body
├── nav (workspace/account navigation)
├── sidebar (workbook/table list?)
└── main content
    ├── table toolbar (filters, sorts, views, settings)
    ├── column headers
    │   └── header cells (column name, type icon, menu trigger)
    ├── table body (virtual scroll)
    │   └── rows
    │       └── cells (rendered values, status indicators)
    ├── formula bar (visible when cell is selected)
    └── footer (row count, pagination?)
```

## CDP Network Observation Points

When running CDP interception, monitor for:

1. **`api.clay.com/v3/*`** -- all internal API calls
2. **WebSocket connections** -- Clay may use WebSockets for real-time updates (row status, enrichment progress)
3. **`clay.com/api/*`** -- any non-v3 API paths
4. **Third-party calls** -- enrichment provider callbacks, analytics

## Playwright Automation Patterns

### Navigate to a Table
```typescript
await page.goto(`https://app.clay.com/workspaces/${wsId}/tables/${tableId}/views/${viewId}`);
await page.waitForSelector('.table-loaded-indicator'); // needs verification
```

### Read Column Names
```typescript
const columnHeaders = await page.$$eval('.column-header', headers => 
  headers.map(h => h.textContent?.trim())
);
```

### Click a Cell and Read Formula
```typescript
await page.click(`[data-row="${rowIdx}"][data-col="${colId}"]`);
await page.waitForSelector('.formula-bar-input');
const formula = await page.textContent('.formula-bar-input');
```

### Detect Error Cells
```typescript
const errorCells = await page.$$('.cell-error, [aria-invalid="true"]');
for (const cell of errorCells) {
  const text = await cell.textContent();
  const colId = await cell.getAttribute('data-col-id');
  console.log(`Error in column ${colId}: ${text}`);
}
```

**All selectors above are speculative and need verification via actual DOM inspection.** The first CDP discovery sprint should map the real selectors.

## Known Clay Frontend Version

Claymate Lite reads `window.clay_version` for the `X-Clay-Frontend-Version` header. This global variable is set by Clay's frontend bundle and changes with deploys. Capturing it during session extraction is important for v3 API compatibility.
