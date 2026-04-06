"use client";

import { useEffect, useState } from "react";
import { Bot, ChevronDown, ChevronRight, Hand, MessageSquare, Pencil, Save, Sparkles, X } from "lucide-react";
import type { ExecutionNode } from "@/components/execution-canvas";
import { IssueCard, type NodeIssue } from "@/components/issue-card";
import { InlineChatInput } from "@/components/inline-chat-input";
import { DiffPreview } from "@/components/diff-preview";

// Description JSONB shape from the backend
export interface NodeDescription {
  display_name?: string;
  architecture?: {
    purpose?: string;
    connections?: string[];
    data_flow?: string;
  };
  technical_spec?: {
    approach?: string;
    tools?: string[];
    configuration?: Record<string, unknown>;
  };
  io_contract?: {
    inputs?: Array<{ name: string; source?: string; schema?: unknown }>;
    outputs?: Array<{ name: string; schema?: unknown }>;
  };
  optionality?: Array<{
    decision: string;
    tradeoffs?: string;
    recommendation?: string;
  }>;
  agent_actions?: string[];
  user_actions?: string[];
  validation_hints?: Array<{ type: string; description: string }>;
  visual_refs?: Array<{ type: string; url: string; caption?: string }>;
  prior_artifacts?: Array<{ title: string; reference?: string }>;
}

const STATUS_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  passed:  { bg: "bg-green-100", text: "text-green-700", label: "Passed" },
  running: { bg: "bg-blue-100", text: "text-blue-700", label: "Running" },
  ready:   { bg: "bg-blue-50",  text: "text-blue-600", label: "Ready" },
  waiting: { bg: "bg-amber-50", text: "text-amber-700", label: "Waiting" },
  failed:  { bg: "bg-red-100",  text: "text-red-700", label: "Failed" },
  skipped: { bg: "bg-gray-100", text: "text-gray-500", label: "Skipped" },
  pending: { bg: "bg-gray-50",  text: "text-gray-500", label: "Pending" },
  preview: { bg: "bg-purple-50", text: "text-purple-500", label: "Preview" },
  awaiting_reply: { bg: "bg-amber-100", text: "text-amber-700", label: "Awaiting Reply" },
};

interface NodeSectionProps {
  node: ExecutionNode;
  index: number;
  isSelected: boolean;
  isEditable: boolean;
  issues: NodeIssue[];
  livePreview?: string;
  onClick: () => void;
  onDescriptionUpdate?: (nodeId: string, description: Record<string, unknown>) => void;
  onIssueResolve?: (issueId: string) => void;
  onIssueDismiss?: (issueId: string) => void;
  onCommentCreate?: (nodeId: string, sectionPath: string) => void;
  onAiEdit?: (nodeId: string, sectionPath: string, instruction: string) => Promise<{ original: string; proposed: string } | null>;
  sessionId?: string;
  apiFetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

export function NodeSection({
  node,
  index,
  isSelected,
  isEditable,
  issues,
  livePreview,
  onClick,
  onDescriptionUpdate,
  onIssueResolve,
  onIssueDismiss,
  onCommentCreate,
  onAiEdit,
}: NodeSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const [editingTask, setEditingTask] = useState(false);
  const [taskDraft, setTaskDraft] = useState(node.task_description);
  const [aiEditSection, setAiEditSection] = useState<string | null>(null);
  const [diffData, setDiffData] = useState<{ original: string; proposed: string; sectionPath: string } | null>(null);

  useEffect(() => {
    if (!editingTask) setTaskDraft(node.task_description);
  }, [node.task_description, editingTask]);

  type Desc = NonNullable<ExecutionNode["description"]>;
  const desc: Desc = node.description ?? {};
  const displayName: string = desc.display_name || node.agent_slug;
  const badge = STATUS_BADGE[node.status] ?? STATUS_BADGE.pending;
  const openIssues = issues.filter((i) => i.status === "open");
  const descArch = desc.architecture;
  const descSpec = desc.technical_spec;
  const descIO = desc.io_contract;
  const descOpts: Array<{ decision: string; tradeoffs?: string; recommendation?: string }> = desc.optionality ?? [];
  const agentActions: string[] = desc.agent_actions ?? [];
  const userActions: string[] = desc.user_actions ?? [];
  const validationHints: Array<{ type: string; description: string }> = desc.validation_hints ?? [];
  const isManualMode = node.execution_mode === "manual";

  const renderAiEditUI = (sectionPath: string) => {
    if (diffData && diffData.sectionPath === sectionPath) {
      return (
        <div className="mt-2">
          <DiffPreview
            original={diffData.original}
            proposed={diffData.proposed}
            onAccept={() => {
              onDescriptionUpdate?.(node.id, { [sectionPath]: diffData.proposed });
              setDiffData(null);
              setAiEditSection(null);
            }}
            onReject={() => {
              setDiffData(null);
              setAiEditSection(null);
            }}
          />
        </div>
      );
    }
    if (aiEditSection === sectionPath) {
      return (
        <div className="relative mt-2" style={{ minHeight: 80 }}>
          <InlineChatInput
            onSubmit={async (instruction) => {
              if (!onAiEdit) return "AI edit not available.";
              const result = await onAiEdit(node.id, sectionPath, instruction);
              if (result) {
                setDiffData({ ...result, sectionPath });
                return "Changes proposed.";
              }
              return "No changes suggested.";
            }}
            onCancel={() => { setAiEditSection(null); setDiffData(null); }}
          />
        </div>
      );
    }
    return null;
  };

  return (
    <div
      id={`node-section-${node.id}`}
      className={`border rounded-lg overflow-hidden transition-all ${
        isSelected ? "border-brand ring-1 ring-brand/20" : "border-rim"
      }`}
    >
      {/* Header */}
      <button
        onClick={() => { onClick(); setExpanded(!expanded); }}
        className="w-full flex items-center gap-2 px-4 py-3 bg-surface hover:bg-gray-50 transition-colors text-left"
      >
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-ink-3 shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-ink-3 shrink-0" />
        )}

