---
name: notion
description: Interact with the Notion API to create pages, create databases, query databases, update pages, and retrieve block children. Triggers on "notion", "add to notion", "create notion page", "notion database", "notion api".
---

# Notion

## References
- `resources/api-reference.md` — full endpoint reference with request/response shapes
- `skills/notion-doc-style.md` — formatting/voice rules for community-facing 1-pagers and program docs in Notion

## Universal Notes
- Always use API version `2022-06-28` (header: `Notion-Version: 2022-06-28`)
- Extract page IDs from Notion URLs: last segment of `notion.so/workspace/<page_id>`
- Dashes can be omitted from UUIDs in requests
- Rollup fields are NOT writable via the Notion API — use Lovable for dynamic dashboards that require aggregated/computed fields; Notion is for documentation, meeting notes, and static pages

## Common Operations

### Create a page (row in a database)
`POST /v1/pages`
Body: `{ "parent": { "database_id": "<db_id>" }, "properties": { ... } }`

### Query a database
`POST /v1/databases/{database_id}/query`

### Update a page
`PATCH /v1/pages/{page_id}`

### Retrieve block children (page content)
`GET /v1/blocks/{block_id}/children`

### Create a database
`POST /v1/databases`
Requires `parent.page_id` and `properties` schema — see `resources/api-reference.md` for full shape.

### Search
`POST /v1/search`
Body: `{ "query": "title", "filter": { "value": "page", "property": "object" } }`
