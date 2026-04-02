# HeyReach n8n Instance Notes

## Credentials

OAuth2 credentials in n8n are all for HeyReach accounts (not Lele/woshicorp). When troubleshooting OAuth2 issues, assume the credentials belong to HeyReach team members.

Known OAuth2 credentials:
- "Latest" (pp2vv8C35I7msPxd) — used by Expert Program welcome DM node; may need reconnecting
- Account 4 — missing scopes
- Account 6 — inactive

The lele2.0 bot token is stored as `slackApi` (Header Auth), NOT Slack OAuth2. It cannot register event subscriptions for trigger nodes.

## API Notes

Before any API call against `heyreach.app.n8n.cloud`:

- Workspace has 3 projects: **Home** (shared), **Spremo**, **Personal** (woshicorp account)
- Workflows built by Lele/woshicorp live in the **Personal** project
- When fetching or listing Personal project workflows via API, scope the call with `?projectId=personal` — without it the call hits the shared Home project and returns 404 for Personal-only workflows
- This was the root cause of the n8n API error in session 2026-03-24: workflow `HERTjOX24Hzv2g3c` (Tolt CSV Group Reassign) returned 404 until projectId was scoped correctly
