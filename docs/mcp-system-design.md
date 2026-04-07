# Lele MCP Server -- System Design

## What This Is

The Lele MCP server lets users interact with the Lele agent platform through Claude Code (or any MCP-compatible client). Instead of using the web UI, a user talks to Claude Code naturally, and Claude Code delegates complex GTM/ops work to Lele's specialized agents running on the server.

The MCP server is a thin HTTP bridge -- it translates MCP protocol requests into calls to the existing Lele REST API. It runs alongside the Lele backend on the same server. Users connect from their local Claude Code with a single URL. No local installation required.

---

## Architecture

```
User's Machine                              Lele Server (EC2 / Cloud)
┌──────────────────────────┐               ┌─────────────────────────────────────┐
│                          │               │                                     │
│  Claude Code             │               │  MCP Server (:3002)                 │
│  ┌──────────────────┐    │    HTTPS      │  ┌─────────────────────────────┐    │
│  │ User's LLM       │    │◄────────────► │  │ /mcp endpoint               │    │
│  │ (reasoning,       │    │  Streamable   │  │ Bearer token auth           │    │
│  │  local tools,     │    │  HTTP         │  │ Per-session MCP instances   │    │
│  │  file access)     │    │               │  └──────────┬──────────────────┘    │
│  └──────────────────┘    │               │             │ localhost              │
│                          │               │             ▼                        │
│  Local capabilities:     │               │  Lele Backend (:3001)               │
│  - Read/write files      │               │  ┌─────────────────────────────┐    │
│  - Run terminal commands │               │  │ Planner                     │    │
│  - Browse codebase       │               │  │ Master Orchestrator         │    │
│  - Git operations        │               │  │ Work Queue                  │    │
│  - Other MCP servers     │               │  │ Agent Runner + Judge Loop   │    │
│                          │               │  └──────────┬──────────────────┘    │
└──────────────────────────┘               │             │                        │
                                           │             ▼                        │
                                           │  Domain Agents                      │
                                           │  ┌───────────┬───────────────────┐  │
                                           │  │ Clay Op   │ n8n Op            │  │
                                           │  │ Notion Op │ Dashboard Builder │  │
                                           │  │ Tolt Op   │ Lovable Op        │  │
                                           │  └───────────┴───────────────────┘  │
                                           │             │                        │
                                           │             ▼                        │
                                           │  External APIs (Clay, n8n, Notion,  │
                                           │  Tolt, Supabase, etc.)              │
                                           └─────────────────────────────────────┘
```

### Why this split

| Responsibility | Where it lives | Why |
|---|---|---|
| Understanding user intent | Claude Code (local) | It has the conversation context and can ask clarifying questions |
| Reading local files, codebase, schemas | Claude Code (local) | Direct filesystem access |
| Enriching requests with local context | Claude Code (local) | Can analyze files before sending to Lele |
| Planning agent execution | Lele backend (server) | Has the full agent catalog, planner prompts, and client context |
| Domain expertise (Clay API, n8n patterns, etc.) | Lele agents (server) | Encapsulated in agent prompts, knowledge docs, and tools |
| External API credentials | Lele backend (server) | Managed securely per-client, never exposed to the user |
| Quality control (judge loops) | Lele backend (server) | Agents are validated before results are returned |
| Local follow-up (editing files, running commands) | Claude Code (local) | Direct system access |

The core principle: **Claude Code is the interface layer; Lele agents are the execution layer.** Neither tries to do the other's job.

---

## How Connection Works

### User setup (one-time)

```bash
claude mcp add --transport http lele https://your-server.com/mcp
```

This registers the Lele MCP server in the user's Claude Code config. The URL points to the MCP server running on your infrastructure.

### Authentication

The user provides a Bearer token via Claude Code's MCP header configuration:

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

The token is the same JWT used by the web UI (obtained via Google Sign-In). The MCP server passes it through to the Lele backend on every API call -- no separate auth system.

### Session lifecycle

Each Claude Code connection creates an MCP session (identified by a UUID). Within that session, the user's Bearer token is bound to a `LeleApiClient` instance. All tool calls within that session use the same authenticated client. When the Claude Code process disconnects, the MCP session is cleaned up.

---

## What Claude Code Can Do

### Available tools

| Tool | What it does | When to use it |
|---|---|---|
| `lele_submit_request` | Creates a new Lele execution session from a text description. Returns a session_id. | User asks for something that involves Clay, n8n, Notion, dashboards, or other Lele-managed tools. |
| `lele_get_plan` | Fetches the current plan for a session. Returns session status and all execution nodes. | After submitting a request, to check when the plan is ready for review. |
| `lele_approve_plan` | Approves the plan and starts agent execution. | After reviewing the plan with the user and getting their go-ahead. |
| `lele_get_status` | Checks execution progress. Lists all nodes with their statuses. Highlights nodes waiting for input. | During execution, to monitor progress and detect when agents need help. |
| `lele_get_node_output` | Gets the full conversation stream for a specific agent node (messages, tool calls, thinking). | After a node completes, to see what the agent did and extract results. |
| `lele_reply` | Sends a reply to an agent that is blocked waiting for user input (`awaiting_reply` status). | When `lele_get_status` shows a node needs input. Claude Code may answer from local context without asking the user. |
| `lele_chat` | Sends a message to the session orchestrator. Used for pre-approval context/changes or post-execution follow-ups. | To refine the plan before approval, or ask questions about results after execution. |
| `lele_stop` | Cancels a running session and all its pending nodes. | User wants to abort, or something is clearly going wrong. |