        <span className="text-xs font-mono text-ink-3 w-6 shrink-0">
          {index + 1}
        </span>

        <span className="font-medium text-sm text-ink flex-1 truncate">
          {displayName}
        </span>

        <span className="text-xs font-mono text-ink-3 shrink-0">
          {node.agent_slug}
        </span>

        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${badge.bg} ${badge.text}`}>
          {badge.label}
        </span>

        {node.execution_mode === "manual" ? (
          <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-amber-50 text-amber-700 flex items-center gap-0.5">
            <Hand className="w-2.5 h-2.5" /> Manual
          </span>
        ) : node.execution_mode != null ? (
          <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-blue-50 text-blue-600 flex items-center gap-0.5">
            <Bot className="w-2.5 h-2.5" /> Agent
          </span>
        ) : null}

        {node.judge_score != null && (
          <span className="text-xs font-mono text-ink-3">
            {node.judge_score.toFixed(1)}/10
          </span>
        )}

        {openIssues.length > 0 ? (
          <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-600 font-medium">
            {openIssues.length} issue{openIssues.length > 1 ? "s" : ""}
          </span>
        ) : null}
      </button>

      {/* Expanded body */}
      {expanded && (
        <div className="border-t border-rim px-4 py-3 space-y-3">
          {/* Task Description */}
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-semibold text-ink-3 uppercase tracking-wider">
                Task
              </span>
              {isEditable && !editingTask && (
                <button onClick={() => setEditingTask(true)} className="text-ink-3 hover:text-ink">
                  <Pencil className="w-3 h-3" />
                </button>
              )}
            </div>
            {editingTask ? (
              <div className="flex gap-2">
                <textarea
                  value={taskDraft}
                  onChange={(e) => setTaskDraft(e.target.value)}
                  className="flex-1 text-xs font-mono text-ink bg-white border border-rim rounded px-2 py-1.5 resize-y min-h-[60px] focus:outline-none focus:ring-1 focus:ring-brand"
                />
                <div className="flex flex-col gap-1">
                  <button
                    onClick={() => {
                      onDescriptionUpdate?.(node.id, { task_description: taskDraft });
                      setEditingTask(false);
                    }}
                    className="p-1 text-green-600 hover:bg-green-50 rounded"
                  >
                    <Save className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => { setTaskDraft(node.task_description); setEditingTask(false); }}
                    className="p-1 text-gray-400 hover:bg-gray-50 rounded"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-ink">{node.task_description}</p>
            )}
          </div>

          {/* Architecture */}
          {descArch ? (
            <>
            <DescSection title="Architecture" sectionPath="architecture" onComment={onCommentCreate ? (sp) => onCommentCreate(node.id, sp) : undefined} onAiEditClick={onAiEdit ? () => setAiEditSection("architecture") : undefined}>
              {descArch.purpose ? <p className="text-xs text-ink">{descArch.purpose}</p> : null}
              {descArch.data_flow ? (
                <p className="text-xs text-ink-2 mt-1">
                  <span className="font-medium">Data flow:</span> {descArch.data_flow}
                </p>
              ) : null}
              {(descArch.connections ?? []).length > 0 ? (
                <div className="flex gap-1 mt-1.5 flex-wrap">
                  {(descArch.connections ?? []).map((c) => (
                    <span key={c} className="text-xs px-1.5 py-0.5 rounded bg-purple-50 text-purple-600 border border-purple-200">
                      {c}
                    </span>
                  ))}
                </div>
              ) : null}
            </DescSection>
            {renderAiEditUI("architecture")}
            </>
          ) : null}

          {/* Technical Spec */}
          {descSpec ? (
            <>
            <DescSection title="Technical Spec" sectionPath="technical_spec" onComment={onCommentCreate ? (sp) => onCommentCreate(node.id, sp) : undefined} onAiEditClick={onAiEdit ? () => setAiEditSection("technical_spec") : undefined}>
              {descSpec.approach ? <p className="text-xs text-ink">{descSpec.approach}</p> : null}
              {(descSpec.tools ?? []).length > 0 ? (
                <div className="flex gap-1 mt-1.5 flex-wrap">
                  {(descSpec.tools ?? []).map((t) => (
                    <span key={t} className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-200 font-mono">
                      {t}
                    </span>
                  ))}
                </div>
              ) : null}
            </DescSection>
            {renderAiEditUI("technical_spec")}
            </>
          ) : null}

          {/* I/O Contract */}
          {descIO != null && ((descIO.inputs ?? []).length > 0 || (descIO.outputs ?? []).length > 0) ? (
            <>
            <DescSection title="I/O Contract" sectionPath="io_contract" onComment={onCommentCreate ? (sp) => onCommentCreate(node.id, sp) : undefined} onAiEditClick={onAiEdit ? () => setAiEditSection("io_contract") : undefined}>
              {(descIO.inputs ?? []).length > 0 ? (
                <div className="mb-2">
                  <span className="text-xs font-medium text-ink-3">Inputs:</span>
                  {(descIO.inputs ?? []).map((inp, i) => (
                    <div key={i} className="text-xs font-mono text-ink-2 ml-2">
                      &larr; {inp.name}{inp.source ? ` (from ${inp.source})` : ""}
                    </div>
                  ))}
                </div>
              ) : null}
              {(descIO.outputs ?? []).length > 0 ? (
                <div>
                  <span className="text-xs font-medium text-ink-3">Outputs:</span>
                  {(descIO.outputs ?? []).map((out, i) => (
                    <div key={i} className="text-xs font-mono text-ink-2 ml-2">
                      &rarr; {out.name}
                    </div>
                  ))}
                </div>
              ) : null}
            </DescSection>
            {renderAiEditUI("io_contract")}
            </>
          ) : null}

          {/* Optionality */}
          {descOpts.length > 0 ? (
            <>
            <DescSection title="Options" sectionPath="optionality" onComment={onCommentCreate ? (sp) => onCommentCreate(node.id, sp) : undefined} onAiEditClick={onAiEdit ? () => setAiEditSection("optionality") : undefined}>
              <div>
                {descOpts.map((opt, oi) => (
                  <div key={oi} className="text-xs mb-1.5">
                    <span className="font-medium text-ink">{opt.decision}</span>
                    {opt.tradeoffs ? <span className="text-ink-3"> &mdash; {opt.tradeoffs}</span> : null}
                    {opt.recommendation ? (
                      <span className="ml-1 text-xs px-1 py-0.5 bg-green-50 text-green-600 rounded">
                        rec: {opt.recommendation}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </DescSection>
            {renderAiEditUI("optionality")}
            </>
          ) : null}

          {/* Agent Actions */}
          {agentActions.length > 0 ? (
            <DescSection title="Agent Will Do">
              <div className="space-y-1">
                {agentActions.map((action, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-xs">
                    <Bot className={`w-3 h-3 mt-0.5 shrink-0 ${isManualMode ? "text-ink-3" : "text-blue-500"}`} />
                    <span className={isManualMode ? "text-ink-3" : "text-ink"}>{action}</span>
                  </div>
                ))}
              </div>
            </DescSection>
          ) : null}

          {/* User Actions */}
          {userActions.length > 0 ? (
            <DescSection title="You'll Need To">
              <div className={`space-y-1 ${isManualMode ? "bg-amber-50/50 -mx-1 px-1 py-1 rounded" : ""}`}>
                {userActions.map((action, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-xs">
                    <Hand className={`w-3 h-3 mt-0.5 shrink-0 ${isManualMode ? "text-amber-600" : "text-ink-3"}`} />
                    <span className={isManualMode ? "text-amber-800" : "text-ink-2"}>{action}</span>
                  </div>
                ))}
              </div>
            </DescSection>
          ) : null}

          {/* Validation Hints */}
          {validationHints.length > 0 ? (
            <DescSection title="Verification">
              <div className="space-y-1">
                {validationHints.map((hint, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-xs">
                    <span className="text-[10px] px-1 py-0.5 rounded bg-gray-100 text-ink-3 font-mono shrink-0">{hint.type}</span>
                    <span className="text-ink-2">{hint.description}</span>
                  </div>
                ))}
              </div>
            </DescSection>
          ) : null}

          {/* Acceptance Criteria */}
          {(node.acceptance_criteria ?? []).length > 0 ? (
            <>
            <DescSection title="Acceptance Criteria" onAiEditClick={onAiEdit ? () => setAiEditSection("acceptance_criteria") : undefined}>
              {(node.acceptance_criteria ?? []).map((c, i) => (
                <div key={i} className="flex items-start gap-1.5 text-xs">
                  <span className={`mt-0.5 ${node.status === "passed" ? "text-green-500" : "text-ink-3"}`}>
                    {node.status === "passed" ? "\u2713" : "\u25CB"}
                  </span>
                  <span className="text-ink">{c}</span>
                </div>
              ))}
            </DescSection>
            {renderAiEditUI("acceptance_criteria")}
            </>
          ) : null}

          {/* Issues */}
          {issues.length > 0 ? (
            <DescSection title={`Issues (${openIssues.length} open)`}>
              <div className="space-y-1.5">
                {issues.map((issue) => (
                  <IssueCard
                    key={issue.id}
                    issue={issue}
                    onResolve={onIssueResolve}
                    onDismiss={onIssueDismiss}
                  />
                ))}
              </div>
            </DescSection>
          ) : null}

          {/* Artifacts (post-execution) */}
          {(node.artifacts ?? []).length > 0 ? (
            <DescSection title="Artifacts">
              <div className="space-y-1">
                {(node.artifacts ?? []).map((a, i) => (
                  <a
                    key={i}
                    href={a.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-xs text-brand hover:underline"
                  >
                    <span className="text-xs px-1 py-0.5 bg-gray-100 rounded font-mono">{a.type}</span>
                    {a.title}
                  </a>
                ))}
              </div>
            </DescSection>
          ) : null}

          {/* Live preview during execution */}
          {node.status === "running" && livePreview && (
            <div className="bg-blue-50/50 border border-blue-100 rounded px-3 py-2">
              <span className="text-xs font-semibold text-blue-500 uppercase tracking-wider">
                Live
              </span>
              <p className="text-xs text-blue-700 font-mono mt-1 whitespace-pre-wrap">
                {livePreview}
                <span className="inline-block w-1.5 h-3 bg-blue-400 animate-pulse ml-0.5" />
              </p>
            </div>
          )}

          {/* Output summary (post-execution) */}
          {node.status === "passed" && node.output != null ? (
            <DescSection title="Output">
              <pre className="text-xs font-mono text-ink-2 bg-gray-50 rounded p-2 overflow-x-auto max-h-40">
                {typeof node.output === "string"
                  ? node.output
                  : JSON.stringify(node.output, null, 2).slice(0, 1000)}
              </pre>
            </DescSection>
          ) : null}
        </div>
      )}
    </div>
  );
}

function DescSection({ title, children, sectionPath, onComment, onAiEditClick }: {
  title: string;
  children: React.ReactNode;
  sectionPath?: string;
  onComment?: (sectionPath: string) => void;
  onAiEditClick?: () => void;
}) {
  return (
    <div className="group/desc">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-semibold text-ink-3 uppercase tracking-wider">
          {title}
        </span>
        {onAiEditClick && (
          <button
            onClick={(e) => { e.stopPropagation(); onAiEditClick(); }}
            className="opacity-0 group-hover/desc:opacity-100 text-ink-3 hover:text-brand transition-opacity p-0.5 rounded"
            title="Edit with AI"
          >
            <Sparkles className="w-3 h-3" />
          </button>
        )}
        {sectionPath && onComment && (
          <button
            onClick={(e) => { e.stopPropagation(); onComment(sectionPath); }}
            className="opacity-0 group-hover/desc:opacity-100 text-ink-3 hover:text-brand transition-opacity p-0.5 rounded"
            title="Add comment"
          >
            <MessageSquare className="w-3 h-3" />
          </button>
        )}
      </div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

