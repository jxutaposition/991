"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { Lock, LockOpen, GripHorizontal, Trash2, Square } from "lucide-react";
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
  type NodeMessage,
} from "@/components/inspector-panel";
import type { StreamEntry } from "@/components/conversation-stream";
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

export type ProbeStatusType =
  | "verified"
  | "auth_failed"
  | "endpoint_not_found"
  | "rate_limited"
  | "server_error"
  | "client_error"
  | "network_error"
  | "config_missing"
  | "missing"
  | "skipped";

export interface ProbeResult {
  status: ProbeStatusType;
  ok: boolean;
  http_status?: number;
  error?: string;
  hint?: string;
  latency_ms?: number;
}

const PROBE_LABELS: Record<ProbeStatusType, string> = {
  verified: "Verified",
  rate_limited: "Verified (rate-limited)",
  auth_failed: "Auth failed",
  endpoint_not_found: "Endpoint not found",
  server_error: "Service down",
  client_error: "Request error",
  network_error: "Unreachable",
  config_missing: "Config missing",
  missing: "Not configured",
  skipped: "Skipped",
};

const PROBE_COLORS: Record<ProbeStatusType, { bg: string; text: string; border: string }> = {
  verified:           { bg: "bg-green-50",  text: "text-green-700",  border: "border-green-200" },
  rate_limited:       { bg: "bg-green-50",  text: "text-green-700",  border: "border-green-200" },
  auth_failed:        { bg: "bg-red-50",    text: "text-red-700",    border: "border-red-200" },
  endpoint_not_found: { bg: "bg-orange-50", text: "text-orange-700", border: "border-orange-200" },
  server_error:       { bg: "bg-red-50",    text: "text-red-600",    border: "border-red-200" },
  client_error:       { bg: "bg-amber-50",  text: "text-amber-700",  border: "border-amber-200" },
  network_error:      { bg: "bg-red-50",    text: "text-red-700",    border: "border-red-200" },
  config_missing:     { bg: "bg-amber-50",  text: "text-amber-700",  border: "border-amber-200" },
  missing:            { bg: "bg-gray-50",   text: "text-gray-600",   border: "border-gray-200" },
  skipped:            { bg: "bg-gray-50",   text: "text-gray-500",   border: "border-gray-200" },
};

export interface CredentialStatus {
  agents: Record<string, AgentCredentialInfo>;
  connected: string[];
  probe_results?: Record<string, ProbeResult>;
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
  const router = useRouter();
  const { activeClient, apiFetch } = useAuth();
  const [session, setSession] = useState<ExecutionSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [stopping, setStopping] = useState(false);
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
  const [liveThinkingChunks, setLiveThinkingChunks] = useState<Record<string, string>>({});
  const [liveTextChunks, setLiveTextChunks] = useState<Record<string, string>>({});
  const [nodeMessages, setNodeMessages] = useState<NodeMessage[]>([]);
  const [nodeMessagesLoading, setNodeMessagesLoading] = useState(false);
  const [streamEntries, setStreamEntries] = useState<StreamEntry[]>([]);
  const [streamLoading, setStreamLoading] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  // Per-node live text preview for canvas (all nodes, not just selected)
  const [livePreviewMap, setLivePreviewMap] = useState<Record<string, string>>({});
  const pendingPreviewMap = useRef<Record<string, string>>({});
  const selectedNodeIdRef = useRef(selectedNodeId);
  selectedNodeIdRef.current = selectedNodeId;

  // RAF-throttled delta accumulation for streaming
  const pendingText = useRef<Record<string, string>>({});
  const pendingThinking = useRef<Record<string, string>>({});
  const rafId = useRef<number>();

  const scheduleRaf = useCallback(() => {
    if (rafId.current) return;
    rafId.current = requestAnimationFrame(() => {
      setLiveTextChunks({ ...pendingText.current });
      setLiveThinkingChunks({ ...pendingThinking.current });
      setLivePreviewMap({ ...pendingPreviewMap.current });
      rafId.current = undefined;
    });
  }, []);

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

  const fetchSession = useCallback(async () => {
    try {
      const r = await apiFetch(`/api/execute/${session_id}`);
      if (!r.ok) { setLoading(false); return; }
      const data = await r.json();
      setSession({
        ...data.session,
        nodes: data.nodes ?? data.session?.nodes ?? [],
      });
    } catch { /* transient network error */ } finally {
      setLoading(false);
    }
  }, [session_id, apiFetch]);

