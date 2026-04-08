"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { Trash2, Square, X, FileText, Columns, LayoutGrid, MessageSquare, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import {
  ExecutionCanvas,
  type CanvasHandle,
  type ExecutionNode,
  type ProjectResource,
} from "@/components/execution-canvas";
import {
  InspectorPanel,
  type ExecutionEvent,
} from "@/components/inspector-panel";
import { type StreamEntry } from "@/components/conversation-stream";
import { DragResizeLayout } from "@/components/drag-resize-layout";
import { SystemDescriptionView } from "@/components/system-description-view";
import type { ProjectDescriptionData, DescriptionVersion } from "@/components/document-header";
import type { NodeIssue } from "@/components/issue-card";
import { CommentSidebar, type CommentThread } from "@/components/comment-sidebar";
import { SESSION_STATUS_TEXT } from "@/lib/tokens";

interface ExecutionSession {
  id: string;
  request_text: string;
  status: string;
  nodes: ExecutionNode[];
  plan_approved_at: string | null;
  project_id?: string | null;
  project_description_id?: string | null;
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


export default function SessionPage() {
  const { session_id } = useParams();
  const router = useRouter();
  const { activeClient, apiFetch, token, loading: _authLoading } = useAuth();
  const [session, setSession] = useState<ExecutionSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [nodeEvents, setNodeEvents] = useState<ExecutionEvent[]>([]);
  const [nodeEventsLoading, setNodeEventsLoading] = useState(false);
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus | null>(null);
  const [catalogMap, setCatalogMap] = useState<CatalogMap>({});
  const [integrationAlternatives, setIntegrationAlternatives] = useState<Record<string, string[]>>({});
  const canvasRef = useRef<CanvasHandle>(null);
  
  const [liveThinkingChunks, setLiveThinkingChunks] = useState<Record<string, string>>({});
  const [liveTextChunks, setLiveTextChunks] = useState<Record<string, string>>({});
  const [streamEntries, setStreamEntries] = useState<StreamEntry[]>([]);
  const [streamLoading, setStreamLoading] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [failures, setFailures] = useState<ExecutionNode[]>([]);
  // Per-node live text preview for canvas (all nodes, not just selected)
  const [livePreviewMap, setLivePreviewMap] = useState<Record<string, string>>({});
  const pendingPreviewMap = useRef<Record<string, string>>({});
  const selectedNodeIdRef = useRef(selectedNodeId);
  selectedNodeIdRef.current = selectedNodeId;

  // Master orchestrator bottom panel state
  const [masterStreamEntries, setMasterStreamEntries] = useState<StreamEntry[]>([]);
  const [masterStreamLoading, setMasterStreamLoading] = useState(false);
  const [masterLiveTextChunks, setMasterLiveTextChunks] = useState<Record<string, string>>({});
  const [masterLiveThinkingChunks, setMasterLiveThinkingChunks] = useState<Record<string, string>>({});
  const pendingMasterText = useRef<Record<string, string>>({});
  const pendingMasterThinking = useRef<Record<string, string>>({});
  const masterFetchSeq = useRef(0);
  const [chatPending, setChatPending] = useState(false);

  // Planning progress (streamed via SSE while status === 'planning')
  const [planningMessages, setPlanningMessages] = useState<string[]>([]);
  const [planningError, setPlanningError] = useState<string | null>(null);

  // Living system description state
  type ViewMode = "document" | "split" | "canvas";
  const [viewMode, setViewMode] = useState<ViewMode>("canvas");
  const [projectDescription, setProjectDescription] = useState<ProjectDescriptionData | null>(null);
  const [descriptionVersions, setDescriptionVersions] = useState<DescriptionVersion[]>([]);
  const [sessionIssues, setSessionIssues] = useState<NodeIssue[]>([]);
  const [commentThreads, setCommentThreads] = useState<CommentThread[]>([]);
  const [showCommentSidebar, setShowCommentSidebar] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);

  // Real-time change tracking for visual transitions
  const [changedNodes, setChangedNodes] = useState<Record<string, number>>({});
  const lastSeqRef = useRef(0);
  const sseConnectedRef = useRef(false);

  // SD-008: Project resources + add node dialog + discovery panel
  const [projectResources, setProjectResources] = useState<ProjectResource[]>([]);
  const [showAddNodeDialog, setShowAddNodeDialog] = useState(false);
  const [showDiscoveryPanel, setShowDiscoveryPanel] = useState(false);

