#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { LeleApiClient } from "./api-client.js";
import type { AgentInfo, ExecutionNode } from "./types.js";

// ---------------------------------------------------------------------------
// Agent catalog — hardcoded from backend/agents/*/agent.toml
// ---------------------------------------------------------------------------

const AGENT_CATALOG: AgentInfo[] = [
  {
    slug: "clay_operator",
    name: "Clay Operator",
    category: "tool_operator",
    description:
      "Designs, builds, and manages Clay workbooks end-to-end: creates tables, columns, formulas, enrichment configs, webhook sources, and action columns via the v3 API. Full CRUD on tables, rows, columns, sources, and enrichments.",
    intents: [
      "clay", "clay table", "clay setup", "clay enrichment", "clay webhook",
      "clay social listening", "configure clay", "create clay table",
      "clay action column", "clay formula",
    ],
    automation_mode: "full",
    required_integrations: ["clay"],
  },
  {
    slug: "n8n_operator",
    name: "Automation Builder",
    category: "tool_operator",
    description:
      "Designs and builds data pipelines and automations end-to-end using n8n. Handles pipeline architecture (source mapping, transformations, webhooks, conditional routing, edge cases) and implements it by creating n8n workflows, configuring nodes, testing, and activating.",
    intents: [
      "n8n", "workflow", "automation", "n8n workflow", "build workflow",
      "create automation", "webhook workflow", "data pipeline",
      "connect systems", "data flow", "webhook setup", "data sync",
      "integration pipeline", "data routing",
    ],
    automation_mode: "full",
    required_integrations: ["n8n"],
  },
  {
    slug: "notion_operator",
    name: "Notion Operator",
    category: "tool_operator",
    description:
      "Operates the Notion API: creates pages, queries databases, updates properties, manages blocks, and searches content. Follows community-facing formatting standards for program documentation.",
    intents: [
      "notion", "notion page", "notion database", "add to notion",
      "create notion page", "update notion", "notion api",
      "meeting notes", "project plan",
    ],
    automation_mode: "full",
    required_integrations: ["notion"],
  },
  {
    slug: "dashboard_builder",
    name: "Dashboard Builder",
    category: "program_operations",
    description:
      "DEFAULT dashboard agent. Builds React dashboards rendered natively in the platform. Reads data from upstream sources (Clay tables, Supabase, APIs) and outputs a dashboard_spec JSON displayed as interactive charts, tables, funnels, and metrics. Use for any 'dashboard', 'React dashboard', 'analytics', 'leaderboard', or 'data visualization' request.",
    intents: [
      "dashboard", "react dashboard", "internal dashboard", "external dashboard",
      "leaderboard", "points display", "partner dashboard", "program dashboard",
      "data visibility", "build dashboard", "create dashboard",
      "analytics dashboard", "pipeline dashboard", "data visualization",
      "charts", "funnel", "metrics view",
    ],
    automation_mode: "full",
    required_integrations: [],
  },
  {
    slug: "tolt_operator",
    name: "Tolt Operator",
    category: "tool_operator",
    description:
      "Operates Tolt affiliate/referral platform: manages partner groups, tracks referral revenue, handles commission data, processes CSV group reassignments, and integrates with scoring systems.",
    intents: [
      "tolt", "affiliate", "referral", "commission", "partner group",
      "tolt group", "referral revenue", "tolt csv", "affiliate tracking",
    ],
    automation_mode: "full",
    required_integrations: ["tolt"],
  },
  {
    slug: "lovable_operator",
    name: "Lovable Operator",
    category: "tool_operator",
    description:
      "Maintains EXISTING Lovable-hosted projects (lovable.dev) only. Diagnoses issues via Supabase API, generates Lovable chat prompts for UI changes, and pauses for user to apply in Lovable editor. Cannot edit projects directly. Do NOT use for building new dashboards — use dashboard_builder instead.",
    intents: [
      "lovable", "lovable project", "lovable app", "lovable bug",
      "lovable fix", "fix lovable", "lovable dashboard", "lovable not showing",
    ],
    automation_mode: "guided",
    required_integrations: ["supabase"],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatNodeSummary(node: ExecutionNode): string {
  const status = node.status.toUpperCase();
  const agent = node.agent_slug;
  const desc = node.task_description || node.description || "(no description)";
  let line = `[${status}] ${agent}: ${desc}`;
  if (node.status === "awaiting_reply") {
    line += "\n  >> This agent is waiting for your reply. Use lele_reply to respond.";
  }
  if (node.output && node.status === "passed") {
    const preview = node.output.slice(0, 200);
    line += `\n  Output preview: ${preview}${node.output.length > 200 ? "..." : ""}`;
  }
  if (node.error_category) {
    line += `\n  Error: ${node.error_category}`;
  }
  return line;
}

function formatSessionStatus(data: {
  session: { status: string; request_text: string };
  nodes: ExecutionNode[];
}): string {
  const { session, nodes } = data;
  const lines: string[] = [
    `Session status: ${session.status}`,
    `Request: ${session.request_text}`,
    `Nodes (${nodes.length}):`,
  ];

  const awaitingReply = nodes.filter((n) => n.status === "awaiting_reply");
  if (awaitingReply.length > 0) {
    lines.push(`\n>> ${awaitingReply.length} node(s) awaiting your reply:`);
    for (const n of awaitingReply) {
      lines.push(
        `  - Node ${n.id} (${n.agent_slug}): ${n.task_description || n.description || ""}`
      );
    }
    lines.push("");
  }

  for (const node of nodes) {
    if (node.agent_slug === "master_orchestrator" && !node.parent_uid) continue;
    lines.push(`  ${formatNodeSummary(node)}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BACKEND_URL = process.env.LELE_BACKEND_URL || "http://localhost:3001";
const MCP_PORT = parseInt(process.env.MCP_PORT || "3002", 10);

// ---------------------------------------------------------------------------
// Build an MCP server instance (one per session)
// ---------------------------------------------------------------------------

function createMcpServer(token: string): McpServer {
  const api = new LeleApiClient(BACKEND_URL, token);

  const server = new McpServer(
    { name: "lele", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } }
  );

  // -- Tools --

  server.tool(
    "lele_submit_request",
    `Submit a task to the Lele agent platform for planning and execution.
Include relevant local context (file contents, schemas, URLs, conventions)
directly in the request_text. Returns a session_id; call lele_get_plan next.`,
    {
      request_text: z
        .string()
        .describe(
          "The task description. Include any local context (file schemas, URLs, " +
            "codebase conventions) that would help the agents."
        ),
      client_slug: z.string().optional().describe("Client/workspace slug"),
      model: z.string().optional().describe("LLM model override"),
      project_slug: z.string().optional().describe("Project slug"),
    },
    async ({ request_text, client_slug, model, project_slug }) => {
      const result = await api.submitRequest(request_text, {
        clientSlug: client_slug,
        model,
        projectSlug: project_slug,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Session created: ${result.session_id}`,
              `Initial plan nodes: ${result.node_count}`,
              "",
              "The plan is being generated in the background.",
              "Call lele_get_plan with this session_id to check when it's ready.",
            ].join("\n"),
          },
        ],
      };
    }
  );

  server.tool(
    "lele_get_plan",
    `Get the current plan and status for a Lele session.
If status is "planning", wait a few seconds and try again.
If status is "awaiting_approval", review the plan and call lele_approve_plan.`,
    {
      session_id: z.string().describe("The session ID"),
    },
    async ({ session_id }) => {
      const data = await api.getSession(session_id);
      return {
        content: [{ type: "text" as const, text: formatSessionStatus(data) }],
      };
    }
  );

  server.tool(
    "lele_approve_plan",
    `Approve a session's plan and start agent execution.
Only call when status is "awaiting_approval".`,
    {
      session_id: z.string().describe("The session ID to approve"),
    },
    async ({ session_id }) => {
      const result = await api.approvePlan(session_id);
      return {
        content: [
          {
            type: "text" as const,
            text: `Plan approved. Execution started. Status: ${result.status}\n\nCall lele_get_status to monitor progress.`,
          },
        ],
      };
    }
  );

  server.tool(
    "lele_get_status",
    `Check the current status of a Lele session and all its agent nodes.
Look for nodes in "awaiting_reply" state — these need your input via lele_reply.
Terminal states: "completed", "failed", "cancelled".`,
    {
      session_id: z.string().describe("The session ID to check"),
    },
    async ({ session_id }) => {
      const data = await api.getSession(session_id);
      return {
        content: [{ type: "text" as const, text: formatSessionStatus(data) }],
      };
    }
  );

  server.tool(
    "lele_get_node_output",
    `Get the full conversation stream and output for a specific agent node.
Best called on nodes with status "passed" or "failed".`,
    {
      session_id: z.string().describe("The session ID"),
      node_id: z.string().describe("The node ID to inspect"),
    },
    async ({ session_id, node_id }) => {
      const data = await api.getNodeStream(session_id, node_id);
      const entries = data.stream || [];

      if (entries.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "No stream entries yet for this node." },
          ],
        };
      }

      const lines: string[] = [];
      for (const entry of entries) {
        if (entry.stream_type === "message") {
          const role = entry.sub_type || entry.role || "unknown";
          const content = entry.content || "";
          lines.push(`[${role}] ${content}`);
        } else if (entry.stream_type === "event") {
          const content = entry.content || "";
          if (
            entry.sub_type === "tool_use" ||
            entry.sub_type === "tool_result"
          ) {
            const preview = content.slice(0, 300);
            lines.push(
              `[${entry.sub_type}] ${preview}${content.length > 300 ? "..." : ""}`
            );
          }
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text:
              lines.length > 0
                ? lines.join("\n\n")
                : "Stream entries exist but contained no displayable messages.",
          },
        ],
      };
    }
  );

  server.tool(
    "lele_reply",
    `Reply to an agent that is waiting for user input (status: "awaiting_reply").
Tip: Check local files/codebase for the answer before asking the user.`,
    {
      session_id: z.string().describe("The session ID"),
      node_id: z.string().describe("The node ID awaiting reply"),
      message: z.string().describe("Your reply to the agent's question"),
    },
    async ({ session_id, node_id, message }) => {
      await api.replyToNode(session_id, node_id, message);
      return {
        content: [
          {
            type: "text" as const,
            text: `Reply sent to node ${node_id}. The agent will continue.\nCall lele_get_status to monitor progress.`,
          },
        ],
      };
    }
  );

  server.tool(
    "lele_chat",
    `Send a message to the session's orchestrator.
Use before approval to add context or request plan changes.
Use after execution for follow-up questions about results.`,
    {
      session_id: z.string().describe("The session ID"),
      message: z.string().describe("Your message to the orchestrator"),
    },
    async ({ session_id, message }) => {
      await api.sessionChat(session_id, message);
      return {
        content: [
          {
            type: "text" as const,
            text: "Message sent to session orchestrator.",
          },
        ],
      };
    }
  );

  server.tool(
    "lele_stop",
    "Stop a running session. Cancels all pending and executing nodes.",
    {
      session_id: z.string().describe("The session ID to stop"),
    },
    async ({ session_id }) => {
      const result = await api.stopExecution(session_id);
      return {
        content: [
          {
            type: "text" as const,
            text: `Session stopped. Status: ${result.status}`,
          },
        ],
      };
    }
  );

  // -- Resources --

  server.resource(
    "agent-catalog",
    "lele://agents",
    {
      description:
        "List of all available Lele agents with their capabilities. " +
        "Read this to understand what Lele can do before submitting a request.",
      mimeType: "text/plain",
    },
    async () => {
      const lines = AGENT_CATALOG.map((a) => {
        const integrations =
          a.required_integrations.length > 0
            ? ` (requires: ${a.required_integrations.join(", ")})`
            : "";
        return `## ${a.name} (${a.slug})${integrations}\n${a.description}\nIntent keywords: ${a.intents.join(", ")}\nMode: ${a.automation_mode}`;
      });

      return {
        contents: [
          {
            uri: "lele://agents",
            text: `# Lele Agent Catalog\n\n${lines.join("\n\n")}`,
            mimeType: "text/plain",
          },
        ],
      };
    }
  );

  for (const agent of AGENT_CATALOG) {
    server.resource(
      `agent-${agent.slug}`,
      `lele://agents/${agent.slug}`,
      {
        description: `Details for the ${agent.name} agent`,
        mimeType: "application/json",
      },
      async () => ({
        contents: [
          {
            uri: `lele://agents/${agent.slug}`,
            text: JSON.stringify(agent, null, 2),
            mimeType: "application/json",
          },
        ],
      })
    );
  }

  return server;
}

