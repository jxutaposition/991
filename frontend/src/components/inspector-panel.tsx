"use client";

import React, { useState } from "react";
import { Activity, Settings2 } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ExecutionNode } from "./execution-canvas";
import { EventDetailsPopup } from "./event-details-popup";

export interface ExecutionEvent {
  id: string;
  node_id: string;
  event_type: string;
  payload: Record<string, unknown> | null;
  created_at: string;
}

interface InspectorPanelProps {
  selectedNode: ExecutionNode | null;
  nodeEvents: ExecutionEvent[];
  nodeEventsLoading: boolean;
  allNodes: ExecutionNode[];
}

export function InspectorPanel({
  selectedNode,
  nodeEvents,
  nodeEventsLoading,
  allNodes,
}: InspectorPanelProps) {
  const [selectedEvent, setSelectedEvent] = useState<ExecutionEvent | null>(null);

  const defaultTab = selectedNode ? "nodeinfo" : "nodes";

  return (
    <div className="flex h-full flex-col border-l border-rim bg-page">
      <Tabs
        defaultValue={defaultTab}
        key={selectedNode?.id ?? "none"}
        className="flex flex-col h-full"
      >
        <TabsList className="w-full justify-start border-b border-rim bg-transparent px-2 py-0 h-10 shrink-0">
          {selectedNode ? (
            <>
              <TabsTrigger
                value="nodeinfo"
                className="text-xs data-[state=active]:text-ink data-[state=active]:border-b-2 data-[state=active]:border-brand rounded-none h-10"
              >
                Node Info
              </TabsTrigger>
              <TabsTrigger
                value="timeline"
                className="text-xs data-[state=active]:text-ink data-[state=active]:border-b-2 data-[state=active]:border-brand rounded-none h-10"
              >
                <Activity className="w-3 h-3 mr-1" /> Timeline
              </TabsTrigger>
              <TabsTrigger
                value="properties"
                className="text-xs data-[state=active]:text-ink data-[state=active]:border-b-2 data-[state=active]:border-brand rounded-none h-10"
              >
                <Settings2 className="w-3 h-3 mr-1" /> Properties
              </TabsTrigger>
            </>
          ) : (
            <TabsTrigger
              value="nodes"
              className="text-xs data-[state=active]:text-ink data-[state=active]:border-b-2 data-[state=active]:border-brand rounded-none h-10"
            >
              Nodes
            </TabsTrigger>
          )}
        </TabsList>

        {/* Node Info tab */}
        <TabsContent value="nodeinfo" className="flex-1 min-h-0 m-0">
          <ScrollArea className="h-full">
            <div className="p-4 space-y-4">
              {selectedNode && (
                <div className="space-y-4">
                  <div>
                    <h3 className="text-sm font-semibold text-ink">
                      {selectedNode.agent_slug}
                    </h3>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span
                        className={`text-xs px-2 py-0.5 rounded capitalize ${statusBadgeClass(selectedNode.status)}`}
                      >
                        {selectedNode.status}
                      </span>
                      {selectedNode.judge_score != null && (
                        <span className="text-xs font-mono text-green-600">
                          Score:{" "}
                          {Number(selectedNode.judge_score).toFixed(1)}/10
                        </span>
                      )}
                    </div>
                    {selectedNode.judge_feedback && (
                      <p className="text-xs text-ink-2 mt-2 whitespace-pre-wrap">
                        {selectedNode.judge_feedback}
                      </p>
                    )}
                  </div>

                  {selectedNode.task_description && (
                    <div>
                      <h4 className="text-xs font-semibold text-ink-3 uppercase tracking-wider mb-1">
                        Task
                      </h4>
                      <p className="text-xs text-ink whitespace-pre-wrap">
                        {selectedNode.task_description}
                      </p>
                    </div>
                  )}

                  {/* Variant info */}
                  {selectedNode.variant_group && (
                    <div>
                      <h4 className="text-xs font-semibold text-ink-3 uppercase tracking-wider mb-2">
                        Decision Variants
                      </h4>
                      <div className="space-y-1.5">
                        {allNodes
                          .filter((n) => n.variant_group === selectedNode.variant_group)
                          .map((v) => (
                            <div
                              key={v.id}
                              className={`flex items-center gap-2 text-xs py-1.5 px-2 rounded ${
                                v.variant_selected
                                  ? "bg-purple-50 text-purple-700 border border-purple-200"
                                  : "bg-surface text-ink-3"
                              }`}
                            >
                              <span className="font-medium">
                                {v.variant_selected ? "\u2713" : "\u2022"}{" "}
                                {v.variant_label || v.agent_slug}
                              </span>
                              {v.variant_selected && (
                                <span className="ml-auto text-[10px] bg-purple-100 text-purple-600 px-1.5 py-0.5 rounded">
                                  selected
                                </span>
                              )}
                            </div>
                          ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </ScrollArea>
        </TabsContent>

        {/* Nodes list tab */}
        <TabsContent value="nodes" className="flex-1 min-h-0 m-0">
          <ScrollArea className="h-full">
            <div className="p-4 space-y-4">
              <h3 className="text-sm font-semibold text-ink-2">
                Execution Nodes
              </h3>
              {allNodes.length === 0 ? (
                <p className="text-xs text-ink-3">
                  No nodes. Submit a request to get started.
                </p>
              ) : (
                <div className="space-y-1">
                  {allNodes.map((n) => (
                    <div
                      key={n.id}
                      className="flex items-center gap-2 text-xs text-ink-2 py-1"
                    >
                      <div
                        className={`w-2 h-2 rounded-full shrink-0 ${dotClass(n.status)}`}
                      />
                      <span className="truncate">
                        {n.agent_slug || n.id.slice(0, 8)}
                      </span>
                      <span className="text-ink-3 capitalize ml-auto">
                        {n.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </ScrollArea>
        </TabsContent>

        {/* Timeline tab */}
        <TabsContent value="timeline" className="flex-1 min-h-0 m-0">
          <ScrollArea className="h-full">
            <div className="p-4 space-y-2">
              <h3 className="text-sm font-semibold text-ink mb-3">
                Execution Timeline
                {selectedNode && (
                  <span className="text-ink-3 font-normal ml-2">
                    ({selectedNode.agent_slug || selectedNode.id.slice(0, 8)})
                  </span>
                )}
              </h3>

              {!selectedNode ? (
                <p className="text-xs text-ink-3">
                  Select a node to view its execution timeline.
                </p>
              ) : nodeEventsLoading ? (
                <p className="text-xs text-ink-3">Loading events...</p>
              ) : nodeEvents.length === 0 ? (
                <p className="text-xs text-ink-3">
                  {selectedNode.status === "running"
                    ? "Waiting for events\u2026 (live streaming)"
                    : selectedNode.status === "ready" ||
                        selectedNode.status === "pending"
                      ? "Events will appear once the node starts executing."
                      : "No events recorded for this node."}
                </p>
              ) : (
                <div className="space-y-1">
                  {nodeEvents.map((ev, i) => (
                    <EventRow
                      key={ev.id ?? i}
                      event={ev}
                      index={i}
                      onClick={() => setSelectedEvent(ev)}
                    />
                  ))}
                </div>
              )}
              {selectedEvent && (
                <EventDetailsPopup
                  event={selectedEvent}
                  onClose={() => setSelectedEvent(null)}
                />
              )}
            </div>
          </ScrollArea>
        </TabsContent>

        {/* Properties tab */}
        <TabsContent value="properties" className="flex-1 min-h-0 m-0">
          <ScrollArea className="h-full">
            <div className="p-4 space-y-2">
              <h3 className="text-sm font-semibold text-ink mb-3">
                Node Properties
              </h3>
              {selectedNode ? (
                <PropertiesTable node={selectedNode} />
              ) : (
                <p className="text-xs text-ink-3">
                  Select a node to view properties.
                </p>
              )}
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PropertiesTable({ node }: { node: ExecutionNode }) {
  const entries: Array<[string, string]> = [
    ["id", node.id],
    ["agent_slug", node.agent_slug],
    ["task_description", node.task_description || ""],
    ["status", node.status],
    ["model", node.model || ""],
    [
      "max_iterations",
      node.max_iterations != null ? String(node.max_iterations) : "",
    ],
    [
      "attempt_count",
      node.attempt_count != null ? String(node.attempt_count) : "",
    ],
    ["parent_uid", node.parent_uid || ""],
    [
      "skip_judge",
      node.skip_judge != null ? String(node.skip_judge) : "",
    ],
    [
      "judge_score",
      node.judge_score != null ? String(node.judge_score) : "",
    ],
    ["judge_feedback", node.judge_feedback || ""],
    [
      "requires",
      node.requires ? JSON.stringify(node.requires) : "[]",
    ],
    [
      "judge_config",
      node.judge_config
        ? JSON.stringify(node.judge_config, null, 2)
        : "",
    ],
    [
      "input",
      node.input ? JSON.stringify(node.input, null, 2) : "",
    ],
    ["started_at", node.started_at || ""],
    ["completed_at", node.completed_at || ""],
  ];

  return (
    <div className="space-y-0.5">
      {entries.map(([key, value]) => (
        <div key={key} className="flex gap-2 py-1 border-b border-rim">
          <span className="text-[10px] font-mono text-ink-3 w-28 shrink-0">
            {key}
          </span>
          <span className="text-[10px] font-mono text-ink break-all flex-1 whitespace-pre-wrap">
            {value || <span className="text-ink-3">-</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

function EventRow({
  event,
  index,
  onClick,
}: {
  event: ExecutionEvent;
  index: number;
  onClick?: () => void;
}) {
  const eventType = event.event_type || "";
  const payload = event.payload;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) =>
        (e.key === "Enter" || e.key === " ") && onClick?.()
      }
      className="flex items-start gap-2 py-1.5 px-2 rounded hover:bg-surface group cursor-pointer"
    >
      <div
        className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${eventDotColor(eventType)}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-ink">
            {formatEventType(eventType)}
          </span>
          <span className="text-[10px] text-ink-3 ml-auto">#{index + 1}</span>
        </div>
        {payload && Object.keys(payload).length > 0 && (
          <div className="text-[10px] text-ink-3 font-mono mt-0.5 truncate max-w-full">
            {formatPayload(payload)}
          </div>
        )}
      </div>
    </div>
  );
}

function formatEventType(eventType: string): string {
  const labels: Record<string, string> = {
    node_started: "Node started",
    node_completed: "Node completed",
    tool_call: "Tool call",
    tool_result: "Tool result",
    critic_start: "Critic started",
    critic_done: "Critic done",
    judge_start: "Judge started",
    judge_done: "Judge verdict",
    judge_pass: "Judge passed",
    judge_fail: "Judge failed",
    judge_reject: "Judge rejected",
    node_retry: "Node retry",
    child_agent_spawned: "Child agent spawned",
    checkpoint_reached: "Checkpoint",
    session_completed: "Session completed",
  };
  return labels[eventType] || eventType.replace(/_/g, " ");
}

function formatPayload(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  if (payload.tool) parts.push(`tool=${payload.tool}`);
  if (payload.iteration) parts.push(`iter=${payload.iteration}`);
  if (payload.verdict) parts.push(`verdict=${payload.verdict}`);
  if (payload.score != null) parts.push(`score=${payload.score}`);
  if (payload.status) parts.push(`status=${payload.status}`);
  if (payload.feedback)
    parts.push(String(payload.feedback).slice(0, 40) + "\u2026");
  if (!parts.length) {
    const json = JSON.stringify(payload);
    return json.length > 80 ? json.slice(0, 80) + "\u2026" : json;
  }
  return parts.join(" \u00B7 ");
}

function eventDotColor(eventType: string): string {
  if (eventType.includes("completed") || eventType.includes("pass"))
    return "bg-green-500";
  if (eventType.includes("fail") || eventType.includes("reject") || eventType.includes("retry"))
    return "bg-red-500";
  if (eventType.includes("judge")) return "bg-purple-500";
  if (eventType.includes("critic")) return "bg-amber-500";
  if (eventType.includes("tool")) return "bg-cyan-500";
  if (eventType.includes("started")) return "bg-blue-500";
  return "bg-gray-400";
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "passed":
      return "bg-green-50 text-green-700";
    case "running":
      return "bg-blue-50 text-blue-700";
    case "ready":
      return "bg-blue-50 text-blue-600";
    case "waiting":
      return "bg-amber-50 text-amber-700";
    case "failed":
      return "bg-red-50 text-red-700";
    case "skipped":
      return "bg-surface text-ink-3";
    default:
      return "bg-surface text-ink-2";
  }
}

function dotClass(status: string): string {
  switch (status) {
    case "passed":
      return "bg-green-500";
    case "running":
      return "bg-blue-500 animate-pulse";
    case "ready":
      return "bg-blue-400";
    case "waiting":
      return "bg-amber-400";
    case "failed":
      return "bg-red-500";
    case "skipped":
      return "bg-gray-300";
    default:
      return "bg-gray-300";
  }
}
