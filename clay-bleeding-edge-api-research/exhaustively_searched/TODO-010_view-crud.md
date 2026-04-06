# TODO-010: View CRUD �� Filter/Sort Update Payload

**Priority:** P1 — Views control row filtering, sorting, field order
**Status:** RESOLVED NEGATIVE (INV-015 + INV-019) — filter/sort NOT settable via REST API
**Related Gap:** NEW-1

## What Works

- **View creation**: `POST /v3/tables/{id}/views` with `{name: "Custom View"}` → 200. Returns full view object.
- **View rename**: `PATCH /v3/tables/{id}/views/{viewId}` with `{name: "New Name"}` → 200. Confirmed.
- Only the `/v3/tables/{id}/views/*` path works. `/v3/views`, `/v3/grid-views` paths all 404.
- No standalone GET for views — read via `GET /v3/tables/{id}` table schema only.

## What Doesn't Work (Yet)

Filter and sort PATCH returns 200 but the response shows `filter: null` and `sort: null` — the update is accepted but not persisted. The payload format may need refinement.

**Tested payloads that didn't stick:**
```json
// Filter
{"filter": {"items": [{"type": "NOT_EMPTY", "fieldId": "f_created_at"}], "combinationMode": "AND"}}

// Sort
{"sort": {"items": [{"fieldId": "f_created_at", "direction": "DESC"}]}}
```

**Known view filter format from existing views:**
```json
{"items": [{"type": "EMPTY", "fieldId": "f_created_at"}], "combinationMode": "OR"}
```

## Remaining Investigation Plan

1. **CDP intercept**: Watch what payload Clay UI sends when changing a view's filter/sort
2. **Try different filter structures**: The items might need additional fields (e.g., `filterType`, `id`, `groupId`)
3. **Try setting filter during creation**: Include `filter` in the `POST /v3/tables/{id}/views` body
4. **Try nested structures**: Clay views have `typeSettings.preconfiguredType` — preconfigured views may need different handling

## View Object Structure (from table schema)

```json
{
  "id": "gv_xxx",
  "tableId": "t_xxx",
  "name": "Errored rows",
  "description": null,
  "order": "h",
  "fields": {
    "f_fieldId": {"order": "b", "isVisible": false, "width": 200, "isPinned": false}
  },
  "sort": {"items": [{"fieldId": "f_xxx", "direction": "DESC"}]},
  "filter": {
    "items": [{"type": "HAS_ERROR", "fieldId": "f_xxx"}],
    "combinationMode": "OR"
  },
  "limit": null,
  "offset": null,
  "typeSettings": {"isPreconfigured": true, "preconfiguredType": "errored_rows"}
}
```

## Success Criteria

- Can create a view with a custom filter (e.g., "only rows where field X is not empty")
- Can modify an existing view's sort order
- Can reorder columns per view via the `fields` map
