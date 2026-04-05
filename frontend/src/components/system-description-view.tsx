"use client";

import { useRef, useEffect } from "react";
import type { ExecutionNode } from "@/components/execution-canvas";
import { DagMinimap } from "@/components/dag-minimap";
import { DocumentHeader, type ProjectDescriptionData, type DescriptionVersion } from "@/components/document-header";
import { NodeSection } from "@/components/node-section";
import type { NodeIssue } from "@/components/issue-card";

interface SystemDescriptionViewProps {
  nodes: ExecutionNode[];
  sessionStatus: string;
  requestText: string;
  selectedNodeId?: string | null;
  projectDescription: ProjectDescriptionData | null;
  issues: NodeIssue[];
  livePreviewMap?: Record<string, string>;
  issueCount?: number;
  openIssueCount?: number;
  versions?: DescriptionVersion[];
  onNodeClick?: (nodeId: string) => void;
  onProjectDescriptionUpdate?: (fields: Partial<ProjectDescriptionData>) => void;
  onNodeDescriptionUpdate?: (nodeId: string, description: Record<string, unknown>) => void;
  onIssueResolve?: (issueId: string) => void;
  onIssueDismiss?: (issueId: string) => void;
  onCommentCreate?: (nodeId: string, sectionPath: string) => void;
}

export function SystemDescriptionView({
  nodes,
  sessionStatus,
  requestText,
  selectedNodeId,
  projectDescription,
  issues,
  livePreviewMap,
  issueCount,
  openIssueCount,
  versions,
  onNodeClick,
  onProjectDescriptionUpdate,
  onNodeDescriptionUpdate,
  onIssueResolve,
  onIssueDismiss,
  onCommentCreate,
}: SystemDescriptionViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isEditable = sessionStatus === "awaiting_approval";

  // Sort nodes by step_index, then by dependency order
  const sortedNodes = [...nodes]
    .filter((n) => n.status !== "preview" || sessionStatus === "awaiting_approval")
    .sort((a, b) => {
      const ai = a.step_index ?? 999;
      const bi = b.step_index ?? 999;
      return ai - bi;
    });

  // Scroll to selected node
  useEffect(() => {
    if (selectedNodeId && scrollRef.current) {
      const el = scrollRef.current.querySelector(`#node-section-${selectedNodeId}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }, [selectedNodeId]);

  // Group issues by node_id
  const issuesByNode = new Map<string, NodeIssue[]>();
  for (const issue of issues) {
    const list = issuesByNode.get(issue.node_id) ?? [];
    list.push(issue);
    issuesByNode.set(issue.node_id, list);
  }

  return (
    <div ref={scrollRef} className="flex flex-col h-full overflow-y-auto bg-page">
      {/* Project-level header */}
      <DocumentHeader
        projectDescription={projectDescription}
        requestText={requestText}
        sessionStatus={sessionStatus}
        nodes={nodes}
        isEditable={isEditable}
        onUpdate={onProjectDescriptionUpdate}
        issueCount={issueCount}
        openIssueCount={openIssueCount}
        versions={versions}
      />

      {/* DAG minimap */}
      <div className="border-b border-rim bg-surface/50">
        <DagMinimap
          nodes={nodes}
          selectedNodeId={selectedNodeId}
          onNodeClick={onNodeClick}
        />
      </div>

      {/* Node sections */}
      <div className="flex-1 px-6 py-4 space-y-3">
        {sortedNodes.map((node, i) => (
          <NodeSection
            key={node.id}
            node={node}
            index={i}
            isSelected={node.id === selectedNodeId}
            isEditable={isEditable}
            issues={issuesByNode.get(node.id) ?? []}
            livePreview={livePreviewMap?.[node.id]}
            onClick={() => onNodeClick?.(node.id)}
            onDescriptionUpdate={onNodeDescriptionUpdate}
            onIssueResolve={onIssueResolve}
            onIssueDismiss={onIssueDismiss}
            onCommentCreate={onCommentCreate}
          />
        ))}

        {sortedNodes.length === 0 && (
          <div className="text-center py-12 text-ink-3 text-sm">
            No components in this description yet.
          </div>
        )}
      </div>
    </div>
  );
}
