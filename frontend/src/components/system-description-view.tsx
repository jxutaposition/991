"use client";

import { useRef, useEffect } from "react";
import { Bot, Hand } from "lucide-react";
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

      {/* Next Steps Summary */}
      {sessionStatus === "awaiting_approval" && sortedNodes.length > 0 && (
        <NextStepsSummary nodes={sortedNodes} onNodeClick={onNodeClick} issues={issues} />
      )}

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

function NextStepsSummary({
  nodes,
  onNodeClick,
  issues,
}: {
  nodes: ExecutionNode[];
  onNodeClick?: (nodeId: string) => void;
  issues: NodeIssue[];
}) {
  const agentNodes = nodes.filter((n) => n.execution_mode !== "manual");
  const manualNodes = nodes.filter((n) => n.execution_mode === "manual");
  const credentialIssues = issues.filter((i) => i.issue_type === "credential" && i.status === "open");

  if (agentNodes.length === 0 && manualNodes.length === 0) return null;

  return (
    <div className="mx-6 mt-4 border border-rim rounded-lg bg-surface overflow-hidden">
      <div className="px-4 py-2.5 bg-gray-50 border-b border-rim">
        <h3 className="text-xs font-semibold text-ink uppercase tracking-wider">Next Steps</h3>
      </div>
      <div className="px-4 py-3 space-y-3">
        {agentNodes.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <Bot className="w-3.5 h-3.5 text-blue-600" />
              <span className="text-xs font-medium text-ink">Agent will handle ({agentNodes.length})</span>
            </div>
            <div className="space-y-0.5 ml-5">
              {agentNodes.map((node) => {
                const desc = node.description as Record<string, unknown> | undefined;
                const displayName = (desc?.display_name as string) || node.agent_slug;
                return (
                  <button
                    key={node.id}
                    onClick={() => onNodeClick?.(node.id)}
                    className="block w-full text-left text-xs text-ink-2 hover:text-brand transition-colors py-0.5"
                  >
                    <span className="text-ink-3 mr-1">&bull;</span>
                    {node.task_description}
                    <span className="text-ink-3 ml-1">({displayName})</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {manualNodes.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <Hand className="w-3.5 h-3.5 text-amber-600" />
              <span className="text-xs font-medium text-ink">You&apos;ll handle manually ({manualNodes.length})</span>
            </div>
            <div className="space-y-0.5 ml-5">
              {manualNodes.map((node) => {
                const desc = node.description as Record<string, unknown> | undefined;
                const displayName = (desc?.display_name as string) || node.agent_slug;
                const hints = (desc?.validation_hints as Array<{ description: string }>) ?? [];
                const hintText = hints.length > 0 ? hints[0].description : "";
                return (
                  <button
                    key={node.id}
                    onClick={() => onNodeClick?.(node.id)}
                    className="block w-full text-left text-xs text-ink-2 hover:text-brand transition-colors py-0.5"
                  >
                    <span className="text-amber-400 mr-1">&bull;</span>
                    {node.task_description}
                    <span className="text-ink-3 ml-1">({displayName})</span>
                    {hintText && <span className="text-ink-3 ml-1">&mdash; agent verifies: {hintText}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {credentialIssues.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className="text-xs font-medium text-ink">Prerequisites</span>
            </div>
            <div className="space-y-0.5 ml-5">
              {credentialIssues.map((issue) => (
                <div key={issue.id} className="text-xs text-amber-700 py-0.5">
                  <span className="text-amber-400 mr-1">&#9888;</span>
                  {issue.description}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
