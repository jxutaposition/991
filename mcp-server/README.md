# Lele MCP Server

A remote MCP (Model Context Protocol) server that bridges Claude Code to the Lele 2.0 agent platform. Runs on your server alongside the Lele backend. Users connect with a single URL -- no local installation required.

## Architecture

```
User's Machine                          Your Server (EC2)
┌────────────────────┐                ┌──────────────────────────────┐
│ Claude Code        │   HTTP/S       │ MCP Server (:3002)           │
│  ├── reads files   ├──────────────► │  └── /mcp endpoint           │
│  ├── runs tools    │                │        │ (localhost)          │
│  └── edits code    │                │        ▼                     │
│                    │                │ Lele Backend (:3001)          │
│ No install needed  │                │  ├── Planner                 │
│                    │                │  ├── Master Orchestrator      │
│                    │                │  ├── Clay / n8n / Notion ...  │
│                    │                │  └── Domain Agents            │
└────────────────────┘                └──────────────────────────────┘
```

## Server Setup

### 1. Build and start

```bash
cd mcp-server
npm install
npm run build
npm start
```

The server starts on port 3002 by default and connects to the Lele backend at `localhost:3001`.

### 2. Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LELE_BACKEND_URL` | `http://localhost:3001` | URL of the Lele backend |
| `MCP_PORT` | `3002` | Port the MCP server listens on |

### 3. Expose to the internet

The MCP server needs to be reachable from your users' machines. Options:
- **Reverse proxy** (recommended): Add to your nginx/caddy config as `/mcp` route
- **Direct**: Open port 3002 in your security group

## User Setup (one command)

Users add the server to their Claude Code with a single command:

```bash
claude mcp add --transport http lele https://your-server.com/mcp
```

Or add to their `.mcp.json` / `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "lele": {
      "type": "http",
      "url": "https://your-server.com/mcp",
      "headers": {
        "Authorization": "Bearer ${LELE_TOKEN}"
      }
    }
  }
}
```

### Authentication

Users authenticate with the same JWT they use for the Lele web UI. The MCP server passes the Bearer token through to the backend -- no separate auth system.

To get a token, users log into the Lele web UI (Google Sign-In), and the token is available in localStorage as `99percent_token`. In the future, this can be replaced with a proper OAuth flow or API keys.

## Available Tools

| Tool | Purpose |
|------|---------|
| `lele_submit_request` | Submit a task to Lele. Include local context (file schemas, URLs, conventions) in the text. |
| `lele_get_plan` | Check if the plan is ready. Returns node details when status is `awaiting_approval`. |
| `lele_approve_plan` | Approve the plan and start agent execution. |
| `lele_get_status` | Monitor execution progress. Highlights agents that need input. |
| `lele_get_node_output` | Get the full output from a specific agent node. |
| `lele_reply` | Reply to an agent waiting for input (`awaiting_reply` status). |
| `lele_chat` | Send a message to the session orchestrator (plan changes, follow-ups). |
| `lele_stop` | Cancel a running session. |

## Available Resources

| Resource | Purpose |
|----------|---------|
| `lele://agents` | Browse all available agents and their capabilities. |
| `lele://agents/{slug}` | Detailed info about a specific agent. |

## Example Workflow

User says to Claude Code:

> "Set up lead enrichment. Leads come from data/leads.csv, enriched data should trigger Slack alerts via n8n."

Claude Code:
1. Reads `data/leads.csv` locally to understand the schema
2. Reads `lele://agents` resource to know what Lele can do
3. Calls `lele_submit_request` with the task + schema context
4. Calls `lele_get_plan` to get the plan, presents it to the user
5. Calls `lele_approve_plan` after user confirms
6. Polls `lele_get_status`, answers agent questions from local files
7. Gets results via `lele_get_node_output`, does local follow-up (updates config, README)
