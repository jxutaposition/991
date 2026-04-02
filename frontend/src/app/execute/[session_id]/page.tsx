"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import { Lock, LockOpen, GripHorizontal } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import {
  ExecutionCanvas,
  type CanvasHandle,
  type ExecutionNode,
} from "@/components/execution-canvas";
import {
  InspectorPanel,
  type ExecutionEvent,
  type ThinkingBlock,
} from "@/components/inspector-panel";
import { CanvasToolbar } from "@/components/canvas-toolbar";
import { DragResizeLayout } from "@/components/drag-resize-layout";

interface ExecutionSession {
  id: string;
  request_text: string;
  status: string;
  nodes: ExecutionNode[];
  plan_approved_at: string | null;
}

export interface ToolInfo {
  name: string;
  credential: string | null;
}

export interface AgentCredentialInfo {
  tools: ToolInfo[];
  required_integrations: string[];
  missing: string[];
  status: "ready" | "blocked" | "no_tools";
}

export interface CredentialStatus {
  agents: Record<string, AgentCredentialInfo>;
  connected: string[];
}

export interface CatalogAgent {
  slug: string;
  name: string;
  category: string;
  description: string;
  tools: Array<{ name: string; credential: string | null }>;
  required_integrations: string[];
}

export type CatalogMap = Record<string, CatalogAgent>;

const STATUS_COLORS: Record<string, string> = {
  planning: "text-ink-3",
  awaiting_approval: "text-amber-600",
  executing: "text-brand",
  completed: "text-green-600",
  failed: "text-danger",
};