### Available resources

| Resource URI | Content |
|---|---|
| `lele://agents` | Human-readable catalog of all agents with descriptions, intent keywords, and required integrations. |
| `lele://agents/{slug}` | JSON detail for a specific agent (e.g., `lele://agents/clay_operator`). |

Claude Code reads these resources to understand what Lele can do before crafting a request.

---

## Typical Interaction Flow

### Step-by-step

```
User: "Build a Clay enrichment table for our leads and wire it to Slack via n8n"
  │
  ▼
Claude Code: reads local files (leads.csv, config, etc.)
  │          reads lele://agents resource
  │          crafts enriched request_text with schema info
  │
  ▼
lele_submit_request("Build Clay enrichment table for leads.
  Schema: name, email, company, title, linkedin_url (~2400 rows).
  Wire enriched rows to #sales-alerts via n8n webhook at
  https://n8n.example.com/webhook/enriched")
  │
  ▼
Backend: planner generates execution plan (master_orchestrator + child nodes)
  │
  ▼
lele_get_plan(session_id) → status: "planning" (wait...)
lele_get_plan(session_id) → status: "awaiting_approval"
  │                          nodes: [clay_operator, n8n_operator]
  ▼
Claude Code: presents plan to user
User: "Looks good, approve it"
  │
  ▼
lele_approve_plan(session_id)
  │
  ▼
Backend: master_orchestrator runs, spawns child agents
  │
  ▼
lele_get_status(session_id) → clay_operator: EXECUTING, n8n_operator: PREVIEW
  ... (poll periodically)
lele_get_status(session_id) → clay_operator: AWAITING_REPLY
  │
  ▼
Claude Code: reads the question, checks local files, answers or asks user
lele_reply(session_id, node_id, "Use Clearbit and Apollo for enrichment")
  │
  ▼
  ... (agents continue working)
  │
  ▼
lele_get_status(session_id) → all nodes PASSED, session COMPLETED
lele_get_node_output(session_id, clay_node_id) → table ID, config details
lele_get_node_output(session_id, n8n_node_id) → workflow URL, webhook details
  │
  ▼
Claude Code: updates local config.ts with table ID
              updates README with new pipeline docs
              tells user "Done, here's what was built..."
```

### What makes this powerful

Claude Code can **interleave Lele work with local work**:
- Read local files before submitting to give agents better context
- Answer agent questions using local knowledge (schemas, configs, URLs)
- After agents finish, write results into local files (config updates, documentation)
- Combine Lele agent work with other MCP servers (GitHub, databases, etc.)
- Run multiple Lele sessions in sequence as part of a larger workflow

---

## What Claude Code CANNOT Do (Limitations)

### Cannot control individual agents directly

Claude Code talks to Lele as a whole through the session lifecycle (submit -> plan -> approve -> monitor -> get results). It cannot:
- Skip the planner and run a specific agent directly
- Override which agents the planner selects
- Change an agent's tools or knowledge at runtime
- See an agent's internal system prompt or knowledge docs

This is by design -- the agents' domain expertise is encapsulated. Claude Code doesn't need to understand Clay's API to get a Clay table built.

### Cannot stream real-time agent output

The current implementation uses **poll-based status checking** (`lele_get_status`). Claude Code calls it periodically to check progress. It does not receive live streaming text deltas as agents work. This means:
- There's latency between an agent finishing and Claude Code knowing about it
- Claude Code decides its own polling interval (typically every few seconds)
- Long-running agent work appears as a status change, not a live stream

Future enhancement: use MCP server notifications to push status changes to Claude Code in real-time.

### Cannot access server-side knowledge

Lele's agents have rich knowledge bases (markdown docs, RAG corpus, client-specific context). Claude Code cannot:
- Search or read the agent knowledge docs
- Access the client's RAG corpus
- See previous session history from the web UI

Claude Code has its own knowledge -- the user's local files and codebase. The two knowledge pools are complementary but separate.

### Token expiry

JWTs last 7 days. When a token expires, the user needs to get a fresh one from the web UI. There is no automatic refresh flow yet.

### No workspace/client selection in MCP

The web UI has workspace switching (multiple clients per user). In the MCP flow, Claude Code can pass `client_slug` as a parameter to `lele_submit_request`, but there's no built-in way to list or switch workspaces. If a user has multiple workspaces, they need to know their client slug.

---

## Comparison: MCP vs Web UI vs Slack

