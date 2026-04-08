# Clay Views

A "view" is a saved filter/sort/column-order configuration on a table. Views are how you control which rows `clay_read_rows` returns. Every table has at least one view (a default `'All rows'` view).

## Endpoints

| Method | Path | Tool | Notes |
|---|---|---|---|
| POST | `/v3/tables/{tableId}/views` | `clay_create_view` | Body `{name (required)}` → returns full view object with `id (gv_…)`, `fields`, `sort: null`, `filter: null` |
| PATCH | `/v3/tables/{tableId}/views/{viewId}` | `clay_update_view` | Body `{name?, filter?, sort?}` |
| DELETE | `/v3/tables/{tableId}/views/{viewId}` | `clay_delete_view` | Returns `{}`. **Cannot delete the last view** — at least one must remain on every table. |

There is **no standalone GET** for views. Read views via `clay_get_table_schema` → `views[]`. Other view paths (`/v3/views`, `/v3/grid-views`) all 404.

## What works vs what doesn't

- ✅ **Create view with a name** — works.
- ✅ **Rename view** — `PATCH {name: "..."}` works.
- ✅ **Reorder columns per view** — works via the `fields` map (each entry has `{order, isVisible, width, isPinned}`).
- ⚠️ **Set filter / sort via PATCH** — endpoint accepts the call (200), but the returned view shows `filter: null` and `sort: null`. The payload format hasn't been figured out yet. If you need a filtered view, the safest approach today is to ask the user to configure the filter in the Clay UI once, then read it back via `clay_get_table_schema` and reuse that view.

## View object shape

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

## When to create vs reuse views

- **Reuse `'All rows'` (or `'Default view'`)** for any full-table read.
- **Create a new view** when you need a stable column ordering or visibility set for a specific consumer (e.g. a dashboard read).
- **Don't create views to filter** — until the filter PATCH payload is figured out, filtering via API is unreliable. Use formula columns + `'errored_rows'` style preconfigured views instead.
