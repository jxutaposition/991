# Notion Gotchas

- **Rollup fields are NOT writable** via the Notion API. Use Lovable/Supabase for dynamic dashboards needing aggregated/computed fields.
- **Rich text blocks have a 2000 character limit.**
- **Pagination required** for queries returning more than 100 results.
- **Page IDs from URLs:** last segment of `notion.so/workspace/<page_id>`, dashes can be omitted.
- **Internal integrations** can only access pages explicitly shared with them via the Share menu.
- **Cannot create workspace-level pages** with internal integration tokens. Always use a parent page.
