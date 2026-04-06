# Search API

**Status**: NO ENDPOINTS EXIST
**Investigated**: INV-018 (Session 5)
**Note**: `enableSemanticSearch: false` and `enableSearchBarUI: true` in feature flags. Search is UI-only.

## Paths Tested (All 404)
- `GET /v3/search?q=test&workspaceId=`
- `GET /v3/workspaces/{id}/search?q=test`
