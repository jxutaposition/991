# Tag-to-Table Association

**Status**: NO MECHANISM FOUND via REST API
**Investigated**: INV-025 (Session 10A)

Resource tags can be created and deleted, but we found no way to associate them with tables or workbooks.

## Tested
- PATCH table with `{tags: [tagId]}` — 200 but tags not in response
- PATCH table with `{resourceTags: [tagId]}` — same
- PATCH table with `{tagIds: [tagId]}` — same
- PATCH table with `{resourceTagIds: [tagId]}` — same
- POST `/v3/tables/{id}/tags` — 404
- POST `/v3/tables/{id}/resource-tags` — 404
- PUT `/v3/tables/{id}/tags/{tagId}` — 404
- POST `/v3/resource-tags/{tagId}/tables` — 404

Tag association is likely UI-only or uses a different mechanism.
