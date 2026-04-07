#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { LeleApiClient } from "./api-client.js";
import type { AgentInfo, ExecutionNode } from "./types.js";

// ---------------------------------------------------------------------------
// Agent catalog — hardcoded from backend/agents/*/agent.toml
// No backend changes needed; update here when agents change.
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
      "Builds dashboards end-to-end. Reads data from upstream sources (Clay tables, Supabase, APIs) and outputs a dashboard spec JSON that the platform renders automatically as interactive charts, tables, and metrics.",
    intents: [
      "dashboard", "internal dashboard", "external dashboard", "leaderboard",
      "points display", "partner dashboard", "program dashboard",
      "data visibility", "build dashboard", "create dashboard",
      "analytics dashboard", "pipeline dashboard",
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
      "Diagnoses Lovable dashboard issues via Supabase API, generates detailed Lovable chat prompts for UI changes, and pauses for user to apply changes in Lovable editor. Cannot edit Lovable projects directly.",
    intents: [
      "lovable", "lovable project", "fix dashboard", "dashboard data",
      "lovable app", "lovable bug", "lovable fix", "dashboard not showing",
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
    line += "\n  ⚠ This agent is waiting for your reply. Use lele_reply to respond.";
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

function formatSessionStatus(data: { session: { status: string; request_text: string }; nodes: ExecutionNode[] }): string {
  const { session, nodes } = data;
  const lines: string[] = [
    `Session status: ${session.status}`,
    `Request: ${session.request_text}`,
    `Nodes (${nodes.length}):`,
  ];

  const awaitingReply = nodes.filter((n) => n.status === "awaiting_reply");
  if (awaitingReply.length > 0) {
    lines.push(
      `\n⚠ ${awaitingReply.length} node(s) awaiting your reply:`
    );
    for (const n of awaitingReply) {
      lines.push(`  - Node ${n.id} (${n.agent_slug}): ${n.task_description || n.description || ""}`);
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
// Server setup
// ---------------------------------------------------------------------------

const BACKEND_URL = process.env.LELE_BACKEND_URL;
const API_TOKEN = process.env.LELE_API_KEY;

if (!BACKEND_URL || !API_TOKEN) {
  console.error(
    "Missing required env vars: LELE_BACKEND_URL and LELE_API_KEY must be set."
  );
  process.exit(1);
}

const api = new LeleApiClient(BACKEND_URL, API_TOKEN);

const server = new McpServer(
  { name: "lele", version: "0.1.0" },
  { capabilities: { tools: {}, resources: {} } }
);

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

server.tool(
  "lele_submit_request",
  `Submit a task to the Lele agent platform for planning and execution.
Include relevant local context (file contents, schemas, URLs, conventions)
directly in the request_text — the agents will use it alongside their own
domain knowledge. Returns a session_id; call lele_get_plan next to see the plan.`,
  {
    request_text: z
      .string()
      .describe(
        "The task description. Include any local context (file schemas, URLs, " +
        "codebase conventions) that would help the agents. The richer the context, " +
        "the better the result."
      ),
    client_slug: z
      .string()
      .optional()
      .describe("Client/workspace slug if the user has multiple workspaces"),
    model: z
      .string()
      .optional()
      .describe("LLM model override (defaults to server config)"),
    project_slug: z
      .string()
      .optional()
      .describe("Project slug to associate this session with"),
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
            "Call lele_get_plan with this session_id to check when it's ready for approval.",
          ].join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "lele_get_plan",
  `Get the current plan and status for a Lele session.
If status is "planning", the plan is still being generated — wait a few seconds and try again.
If status is "awaiting_approval", review the plan and call lele_approve_plan to start execution.`,
  {
    session_id: z.string().describe("The session ID returned by lele_submit_request"),
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
Only call this when status is "awaiting_approval".
Optionally send a chat message first (via lele_chat) to add context or modifications.`,
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
Use this to monitor execution progress after approval.
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
Use this to see what an agent did, including its thinking, tool calls, and final output.
Best called on nodes that have status "passed" or "failed".`,
  {
    session_id: z.string().describe("The session ID"),
    node_id: z.string().describe("The specific node ID to inspect"),
  },
  async ({ session_id, node_id }) => {
    const data = await api.getNodeStream(session_id, node_id);
    const entries = data.stream || [];

    if (entries.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No stream entries yet for this node." }],
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
        if (entry.sub_type === "tool_use" || entry.sub_type === "tool_result") {
          const preview = content.slice(0, 300);
          lines.push(`[${entry.sub_type}] ${preview}${content.length > 300 ? "..." : ""}`);
        }
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: lines.length > 0
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
The agent asked a question or needs clarification. Provide the answer here.
Tip: Check local files/codebase for the answer before asking the user.`,
  {
    session_id: z.string().describe("The session ID"),
    node_id: z
      .string()
      .describe("The node ID of the agent awaiting reply (shown in lele_get_status)"),
    message: z.string().describe("Your reply to the agent's question"),
  },
  async ({ session_id, node_id, message }) => {
    await api.replyToNode(session_id, node_id, message);
    return {
      content: [
        {
          type: "text" as const,
          text: `Reply sent to node ${node_id}. The agent will continue execution.\nCall lele_get_status to monitor progress.`,
        },
      ],
    };
  }
);

server.tool(
  "lele_chat",
  `Send a message to the session's orchestrator.
Use before approval to add context, request plan changes, or provide specs.
Use after execution to ask follow-up questions about results.`,
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

// ---------------------------------------------------------------------------
// Resources — agent catalog
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
