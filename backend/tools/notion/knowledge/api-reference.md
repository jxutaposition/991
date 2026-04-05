# Notion API Reference

## Authentication
- Bearer token in `Authorization` header
- `Notion-Version: 2022-06-28` required on all requests

## Create Page
```
POST /v1/pages
{
  "parent": { "database_id": "<db_id>" },
  "properties": { ... }
}
```

## Query Database
```
POST /v1/databases/{database_id}/query
{
  "filter": { "property": "Status", "select": { "equals": "Active" } },
  "sorts": [{ "property": "Created", "direction": "descending" }]
}
```

## Update Page
```
PATCH /v1/pages/{page_id}
{
  "properties": { "Status": { "select": { "name": "Done" } } }
}
```

## Get Block Children
```
GET /v1/blocks/{block_id}/children?start_cursor=...&page_size=100
```

## Create Database
```
POST /v1/databases
{
  "parent": { "page_id": "<page_id>" },
  "title": [{ "text": { "content": "My Database" } }],
  "properties": {
    "Name": { "title": {} },
    "Status": { "select": { "options": [{ "name": "Active" }, { "name": "Archived" }] } }
  }
}
```

## Search
```
POST /v1/search
{
  "query": "title text",
  "filter": { "value": "page", "property": "object" }
}
```

## Pagination

All list endpoints (search, query database, get block children) return a paginated response:
```json
{
  "object": "list",
  "results": [ ... ],
  "has_more": true,
  "next_cursor": "abc123-def456",
  "type": "block_object"
}
```

- Max 100 results per request (`page_size` parameter, default 100)
- If `has_more` is `true`, make another request with `start_cursor` set to the `next_cursor` value
- Keep fetching until `has_more` is `false`
- Works identically for `POST /v1/search`, `POST /v1/databases/{id}/query`, and `GET /v1/blocks/{id}/children`

Example pagination loop for block children:
```
GET /v1/blocks/{block_id}/children?page_size=100
-> if has_more: GET /v1/blocks/{block_id}/children?page_size=100&start_cursor={next_cursor}
-> repeat until has_more is false
```

## Key Constraints
- Rollup properties are read-only
- Rich text blocks have a 2000-character limit per block
- Rate limit: ~3 requests/second average
