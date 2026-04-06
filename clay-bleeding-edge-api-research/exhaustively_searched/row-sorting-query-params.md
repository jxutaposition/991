# Row Sorting via Query Parameters

**Status**: NOT AVAILABLE — sorting is view-level only
**Investigated**: INV-017 (Session 4)

## Params Tested (All Silently Ignored)
- `sort=f_xxx&direction=ASC`
- `sort=f_xxx&direction=DESC`
- `sortBy=f_xxx&order=asc`
- `orderBy=f_xxx&order=desc`
- `sort=f_created_at&direction=DESC`
- `sortField=f_xxx&sortDirection=asc`

All return rows in the same default order regardless of params.

## Alternative
Sorting is controlled by the view definition. However, setting sort on a view via PATCH also doesn't persist (see view-filter-sort.md). The only sorted views are preconfigured ones.
