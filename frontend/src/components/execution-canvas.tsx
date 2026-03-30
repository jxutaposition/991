"use client";
import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Node,
  Edge,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";

interface ExecutionNode {
  id: string;
  agent_slug: string;
  task_description: string;
  status: string;
  requires: string[];
  judge_score: number | null;
  attempt_count: number;
}

const STATUS_STYLES: Record<string, { border: string; bg: string; text: string }> = {
  pending:  { border: "#3f3f46", bg: "#18181b", text: "#71717a" },
  waiting:  { border: "#3f3f46", bg: "#18181b", text: "#71717a" },
  ready:    { border: "#3b82f6", bg: "#1e3a5f", text: "#93c5fd" },
  running:  { border: "#3b82f6", bg: "#1e3a5f", text: "#60a5fa" },
  passed:   { border: "#22c55e", bg: "#14532d", text: "#86efac" },
  failed:   { border: "#ef4444", bg: "#450a0a", text: "#fca5a5" },
  skipped:  { border: "#6b7280", bg: "#111827", text: "#6b7280" },
};

function layoutGraph(nodes: ExecutionNode[]): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: 60, ranksep: 100 });

  nodes.forEach((n) => g.setNode(n.id, { width: 190, height: 80 }));
  nodes.forEach((n) =>
    n.requires.forEach((dep) => g.setEdge(dep, n.id))
  );

  dagre.layout(g);

  const flowNodes: Node[] = nodes.map((n) => {
    const pos = g.node(n.id);
    const style = STATUS_STYLES[n.status] ?? STATUS_STYLES.pending;
    return {
      id: n.id,
      position: { x: pos.x - 95, y: pos.y - 40 },
      data: {
        label: (
          <div style={{ fontSize: 11, lineHeight: 1.4 }}>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>{n.agent_slug}</div>
            <div style={{ opacity: 0.6, fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 155 }}>
              {n.task_description}
            </div>
            {n.judge_score != null && (
              <div style={{ marginTop: 3, fontSize: 10, opacity: 0.8 }}>
                score: {n.judge_score.toFixed(1)}
              </div>
            )}
          </div>
        ),
      },
      style: {
        background: style.bg,
        border: `1px solid ${style.border}`,
        borderRadius: 10,
        padding: "8px 12px",
        width: 190,
        color: style.text,
      },
    };
  });

  const flowEdges: Edge[] = [];
  nodes.forEach((n) =>
    n.requires.forEach((dep) => {
      flowEdges.push({
        id: `${dep}-${n.id}`,
        source: dep,
        target: n.id,
        style: { stroke: "#3f3f46", strokeWidth: 1.5 },
        animated: n.status === "running",
      });
    })
  );

  return { nodes: flowNodes, edges: flowEdges };
}

export function ExecutionCanvas({
  nodes,
  sessionStatus,
}: {
  nodes: ExecutionNode[];
  sessionStatus: string;
}) {
  const { nodes: flowNodes, edges: flowEdges } = useMemo(
    () => layoutGraph(nodes),
    [nodes]
  );

  if (nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-600 text-sm">
        {sessionStatus === "planning" ? "Building plan..." : "No nodes in plan"}
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      fitView
      fitViewOptions={{ padding: 0.3 }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#27272a" />
      <Controls className="!bg-zinc-900 !border-zinc-700" />
    </ReactFlow>
  );
}