// ---------------------------------------------------------------------------
// HTTP server with Streamable HTTP transport
// ---------------------------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json());

// Extract Bearer token from Authorization header
function extractToken(req: express.Request): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  return null;
}

// Session transport store
const transports: Record<string, StreamableHTTPServerTransport> = {};

// POST /mcp — main MCP endpoint
app.post("/mcp", async (req, res) => {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Missing Authorization: Bearer <token>" },
      id: null,
    });
    return;
  }

  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  try {
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          delete transports[sid];
        }
      };

      const server = createMcpServer(token);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else if (sessionId) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session not found" },
        id: null,
      });
      return;
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: missing session ID" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// GET /mcp — SSE stream for server-to-client notifications
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(404).send("Session not found");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

// DELETE /mcp — session termination
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(404).send("Session not found");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "lele-mcp-server", transport: "streamable-http" });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(MCP_PORT, () => {
  console.log(`Lele MCP server listening on port ${MCP_PORT}`);
  console.log(`Backend URL: ${BACKEND_URL}`);
  console.log(`\nClaude Code setup:`);
  console.log(`  claude mcp add --transport http lele http://YOUR_HOST:${MCP_PORT}/mcp`);
});

process.on("SIGINT", async () => {
  console.log("Shutting down...");
  for (const sid of Object.keys(transports)) {
    await transports[sid].close();
    delete transports[sid];
  }
  process.exit(0);
});
