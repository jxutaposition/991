# Notion API Reference

## Base URL
`https://api.notion.com/v1`

## Auth
Header: `Authorization: Bearer <token>`
Header: `Notion-Version: 2022-06-28`  ← use this stable version unless told otherwise

## Key Endpoints

### Search
`POST /v1/search`
Body: `{ "query": "page title", "filter": { "value": "page", "property": "object" } }`
Returns list of matching pages/databases.

### Retrieve a Page
`GET /v1/pages/{page_id}`

### Create a Database
`POST /v1/databases`
Body:
```json
{
  "parent": { "type": "page_id", "page_id": "<page_id>" },
  "title": [{ "type": "text", "text": { "content": "Database Title" } }],
  "is_inline": true,
  "properties": {
    "Name": { "title": {} },
    "SomeProperty": { "rich_text": {} },
    "Score": { "number": { "format": "number" } },
    "Status": { "select": { "options": [{ "name": "Option1", "color": "blue" }] } },
    "URL": { "url": {} },
    "Date": { "date": {} },
    "Checkbox": { "checkbox": {} },
    "MultiSelect": { "multi_select": { "options": [] } }
  }
}
```

### Query a Database
`POST /v1/databases/{database_id}/query`

### Create a Page (row in DB)
`POST /v1/pages`
Body: `{ "parent": { "database_id": "<db_id>" }, "properties": { ... } }`

### Update a Page
`PATCH /v1/pages/{page_id}`

### Retrieve Block Children (page content)
`GET /v1/blocks/{block_id}/children`

## Notes
- Page IDs can be extracted from Notion URLs: `notion.so/workspace/<page_id>` or last segment
- Dashes can be omitted from UUIDs in requests
- API version 2022-06-28 is the most stable for database creation
