"use client";

import { KeyRound, Wrench, HelpCircle, Globe, Bug, Check, X } from "lucide-react";
import { ISSUE_STATUS_COLORS } from "@/lib/tokens";

export interface NodeIssue {
  id: string;
  node_id: string;
  session_id: string;
  issue_type: "credential" | "manual" | "decision" | "external" | "technical";
  description: string;
  status: "open" | "resolved" | "dismissed";
  source: "preflight" | "agent" | "user" | "system";
  resolved_at?: string | null;
  resolved_by?: string | null;
  created_at: string;
}

const ISSUE_ICONS: Record<string, React.ElementType> = {
  credential: KeyRound,
  manual: Wrench,
  decision: HelpCircle,
  external: Globe,
  technical: Bug,
};


interface IssueCardProps {
  issue: NodeIssue;
  onResolve?: (issueId: string) => void;
  onDismiss?: (issueId: string) => void;
}

export function IssueCard({ issue, onResolve, onDismiss }: IssueCardProps) {
  const Icon = ISSUE_ICONS[issue.issue_type] ?? Bug;
  const colors = ISSUE_STATUS_COLORS[issue.status] ?? ISSUE_STATUS_COLORS.open;

  return (
    <div className={`flex items-start gap-2 px-3 py-2 rounded-lg border ${colors.bg} ${colors.border}`}>
      <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${colors.text}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={`text-xs font-medium ${colors.text}`}>
            {issue.issue_type}
          </span>
          <span className="text-xs text-ink-3">
            via {issue.source}
          </span>
        </div>
        <p className={`text-xs mt-0.5 ${issue.status === "open" ? "text-ink" : "text-ink-3"}`}>
          {issue.description}
        </p>
      </div>
      {issue.status === "open" && (
        <div className="flex items-center gap-1 shrink-0">
          {onResolve && (
            <button
              onClick={() => onResolve(issue.id)}
              className="p-1 rounded hover:bg-green-100 text-green-600"
              title="Resolve"
              aria-label="Resolve issue"
            >
              <Check className="w-3 h-3" />
            </button>
          )}
          {onDismiss && (
            <button
              onClick={() => onDismiss(issue.id)}
              className="p-1 rounded hover:bg-gray-100 text-gray-400"
              title="Dismiss"
              aria-label="Dismiss issue"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
