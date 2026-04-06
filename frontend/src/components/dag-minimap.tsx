"use client";

import { useMemo } from "react";
import { type ExecutionNode, buildDag } from "@/components/execution-canvas";
import { NODE_STATUS_DOT } from "@/lib/tokens";

interface DagMinimapProps {
  nodes: ExecutionNode[];
  selectedNodeId?: string | null;
  onNodeClick?: (nodeId: string) => void;
}

export function DagMinimap({ nodes, selectedNodeId, onNodeClick }: DagMinimapProps) {
  const { layers, edges } = useMemo(() => buildDag(nodes), [nodes]);

  if (layers.length === 0) return null;

  return (
    <div className="relative flex items-center gap-4 px-4 py-3 overflow-x-auto">
      {/* SVG edges */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 0 }}>
        {edges.map((edge, i) => {
          // Simple horizontal connections between layers
          return (
            <line
              key={i}
              x1="0" y1="0" x2="0" y2="0"
              className="stroke-purple-200"
              strokeWidth={1}
              strokeDasharray="2 2"
              style={{ display: "none" }} // edges are visual-only, hidden in minimap
            />
          );
        })}
      </svg>

      {layers.map((layer, li) => (
        <div key={li} className="flex flex-col gap-1.5 shrink-0" style={{ zIndex: 1 }}>
          {layer.map((node) => {
            const isSelected = node.id === selectedNodeId;
            const dotColor = NODE_STATUS_DOT[node.status] ?? "bg-muted-rim";
            return (
              <button
                key={node.id}
                onClick={() => onNodeClick?.(node.id)}
                className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-mono
                  border transition-all cursor-pointer
                  ${isSelected
                    ? "border-brand bg-brand/5 ring-1 ring-brand/30"
                    : "border-rim bg-surface hover:bg-gray-50"
                  }`}
                title={node.task_description}
              >
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />
                <span className="truncate max-w-[100px] text-ink-2">
                  {node.agent_slug}
                </span>
              </button>
            );
          })}
          {li < layers.length - 1 && (
            <div className="flex items-center justify-center text-purple-300 text-xs">
              &rarr;
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
