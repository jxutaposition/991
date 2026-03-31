---
name: n8n
description: n8n workflow automation expert. Routes to sub-skills for expressions, node configuration, workflow patterns, code nodes (JavaScript/Python), MCP tools, and validation. Triggers on any n8n workflow, node, expression, or automation question.
---

# n8n Master Skill

You are an n8n workflow automation expert. Route questions to the appropriate sub-skill.

## Sub-Skills

| Sub-skill | Triggers |
|-----------|---------|
| `expression-syntax` | Writing expressions, `{{}}` syntax, `$json`/`$node` variables, expression errors |
| `node-configuration` | Configuring nodes, required fields, property dependencies, operation-aware setup |
| `workflow-patterns` | Workflow architecture, webhook processing, HTTP API integration, database ops, AI agents, scheduled tasks |
| `code-javascript` | JavaScript in Code nodes, `$input`/`$json`/`$helpers`, DateTime, Code node errors |
| `code-python` | Python in Code nodes, `_input`/`_json` syntax, standard library, Python limitations |
| `mcp-tools-expert` | Searching nodes, validating configurations, templates, managing workflows via n8n-mcp tools |
| `validation-expert` | Validation errors, warnings, false positives, operator structure, validation loop |

## HeyReach n8n Instance — Credentials

**OAuth2 credentials in n8n are all for HeyReach accounts** (not Lele/woshicorp). There may be a Lele account connected but this is unconfirmed. When troubleshooting OAuth2 issues, assume the credentials belong to HeyReach team members.

Known OAuth2 credentials:
- "Latest" (pp2vv8C35I7msPxd) — used by Expert Program welcome DM node; may need reconnecting
- Account 4 — missing scopes
- Account 6 — inactive

The lele2.0 bot token is stored as `slackApi` (Header Auth), NOT Slack OAuth2. It cannot register event subscriptions for trigger nodes.

---

## HeyReach n8n Instance — API Notes

Before any API call against `heyreach.app.n8n.cloud`:

- Credentials and API key: `client/access/n8n.md`
- Workspace has 3 projects: **Home** (shared), **Spremo**, **Personal** (woshicorp account)
- Workflows built by Lele/woshicorp live in the **Personal** project
- When fetching or listing Personal project workflows via API, scope the call with `?projectId=personal` — without it the call hits the shared Home project and returns 404 for Personal-only workflows
- This was the root cause of the n8n API error in session 2026-03-24: workflow `HERTjOX24Hzv2g3c` (Tolt CSV Group Reassign) returned 404 until projectId was scoped correctly

## Skill Base Directory
Locate sub-skills relative to this file's location at `.claude/skills/n8n/`.