export default function SessionPage() {
  const { session_id } = useParams();
  const { activeClient, apiFetch } = useAuth();
  const [session, setSession] = useState<ExecutionSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [nodeEvents, setNodeEvents] = useState<ExecutionEvent[]>([]);
  const [nodeEventsLoading, setNodeEventsLoading] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(0.9);
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus | null>(null);
  const [catalogMap, setCatalogMap] = useState<CatalogMap>({});
  const canvasRef = useRef<CanvasHandle>(null);
  const [bottomHeight, setBottomHeight] = useState(288); // ~max-h-72 default
  const [isDraggingBottom, setIsDraggingBottom] = useState(false);
  const [thinkingBlocks, setThinkingBlocks] = useState<ThinkingBlock[]>([]);
  const [thinkingBlocksLoading, setThinkingBlocksLoading] = useState(false);
  const [liveThinkingChunks, setLiveThinkingChunks] = useState<Record<number, string>>({});
  const selectedNodeIdRef = useRef(selectedNodeId);
  selectedNodeIdRef.current = selectedNodeId;

  const handleBottomDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDraggingBottom(true);
      const startY = e.clientY;
      const startHeight = bottomHeight;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = startY - moveEvent.clientY;
        const newHeight = Math.max(100, Math.min(window.innerHeight * 0.7, startHeight + delta));
        setBottomHeight(newHeight);
      };

      const handleMouseUp = () => {
        setIsDraggingBottom(false);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [bottomHeight]
  );

  const fetchSession = useCallback(() => {
    apiFetch(`/api/execute/${session_id}`)
      .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then((data) => {
        setSession({
          ...data.session,
          nodes: data.nodes ?? data.session?.nodes ?? [],
        });
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [session_id, apiFetch]);

  useEffect(() => {
    fetchSession();
  }, [fetchSession]);

  // Fetch credential status for agents in this session
  useEffect(() => {
    if (!session || !activeClient) return;
    const slugs = [...new Set(session.nodes.map((n) => n.agent_slug))].join(",");
    if (!slugs) return;
    apiFetch(`/api/clients/${activeClient}/credential-check?agents=${slugs}`)
      .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then(setCredentialStatus)
      .catch(() => {});
  }, [session?.nodes, activeClient, apiFetch]);

  // Fetch catalog for agent metadata (tools, category, description)
  useEffect(() => {
    apiFetch("/api/catalog")
      .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then((data) => {
        const map: CatalogMap = {};
        for (const a of data.agents ?? []) map[a.slug] = a;
        setCatalogMap(map);
      })
      .catch(() => {});
  }, [apiFetch]);

  // Update a node field via PATCH (for pre-approval editing)
  const handleNodeUpdate = useCallback(
    async (nodeId: string, patch: Record<string, unknown>) => {
      await apiFetch(`/api/execute/${session_id}/nodes/${nodeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      fetchSession();
    },
    [session_id, apiFetch, fetchSession]
  );

  const fetchNodeEvents = useCallback(() => {
    if (!selectedNodeId || !session_id) {
      setNodeEvents([]);
      return;
    }
    apiFetch(`/api/execute/${session_id}/nodes/${selectedNodeId}/events`)
      .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then((data) => {
        setNodeEvents(data.events ?? []);
        setNodeEventsLoading(false);
      })
      .catch(() => {
        setNodeEvents([]);
        setNodeEventsLoading(false);
      });
  }, [selectedNodeId, session_id, apiFetch]);

  const fetchThinkingBlocks = useCallback(() => {
    if (!selectedNodeId || !session_id) {
      setThinkingBlocks([]);
      return;
    }
    setThinkingBlocksLoading(true);
    apiFetch(`/api/execute/${session_id}/nodes/${selectedNodeId}/thinking`)
      .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then((data) => {
        setThinkingBlocks(data.thinking_blocks ?? []);
        setThinkingBlocksLoading(false);
      })
      .catch(() => {
        setThinkingBlocks([]);
        setThinkingBlocksLoading(false);
      });
  }, [selectedNodeId, session_id, apiFetch]);

  // Fetch thinking blocks when selected node changes
  useEffect(() => {
    fetchThinkingBlocks();
    setLiveThinkingChunks({}); // Reset live chunks when switching nodes
  }, [fetchThinkingBlocks]);

  useEffect(() => {
    if (
      !session ||
      session.status === "planning" ||
      session.status === "awaiting_approval"
    )
      return;
    const es = new EventSource(`/api/execute/${session_id}/events`);
    es.onmessage = (msg) => {
      fetchSession();
      fetchNodeEvents();

      // Handle thinking events for live display
      try {
        const data = JSON.parse(msg.data);
        if (
          data.type === "executor_thinking" &&
          data.node_uid === selectedNodeIdRef.current
        ) {
          // A complete thinking block arrived — refetch persisted blocks
          fetchThinkingBlocks();
        }
      } catch {
        // Not JSON, ignore
      }
    };
    // Let EventSource auto-reconnect on transient errors.
    // Fall back to polling if the connection stays down.
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    es.onerror = () => {
      if (!pollTimer) {
        pollTimer = setInterval(() => {
          fetchSession();
          fetchNodeEvents();
        }, 5000);
      }
    };
    es.onopen = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
    return () => {
      es.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [session_id, session?.status, fetchSession, fetchNodeEvents, fetchThinkingBlocks]);

  useEffect(() => {
    setNodeEventsLoading(true);
    fetchNodeEvents();
  }, [fetchNodeEvents]);

  const handleApprove = async () => {
    setApproving(true);
    try {
      await apiFetch(`/api/execute/${session_id}/approve`, { method: "POST" });
      fetchSession();
    } finally {
      setApproving(false);
    }
  };

  const handleNodeClick = (id: string) => {
    setSelectedNodeId((prev) => (prev === id ? null : id));
  };

  const selectedNode =
    session?.nodes.find((n) => n.id === selectedNodeId) ?? null;

  if (loading)
    return (
      <div className="p-8 text-ink-3 text-sm">Loading plan\u2026</div>
    );
  if (!session)
    return (
      <div className="p-8 text-ink-3 text-sm">Session not found.</div>
    );

  return (
    <div className="flex flex-col h-[calc(100vh-49px)]">
      {/* Header */}
      <div className="border-b border-rim px-6 py-3 flex items-center justify-between bg-page shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <span
            className={`text-xs font-medium ${STATUS_COLORS[session.status] ?? "text-ink-3"}`}
          >
            {session.status.replace(/_/g, " ").toUpperCase()}
          </span>
          <span className="text-rim-strong">{"\u00B7"}</span>
          <span className="text-sm text-ink-2 truncate max-w-xl">
            {session.request_text}
          </span>
        </div>
        {session.status === "awaiting_approval" && (
          <button
            onClick={handleApprove}
            disabled={approving}
            className="bg-brand text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50 shrink-0 ml-4 transition-colors"
          >
            {approving ? "Approving\u2026" : "Approve & Execute \u2192"}
          </button>
        )}
      </div>

      {/* Main content: canvas + inspector */}
      <DragResizeLayout
        defaultRightWidth={420}
        minRightWidth={320}
        maxRightWidth="70%"
        left={
          <div className="relative h-full bg-surface">
            <ExecutionCanvas
              ref={canvasRef}
              nodes={session.nodes}
              sessionStatus={session.status}
              selectedNodeId={selectedNodeId}
              onNodeClick={handleNodeClick}
              onZoomChange={setZoomLevel}
              credentialStatus={credentialStatus}
              catalogMap={catalogMap}
            />
            <CanvasToolbar
              zoomLevel={zoomLevel}
              onZoomIn={() => canvasRef.current?.zoomIn()}
              onZoomOut={() => canvasRef.current?.zoomOut()}
              onFitToScreen={() => canvasRef.current?.resetTransform()}
            />
          </div>
        }
        right={
          <InspectorPanel
            selectedNode={selectedNode}
            nodeEvents={nodeEvents}
            nodeEventsLoading={nodeEventsLoading}
            allNodes={session.nodes}
            credentialStatus={credentialStatus}
            catalogMap={catalogMap}
            sessionStatus={session.status}
            onNodeUpdate={handleNodeUpdate}
            thinkingBlocks={thinkingBlocks}
            thinkingBlocksLoading={thinkingBlocksLoading}
            liveThinkingChunks={liveThinkingChunks}
          />
        }
      />

      {/* Plan list -- shown while awaiting approval */}
      {session.status === "awaiting_approval" && (
        <div className="border-t border-rim bg-page shrink-0 overflow-hidden flex flex-col" style={{ height: bottomHeight }}>
          {/* Drag handle */}
          <div
            onMouseDown={handleBottomDragStart}
            className={`relative flex items-center justify-center h-2 cursor-row-resize shrink-0 group
              ${isDraggingBottom ? "bg-brand/20" : "hover:bg-brand/10"}
              transition-colors`}
          >
            <div className="z-10 flex w-8 h-4 items-center justify-center rounded-sm border border-rim bg-surface shadow-sm group-hover:border-brand/40 transition-colors">
              <GripHorizontal className="h-3.5 w-3.5 text-ink-3 group-hover:text-brand transition-colors" />
            </div>
            <div className="absolute -top-2 -bottom-2 inset-x-0" />
          </div>
          <div className="p-4 overflow-auto flex-1">
          <p className="text-xs text-ink-3 uppercase tracking-wider mb-3">
            Execution Plan {"\u2014"} {session.nodes.length} steps
            <span className="ml-2 text-ink-3 normal-case">Click a node on the canvas to edit</span>
          </p>
          <div className="space-y-2">
            {session.nodes.map((node, i) => {
              const credInfo = credentialStatus?.agents[node.agent_slug];
              const catalog = catalogMap[node.agent_slug];
              const isBlocked = credInfo?.status === "blocked";
              const toolCount = catalog?.tools?.filter(
                (t) => !["read_upstream_output", "write_output", "spawn_agent"].includes(t.name)
              ).length ?? 0;
              const integrationCount = credInfo?.required_integrations?.length ?? 0;

              return (
                <div
                  key={node.id}
                  className={`flex items-start gap-3 text-sm py-1.5 px-2 rounded-lg cursor-pointer hover:bg-surface transition-colors ${
                    selectedNodeId === node.id ? "bg-blue-50 border border-blue-200" : ""
                  } ${isBlocked ? "border-l-4 border-l-amber-400" : ""}`}
                  onClick={() => handleNodeClick(node.id)}
                >
                  <span className="text-ink-3 shrink-0 w-5 pt-0.5">
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-ink font-mono font-medium text-xs">
                        {node.agent_slug}
                      </span>
                      {catalog && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-gray-100 text-ink-3">
                          {catalog.category.replace(/_/g, " ")}
                        </span>
                      )}
                      {isBlocked && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 flex items-center gap-0.5">
                          <Lock className="w-2.5 h-2.5" /> blocked
                        </span>
                      )}
                      {integrationCount > 0 && !isBlocked && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 flex items-center gap-0.5">
                          <LockOpen className="w-2.5 h-2.5" /> ready
                        </span>
                      )}
                      {toolCount > 0 && (
                        <span className="text-[9px] text-ink-3">
                          {toolCount} tool{toolCount !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                    <span className="text-ink-2 text-xs leading-relaxed">
                      {node.task_description}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          </div>
        </div>
      )}
    </div>
  );
}
