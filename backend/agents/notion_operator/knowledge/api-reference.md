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

## Key Constraints
- Rollup properties are read-only
- Rich text blocks have a 2000-character limit per block
- Pagination: max 100 results per request, use `start_cursor` for more
- Rate limit: ~3 requests/second average
