import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Fetch JSON from an API endpoint, throwing on non-OK responses. */
export async function apiFetch<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

/** @deprecated Import from @/lib/tokens instead. Re-exported for backwards compat. */
export { SESSION_STATUS_BADGE } from "@/lib/tokens";

/* ── Tool / event display helpers for Perplexity-style action groups ── */

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  request_user_action: "Requesting manual action",
  read_upstream_output: "Reading upstream data",
  write_output: "Writing output",
  spawn_agent: "Spawning sub-agent",
  clay_search: "Searching Clay",
  clay_enrich: "Enriching with Clay",
  clay_create_table: "Creating Clay table",
  clay_add_rows: "Adding Clay rows",
  clay_get_table: "Fetching Clay table",
  n8n_trigger: "Triggering N8N workflow",
  n8n_execute: "Running N8N workflow",
  notion_create_page: "Creating Notion page",
  notion_update_page: "Updating Notion page",
  notion_query_database: "Querying Notion database",
  lovable_deploy: "Deploying with Lovable",
  tolt_create_campaign: "Creating Tolt campaign",
};

export function humanizeToolName(name: string): string {
  if (TOOL_DISPLAY_NAMES[name]) return TOOL_DISPLAY_NAMES[name];
  return name
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const EVENT_DISPLAY_LABELS: Record<string, string> = {
  executor_start: "Starting executor",
  executor_llm_send: "Sending to LLM",
  executor_llm_receive: "Receiving LLM response",
  executor_thinking: "Processing",
  critic_start: "Running quality check",
  critic_done: "Quality check complete",
  judge_start: "Evaluating output",
  judge_done: "Evaluation complete",
  node_started: "Node started",
  node_completed: "Node completed",
  plan_execution_start: "Starting plan execution",
  plan_step_start: "Running plan step",
  plan_step_complete: "Plan step complete",
  plan_synthesis_start: "Synthesizing results",
};

export function humanizeEventType(eventType: string): string {
  return EVENT_DISPLAY_LABELS[eventType] || eventType.replace(/_/g, " ");
}

const VISIBLE_EVENT_TYPES = new Set([
  "executor_start",
  "critic_start",
  "critic_done",
  "judge_start",
  "judge_done",
  "plan_execution_start",
  "plan_step_start",
  "plan_step_complete",
  "plan_synthesis_start",
]);

export function isVisibleEvent(eventType: string): boolean {
  return VISIBLE_EVENT_TYPES.has(eventType);
}