| Capability | Web UI | Slack | MCP (Claude Code) |
|---|---|---|---|
| Submit requests | Text input | `/99percent run` | `lele_submit_request` |
| Review plans | Visual canvas with node graph | Block Kit message | Text summary in Claude Code |
| Approve plans | Click button | Click "Approve" button | `lele_approve_plan` tool call |
| Monitor execution | Live streaming canvas + SSE | Thread updates | Poll via `lele_get_status` |
| Agent clarifications | Reply in inspector panel | Reply in thread | `lele_reply` tool call |
| View results | Full conversation stream + artifacts | Thread summary | `lele_get_node_output` |
| Edit plan before approval | Node editor | Not supported | `lele_chat` to request changes |
| Local file integration | Not possible | Not possible | Native (Claude Code reads/writes local files) |
| Combine with other work | Manual copy-paste | Not possible | Claude Code interleaves Lele with local tools |
| Credential management | Settings UI | Not supported | Not supported (uses web UI) |
| Setup effort | Log in with Google | Install Slack app + connect | One `claude mcp add` command |

### Key advantage of MCP

The MCP integration uniquely enables **context enrichment** -- Claude Code reads local files, understands the codebase, and packages that knowledge into requests. This makes agent output significantly more relevant because the agents know about the user's specific schema, URLs, conventions, and constraints. Neither the web UI nor Slack can do this.

---

## Server-Side Components

### MCP Server (`mcp-server/`)

| File | Purpose |
|---|---|
| `src/index.ts` | Express HTTP server, MCP transport setup, tool and resource definitions |
| `src/api-client.ts` | Typed HTTP client wrapping all Lele backend REST endpoints |
| `src/types.ts` | TypeScript interfaces matching backend response shapes |

The MCP server is stateless from a data perspective -- all state lives in the Lele backend's Postgres database. The server only holds in-memory MCP transport sessions (which map to authenticated `LeleApiClient` instances).

### How tool calls flow through the system

```
Claude Code                   MCP Server                 Lele Backend
    │                             │                           │
    │  MCP JSON-RPC over HTTP     │                           │
    │  (tool: lele_get_status)    │                           │
    ├────────────────────────────►│                           │
    │                             │  GET /api/execute/:id     │
    │                             │  Authorization: Bearer    │
    │                             ├──────────────────────────►│
    │                             │                           │  SQL query
    │                             │  { session, nodes[] }     │  session + nodes
    │                             │◄──────────────────────────┤
    │                             │                           │
    │  Format into readable text  │                           │
    │  (node summaries, status,   │                           │
    │   awaiting_reply flags)     │                           │
    │◄────────────────────────────┤                           │
    │                             │                           │
```

The MCP server does two things beyond proxying:
1. **Auth passthrough**: Extracts Bearer token from the MCP request and attaches it to backend calls
2. **Response formatting**: Converts raw JSON into human-readable text that Claude Code's LLM can reason over effectively (e.g., highlighting `awaiting_reply` nodes, truncating large outputs)

---

## Security Considerations

### Authentication
- Bearer tokens (JWTs) are passed from Claude Code to the MCP server in the Authorization header
- The MCP server never stores tokens -- they are bound to in-memory transport sessions
- The backend validates the JWT on every API call (same auth middleware as the web UI)
- Token expiry is enforced by the backend (7-day window)

### Authorization
- Users can only see/modify sessions that belong to their account or client
- The backend's `user_client_roles` table enforces workspace-level permissions
- Credential management (API keys for Clay, n8n, etc.) is entirely server-side -- never exposed through MCP

### Network
- The MCP server should be behind HTTPS (TLS termination at reverse proxy)
- CORS is enabled for cross-origin requests from Claude Code
- The MCP server to backend connection is localhost (never exposed to the internet)

---

## Deployment

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `LELE_BACKEND_URL` | `http://localhost:3001` | Backend API URL (should be localhost in production) |
| `MCP_PORT` | `3002` | Port the MCP server listens on |

### Running alongside the backend

```bash
# In your deployment (docker-compose, systemd, etc.)
cd mcp-server && npm start
# Listens on :3002, talks to backend at localhost:3001
```

### Reverse proxy config (nginx example)

```nginx
location /mcp {
    proxy_pass http://127.0.0.1:3002/mcp;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Connection '';
    proxy_buffering off;           # Required for SSE
    proxy_cache off;
    chunked_transfer_encoding on;
}
```

---

## Future Enhancements

| Enhancement | What it would enable | Effort |
|---|---|---|
| OAuth integration | Users authenticate by clicking "Allow" in browser -- no manual token copy | Medium |
| Real-time notifications | Push agent status changes to Claude Code instead of polling | Low-Medium |
| Workspace listing tool | `lele_list_workspaces` so users can discover/switch clients | Low |
| Session history resource | `lele://sessions/recent` so Claude Code can reference past work | Low |
| Structured context field | Dedicated `additional_context` field on the backend instead of inline in request_text | Low |
| API key auth | Long-lived API keys instead of expiring JWTs | Low |
| Agent catalog from backend | Dynamic `GET /api/agents/catalog` endpoint instead of hardcoded list | Low |
