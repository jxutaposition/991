"use client";

import { useEffect, useState, useCallback } from "react";
import { useAuth } from "@/lib/auth-context";
import { SCOPE_BADGE, AUTHORITY_BADGE } from "@/lib/tokens";
import { clsx } from "clsx";
import {
  ChevronRight,
  ChevronDown,
  Database,
  FileText,
  MessageSquare,
  ThumbsUp,
  Eye,
  Layers,
  BookOpen,
  Activity,
  Loader2,
  AlertCircle,
  Boxes,
  GitPullRequest,
  Zap,
  Bot,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ObservatoryData {
  expert: {
    agents_with_knowledge: { slug: string; name: string; doc_count: number }[];
  };
  workspace: {
    corpus: {
      total_documents: number;
      total_chunks: number;
      by_status: Record<string, number>;
    };
    chat_learning: {
      sessions_analyzed: number | null;
      by_status: Record<string, number | null>;
      narratives: number;
    };
    feedback: {
      total_signals: number;
      by_type: Record<string, number>;
      active_patterns: number;
      agent_prs: Record<string, number>;
    };
    observations: {
      sessions: number | null;
      distillations: number | null;
    };
    overlays: {
      total_active: number;
      by_source: Record<string, number>;
      by_scope: Record<string, number>;
    };
    retrieval_activity: {
      total_7d: number;
      top_chunks: { resource_id: string; total: number; last_accessed: string }[];
    };
    projects: {
      id: string;
      name: string;
      corpus_docs: number;
      corpus_chunks: number;
      overlays: number;
    }[];
  };
}

interface DetailResult {
  rows: Record<string, unknown>[];
  total: number;
}

/* ------------------------------------------------------------------ */
/*  Section config                                                     */
/* ------------------------------------------------------------------ */

const LAYER_COLORS = {
  source: "border-l-blue-500",
  processing: "border-l-amber-500",
  distilled: "border-l-emerald-500",
  usage: "border-l-purple-500",
  meta: "border-l-gray-400",
};

const LAYER_DOT = {
  source: "bg-blue-500",
  processing: "bg-amber-500",
  distilled: "bg-emerald-500",
  usage: "bg-purple-500",
  meta: "bg-gray-400",
};

/* ------------------------------------------------------------------ */
/*  Accordion Section Component                                        */
/* ------------------------------------------------------------------ */

function Section({
  title,
  count,
  subtitle,
  layer,
  icon: Icon,
  defaultOpen = false,
  children,
}: {
  title: string;
  count?: number | string | null;
  subtitle?: string;
  layer: keyof typeof LAYER_COLORS;
  icon: React.ElementType;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={clsx("border-l-2 rounded-r-lg", LAYER_COLORS[layer])}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-raised/50 transition-colors text-left"
      >
        <span className={clsx("w-2 h-2 rounded-full shrink-0", LAYER_DOT[layer])} />
        <Icon className="w-4 h-4 shrink-0 text-ink-2" />
        <span className="font-medium text-sm text-ink flex-1">{title}</span>
        {count != null && (
          <span className="text-xs font-mono bg-raised px-2 py-0.5 rounded-full text-ink-2">
            {typeof count === "number" ? count.toLocaleString() : count}
          </span>
        )}
        {subtitle && (
          <span className="text-xs text-ink-3 hidden sm:inline">{subtitle}</span>
        )}
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-ink-3 shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-ink-3 shrink-0" />
        )}
      </button>
      {open && <div className="pl-10 pr-4 pb-3">{children}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sub-section: breakdown pills                                       */
/* ------------------------------------------------------------------ */

function BreakdownPills({ data, badgeMap }: { data: Record<string, number>; badgeMap?: Record<string, string> }) {
  const entries = Object.entries(data).filter(([, v]) => v > 0);
  if (entries.length === 0) return <p className="text-xs text-ink-3 italic">None</p>;
  return (
    <div className="flex flex-wrap gap-1.5 mt-1">
      {entries.map(([key, val]) => (
        <span
          key={key}
          className={clsx(
            "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs",
            badgeMap?.[key] ?? "bg-raised text-ink-2"
          )}
        >
          <span className="font-medium">{val.toLocaleString()}</span>
          <span className="opacity-70">{key.replace(/_/g, " ")}</span>
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Drill-down data table (loads on demand)                            */
/* ------------------------------------------------------------------ */

function DrillDown({
  section,
  tenantId,
  extraParams,
  columns,
}: {
  section: string;
  tenantId: string;
  extraParams?: Record<string, string>;
  columns: { key: string; label: string; render?: (val: unknown, row: Record<string, unknown>) => React.ReactNode }[];
}) {
  const { apiFetch } = useAuth();
  const [data, setData] = useState<DetailResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  const load = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ tenant_id: tenantId, page: String(p), limit: "10", ...extraParams });
      const res = await apiFetch(`/api/knowledge/observatory/${section}?${params}`);
      if (res.ok) {
        setData(await res.json());
      }
    } finally {
      setLoading(false);
    }
  }, [apiFetch, section, tenantId, extraParams]);

  useEffect(() => { load(page); }, [load, page]);

  if (loading && !data) {
    return (
      <div className="flex items-center gap-2 py-3 text-xs text-ink-3">
        <Loader2 className="w-3 h-3 animate-spin" />
        Loading...
      </div>
    );
  }

  if (!data || data.rows.length === 0) {
    return <p className="text-xs text-ink-3 italic py-2">No data</p>;
  }

  return (
    <div className="mt-2">
      <div className="border border-rim rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-raised/50">
              {columns.map((col) => (
                <th key={col.key} className="px-3 py-2 text-left font-medium text-ink-3">
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-rim">
            {data.rows.map((row, i) => (
              <tr key={i} className="hover:bg-raised/30 transition-colors">
                {columns.map((col) => (
                  <td key={col.key} className="px-3 py-2 text-ink-2 max-w-[300px] truncate">
                    {col.render
                      ? col.render(row[col.key], row)
                      : String(row[col.key] ?? "—")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.total > 10 && (
        <div className="flex items-center justify-between mt-2">
          <span className="text-xs text-ink-3">
            Page {page} of {Math.ceil(data.total / 10)}
            {" "}({data.total.toLocaleString()} total)
          </span>
          <div className="flex gap-1">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="px-2 py-1 text-xs rounded border border-rim hover:bg-raised disabled:opacity-30"
            >
              Prev
            </button>
            <button
              disabled={page >= Math.ceil(data.total / 10)}
              onClick={() => setPage((p) => p + 1)}
              className="px-2 py-1 text-xs rounded border border-rim hover:bg-raised disabled:opacity-30"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Timestamp helper                                                   */
/* ------------------------------------------------------------------ */

function timeAgo(ts: unknown): string {
  if (!ts || typeof ts !== "string") return "—";
  const d = new Date(ts);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

type ScopeTab = "workspace" | "agents" | "projects";

const SCOPE_TABS: { id: ScopeTab; label: string; icon: React.ElementType; description: string }[] = [
  { id: "workspace", label: "Workspace", icon: Database, description: "Uploaded corpus, chat learnings, observations, and retrieved knowledge" },
  { id: "agents", label: "Agents", icon: Bot, description: "Bundled agent docs, feedback signals, patterns, and agent PRs" },
  { id: "projects", label: "Projects", icon: Boxes, description: "Per-project corpus, overlays, and learnings" },
];

export default function ObservatoryPage() {
  const { apiFetch, activeClient } = useAuth();
  const [data, setData] = useState<ObservatoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ScopeTab>("workspace");

  useEffect(() => {
    if (!activeClient) return;
    setLoading(true);
    setError(null);
    apiFetch(`/api/knowledge/observatory?tenant_id=${encodeURIComponent(activeClient)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        setData(await res.json());
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [apiFetch, activeClient]);

  if (!activeClient) {
    return (
      <div className="flex items-center justify-center h-full text-ink-3 text-sm">
        Select a workspace to view its knowledge observatory.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-ink-3 text-sm">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading knowledge observatory...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-danger text-sm">
        <AlertCircle className="w-4 h-4" />
        Failed to load observatory: {error}
      </div>
    );
  }

  if (!data) return null;

  const ws = data.workspace;
  const totalLearnings = Object.values(ws.chat_learning.by_status).reduce<number>((a, b) => a + (b ?? 0), 0);
  const totalPrs = Object.values(ws.feedback.agent_prs).reduce((a, b) => a + b, 0);

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-ink">Knowledge Observatory</h1>
        <p className="text-sm text-ink-3 mt-1">
          Complete knowledge landscape — what the system knows, where it came from, and what it uses.
        </p>
      </div>

      {/* Scope tabs */}
      <div className="flex items-center gap-1 mb-6 border-b border-rim">
        {SCOPE_TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={clsx(
                "flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors",
                activeTab === tab.id
                  ? "border-brand text-ink"
                  : "border-transparent text-ink-3 hover:text-ink-2"
              )}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      <p className="text-xs text-ink-3 mb-4">{SCOPE_TABS.find((t) => t.id === activeTab)?.description}</p>

      {/* Layer legend */}
      <div className="flex items-center gap-4 mb-6 text-xs text-ink-3">
        {(["source", "processing", "distilled", "usage"] as const).map((layer) => (
          <div key={layer} className="flex items-center gap-1.5">
            <span className={clsx("w-2 h-2 rounded-full", LAYER_DOT[layer])} />
            <span className="capitalize">{layer}</span>
          </div>
        ))}
      </div>

      {/* ================================================================ */}
      {/* WORKSPACE TAB                                                     */}
      {/* ================================================================ */}
      {activeTab === "workspace" && (
        <div className="space-y-1">
          <Section
            title="Knowledge Corpus"
            count={ws.corpus.total_documents}
            subtitle={`${ws.corpus.total_chunks.toLocaleString()} chunks`}
            layer="source"
            icon={FileText}
            defaultOpen
          >
            <div className="space-y-3">
              <div>
                <p className="text-xs font-medium text-ink-2 mb-1">Documents by status</p>
                <BreakdownPills
                  data={ws.corpus.by_status}
                  badgeMap={{
                    ready: "bg-success-subtle text-success",
                    pending: "bg-warning-subtle text-warning",
                    processing: "bg-info-subtle text-info",
                    error: "bg-danger-subtle text-danger",
                  }}
                />
              </div>

              <Section title="All Documents" count={ws.corpus.total_documents} layer="source" icon={Database}>
                <DrillDown
                  section="corpus_documents"
                  tenantId={activeClient}
                  columns={[
                    { key: "source_filename", label: "Filename" },
                    { key: "status", label: "Status", render: (v) => (
                      <span className={clsx("px-1.5 py-0.5 rounded text-xs", v === "ready" ? "bg-success-subtle text-success" : v === "error" ? "bg-danger-subtle text-danger" : "bg-warning-subtle text-warning")}>
                        {String(v)}
                      </span>
                    )},
                    { key: "chunk_count", label: "Chunks" },
                    { key: "created_at", label: "Uploaded", render: (v) => timeAgo(v) },
                  ]}
                />
              </Section>

              <Section title="Chunks" count={ws.corpus.total_chunks} layer="processing" icon={Boxes}>
                <DrillDown
                  section="corpus_chunks"
                  tenantId={activeClient}
                  columns={[
                    { key: "source_filename", label: "Document" },
                    { key: "section_title", label: "Section" },
                    { key: "content_preview", label: "Preview" },
                    { key: "token_count", label: "Tokens" },
                  ]}
                />
              </Section>

              <Section
                title="Retrieval Activity"
                count={ws.retrieval_activity.total_7d}
                subtitle="hits last 7 days"
                layer="usage"
                icon={Activity}
              >
                {ws.retrieval_activity.total_7d > 0 ? (
                  <DrillDown
                    section="retrieval_hits"
                    tenantId={activeClient}
                    columns={[
                      { key: "source_filename", label: "Document" },
                      { key: "content_preview", label: "Chunk Preview" },
                      { key: "hit_count", label: "Hits" },
                      { key: "last_accessed", label: "Last Hit", render: (v) => timeAgo(v) },
                    ]}
                  />
                ) : (
                  <p className="text-xs text-ink-3 italic">No retrieval activity recorded yet.</p>
                )}
              </Section>
            </div>
          </Section>

          <Section
            title="Chat Learning"
            count={ws.chat_learning.sessions_analyzed}
            subtitle={`${totalLearnings} learnings extracted`}
            layer="source"
            icon={MessageSquare}
          >
            <div className="space-y-3">
              <div>
                <p className="text-xs font-medium text-ink-2 mb-1">Learnings by status</p>
                <BreakdownPills
                  data={Object.fromEntries(
                    Object.entries(ws.chat_learning.by_status)
                      .filter(([, v]) => v != null)
                      .map(([k, v]) => [k, v as number])
                  )}
                  badgeMap={{
                    applied: "bg-success-subtle text-success",
                    distilled: "bg-success-subtle text-success",
                    conflict: "bg-warning-subtle text-warning",
                    pending: "bg-info-subtle text-info",
                    rejected: "bg-danger-subtle text-danger",
                  }}
                />
              </div>

              <Section title="All Learnings" count={totalLearnings} layer="processing" icon={Zap}>
                <DrillDown
                  section="chat_learnings"
                  tenantId={activeClient}
                  columns={[
                    { key: "learning_text", label: "Learning" },
                    { key: "status", label: "Status", render: (v) => (
                      <span className={clsx("px-1.5 py-0.5 rounded text-xs",
                        v === "applied" || v === "distilled" ? "bg-success-subtle text-success" :
                        v === "conflict" ? "bg-warning-subtle text-warning" :
                        v === "rejected" ? "bg-danger-subtle text-danger" :
                        "bg-info-subtle text-info"
                      )}>{String(v)}</span>
                    )},
                    { key: "scope", label: "Scope", render: (v) => (
                      <span className={clsx("px-1.5 py-0.5 rounded text-xs", SCOPE_BADGE[String(v)] ?? "bg-raised text-ink-2")}>{String(v ?? "—")}</span>
                    )},
                    { key: "created_at", label: "When", render: (v) => timeAgo(v) },
                  ]}
                />
              </Section>

              <Section title="Scope Narratives" count={ws.chat_learning.narratives} layer="distilled" icon={BookOpen}>
                <DrillDown
                  section="scope_narratives"
                  tenantId={activeClient}
                  columns={[
                    { key: "scope", label: "Scope", render: (v) => (
                      <span className={clsx("px-1.5 py-0.5 rounded text-xs", SCOPE_BADGE[String(v)] ?? "bg-raised text-ink-2")}>{String(v)}</span>
                    )},
                    { key: "narrative_text", label: "Narrative" },
                    { key: "source_overlay_count", label: "Sources" },
                    { key: "generated_at", label: "Generated", render: (v) => timeAgo(v) },
                  ]}
                />
              </Section>
            </div>
          </Section>

          <Section
            title="Learned Knowledge"
            count={ws.overlays.total_active}
            subtitle="active overlays"
            layer="distilled"
            icon={Layers}
          >
            <div className="space-y-3">
              <div>
                <p className="text-xs font-medium text-ink-2 mb-1">By source</p>
                <BreakdownPills data={ws.overlays.by_source} />
              </div>
              <div>
                <p className="text-xs font-medium text-ink-2 mb-1">By scope</p>
                <BreakdownPills data={ws.overlays.by_scope} badgeMap={SCOPE_BADGE} />
              </div>

              <Section title="All Overlays" count={ws.overlays.total_active} layer="distilled" icon={Layers}>
                <DrillDown
                  section="overlays"
                  tenantId={activeClient}
                  columns={[
                    { key: "content", label: "Content" },
                    { key: "source", label: "Source" },
                    { key: "scope", label: "Scope", render: (v) => (
                      <span className={clsx("px-1.5 py-0.5 rounded text-xs", SCOPE_BADGE[String(v)] ?? "bg-raised text-ink-2")}>{String(v)}</span>
                    )},
                    { key: "skill_name", label: "Skill" },
                    { key: "created_at", label: "When", render: (v) => timeAgo(v) },
                  ]}
                />
              </Section>
            </div>
          </Section>

          <Section
            title="Observations"
            count={ws.observations.sessions}
            subtitle={`${ws.observations.distillations ?? 0} distillations`}
            layer="source"
            icon={Eye}
          >
            <p className="text-xs text-ink-3">
              Browser observation sessions feed distillations which become feedback signals.
            </p>
          </Section>
        </div>
      )}

      {/* ================================================================ */}
      {/* AGENTS TAB                                                        */}
      {/* ================================================================ */}
      {activeTab === "agents" && (
        <div className="space-y-1">
          <Section
            title="Agent Knowledge"
            count={data.expert.agents_with_knowledge.length}
            subtitle="bundled reference docs"
            layer="meta"
            icon={Bot}
            defaultOpen
          >
            <p className="text-xs text-ink-3 mb-2">Static markdown bundled per agent -- loaded at startup, versioned with code.</p>
            {data.expert.agents_with_knowledge.length > 0 ? (
              <div className="space-y-1">
                {data.expert.agents_with_knowledge.map((a) => (
                  <div key={a.slug} className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-ink-2">{a.slug}</span>
                    <span className="text-ink-3">--</span>
                    <span className="text-ink-3">{a.name}</span>
                    <span className="ml-auto text-ink-3 font-mono">{a.doc_count} docs</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-ink-3 italic">No agents have bundled knowledge docs.</p>
            )}

            <Section title="Agent-Specific Docs" count={data.expert.agents_with_knowledge.length} layer="meta" icon={FileText}>
              <DrillDown
                section="agent_knowledge"
                tenantId={activeClient}
                columns={[
                  { key: "agent_slug", label: "Agent" },
                  { key: "doc_name", label: "Document" },
                  { key: "doc_path", label: "Path" },
                ]}
              />
            </Section>
          </Section>

          <Section
            title="Feedback Signals"
            count={ws.feedback.total_signals}
            subtitle={`${ws.feedback.active_patterns} patterns`}
            layer="source"
            icon={ThumbsUp}
          >
            <div className="space-y-3">
              <div>
                <p className="text-xs font-medium text-ink-2 mb-1">Signals by type</p>
                <BreakdownPills data={ws.feedback.by_type} badgeMap={AUTHORITY_BADGE} />
              </div>

              <Section title="All Signals" count={ws.feedback.total_signals} layer="processing" icon={Zap}>
                <DrillDown
                  section="feedback_signals"
                  tenantId={activeClient}
                  columns={[
                    { key: "description", label: "Description" },
                    { key: "signal_type", label: "Type" },
                    { key: "authority", label: "Authority", render: (v) => (
                      <span className={clsx("px-1.5 py-0.5 rounded text-xs", AUTHORITY_BADGE[String(v)] ?? "bg-raised text-ink-2")}>{String(v)}</span>
                    )},
                    { key: "agent_slug", label: "Agent" },
                    { key: "created_at", label: "When", render: (v) => timeAgo(v) },
                  ]}
                />
              </Section>

              <Section title="Active Patterns" count={ws.feedback.active_patterns} layer="distilled" icon={Layers}>
                <DrillDown
                  section="feedback_patterns"
                  tenantId={activeClient}
                  columns={[
                    { key: "description", label: "Pattern" },
                    { key: "agent_slug", label: "Agent" },
                    { key: "session_count", label: "Sessions" },
                    { key: "severity", label: "Severity" },
                  ]}
                />
              </Section>
            </div>
          </Section>

          <Section
            title="Agent PRs"
            count={totalPrs}
            subtitle="proposed prompt/knowledge changes"
            layer="distilled"
            icon={GitPullRequest}
          >
            <div className="mb-2">
              <BreakdownPills data={ws.feedback.agent_prs} badgeMap={{
                open: "bg-warning-subtle text-warning",
                applied: "bg-success-subtle text-success",
                rejected: "bg-danger-subtle text-danger",
              }} />
            </div>
            <DrillDown
              section="agent_prs"
              tenantId={activeClient}
              columns={[
                { key: "gap_summary", label: "Summary" },
                { key: "target_agent_slug", label: "Target Agent" },
                { key: "confidence", label: "Confidence" },
                { key: "status", label: "Status" },
                { key: "created_at", label: "When", render: (v) => timeAgo(v) },
              ]}
            />
          </Section>
        </div>
      )}

      {/* ================================================================ */}
      {/* PROJECTS TAB                                                      */}
      {/* ================================================================ */}
      {activeTab === "projects" && (
        <div className="space-y-1">
          {ws.projects.length > 0 ? (
            ws.projects.map((p) => (
              <Section
                key={p.id}
                title={p.name}
                count={p.corpus_docs}
                subtitle={`${p.corpus_chunks} chunks, ${p.overlays} overlays`}
                layer="source"
                icon={Database}
                defaultOpen={ws.projects.length === 1}
              >
                <div className="space-y-2">
                  <div className="grid grid-cols-3 gap-3">
                    <div className="border border-rim rounded-lg p-3 text-center">
                      <p className="text-lg font-semibold text-ink">{p.corpus_docs}</p>
                      <p className="text-xs text-ink-3">Documents</p>
                    </div>
                    <div className="border border-rim rounded-lg p-3 text-center">
                      <p className="text-lg font-semibold text-ink">{p.corpus_chunks}</p>
                      <p className="text-xs text-ink-3">Chunks</p>
                    </div>
                    <div className="border border-rim rounded-lg p-3 text-center">
                      <p className="text-lg font-semibold text-ink">{p.overlays}</p>
                      <p className="text-xs text-ink-3">Overlays</p>
                    </div>
                  </div>
                </div>
              </Section>
            ))
          ) : (
            <div className="text-center py-12 text-ink-3">
              <Database className="w-8 h-8 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No projects yet. Projects are created when you scope execution sessions to specific engagements.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
