"use client";

import { useState } from "react";
import { AlertTriangle, Clock, Pencil, Save, X } from "lucide-react";
import type { ExecutionNode } from "@/components/execution-canvas";
import { SESSION_STATUS_PILL, CHANGE_SOURCE_BADGE } from "@/lib/tokens";

export interface ProjectDescriptionData {
  id: string;
  project_id: string;
  title: string;
  summary?: string | null;
  architecture?: Record<string, unknown>;
  data_flows?: Array<{ from: string; to: string; description: string }>;
  integration_map?: Record<string, unknown>;
  version: number;
}

export interface DescriptionVersion {
  id: string;
  version: number;
  snapshot?: unknown;
  change_summary?: string;
  change_source: string;
  changed_by?: string;
  created_at: string;
}

interface DocumentHeaderProps {
  projectDescription: ProjectDescriptionData | null;
  requestText: string;
  sessionStatus: string;
  nodes: ExecutionNode[];
  isEditable: boolean;
  onUpdate?: (fields: Partial<ProjectDescriptionData>) => void;
  issueCount?: number;
  openIssueCount?: number;
  versions?: DescriptionVersion[];
}

export function DocumentHeader({
  projectDescription,
  requestText,
  sessionStatus,
  nodes,
  isEditable,
  onUpdate,
  openIssueCount,
  versions,
}: DocumentHeaderProps) {
  const [editingSummary, setEditingSummary] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState(projectDescription?.summary ?? "");
  const [showHistory, setShowHistory] = useState(false);

  const title = projectDescription?.title ?? "System Description";
  const summary = projectDescription?.summary ?? requestText;

  // Aggregated stats
  const passed = nodes.filter((n) => n.status === "passed").length;
  const failed = nodes.filter((n) => n.status === "failed").length;
  const running = nodes.filter((n) => n.status === "running").length;
  const total = nodes.length;

  const dataFlows = projectDescription?.data_flows ?? [];

  return (
    <div className="px-6 py-5 border-b border-rim bg-surface">
      {/* Title + history toggle */}
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold text-ink">{title}</h1>
        {versions && versions.length > 0 && (
          <button
            onClick={() => setShowHistory((v) => !v)}
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium transition-colors ${
              showHistory
                ? "bg-brand/10 text-brand"
                : "text-ink-3 hover:text-ink hover:bg-gray-50"
            }`}
            title="Version history"
          >
            <Clock className="w-3 h-3" />
            v{projectDescription?.version ?? versions[0]?.version}
          </button>
        )}
      </div>

      {/* Status badges */}
      <div className="flex items-center gap-2 mt-2">
        <StatusPill label={sessionStatus} />
        <span className="text-xs text-ink-3">
          {total} component{total !== 1 ? "s" : ""}
        </span>
        {passed > 0 && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-green-50 text-green-600 font-medium">
            {passed} passed
          </span>
        )}
        {failed > 0 && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-red-50 text-red-600 font-medium">
            {failed} failed
          </span>
        )}
        {running > 0 && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 font-medium">
            {running} running
          </span>
        )}
        {(openIssueCount ?? 0) > 0 && (
          <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 font-medium">
            <AlertTriangle className="w-3 h-3" />
            {openIssueCount} issue{openIssueCount !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Summary */}
      <div className="mt-3">
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-xs font-semibold text-ink-3 uppercase tracking-wider">
            Overview
          </span>
          {isEditable && !editingSummary && (
            <button onClick={() => { setSummaryDraft(summary); setEditingSummary(true); }} className="text-ink-3 hover:text-ink" aria-label="Edit summary">
              <Pencil className="w-3 h-3" />
            </button>
          )}
        </div>
        {editingSummary ? (
          <div className="flex gap-2">
            <textarea
              value={summaryDraft}
              onChange={(e) => setSummaryDraft(e.target.value)}
              className="flex-1 text-sm text-ink bg-white border border-rim rounded px-3 py-2 resize-y min-h-[80px] focus:outline-none focus:ring-1 focus:ring-brand"
            />
            <div className="flex flex-col gap-1">
              <button
                onClick={() => {
                  onUpdate?.({ summary: summaryDraft });
                  setEditingSummary(false);
                }}
                className="p-1 text-green-600 hover:bg-green-50 rounded"
                aria-label="Save summary"
              >
                <Save className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setEditingSummary(false)}
                className="p-1 text-gray-400 hover:bg-gray-50 rounded"
                aria-label="Cancel editing"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-ink-2 whitespace-pre-wrap">{summary}</p>
        )}
      </div>

      {/* Data Flows */}
      {dataFlows.length > 0 && (
        <div className="mt-3">
          <span className="text-xs font-semibold text-ink-3 uppercase tracking-wider">
            Data Flows
          </span>
          <div className="flex flex-wrap gap-2 mt-1.5">
            {dataFlows.map((flow, i) => (
              <div
                key={i}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-rim bg-white"
              >
                <span className="font-mono text-purple-600">{flow.from}</span>
                <span className="text-ink-3">&rarr;</span>
                <span className="font-mono text-purple-600">{flow.to}</span>
                {flow.description && (
                  <span className="text-ink-3 ml-1">({flow.description})</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Architecture overview */}
      {projectDescription?.architecture && (
        <div className="mt-3">
          {typeof projectDescription.architecture === "object" && "overview" in projectDescription.architecture && (
            <>
              <span className="text-xs font-semibold text-ink-3 uppercase tracking-wider">
                Architecture
              </span>
              <p className="text-xs text-ink-2 mt-1">
                {String((projectDescription.architecture as Record<string, unknown>).overview ?? "")}
              </p>
            </>
          )}
        </div>
      )}

      {/* Version history panel */}
      {showHistory && versions && versions.length > 0 && (
        <div className="mt-3 border border-rim rounded-lg bg-white overflow-hidden">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-rim bg-gray-50/80">
            <span className="text-xs font-semibold text-ink-3 uppercase tracking-wider">
              Version History
            </span>
            <button onClick={() => setShowHistory(false)} className="text-ink-3 hover:text-ink" aria-label="Close version history">
              <X className="w-3 h-3" />
            </button>
          </div>
          <div className="max-h-52 overflow-y-auto divide-y divide-rim">
            {versions.map((v) => (
              <div key={v.id} className="px-3 py-2 flex items-start gap-2 text-xs">
                <span className="shrink-0 font-mono text-ink-3 tabular-nums w-6 text-right">
                  v{v.version}
                </span>
                <ChangeSourceBadge source={v.change_source} />
                <div className="flex-1 min-w-0">
                  <span className="text-ink-2">
                    {v.change_summary || "No summary"}
                  </span>
                  {v.changed_by && (
                    <span className="text-ink-3 ml-1">by {v.changed_by}</span>
                  )}
                </div>
                <span className="shrink-0 font-mono text-xs text-ink-3 tabular-nums">
                  {formatRelativeTime(v.created_at)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusPill({ label }: { label: string }) {
  const cls = SESSION_STATUS_PILL[label] ?? SESSION_STATUS_PILL.planning;
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${cls}`}>
      {label.replace(/_/g, " ")}
    </span>
  );
}

function ChangeSourceBadge({ source }: { source: string }) {
  const cls = CHANGE_SOURCE_BADGE[source] ?? "bg-muted-subtle text-muted border-muted-rim";
  return (
    <span className={`shrink-0 text-xs px-1.5 py-0.5 rounded border font-medium ${cls}`}>
      {source.replace(/_/g, " ")}
    </span>
  );
}

function formatRelativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffSec = Math.max(0, Math.floor((now - then) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}
