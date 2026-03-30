"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import {
  ExecutionCanvas,
  type CanvasHandle,
  type ExecutionNode,
} from "@/components/execution-canvas";
import {
  InspectorPanel,
  type ExecutionEvent,
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

const STATUS_COLORS: Record<string, string> = {
  planning: "text-ink-3",
  awaiting_approval: "text-amber-600",
  executing: "text-brand",
  completed: "text-green-600",
  failed: "text-danger",
};

export default function SessionPage() {
  const { session_id } = useParams();
  const [session, setSession] = useState<ExecutionSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [nodeEvents, setNodeEvents] = useState<ExecutionEvent[]>([]);
  const [nodeEventsLoading, setNodeEventsLoading] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(0.9);
  const canvasRef = useRef<CanvasHandle>(null);

  const fetchSession = useCallback(() => {
    fetch(`/api/execute/${session_id}`)
      .then((r) => r.json())
      .then((data) => {
        setSession({
          ...data.session,
          nodes: data.nodes ?? data.session?.nodes ?? [],
        });
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [session_id]);

  useEffect(() => {
    fetchSession();
  }, [fetchSession]);

  useEffect(() => {
    if (
      !session ||
      session.status === "planning" ||
      session.status === "awaiting_approval"
    )
      return;
    const es = new EventSource(`/api/execute/${session_id}/events`);
    es.onmessage = () => fetchSession();
    es.onerror = () => es.close();
    return () => es.close();
  }, [session_id, session?.status, fetchSession]);

  useEffect(() => {
    if (!selectedNodeId || !session_id) {
      setNodeEvents([]);
      return;
    }
    setNodeEventsLoading(true);
    fetch(`/api/execute/${session_id}/nodes/${selectedNodeId}/events`)
      .then((r) => r.json())
      .then((data) => {
        setNodeEvents(data.events ?? []);
        setNodeEventsLoading(false);
      })
      .catch(() => {
        setNodeEvents([]);
        setNodeEventsLoading(false);
      });
  }, [selectedNodeId, session_id]);

  const handleApprove = async () => {
    setApproving(true);
    try {
      await fetch(`/api/execute/${session_id}/approve`, { method: "POST" });
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
        defaultRightWidth={380}
        minRightWidth={240}
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
          />
        }
      />

      {/* Plan list -- shown while awaiting approval */}
      {session.status === "awaiting_approval" && (
        <div className="border-t border-rim bg-page p-4 shrink-0 max-h-60 overflow-auto">
          <p className="text-xs text-ink-3 uppercase tracking-wider mb-3">
            Execution Plan {"\u2014"} {session.nodes.length} steps
          </p>
          <div className="space-y-2">
            {session.nodes.map((node, i) => (
              <div key={node.id} className="flex items-start gap-3 text-sm">
                <span className="text-ink-3 shrink-0 w-5 pt-0.5">
                  {i + 1}
                </span>
                <span className="text-ink font-mono font-medium shrink-0 w-52 text-xs pt-0.5">
                  {node.agent_slug}
                </span>
                <span className="text-ink-2 text-xs leading-relaxed">
                  {node.task_description}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
