# Prompt: DOM Structure Mapping

## Objective

Map Clay's DOM structure for a specific page/feature to identify reliable selectors for Playwright automation. This feeds into Layer 3 (Playwright DOM automation) of the architecture.

## Prerequisites

- Read `../AGENT.md` for conventions and safety rules
- Read `../../knowledge/clay-dom-structure.md` for known selectors
- An authenticated Clay browser session (headed mode recommended)
- Playwright available

## Method

### Step 1: Page Load Analysis

Navigate to the target page and wait for full load:

```typescript
const page = await context.newPage();
await page.goto('https://app.clay.com/workspaces/{wsId}/tables/{tableId}');
await page.waitForLoadState('networkidle');
```

### Step 2: Structure Dump

Get the high-level DOM structure:

```typescript
const structure = await page.evaluate(() => {
  function mapElement(el, depth = 0) {
    if (depth > 4) return null;
    const tag = el.tagName?.toLowerCase();
    const id = el.id || null;
    const classes = Array.from(el.classList || []).join(' ');
    const dataAttrs = {};
    for (const attr of el.attributes || []) {
      if (attr.name.startsWith('data-')) {
        dataAttrs[attr.name] = attr.value;
      }
    }
    const role = el.getAttribute('role');
    const aria = {};
    for (const attr of el.attributes || []) {
      if (attr.name.startsWith('aria-')) {
        aria[attr.name] = attr.value;
      }
    }
    return {
      tag, id, classes, dataAttrs, role, aria,
      children: Array.from(el.children).map(c => mapElement(c, depth + 1)).filter(Boolean)
    };
  }
  return mapElement(document.body);
});
```

### Step 3: Feature-Specific Mapping

For each UI feature, identify:

1. **Container element**: The outermost element for the feature
2. **Interactive elements**: Buttons, inputs, dropdowns
3. **Data elements**: Where values are displayed
4. **State indicators**: CSS classes or attributes that change with state

### Step 4: Selector Stability Assessment

For each selector found, assess stability:
- **ID-based** (`#element-id`): Most stable, but Clay may not use IDs consistently
- **data-* attribute** (`[data-col-id="..."]`): Stable if Clay uses data attributes
- **Role-based** (`[role="grid"]`): Stable for accessibility-compliant elements
- **Class-based** (`.class-name`): Fragile, changes with CSS updates
- **Text-based** (`:has-text("...")`): Fragile, changes with i18n or copy updates
- **Structural** (`div > div:nth-child(2)`): Very fragile

## Target Features to Map

### Table Grid
- Column headers (name, type icon, menu trigger)
- Row cells (value display, edit mode, error state)
- Row numbers / selection checkboxes
- Virtual scroll container
- Empty state

### Formula Bar
- Container element
- Input/display element
- How it changes when a cell is selected vs. not

### Column Configuration
- Column type selector
- Formula editor
- Enrichment provider picker
- Action/webhook settings

### Error States
- Cell-level error indicators
- Column-level error indicators
- Error messages / tooltips

### Table Toolbar
- Filter controls
- Sort controls
- View switcher
- Settings button

## Output

Write findings to `../../knowledge/clay-dom-structure.md`, updating/replacing speculative selectors with verified ones.

For each selector, document:
```markdown
### Feature: {name}

**Selector**: `{css selector}`
**Stability**: high | medium | low
**Verified**: {date}
**Notes**: {context}
```
