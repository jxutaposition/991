# View Filter/Sort/Field-Order Update via REST API

**Status**: NOT POSSIBLE
**Investigated**: INV-015, INV-019 (Sessions 4-5)
**Probes**: 11 different payload formats

## What Works
- `POST /v3/tables/{id}/views` — create view (name only)
- `PATCH /v3/tables/{id}/views/{viewId}` — rename view
- `DELETE /v3/tables/{id}/views/{viewId}` — delete view

## What Doesn't Work
Setting `filter`, `sort`, or `fields` on a view via PATCH or POST. All 11 formats tested return 200 but the values remain `null` in the response and in subsequent reads.

## Formats Tested (All No-Op)
1. `{filter: {items: [{type: "NOT_EMPTY", fieldId: "f_xxx"}], combinationMode: "AND"}}`
2. Same with `filterType: "Filter"` in items
3. Same with `id: "filter_1"` in items
4. Wrapper `{filter: {filterType: "Group", items: [...]}}`
5. Flat array `{filter: [...]}`
6. Stringified `{filter: JSON.stringify(...)}`
7. Combined with name `{name: "...", filter: {...}}`
8. Sort items `{sort: {items: [{fieldId: "f_xxx", direction: "ASC"}]}}`
9. Sort flat `{sort: [{fieldId: "f_xxx", direction: "DESC"}]}`
10. Sort stringified
11. Sort direct `{sort: {fieldId: "f_xxx", direction: "ASC"}}`

Field visibility/order PATCH also returns 200 but doesn't persist.

## Why Preconfigured Views Have Filters
Views like "Errored rows" get filters via `typeSettings.preconfiguredType: "errored-rows"` — Clay applies these server-side, not through the REST filter field.

## Likely Explanation
View filter/sort state is managed via a different channel — probably WebSocket-based UI state sync or a GraphQL mutation we haven't found.