  const markNodeChanged = useCallback((nodeId: string) => {
    const now = Date.now();
    setChangedNodes(prev => ({ ...prev, [nodeId]: now }));
    setTimeout(() => {
      setChangedNodes(prev => {
        if (prev[nodeId] === now) {
          const next = { ...prev };
          delete next[nodeId];
          return next;
        }
        return prev;
      });
    }, 2500);
  }, []);

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
      setMasterLiveTextChunks({ ...pendingMasterText.current });
      setMasterLiveThinkingChunks({ ...pendingMasterThinking.current });
      rafId.current = undefined;
    });
  }, []);

  // Cleanup pending RAF on unmount to prevent state updates on unmounted component
  useEffect(() => {
    return () => {
      if (rafId.current !== undefined) {
        cancelAnimationFrame(rafId.current);
        rafId.current = undefined;
      }
    };
  }, []);

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

  const fetchFailures = useCallback(async () => {
    try {
      const r = await apiFetch(`/api/execute/${session_id}/failures`);
      if (!r.ok) return;
      const data = await r.json();
      setFailures(data.failures ?? []);
    } catch { /* transient */ }
  }, [session_id, apiFetch]);

  // Fetch session issues
  const fetchIssues = useCallback(async () => {
    try {
      const r = await apiFetch(`/api/execute/${session_id}/issues`);
      if (!r.ok) return;
      const data = await r.json();
      setSessionIssues(data.issues ?? []);
    } catch { /* transient */ }
  }, [session_id, apiFetch]);

  const fetchThreads = useCallback(async () => {
    try {
      const r = await apiFetch(`/api/execute/${session_id}/threads`);
      if (!r.ok) return;
      const data = await r.json();
      setCommentThreads(data.threads ?? []);
    } catch { /* transient */ }
  }, [session_id, apiFetch]);

  // Fetch project description if session has one
  const hasAutoSwitchedView = useRef(false);
  const fetchProjectDescription = useCallback(async () => {
    if (!session) return;
    const projectId = session?.project_id;
    if (!projectId) return;
    try {
      const r = await apiFetch(`/api/projects/${projectId}/descriptions`);
      if (!r.ok) return;
      const data = await r.json();
      if (data.description) {
        setProjectDescription(data.description);
        setDescriptionVersions(data.versions ?? []);
        if (!hasAutoSwitchedView.current) {
          hasAutoSwitchedView.current = true;
          setViewMode("document");
        }
      }
    } catch { /* transient */ }
  }, [session, apiFetch]);

  useEffect(() => {
    if (!token) return;
    fetchSession();
    fetchFailures();
    fetchIssues();
    fetchThreads();
  }, [token, fetchSession, fetchFailures, fetchIssues, fetchThreads]);

  useEffect(() => {
    fetchProjectDescription();
  }, [fetchProjectDescription]);

  // SD-008: Fetch linked project resources
  const fetchProjectResources = useCallback(async () => {
    if (!session?.project_id) return;
    try {
      const r = await apiFetch(`/api/projects/${session.project_id}/resources`);
      if (!r.ok) return;
      const data = await r.json();
      setProjectResources(data.resources ?? []);
    } catch { /* transient */ }
  }, [session?.project_id, apiFetch]);

  useEffect(() => {
    fetchProjectResources();
  }, [fetchProjectResources]);

  // Poll during planning phase — planner_progress SSE events are broadcast
  // before the frontend subscribes, so we poll to catch the transition.
  useEffect(() => {
    if (!session || session.status !== "planning") return;
    const timer = setInterval(() => fetchSession(), 4000);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.status, fetchSession]);

  // Fetch credential status for agents in this session
  useEffect(() => {
    if (!session || !activeClient) return;
    const slugs = [...new Set(session.nodes.map((n) => n.agent_slug))].join(",");
    if (!slugs) return;
    apiFetch(`/api/clients/${activeClient}/credential-check?agents=${slugs}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setCredentialStatus(data); })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.nodes, activeClient, apiFetch]);

  // Fetch catalog for agent metadata (tools, category, description)
  useEffect(() => {
    if (!token) return;
    apiFetch("/api/catalog")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data) return;
        const map: CatalogMap = {};
        for (const a of data.agents ?? []) map[a.slug] = a;
        setCatalogMap(map);
        if (data.integration_alternatives) {
          setIntegrationAlternatives(data.integration_alternatives);
        }
      })
      .catch(() => {});
  }, [token, apiFetch]);

  // Update a node field via PATCH — optimistic local update with SSE confirmation
  const handleNodeUpdate = useCallback(
    async (nodeId: string, patch: Record<string, unknown>) => {
      setSession(prev => {
        if (!prev) return prev;
        return { ...prev, nodes: prev.nodes.map(n => n.id === nodeId ? { ...n, ...patch } : n) };
      });
      markNodeChanged(nodeId);

      try {
        const resp = await apiFetch(`/api/execute/${session_id}/nodes/${nodeId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!resp.ok) {
          fetchSession();
        }
      } catch {
        fetchSession();
      }
    },
    [session_id, apiFetch, fetchSession, markNodeChanged]
  );

  // SD-008: Delete a node from the plan
  const handleNodeDelete = useCallback(async (nodeId: string) => {
    try {
      const resp = await apiFetch(`/api/execute/${session_id}/nodes/${nodeId}`, { method: "DELETE" });
      if (resp.ok) {
        setSession(prev => {
          if (!prev) return prev;
          return { ...prev, nodes: prev.nodes.filter(n => n.id !== nodeId) };
        });
        if (selectedNodeId === nodeId) setSelectedNodeId(null);
      }
    } catch { /* transient */ }
  }, [session_id, apiFetch, selectedNodeId]);

  // SD-008: Add a new node to the plan
  const handleAddNode = useCallback(async (req: {
    agent_slug: string;
    task_description: string;
    requires?: string[];
    execution_mode?: string;
    description?: Record<string, unknown>;
  }) => {
    try {
      const resp = await apiFetch(`/api/execute/${session_id}/nodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      if (resp.ok) {
        fetchSession();
        setShowAddNodeDialog(false);
      }
    } catch { /* transient */ }
  }, [session_id, apiFetch, fetchSession]);

  const fetchNodeEvents = useCallback(async () => {
    if (!selectedNodeId || !session_id) {
      setNodeEvents([]);
      setNodeEventsLoading(false);
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

  const fetchNodeStream = useCallback(async () => {
    if (!selectedNodeId || !session_id) {
      setStreamEntries([]);
      setStreamLoading(false);
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

  // Derive master orchestrator node (the one without parent_uid)
  const masterNode = session?.nodes.find(n => !n.parent_uid) ?? null;
  const masterNodeId = masterNode?.id ?? null;
  const masterNodeIdRef = useRef(masterNodeId);
  masterNodeIdRef.current = masterNodeId;

  const fetchMasterStream = useCallback(async () => {
    if (!masterNodeId || !session_id) {
      setMasterStreamEntries([]);
      return;
    }
    const seq = ++masterFetchSeq.current;
    setMasterStreamLoading(true);
    try {
      const r = await apiFetch(`/api/execute/${session_id}/nodes/${masterNodeId}/stream`);
      if (seq !== masterFetchSeq.current) return;
      if (!r.ok) { setMasterStreamEntries([]); setMasterStreamLoading(false); return; }
      const data = await r.json();
      if (seq !== masterFetchSeq.current) return;
      setMasterStreamEntries(data.stream ?? []);
    } catch {
      if (seq === masterFetchSeq.current) setMasterStreamEntries([]);
    } finally {
      if (seq === masterFetchSeq.current) setMasterStreamLoading(false);
    }
  }, [masterNodeId, session_id, apiFetch]);

  // Fetch master stream when master node becomes available
  useEffect(() => {
    fetchMasterStream();
  }, [fetchMasterStream]);

  // Fetch stream (unified events+thinking+messages) when selected node changes.
  // The /stream endpoint already includes thinking blocks and messages via UNION ALL,
  // so we only need this single call — no separate /thinking or /messages fetches.
  useEffect(() => {
    fetchNodeStream();
    // Reset live chunks when switching nodes
    setLiveThinkingChunks({});
    setLiveTextChunks({});
    pendingText.current = {};
    pendingThinking.current = {};
    // Also reset preview map for the previously selected node
    pendingPreviewMap.current = {};
  }, [fetchNodeStream]);

  useEffect(() => {
    if (!session || !token) return;
    let isMounted = true;
    const sseUrl = `/api/execute/${session_id}/events?token=${encodeURIComponent(token)}`;
    const es = new EventSource(sseUrl);
    es.onmessage = (msg) => {
      if (!isMounted) return;

      try {
        const data = JSON.parse(msg.data);

        // Sequence gap detection
        const seq = typeof data._seq === "number" ? data._seq : undefined;
        if (seq !== undefined) {
          if (lastSeqRef.current > 0 && seq > lastSeqRef.current + 1) {
            if (process.env.NODE_ENV === "development") {
              console.warn(`[SSE] seq gap: expected ${lastSeqRef.current + 1}, got ${seq}`);
            }
            fetchSession();
          }
          lastSeqRef.current = seq;
        }

        const streamEntry = data.stream_entry;
        const nodeUid = data.node_uid as string | undefined;
        const isSelectedNode = nodeUid === selectedNodeIdRef.current;
        const isMasterNode = nodeUid === masterNodeIdRef.current;
        const eventType = data.type as string | undefined;

        // Debug: trace SSE events for session chat
        if (streamEntry?.stream_type === "message" || streamEntry?.stream_type === "message_stop") {
          if (process.env.NODE_ENV === "development") {
            console.log("[SSE]", streamEntry.stream_type, streamEntry.sub_type, { isMasterNode, nodeUid, masterRef: masterNodeIdRef.current });
          }
        }

        // Handle planning phase events
        if (eventType === "planner_progress") {
          setPlanningMessages((prev) => [...prev, data.message as string]);
          return;
        }
        if (eventType === "plan_ready") {
          setPlanningMessages([]);
          fetchSession();
          return;
        }
        if (eventType === "planner_error") {
          setPlanningError(data.error as string);
          fetchSession();
          return;
        }

        // Granular node mutation events (real-time digital twin)
        if (eventType === "node_updated") {
          const changes = data.changes as Record<string, unknown> | undefined;
          if (changes) {
            setSession(prev => {
              if (!prev) return prev;
              return { ...prev, nodes: prev.nodes.map(n => n.id === data.node_id ? { ...n, ...changes } : n) };
            });
          }
          markNodeChanged(data.node_id as string);
          return;
        }
        if (eventType === "node_added") {
          fetchSession();
          markNodeChanged(data.node_id as string);
          return;
        }
        if (eventType === "node_removed") {
          const removedId = data.node_id as string;
          markNodeChanged(removedId);
          setTimeout(() => {
            setSession(prev => {
              if (!prev) return prev;
              return { ...prev, nodes: prev.nodes.filter(n => n.id !== removedId) };
            });
          }, 300);
          return;
        }
        if (eventType === "node_status_changed") {
          setSession(prev => {
            if (!prev) return prev;
            return { ...prev, nodes: prev.nodes.map(n => n.id === data.node_uid ? { ...n, status: data.status as string } : n) };
          });
          markNodeChanged(data.node_uid as string);
          return;
        }
        if (eventType === "resync_required") {
          fetchSession();
          fetchFailures();
          return;
        }

        // Only re-fetch session/failures on meaningful state changes (not every delta)
        const isTerminalEvent = eventType === "node_completed" || eventType === "node_started"
          || eventType === "session_completed" || eventType === "node_resumed"
          || eventType === "node_awaiting_reply" || eventType === "artifacts_updated";
        if (isTerminalEvent) {
          fetchSession();
          fetchFailures();
          if (isSelectedNode) {
            fetchNodeEvents();
            fetchNodeStream();
          }
          // Re-fetch master stream on terminal events
          if (isMasterNode) {
            fetchMasterStream();
          }
        }

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

        // Accumulate live chunks for MASTER node (bottom panel).
        // Also forward child-node deltas when the master is selected so the
        // orchestrator view isn't blank while children execute.
        const showInMaster = isMasterNode || (!isMasterNode && nodeUid && masterNodeIdRef.current && selectedNodeIdRef.current === masterNodeIdRef.current);
        if (streamEntry && showInMaster) {
          const st = streamEntry.stream_type;
          if (st === "text_delta") {
            const key = String(streamEntry.block_index ?? 0);
            pendingMasterText.current[key] = (pendingMasterText.current[key] || "") + (streamEntry.content || "");
            setChatPending(false);
            scheduleRaf();
          } else if (st === "thinking_delta") {
            const key = String(streamEntry.block_index ?? 0);
            pendingMasterThinking.current[key] = (pendingMasterThinking.current[key] || "") + (streamEntry.content || "");
            setChatPending(false);
            scheduleRaf();
          } else if (st === "message_stop") {
            pendingMasterText.current = {};
            pendingMasterThinking.current = {};
            setMasterLiveTextChunks({});
            setMasterLiveThinkingChunks({});
            setChatPending(false);
            fetchMasterStream();
          } else if (st !== "content_block_start" && st !== "content_block_stop") {
            setMasterStreamEntries((prev) => [...prev, streamEntry as StreamEntry]);
          }
        }

        // Accumulate live chunks for SELECTED node (inspector panel)
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
          eventType === "executor_thinking" &&
          isSelectedNode
        ) {
          fetchNodeStream();
        }
      } catch {
        // Not JSON, ignore
      }
    };
    // Let EventSource auto-reconnect on transient errors.
    // Fall back to polling if the connection stays down.
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    es.onerror = () => {
      if (!isMounted) return;
      sseConnectedRef.current = false;
      if (!pollTimer) {
        pollTimer = setInterval(() => {
          if (!isMounted) return;
          fetchSession();
          fetchFailures();
        }, 5000);
      }
    };
    es.onopen = () => {
      sseConnectedRef.current = true;
      lastSeqRef.current = 0;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      // Re-fetch session to catch any state changes (e.g. plan_ready) that
      // happened between session creation and SSE subscription, since
      // broadcast receivers only see events sent after they subscribe.
      fetchSession();
    };
    return () => {
      isMounted = false;
      sseConnectedRef.current = false;
      es.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session_id, token, session?.status, fetchSession, fetchFailures, fetchNodeEvents, fetchNodeStream, fetchMasterStream, scheduleRaf]);

  // Background reconciliation: 30s when SSE connected, 5s when disconnected
  useEffect(() => {
    if (!session) return;
    const interval = setInterval(() => {
      fetchSession();
    }, sseConnectedRef.current ? 30000 : 5000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, fetchSession]);

  useEffect(() => {
    setNodeEventsLoading(true);
    fetchNodeEvents();
  }, [fetchNodeEvents]);

  const handleReply = useCallback(
    async (nodeId: string, message: string) => {
      const resp = await apiFetch(`/api/execute/${session_id}/nodes/${nodeId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const data = await resp.json().catch(() => ({}));
      const targetNodeId = data.target_node_id ?? nodeId;

      fetchSession();
      fetchMasterStream();
      if (selectedNodeIdRef.current) fetchNodeStream();

      // Poll for the response in case SSE events are missed (e.g. reconnect gap).
      const poll = async () => {
        let delay = 1000;
        const maxDelay = 8000;
        const maxAttempts = 20;
        for (let i = 0; i < maxAttempts; i++) {
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(delay * 1.5, maxDelay);
          try {
            // Check the target node's stream for an assistant response
            const r = await apiFetch(
              `/api/execute/${session_id}/nodes/${targetNodeId}/stream`
            );
            if (!r.ok) continue;
            const streamData = await r.json();
            const entries = (streamData.stream ?? []) as StreamEntry[];
            const last = entries[entries.length - 1];
            if (
              last &&
              last.stream_type === "message" &&
              (last.sub_type === "assistant" || last.role === "assistant")
            ) {
              // Response arrived — refresh both streams
              fetchMasterStream();
              if (selectedNodeIdRef.current) fetchNodeStream();
              fetchSession();
              break;
            }
            // Also break if the node is no longer running
            const sessResp = await apiFetch(`/api/execute/${session_id}`);
            if (sessResp.ok) {
              const sessData = await sessResp.json();
              const nodes = sessData.nodes ?? sessData.session?.nodes ?? [];
              const target = nodes.find((n: ExecutionNode) => n.id === targetNodeId);
              if (target && target.status !== "running") {
                fetchMasterStream();
                if (selectedNodeIdRef.current) fetchNodeStream();
                fetchSession();
                break;
              }
            }
          } catch {
            // ignore transient errors
          }
        }
      };
      poll();
    },
    [session_id, apiFetch, fetchNodeStream, fetchSession, fetchMasterStream]
  );

  const handleSessionChat = useCallback(
    async (_nodeId: string, message: string) => {
      setChatPending(true);
      await apiFetch(`/api/execute/${session_id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      fetchMasterStream();

      // Poll for the assistant response with exponential backoff.
      // SSE should also deliver it, but polling guarantees it appears regardless.
      const poll = async () => {
        const nid = masterNodeIdRef.current;
        if (!nid) return;
        let delay = 1000;
        const maxDelay = 8000;
        const maxAttempts = 15;
        for (let i = 0; i < maxAttempts; i++) {
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(delay * 1.5, maxDelay);
          try {
            const r = await apiFetch(
              `/api/execute/${session_id}/nodes/${nid}/stream`
            );
            if (!r.ok) continue;
            const data = await r.json();
            const entries = (data.stream ?? []) as StreamEntry[];
            const last = entries[entries.length - 1];
            if (
              last &&
              last.stream_type === "message" &&
              (last.sub_type === "assistant" || last.role === "assistant")
            ) {
              setMasterStreamEntries(entries);
              setChatPending(false);
              break;
            }
          } catch {
            // ignore
          }
        }
        // If poll exhausted without finding a response, clear pending anyway
        setChatPending(false);
      };
      poll();
    },
    [session_id, apiFetch, fetchMasterStream]
  );

  const activeReplyHandler = session?.status === "awaiting_approval" || session?.status === "planning"
    || session?.status === "completed" || session?.status === "failed" || session?.status === "stopped"
    ? handleSessionChat
    : handleReply;

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

  // ── Living Description Handlers ─────────────────────────────────────────
  const handleIssueResolve = async (issueId: string) => {
    await apiFetch(`/api/execute/${session_id}/issues/${issueId}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "resolve" }),
    });
    fetchIssues();
  };

  const handleIssueDismiss = async (issueId: string) => {
    await apiFetch(`/api/execute/${session_id}/issues/${issueId}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "dismiss" }),
    });
    fetchIssues();
  };

  const handleProjectDescriptionUpdate = async (fields: Partial<ProjectDescriptionData>) => {
    const projectId = session?.project_id;
    if (!projectId) return;
    await apiFetch(`/api/projects/${projectId}/descriptions/update`, {
      method: "PATCH",
      body: JSON.stringify(fields),
    });
    fetchProjectDescription();
  };

  const handleNodeDescriptionUpdate = async (nodeId: string, description: Record<string, unknown>) => {
    await apiFetch(`/api/execute/${session_id}/nodes/${nodeId}/description`, {
      method: "PATCH",
      body: JSON.stringify({ description }),
    });
    fetchSession();
  };

  const handleCommentCreate = useCallback(async (nodeId: string, sectionPath: string) => {
    try {
      const r = await apiFetch(`/api/execute/${session_id}/threads`, {
        method: "POST",
        body: JSON.stringify({ node_id: nodeId, section_path: sectionPath, message: "New discussion" }),
      });
      if (r.ok) {
        await fetchThreads();
        setShowCommentSidebar(true);
      }
    } catch { /* transient */ }
  }, [session_id, apiFetch, fetchThreads]);

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
      {/* Unified top bar: status + progress + view toggles + actions */}
      <div className="border-b border-rim px-3 h-10 flex items-center gap-3 bg-page shrink-0">
        {/* Status badge */}
        <span className={`text-[11px] font-semibold uppercase tracking-wide shrink-0 ${SESSION_STATUS_TEXT[session.status] ?? "text-ink-3"}`}>
          {session.status.replace(/_/g, " ")}
        </span>

        {/* Inline progress bar (only during execution) */}
        {session.status === "executing" && (() => {
          const mn = session.nodes.find(n => !n.parent_uid);
          const children = mn ? session.nodes.filter(n => n.parent_uid === mn.id) : session.nodes;
          const total = children.length;
          const done = children.filter(n => n.status === "passed" || n.status === "failed" || n.status === "skipped").length;
          const running = children.find(n => n.status === "running");
          const pct = total > 0 ? (done / total) * 100 : 0;
          return total > 0 ? (
            <div className="flex items-center gap-2 shrink-0">
              <div className="w-24 h-1 rounded-full bg-rim overflow-hidden">
                <div className="h-full bg-brand rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
              </div>
              <span className="text-[11px] text-ink-3 whitespace-nowrap">
                {done + (running ? 1 : 0)}/{total}
              </span>
            </div>
          ) : null;
        })()}

        {/* Request text */}
        <span className="text-xs text-ink-3 truncate min-w-0 flex-1">
          {session.request_text}
        </span>

        {/* Separator */}
        <span className="text-rim-strong shrink-0">{"\u2502"}</span>

        {/* View mode toggles */}
        <div className="flex items-center gap-0.5 shrink-0">
          {(["document", "split", "canvas"] as const).map((mode) => {
            const Icon = mode === "document" ? FileText : mode === "split" ? Columns : LayoutGrid;
            return (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                className={`p-1.5 rounded text-xs transition-colors ${
                  viewMode === mode ? "text-brand bg-brand/10" : "text-ink-3 hover:text-ink"
                }`}
                title={mode.charAt(0).toUpperCase() + mode.slice(1)}
              >
                <Icon className="w-3.5 h-3.5" />
              </button>
            );
          })}
        </div>

        {/* Comments */}
        <button
          onClick={() => setShowCommentSidebar((v) => !v)}
          className={`flex items-center gap-1 p-1.5 rounded text-xs transition-colors shrink-0 ${
            showCommentSidebar ? "text-brand bg-brand/10" : "text-ink-3 hover:text-ink"
          }`}
          title="Comments"
        >
          <MessageSquare className="w-3.5 h-3.5" />
          {commentThreads.filter((t) => t.status === "open").length > 0 && (
            <span className="text-xs px-1 rounded-full bg-brand text-white leading-4 min-w-[14px] text-center">
              {commentThreads.filter((t) => t.status === "open").length}
            </span>
          )}
        </button>

        {/* Separator */}
        <span className="text-rim-strong shrink-0">{"\u2502"}</span>

        {/* Actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          {session.project_id && (
            <button
              onClick={() => setShowDiscoveryPanel(true)}
              className="px-2.5 py-1 text-xs text-ink-2 hover:text-ink border border-rim rounded hover:bg-surface transition-colors"
            >
              Discover Resources
            </button>
          )}
          {session.status === "awaiting_approval" && (
            <button
              onClick={handleApprove}
              disabled={approving || hasProbeFailures}
              className="bg-brand text-white px-3 py-1 rounded text-xs font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors"
              title={hasProbeFailures ? "Fix credential issues before approving" : undefined}
            >
              {approving ? "Approving\u2026" : "Approve"}
            </button>
          )}
          {session.status === "executing" && (
            <button
              onClick={handleStop}
              disabled={stopping}
              className="bg-red-600 text-white px-3 py-1 rounded text-xs font-medium hover:bg-red-700 disabled:opacity-50 transition-colors flex items-center gap-1"
            >
              <Square className="w-3 h-3 fill-current" />
              {stopping ? "Stopping\u2026" : "Stop"}
            </button>
          )}
          <button
            onClick={handleDeleteSession}
            className="p-1.5 rounded hover:bg-red-50 hover:text-red-500 text-ink-3 transition-colors"
            title="Delete session"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Contextual banners (only shown when needed) */}
      {session.status === "awaiting_approval" && hasProbeFailures && (
        <div className="border-b border-red-200 px-4 py-2 shrink-0 bg-red-50/80">
          <p className="text-xs font-medium text-red-800 mb-1">
            Credential check failed:
          </p>
          <div className="space-y-1">
            {probeFailures.map(([slug, r]) => {
              const colors = PROBE_COLORS[r.status] ?? PROBE_COLORS.missing;
              return (
                <div key={slug} className="flex items-center gap-2 text-[11px]">
                  <span className={`shrink-0 px-1 py-0.5 rounded font-medium ${colors.bg} ${colors.text} border ${colors.border}`}>
                    {PROBE_LABELS[r.status] ?? r.status}
                  </span>
                  <span className="font-mono text-ink">{slug}</span>
                  {r.error && <span className="text-ink-2">{"\u2014"} {r.error}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {approvalError && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-xs text-amber-800 shrink-0 whitespace-pre-line">
          {approvalError}
        </div>
      )}
      {/* Main content area — top portion */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        {viewMode === "document" && (
          <div className="flex h-full">
            <div className="flex-1 min-w-0">
              <SystemDescriptionView
                nodes={session.nodes}
                sessionStatus={session.status}
                requestText={session.request_text}
                selectedNodeId={selectedNodeId}
                projectDescription={projectDescription}
                issues={sessionIssues}
                livePreviewMap={livePreviewMap}
                versions={descriptionVersions}
                onNodeClick={handleNodeClick}
                onProjectDescriptionUpdate={handleProjectDescriptionUpdate}
                onNodeDescriptionUpdate={handleNodeDescriptionUpdate}
                onIssueResolve={handleIssueResolve}
                onIssueDismiss={handleIssueDismiss}
                onCommentCreate={handleCommentCreate}
                issueCount={sessionIssues.length}
                openIssueCount={sessionIssues.filter(i => i.status === "open").length}
              />
            </div>
            {showCommentSidebar && (
              <div className="w-80 border-l border-rim bg-page overflow-y-auto shrink-0">
                <div className="flex items-center justify-between px-3 py-2 border-b border-rim">
                  <span className="text-xs font-semibold text-ink-2 uppercase tracking-wider">Comments</span>
                  <button onClick={() => setShowCommentSidebar(false)} className="text-ink-3 hover:text-ink">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <CommentSidebar
                  threads={commentThreads}
                  sessionId={session_id as string}
                  apiFetch={apiFetch}
                  onThreadCreated={fetchThreads}
                />
              </div>
            )}
          </div>
        )}

        {viewMode === "split" && (
          <div className="flex h-full">
            <div className="flex-1 min-w-0">
              <DragResizeLayout
                defaultRightWidth={420}
                minRightWidth={320}
                maxRightWidth="70%"
                left={
                  <SystemDescriptionView
                    nodes={session.nodes}
                    sessionStatus={session.status}
                    requestText={session.request_text}
                    selectedNodeId={selectedNodeId}
                    projectDescription={projectDescription}
                    issues={sessionIssues}
                    livePreviewMap={livePreviewMap}
                    versions={descriptionVersions}
                    onNodeClick={handleNodeClick}
                    onProjectDescriptionUpdate={handleProjectDescriptionUpdate}
                    onNodeDescriptionUpdate={handleNodeDescriptionUpdate}
                    onIssueResolve={handleIssueResolve}
                    onIssueDismiss={handleIssueDismiss}
                    onCommentCreate={handleCommentCreate}
                    issueCount={sessionIssues.length}
                    openIssueCount={sessionIssues.filter(i => i.status === "open").length}
                  />
                }
                right={
                  <div className="relative h-full bg-surface">
                    <ExecutionCanvas
                      ref={canvasRef}
                      nodes={session.nodes}
                      sessionStatus={session.status}
                      selectedNodeId={selectedNodeId}
                      onNodeClick={handleNodeClick}
                      credentialStatus={credentialStatus}
                      catalogMap={catalogMap}
                      livePreviewMap={livePreviewMap}
                      planningMessages={planningMessages}
                      changedNodes={changedNodes}
                      onNodeDelete={handleNodeDelete}
                      onAddNode={() => setShowAddNodeDialog(true)}
                      projectResources={projectResources}
                    />
                  </div>
                }
              />
            </div>
            {showCommentSidebar && (
              <div className="w-80 border-l border-rim bg-page overflow-y-auto shrink-0">
                <div className="flex items-center justify-between px-3 py-2 border-b border-rim">
                  <span className="text-xs font-semibold text-ink-2 uppercase tracking-wider">Comments</span>
                  <button onClick={() => setShowCommentSidebar(false)} className="text-ink-3 hover:text-ink">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <CommentSidebar
                  threads={commentThreads}
                  sessionId={session_id as string}
                  apiFetch={apiFetch}
                  onThreadCreated={fetchThreads}
                />
              </div>
            )}
          </div>
        )}

        {viewMode === "canvas" && (
          <div className="flex h-full">
            {chatCollapsed ? (
              <div className="relative flex-1 min-w-0 bg-surface">
                <button
                  onClick={() => setChatCollapsed(false)}
                  className="absolute top-2 left-2 z-20 p-1.5 rounded-md border border-rim bg-page/80 backdrop-blur-sm text-ink-3 hover:text-ink hover:bg-surface transition-colors shadow-sm"
                  title="Show chat"
                >
                  <PanelLeftOpen className="w-4 h-4" />
                </button>
                <ExecutionCanvas
                  ref={canvasRef}
                  nodes={session.nodes}
                  sessionStatus={session.status}
                  selectedNodeId={selectedNodeId}
                  onNodeClick={handleNodeClick}
                  credentialStatus={credentialStatus}
                  catalogMap={catalogMap}
                  livePreviewMap={livePreviewMap}
                  planningMessages={planningMessages}
                  changedNodes={changedNodes}
                  onNodeDelete={handleNodeDelete}
                  onAddNode={() => setShowAddNodeDialog(true)}
                  projectResources={projectResources}
                />
              </div>
            ) : (
              <DragResizeLayout
                fixedSide="left"
                defaultLeftWidth={340}
                minLeftWidth={280}
                maxLeftWidth="50%"
                left={
                  <InspectorPanel
                    selectedNode={selectedNode}
                    nodeEvents={nodeEvents}
                    nodeEventsLoading={nodeEventsLoading}
                    allNodes={session.nodes}
                    credentialStatus={credentialStatus}
                    catalogMap={catalogMap}
                    integrationAlternatives={integrationAlternatives}
                    sessionStatus={session.status}
                    onNodeUpdate={handleNodeUpdate}
                    liveThinkingChunks={liveThinkingChunks}
                    onReply={activeReplyHandler}
                    streamEntries={streamEntries}
                    streamLoading={streamLoading}
                    liveTextChunks={liveTextChunks}
                    failures={failures}
                    onNodeSelect={handleNodeClick}
                    masterNode={masterNode}
                    masterStreamEntries={masterStreamEntries}
                    masterStreamLoading={masterStreamLoading}
                    masterLiveTextChunks={masterLiveTextChunks}
                    masterLiveThinkingChunks={masterLiveThinkingChunks}
                    planningMessages={planningMessages}
                    planningError={planningError}
                    chatPending={chatPending}
                    projectResources={projectResources}
                    onNodeDescriptionUpdate={handleNodeDescriptionUpdate}
                    clientSlug={activeClient ?? undefined}
                  />
                }
                right={
                  <div className="relative h-full bg-surface">
                    <button
                      onClick={() => setChatCollapsed(true)}
                      className="absolute top-2 left-2 z-20 p-1.5 rounded-md border border-rim bg-page/80 backdrop-blur-sm text-ink-3 hover:text-ink hover:bg-surface transition-colors shadow-sm"
                      title="Hide chat"
                    >
                      <PanelLeftClose className="w-4 h-4" />
                    </button>
                    <ExecutionCanvas
                      ref={canvasRef}
                      nodes={session.nodes}
                      sessionStatus={session.status}
                      selectedNodeId={selectedNodeId}
                      onNodeClick={handleNodeClick}
                      credentialStatus={credentialStatus}
                      catalogMap={catalogMap}
                      livePreviewMap={livePreviewMap}
                      planningMessages={planningMessages}
                      changedNodes={changedNodes}
                      onNodeDelete={handleNodeDelete}
                      onAddNode={() => setShowAddNodeDialog(true)}
                      projectResources={projectResources}
                    />
                  </div>
                }
              />
            )}
          </div>
        )}
      </div>

      {/* SD-008: Add Node Dialog */}
      {showAddNodeDialog && (
        <AddNodeDialog
          catalogMap={catalogMap}
          allNodes={session.nodes}
          projectResources={projectResources}
          onSubmit={handleAddNode}
          onClose={() => setShowAddNodeDialog(false)}
        />
      )}

      {/* SD-008: Discovery Panel */}
      {showDiscoveryPanel && session.project_id && (
        <DiscoveryPanel
          projectId={session.project_id}
          apiFetch={apiFetch}
          onClose={() => setShowDiscoveryPanel(false)}
          onResourcesLinked={fetchProjectResources}
        />
      )}

    </div>
  );
}

// ── SD-008: Add Node Dialog ──────────────────────────────────────────────────

function AddNodeDialog({
  catalogMap,
  allNodes,
  projectResources,
  onSubmit,
  onClose,
}: {
  catalogMap: CatalogMap;
  allNodes: ExecutionNode[];
  projectResources: ProjectResource[];
  onSubmit: (req: {
    agent_slug: string;
    task_description: string;
    requires?: string[];
    execution_mode?: string;
    description?: Record<string, unknown>;
  }) => Promise<void>;
  onClose: () => void;
}) {
  const [agentSlug, setAgentSlug] = useState("");
  const [taskDesc, setTaskDesc] = useState("");
  const [execMode, setExecMode] = useState<"agent" | "manual">("agent");
  const [deps, setDeps] = useState<string[]>([]);
  const [selectedResources, setSelectedResources] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const agents = Object.values(catalogMap).sort((a, b) => a.name.localeCompare(b.name));

  const handleSubmit = async () => {
    if (!agentSlug || !taskDesc.trim()) return;
    setSubmitting(true);
    try {
      const description: Record<string, unknown> = {};
      if (selectedResources.length > 0) {
        description.assigned_resources = selectedResources.map(id => ({ resource_id: id, role: "owner" }));
      }
      await onSubmit({
        agent_slug: agentSlug,
        task_description: taskDesc.trim(),
        requires: deps.length > 0 ? deps : undefined,
        execution_mode: execMode,
        description: Object.keys(description).length > 0 ? description : undefined,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-page border border-rim rounded-xl shadow-xl w-[480px] max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-rim">
          <h3 className="text-sm font-semibold text-ink">Add Node</h3>
          <button onClick={onClose} className="text-ink-3 hover:text-ink"><X className="w-4 h-4" /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="text-xs font-medium text-ink-2 block mb-1">Agent Type</label>
            <select
              value={agentSlug}
              onChange={e => setAgentSlug(e.target.value)}
              className="w-full border border-rim rounded-lg px-3 py-2 text-sm bg-surface text-ink"
            >
              <option value="">Select agent...</option>
              {agents.map(a => (
                <option key={a.slug} value={a.slug}>{a.name} ({a.category})</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-ink-2 block mb-1">Task Description</label>
            <textarea
              value={taskDesc}
              onChange={e => setTaskDesc(e.target.value)}
              rows={3}
              className="w-full border border-rim rounded-lg px-3 py-2 text-sm bg-surface text-ink resize-none"
              placeholder="What should this agent do?"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-ink-2 block mb-1">Execution Mode</label>
            <div className="flex items-center gap-3">
              {(["agent", "manual"] as const).map(m => (
                <label key={m} className="flex items-center gap-1.5 text-sm text-ink cursor-pointer">
                  <input type="radio" checked={execMode === m} onChange={() => setExecMode(m)} className="accent-brand" />
                  {m === "agent" ? "Agent (automated)" : "Manual (guided)"}
                </label>
              ))}
            </div>
          </div>

          {allNodes.length > 0 && (
            <div>
              <label className="text-xs font-medium text-ink-2 block mb-1">Depends On</label>
              <div className="space-y-1 max-h-32 overflow-y-auto border border-rim rounded-lg p-2">
                {allNodes.map(n => (
                  <label key={n.id} className="flex items-center gap-2 text-xs text-ink cursor-pointer">
                    <input
                      type="checkbox"
                      checked={deps.includes(n.id)}
                      onChange={e => {
                        if (e.target.checked) setDeps(prev => [...prev, n.id]);
                        else setDeps(prev => prev.filter(d => d !== n.id));
                      }}
                      className="accent-brand"
                    />
                    {n.description?.display_name || n.agent_slug}
                  </label>
                ))}
              </div>
            </div>
          )}

          {projectResources.length > 0 && (
            <div>
              <label className="text-xs font-medium text-ink-2 block mb-1">Assign Resources</label>
              <div className="space-y-1 max-h-32 overflow-y-auto border border-rim rounded-lg p-2">
                {projectResources.map(r => (
                  <label key={r.id} className="flex items-center gap-2 text-xs text-ink cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedResources.includes(r.id)}
                      onChange={e => {
                        if (e.target.checked) setSelectedResources(prev => [...prev, r.id]);
                        else setSelectedResources(prev => prev.filter(id => id !== r.id));
                      }}
                      className="accent-brand"
                    />
                    <span>{r.display_name}</span>
                    <span className="text-ink-3">({r.integration_slug} · {r.resource_type})</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-rim">
          <button onClick={onClose} className="px-3 py-1.5 text-xs text-ink-2 hover:text-ink rounded">Cancel</button>
          <button
            onClick={handleSubmit}
            disabled={!agentSlug || !taskDesc.trim() || submitting}
            className="px-4 py-1.5 text-xs font-medium bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50 transition-colors"
          >
            {submitting ? "Adding..." : "Add Node"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── SD-008: Discovery Panel ──────────────────────────────────────────────────

interface DiscoveredResource {
  external_id: string;
  resource_type: string;
  display_name: string;
  external_url: string | null;
  metadata: Record<string, unknown>;
  already_linked: boolean;
}

function DiscoveryPanel({
  projectId,
  apiFetch,
  onClose,
  onResourcesLinked,
}: {
  projectId: string;
  apiFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  onClose: () => void;
  onResourcesLinked: () => void;
}) {
  const [integrations, setIntegrations] = useState<Array<{ slug: string; name: string }>>([]);
  const [discovered, setDiscovered] = useState<Record<string, DiscoveredResource[]>>({});
  const [discovering, setDiscovering] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  const [linking, setLinking] = useState(false);

  useEffect(() => {
    apiFetch("/api/integrations")
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.integrations) {
          setIntegrations(data.integrations.map((i: { slug: string; name: string }) => ({ slug: i.slug, name: i.name })));
        }
      })
      .catch(() => {});
  }, [apiFetch]);

  const handleDiscover = async (slug: string) => {
    setDiscovering(prev => ({ ...prev, [slug]: true }));
    try {
      const r = await apiFetch(`/api/integrations/${slug}/discover?project_id=${projectId}`);
      if (r.ok) {
        const data = await r.json();
        setDiscovered(prev => ({ ...prev, [slug]: data.resources ?? [] }));
      }
    } catch { /* transient */ }
    finally {
      setDiscovering(prev => ({ ...prev, [slug]: false }));
    }
  };

  const toggleSelect = (slug: string, externalId: string) => {
    setSelected(prev => {
      const set = new Set(prev[slug] ?? []);
      if (set.has(externalId)) set.delete(externalId); else set.add(externalId);
      return { ...prev, [slug]: set };
    });
  };

  const totalSelected = Object.values(selected).reduce((sum, s) => sum + s.size, 0);

  const handleLinkSelected = async () => {
    setLinking(true);
    try {
      for (const [slug, ids] of Object.entries(selected)) {
        for (const extId of ids) {
          const res = discovered[slug]?.find(r => r.external_id === extId);
          if (!res) continue;
          await apiFetch(`/api/projects/${projectId}/resources`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              integration_slug: slug,
              resource_type: res.resource_type,
              external_id: res.external_id,
              external_url: res.external_url,
              display_name: res.display_name,
              discovered_metadata: res.metadata,
            }),
          });
        }
      }
      onResourcesLinked();
      setSelected({});
      for (const slug of Object.keys(discovered)) {
        handleDiscover(slug);
      }
    } finally {
      setLinking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-page border border-rim rounded-xl shadow-xl w-[560px] max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-rim">
          <h3 className="text-sm font-semibold text-ink">Discover Resources</h3>
          <button onClick={onClose} className="text-ink-3 hover:text-ink"><X className="w-4 h-4" /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {integrations.map(integration => (
            <div key={integration.slug} className="border border-rim rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-ink">{integration.name}</span>
                <button
                  onClick={() => handleDiscover(integration.slug)}
                  disabled={discovering[integration.slug]}
                  className="px-3 py-1 text-xs font-medium bg-surface border border-rim rounded-lg hover:bg-page transition-colors disabled:opacity-50"
                >
                  {discovering[integration.slug] ? "Discovering..." : "Discover"}
                </button>
              </div>

              {discovered[integration.slug] && (
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {discovered[integration.slug].length === 0 ? (
                    <p className="text-xs text-ink-3">No resources found</p>
                  ) : (
                    discovered[integration.slug].map(r => (
                      <label
                        key={r.external_id}
                        className={`flex items-center gap-2 text-xs p-1.5 rounded cursor-pointer hover:bg-surface ${
                          r.already_linked ? "opacity-50" : ""
                        }`}
                      >
                        <input
                          type="checkbox"
                          disabled={r.already_linked}
                          checked={r.already_linked || (selected[integration.slug]?.has(r.external_id) ?? false)}
                          onChange={() => !r.already_linked && toggleSelect(integration.slug, r.external_id)}
                          className="accent-brand"
                        />
                        <span className="font-medium text-ink">{r.display_name}</span>
                        <span className="text-ink-3">({r.resource_type})</span>
                        {r.already_linked && <span className="text-green-600 text-[10px]">linked</span>}
                      </label>
                    ))
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between px-5 py-3 border-t border-rim">
          <span className="text-xs text-ink-3">{totalSelected} selected</span>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-xs text-ink-2 hover:text-ink rounded">Close</button>
            <button
              onClick={handleLinkSelected}
              disabled={totalSelected === 0 || linking}
              className="px-4 py-1.5 text-xs font-medium bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50 transition-colors"
            >
              {linking ? "Linking..." : `Link Selected (${totalSelected})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

