# INV-002: Table Lifecycle via v3

**Status**: not-started
**Priority**: P0
**Gap**: GAP-002 (Table Lifecycle via v3)
**Date started**: --
**Date completed**: --

## Hypothesis

Clay's frontend must call a v3 API endpoint to create and delete tables. If we can identify these endpoints and their payloads, we unlock the highest-value capability gap: programmatic table creation.

Expected patterns:
- `POST /v3/tables` or `POST /v3/workspaces/{id}/tables` for creation
- `DELETE /v3/tables/{tableId}` for deletion
- Possibly `PATCH /v3/tables/{tableId}` for renaming/updating

## Method

1. **Depends on INV-001**: If the CDP sprint reveals table lifecycle endpoints, document them here
2. **Direct probing**: Try the expected endpoints with `harness/scripts/probe-endpoint.ts`
3. **Payload discovery**: If creation endpoint is found, probe for required vs. optional fields

### Specific probes:
```
POST /v3/tables {"workspaceId": N, "name": "Test Table"}
POST /v3/workspaces/{id}/tables {"name": "Test Table"}
DELETE /v3/tables/{tableId}
PATCH /v3/tables/{tableId} {"name": "Renamed"}
```

## Findings

*Not yet started.*

## New Endpoints Discovered

*Will be added to `registry/endpoints.jsonl` as discovered.*

## Implications

If table creation works via v3:
- The `clay_operator` can fully automate workbook setup (currently the biggest `request_user_action` bottleneck)
- Schema import can create the table first, then import columns
- End-to-end pipeline setup (table + columns + sources + webhooks) becomes fully programmatic

If table creation does NOT work via v3:
- Playwright automation becomes the only option for table creation
- Need to map the table creation UI flow in detail (see `harness/prompts/dom-mapping.md`)

## Next Steps

*Based on findings.*
