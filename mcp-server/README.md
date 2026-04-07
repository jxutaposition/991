# Lele MCP Server

An MCP (Model Context Protocol) server that bridges Claude Code to the Lele 2.0 agent platform. Claude Code acts as the smart local client — reading your files, understanding your codebase, enriching requests with local context — while Lele's server-side agents handle domain-specific work (Clay tables, n8n workflows, Notion pages, dashboards, etc.).

## Setup

### 1. Build the server

```bash
cd mcp-server
npm install
npm run build
```

### 2. Get a JWT token

Log into the Lele web UI normally, then grab the token from your browser:

1. Open the Lele frontend in your browser and log in
2. Open DevTools → Application → Local Storage
3. Copy the value of `99percent_token`

This token will expire eventually. For long-term use, ask for an API key to be added to the backend.

### 3. Configure Claude Code

Add this to your Claude Code MCP config (usually `~/.claude/mcp.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "lele": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/dist/index.js"],
      "env": {
        "LELE_BACKEND_URL": "http://localhost:3001",
        "LELE_API_KEY": "your-jwt-token-here"
      }
    }
  }
}
```

Replace `/absolute/path/to/mcp-server` with the actual path to this directory. Replace `LELE_BACKEND_URL` with your Lele backend URL if not running locally.

## Usage

Once configured, Claude Code will have access to these tools:

### Tools

| Tool | Purpose |
|------|---------|
| `lele_submit_request` | Submit a task to Lele for planning. Include local context (file schemas, URLs, conventions) in the request text. |
| `lele_get_plan` | Check if the plan is ready. Returns node details when status is `awaiting_approval`. |
| `lele_approve_plan` | Approve the plan and start agent execution. |
| `lele_get_status` | Monitor execution progress. Shows which agents are running, done, or need input. |
| `lele_get_node_output` | Get the full output from a specific agent node. |
| `lele_reply` | Reply to an agent that is waiting for input (status: `awaiting_reply`). |
| `lele_chat` | Send a message to the session orchestrator (for plan changes or follow-ups). |
| `lele_stop` | Cancel a running session. |

### Resources

| Resource | Purpose |
|----------|---------|
| `lele://agents` | Browse all available agents and their capabilities. |
| `lele://agents/{slug}` | Detailed info about a specific agent. |

### Example workflow

You say to Claude Code:

> "I need to set up lead enrichment. The leads come from data/leads.csv and enriched data should trigger a Slack alert via our n8n automation."

Claude Code will:

1. Read `data/leads.csv` to understand your schema
2. Read the agent catalog to know what Lele can do
3. Submit an enriched request to Lele with your schema context
4. Show you the plan and ask for approval
5. Monitor execution, answering agent questions from local context when possible
6. Present results and optionally update local files (config, README, etc.)

## Architecture

```
Your Machine                          Lele Backend
┌────────────────────┐                ┌──────────────────────────┐
│ Claude Code        │                │ REST API                 │
│  ├── reads files   │  MCP (stdio)   │  ├── Planner             │
│  ├── runs tools   ◄──────────────►  │  ├── Master Orchestrator │
│  └── edits code    │   HTTP/S       │  ├── Clay Operator       │
│                    │                │  ├── n8n Operator         │
│ MCP Server (local) │                │  ├── Notion Operator     │
│  └── thin bridge   │                │  └── ... more agents     │
└────────────────────┘                └──────────────────────────┘
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LELE_BACKEND_URL` | Yes | URL of the Lele backend (e.g., `http://localhost:3001` or `https://your-instance.com`) |
| `LELE_API_KEY` | Yes | JWT token or API key for authentication |
