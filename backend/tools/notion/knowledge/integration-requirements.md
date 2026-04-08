# Notion — Integration Requirements

## Credentials

Notion integration token (internal integration) — configured in Settings > Integrations.

## Access Model

- **CRITICAL**: Internal integration tokens can ONLY access pages and databases that have been explicitly shared with the integration by the user in the Notion UI.
- The token does NOT give workspace-wide access.
- Agents cannot list "all databases" — only ones shared with the integration appear in search results.
- If a user provides a database ID the integration can't access, the API returns 404.
- Rollup fields are NOT writable via API.
- Rich text blocks have a 2000 character limit per block.

## Runtime Configuration

### Database ID (for creating pages)

- **What**: The Notion database ID where new pages should be created
- **Why**: Any workflow that creates Notion pages needs a target database
- **Input type**: `notion_database`
- **How to ask**: Use `request_user_action` with a `type: "inputs"` section:
  ```json
  {
    "type": "inputs",
    "title": "Notion Configuration",
    "inputs": [{
      "id": "notion_database_id",
      "label": "Notion database",
      "input_type": "notion_database",
      "required": true,
      "description": "Which database should new pages be created in? Make sure this database is shared with the Notion integration."
    }]
  }
  ```
- **How to validate**: Call `GET /v1/databases/{id}`. HTTP 200 = accessible. 404 = not shared with integration or doesn't exist.
- **Fallback**: Offer to create a new database. The user must then share it with the integration in Notion's UI before the agent can write to it.

### Parent Page (for creating databases)

- **What**: The Notion page under which new databases should be created
- **Why**: Databases are children of pages in Notion's hierarchy
- **Input type**: `notion_page`
- **Required**: false — if omitted, creates at workspace root (if the integration has access)
- **How to validate**: Call `GET /v1/pages/{id}`. 200 = accessible.

### Sharing Reminder

When asking for Notion resources, always remind the user: "Make sure this page/database is shared with the Notion integration. In Notion, open the page → click '...' → 'Add connections' → select the integration."
