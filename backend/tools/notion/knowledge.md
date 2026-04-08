# Notion Platform Knowledge

## How Notion Works

Notion is a workspace platform for docs, wikis, and databases. Content is organized as pages containing blocks (text, headings, tables, callouts, etc.). Databases are structured collections with typed properties.

## Authentication

Auth is automatic — `Authorization` and `Notion-Version` headers are injected by the system for requests to `api.notion.com`. Do NOT set these headers yourself.

## Internal Integrations

Internal integration tokens can only see pages explicitly shared with the integration (via Share menu in Notion). They cannot create workspace-level pages.

## Standard Workflow

1. **Search first:** `POST /v1/search` with `{"page_size": 100}` to discover accessible pages
2. **Pick a parent:** Use an accessible page as parent for new content
3. **Create the page:** `POST /v1/pages` with `parent: {"page_id": "<id>"}`
4. **Add content blocks:** `PATCH /v1/blocks/<page_id>/children`
5. **Verify:** `GET /v1/pages/<page_id>` to confirm creation

If search returns nothing, the integration has no shared pages — user must share pages with the integration first.

## Pagination

All list endpoints return `has_more` (boolean) and `next_cursor` (string or null). If `has_more` is `true`, repeat the request with `start_cursor` set to `next_cursor`. Keep fetching until `has_more` is `false`. This applies to search, database queries, and block children.

## Common Operations

- **Search:** `POST /v1/search` with `{"page_size": 100}`
- **Create page:** `POST /v1/pages` with parent and title properties
- **Append blocks:** `PATCH /v1/blocks/{page_id}/children`
- **Create DB row:** `POST /v1/pages` with `parent: {"database_id": "..."}`
- **Query database:** `POST /v1/databases/{id}/query`
- **Update page:** `PATCH /v1/pages/{page_id}`
- **Get blocks:** `GET /v1/blocks/{block_id}/children`
- **Create database:** `POST /v1/databases` with parent and properties schema

## Formatting Standards

When creating documentation:
- Use Notion's native block types (headings, callouts, toggles, tables)
- Lead with conclusion, not background
- Keep pages scannable with toggles for detail
- Link related pages instead of duplicating content
- Mark data gaps with callout blocks

## Gotchas

- **Rollup fields are NOT writable** via the Notion API. Use Lovable/Supabase for dynamic dashboards needing aggregated/computed fields.
- **Rich text blocks have a 2000 character limit.**
- **Pagination required** for queries returning more than 100 results.
- **Page IDs from URLs:** last segment of `notion.so/workspace/<page_id>`, dashes can be omitted.
- **Internal integrations** can only access pages explicitly shared with them via the Share menu.
- **Cannot create workspace-level pages** with internal integration tokens. Always use a parent page.