  useEffect(() => {
    fetchSession();
  }, [fetchSession]);

  // Fetch credential status for agents in this session
  useEffect(() => {
    if (!session || !activeClient) return;
    const slugs = [...new Set(session.nodes.map((n) => n.agent_slug))].join(",");
    if (!slugs) return;
    apiFetch(`/api/clients/${activeClient}/credential-check?agents=${slugs}&verify=true`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setCredentialStatus(data); })
      .catch(() => {});
  }, [session?.nodes, activeClient, apiFetch]);

  // Fetch catalog for agent metadata (tools, category, description)
  useEffect(() => {
    apiFetch("/api/catalog")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data) return;
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

  const fetchNodeEvents = useCallback(async () => {
    if (!selectedNodeId || !session_id) {
      setNodeEvents([]);
      return;
    }
    try {
      const r = await apiFetch(`/api/execute/${session_id}/nodes/${selectedNodeId}/events`);
      if (!r.ok) { setNodeEvents([]); setNodeEventsLoading(false); return; }
      const data = await r.json();
      setNodeEvents(data.events ?? []);
    } catch {
      setNodeEvents([]);
    } finally {
      setNodeEventsLoading(false);
    }
  }, [selectedNodeId, session_id, apiFetch]);

  const fetchThinkingBlocks = useCallback(async () => {
    if (!selectedNodeId || !session_id) {
      setThinkingBlocks([]);
      return;
    }
    setThinkingBlocksLoading(true);
    try {
      const r = await apiFetch(`/api/execute/${session_id}/nodes/${selectedNodeId}/thinking`);
      if (!r.ok) { setThinkingBlocks([]); setThinkingBlocksLoading(false); return; }
      const data = await r.json();
      setThinkingBlocks(data.thinking_blocks ?? []);
    } catch {
      setThinkingBlocks([]);
    } finally {
      setThinkingBlocksLoading(false);
    }
  }, [selectedNodeId, session_id, apiFetch]);

  const fetchNodeMessages = useCallback(async () => {
    if (!selectedNodeId || !session_id) {
      setNodeMessages([]);
      return;
    }
    setNodeMessagesLoading(true);
    try {
      const r = await apiFetch(`/api/execute/${session_id}/nodes/${selectedNodeId}/messages`);
      if (!r.ok) { setNodeMessages([]); setNodeMessagesLoading(false); return; }
      const data = await r.json();
      setNodeMessages(data.messages ?? []);
    } catch {
      setNodeMessages([]);
    } finally {
      setNodeMessagesLoading(false);
    }
  }, [selectedNodeId, session_id, apiFetch]);

  const fetchNodeStream = useCallback(async () => {
    if (!selectedNodeId || !session_id) {
      setStreamEntries([]);
      return;
    }
    setStreamLoading(true);
    try {
      const r = await apiFetch(`/api/execute/${session_id}/nodes/${selectedNodeId}/stream`);
      if (!r.ok) { setStreamEntries([]); setStreamLoading(false); return; }
      const data = await r.json();
      setStreamEntries(data.stream ?? []);
    } catch {
      setStreamEntries([]);
    } finally {
      setStreamLoading(false);
    }
  }, [selectedNodeId, session_id, apiFetch]);

  // Fetch thinking blocks, messages, and stream when selected node changes
  useEffect(() => {
    fetchThinkingBlocks();
    fetchNodeMessages();
    fetchNodeStream();
    // Reset live chunks when switching nodes
    setLiveThinkingChunks({});
    setLiveTextChunks({});
    pendingText.current = {};
    pendingThinking.current = {};
  }, [fetchThinkingBlocks, fetchNodeMessages, fetchNodeStream]);

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
      fetchNodeMessages();

      try {
        const data = JSON.parse(msg.data);
        const streamEntry = data.stream_entry;
        const nodeUid = data.node_uid as string | undefined;
        const isSelectedNode = nodeUid === selectedNodeIdRef.current;

        // Accumulate text preview for ALL nodes (for canvas inline preview)
        if (streamEntry?.stream_type === "text_delta" && nodeUid) {
          const content = streamEntry.content || "";
          const prev = pendingPreviewMap.current[nodeUid] || "";
          pendingPreviewMap.current[nodeUid] = (prev + content).slice(-120);
          scheduleRaf();
        }
        if (streamEntry?.stream_type === "message_stop" && nodeUid) {
          delete pendingPreviewMap.current[nodeUid];
          setLivePreviewMap((m) => { const next = { ...m }; delete next[nodeUid]; return next; });
        }

        if (streamEntry && isSelectedNode) {
          const st = streamEntry.stream_type;

          if (st === "text_delta") {
            const key = String(streamEntry.block_index ?? 0);
            pendingText.current[key] = (pendingText.current[key] || "") + (streamEntry.content || "");
            scheduleRaf();
          } else if (st === "thinking_delta") {
            const key = String(streamEntry.block_index ?? 0);
            pendingThinking.current[key] = (pendingThinking.current[key] || "") + (streamEntry.content || "");
            scheduleRaf();
          } else if (st === "message_stop") {
            pendingText.current = {};
            pendingThinking.current = {};
            setLiveTextChunks({});
            setLiveThinkingChunks({});
            fetchNodeStream();
          } else if (st !== "content_block_start" && st !== "content_block_stop") {
            setStreamEntries((prev) => [...prev, streamEntry as StreamEntry]);
          }
        }

        if (
          data.type === "executor_thinking" &&
          isSelectedNode
        ) {
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
          fetchNodeMessages();
          fetchNodeStream();
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
  }, [session_id, session?.status, fetchSession, fetchNodeEvents, fetchThinkingBlocks, fetchNodeMessages, fetchNodeStream]);

  useEffect(() => {
    setNodeEventsLoading(true);
    fetchNodeEvents();
  }, [fetchNodeEvents]);

  const handleReply = useCallback(
    async (nodeId: string, message: string) => {
      await apiFetch(`/api/execute/${session_id}/nodes/${nodeId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      // Immediately refetch to show the user's message
      fetchNodeMessages();
      fetchSession();
    },
    [session_id, apiFetch, fetchNodeMessages, fetchSession]
  );

  const handleDeleteSession = async () => {
    if (!confirm("Delete this session? This cannot be undone.")) return;
    try {
      const res = await apiFetch(`/api/execute/${session_id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      router.push("/execute");
    } catch (err) {
      console.error("Failed to delete session:", err);
    }
  };

  const handleApprove = async () => {
    setApproving(true);
    setApprovalError(null);
    try {
      const res = await apiFetch(`/api/execute/${session_id}/approve`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body.preflight_failures) {
          const failures = body.preflight_failures as Array<{
            integration: string;
            type: string;
            error: string;
            hint?: string;
          }>;
          const lines = failures.map((f) => {
            const label = PROBE_LABELS[f.type as ProbeStatusType] ?? f.type;
            return `${f.integration} [${label}]: ${f.error}`;
          });
          setApprovalError(
            `Credential check failed:\n${lines.join("\n")}\nFix in Settings > Integrations.`
          );
        } else {
          setApprovalError(body.error || "Approval failed");
        }
        return;
      }
      fetchSession();
    } catch (err) {
      setApprovalError(err instanceof Error ? err.message : "Approval failed");
    } finally {
      setApproving(false);
    }
  };

  const handleStop = async () => {
    if (!confirm("Stop this orchestration? Running agents will finish but no new ones will start.")) return;
    setStopping(true);
    try {
      await apiFetch(`/api/execute/${session_id}/stop`, { method: "POST" });
      fetchSession();
    } finally {
      setStopping(false);
    }
  };

  const handleNodeClick = (id: string) => {
    setSelectedNodeId((prev) => (prev === id ? null : id));
  };

  const selectedNode =
    session?.nodes.find((n) => n.id === selectedNodeId) ?? null;

  const probeFailures = credentialStatus?.probe_results
    ? Object.entries(credentialStatus.probe_results).filter(
        ([, r]) => !r.ok && r.status !== "skipped"
      )
    : [];
  const hasProbeFailures = probeFailures.length > 0;

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
        <div className="flex items-center gap-2 shrink-0 ml-4">
          {session.status === "awaiting_approval" && (
            <button
              onClick={handleApprove}
              disabled={approving || hasProbeFailures}
              className="bg-brand text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors"
              title={hasProbeFailures ? "Fix credential issues before approving" : undefined}
            >
              {approving ? "Approving\u2026" : "Approve & Execute \u2192"}
            </button>
          )}
          {session.status === "executing" && (
            <button
              onClick={handleStop}
              disabled={stopping}
              className="bg-red-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50 transition-colors flex items-center gap-1.5"
            >
              <Square className="w-3.5 h-3.5 fill-current" />
              {stopping ? "Stopping\u2026" : "Stop"}
            </button>
          )}
          <button
            onClick={handleDeleteSession}
            className="p-1.5 rounded-lg hover:bg-red-50 hover:text-red-500 text-ink-3 transition-colors"
            title="Delete session"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Preflight failure banner */}
      {session.status === "awaiting_approval" && hasProbeFailures && (
        <div className="border-b border-red-200 px-6 py-3 shrink-0 bg-red-50/80">
          <p className="text-sm font-medium text-red-800 mb-2">
            Credential check failed — fix before approving:
          </p>
          <div className="space-y-1.5">
            {probeFailures.map(([slug, r]) => {
              const colors = PROBE_COLORS[r.status] ?? PROBE_COLORS.missing;
              return (
                <div key={slug} className="flex items-start gap-2 text-xs">
                  <span className={`shrink-0 px-1.5 py-0.5 rounded font-medium ${colors.bg} ${colors.text} border ${colors.border}`}>
                    {PROBE_LABELS[r.status] ?? r.status}
                  </span>
                  <span className="font-mono text-ink">{slug}</span>
                  {r.error && <span className="text-ink-2">{"\u2014"} {r.error}</span>}
                  {r.hint && <span className="text-ink-3 italic">{r.hint}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Approval error banner */}
      {approvalError && (
        <div className="bg-amber-50 border-b border-amber-200 px-6 py-2.5 text-sm text-amber-800 shrink-0 whitespace-pre-line">
          {approvalError}
        </div>
      )}

      {/* Execution progress bar */}
      {session.status === "executing" && (() => {
        const masterNode = session.nodes.find(n => !n.parent_uid);
        const childNodes = masterNode
          ? session.nodes.filter(n => n.parent_uid === masterNode.id)
          : session.nodes;
        const total = childNodes.length;
        const completed = childNodes.filter(n => n.status === "passed" || n.status === "failed" || n.status === "skipped").length;
        const running = childNodes.find(n => n.status === "running");
        const pct = total > 0 ? (completed / total) * 100 : 0;
        return total > 0 ? (
          <div className="border-b border-rim px-6 py-2 bg-blue-50/50 shrink-0 flex items-center gap-3">
            <div className="flex-1 h-1.5 rounded-full bg-gray-200 overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-xs text-ink-2 whitespace-nowrap">
              Step {completed + (running ? 1 : 0)}/{total}
              {running && <>{": "}<span className="font-medium text-blue-700">{running.agent_slug}</span></>}
            </span>
          </div>
        ) : null;
      })()}

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
              livePreviewMap={livePreviewMap}
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
            nodeMessages={nodeMessages}
            nodeMessagesLoading={nodeMessagesLoading}
            onReply={handleReply}
            streamEntries={streamEntries}
            streamLoading={streamLoading}
            liveTextChunks={liveTextChunks}
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
                      {integrationCount > 0 && !isBlocked && (() => {
                        const agentIntegrations = credInfo?.required_integrations ?? [];
                        const probes = credentialStatus?.probe_results ?? {};
                        const issues = agentIntegrations
                          .map((s) => ({ slug: s, probe: probes[s] }))
                          .filter(({ probe }) => probe && !probe.ok);
                        if (issues.length > 0) {
                          const worst = issues[0].probe!;
                          const colors = PROBE_COLORS[worst.status] ?? PROBE_COLORS.missing;
                          return (
                            <span
                              className={`text-[9px] px-1.5 py-0.5 rounded-full ${colors.bg} ${colors.text} flex items-center gap-0.5`}
                              title={worst.hint || worst.error || ""}
                            >
                              <Lock className="w-2.5 h-2.5" />
                              {issues.map(({ slug, probe }) => (
                                <span key={slug}>{slug}: {PROBE_LABELS[probe!.status]}</span>
                              ))}
                            </span>
                          );
                        }
                        return (
                          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 flex items-center gap-0.5">
                            <LockOpen className="w-2.5 h-2.5" /> verified
                          </span>
                        );
                      })()}
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
