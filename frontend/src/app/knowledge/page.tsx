"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import {
  ONBOARDING_STORAGE,
  markKnowledgeSowReady,
  readOnboardingFlowActive,
  readOnboardingStep,
  setOnboardingActive,
  setOnboardingStep,
} from "@/lib/onboarding-storage";
import {
  FolderOpen,
  FileText,
  Upload,
  Search,
  ChevronRight,
  ChevronDown,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Clock,
  Trash2,
  X,
  Download,
  Eye,
  List,
  Brain,
  Sparkles,
  BookOpen,
  Layers,
  RefreshCw,
} from "lucide-react";
import { clsx } from "clsx";
import ReactMarkdown from "react-markdown";
import { SCOPE_BADGE } from "@/lib/tokens";

interface Toast {
  id: number;
  type: "error" | "success" | "info";
  title: string;
  message?: string;
}

let toastCounter = 0;

function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((type: Toast["type"], title: string, message?: string) => {
    const id = ++toastCounter;
    setToasts((prev) => [...prev, { id, type, title, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, addToast, dismiss };
}

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={clsx(
            "flex items-start gap-2.5 px-3.5 py-2.5 rounded-lg shadow-lg border text-sm animate-in slide-in-from-right",
            t.type === "error" && "bg-red-50 border-red-200 text-red-900",
            t.type === "success" && "bg-green-50 border-green-200 text-green-900",
            t.type === "info" && "bg-blue-50 border-blue-200 text-blue-900"
          )}
        >
          {t.type === "error" ? (
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-red-500" />
          ) : t.type === "success" ? (
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-green-500" />
          ) : (
            <Loader2 className="w-4 h-4 mt-0.5 shrink-0 text-blue-500" />
          )}
          <div className="flex-1 min-w-0">
            <p className="font-medium">{t.title}</p>
            {t.message && <p className="mt-0.5 text-xs opacity-80">{t.message}</p>}
          </div>
          <button onClick={() => onDismiss(t.id)} className="shrink-0 mt-0.5 opacity-50 hover:opacity-100">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

interface KnowledgeDoc {
  id: string;
  tenant_id: string;
  project_id: string | null;
  source_filename: string;
  source_path: string;
  source_folder: string;
  mime_type: string;
  status: string;
  error_message: string | null;
  chunk_count: number;
  inferred_scope: string | null;
  created_at: string;
  normalized_markdown?: string | null;
  has_raw_content?: boolean;
  file_size_bytes?: number | null;
}

interface FolderInfo {
  source_folder: string;
  file_count: number;
  last_updated: string;
}

interface ChunkInfo {
  id: string;
  chunk_index: number;
  section_title: string | null;
  content: string;
  token_count: number | null;
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "ready":
      return (
        <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">
          <CheckCircle2 className="w-3 h-3" /> Ready
        </span>
      );
    case "processing":
      return (
        <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700">
          <Loader2 className="w-3 h-3 animate-spin" /> Processing
        </span>
      );
    case "error":
      return (
        <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-red-100 text-red-700">
          <AlertCircle className="w-3 h-3" /> Error
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">
          <Clock className="w-3 h-3" /> Pending
        </span>
      );
  }
}

function ScopeBadge({ scope }: { scope: string | null }) {
  if (!scope) return null;
  return (
    <span
      className={clsx(
        "text-xs px-1.5 py-0.5 rounded-full",
        SCOPE_BADGE[scope] || "bg-muted-subtle text-muted"
      )}
    >
      {scope}
    </span>
  );
}

interface FolderTreeNode {
  name: string;
  path: string;
  fileCount: number;
  children: FolderTreeNode[];
}

function buildTree(folders: FolderInfo[]): FolderTreeNode[] {
  const root: FolderTreeNode[] = [];

  for (const f of folders) {
    const parts = f.source_folder.split("/").filter(Boolean);
    let current = root;
    let pathSoFar = "";

    for (let i = 0; i < parts.length; i++) {
      pathSoFar += (i > 0 ? "/" : "") + parts[i];
      let node = current.find((n) => n.name === parts[i]);
      if (!node) {
        node = { name: parts[i], path: pathSoFar, fileCount: 0, children: [] };
        current.push(node);
      }
      if (i === parts.length - 1) {
        node.fileCount = Number(f.file_count) || 0;
      }
      current = node.children;
    }
  }

  // Also add a root entry for files at ""
  const rootFiles = folders.find((f) => f.source_folder === "");
  if (rootFiles) {
    root.unshift({
      name: "/",
      path: "",
      fileCount: Number(rootFiles.file_count) || 0,
      children: [],
    });
  }

  return root;
}

function FolderNode({
  node,
  selectedFolder,
  onSelect,
  onDelete,
  depth,
}: {
  node: FolderTreeNode;
  selectedFolder: string | null;
  onSelect: (path: string) => void;
  onDelete: (path: string) => void;
  depth: number;
}) {
  const [open, setOpen] = useState(depth < 2);
  const [hovered, setHovered] = useState(false);
  const hasChildren = node.children.length > 0;
  const isSelected = selectedFolder === node.path;

  return (
    <div>
      <div
        className="relative group"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <button
          onClick={() => {
            onSelect(node.path);
            if (hasChildren) setOpen(!open);
          }}
          className={clsx(
            "w-full flex items-center gap-1 px-2 py-1 text-sm rounded hover:bg-surface transition-colors",
            isSelected && "bg-brand-subtle text-brand"
          )}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          {hasChildren ? (
            open ? (
              <ChevronDown className="w-3.5 h-3.5 shrink-0" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 shrink-0" />
            )
          ) : (
            <span className="w-3.5" />
          )}
          <FolderOpen className="w-3.5 h-3.5 shrink-0 text-ink-3" />
          <span className="truncate flex-1 text-left">{node.name}</span>
          {node.fileCount > 0 && (
            <span className="text-xs text-ink-3">{node.fileCount}</span>
          )}
        </button>
        {hovered && node.path && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(node.path);
            }}
            className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-ink-3 hover:text-red-600 hover:bg-red-50 transition-colors"
            title={`Delete folder "${node.name}" and all its files`}
          >
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>
      {open &&
        node.children.map((child) => (
          <FolderNode
            key={child.path}
            node={child}
            selectedFolder={selectedFolder}
            onSelect={onSelect}
            onDelete={onDelete}
            depth={depth + 1}
          />
        ))}
    </div>
  );
}

interface ProcessingProgress {
  parent_status: string;
  parent_filename: string;
  parent_error: string | null;
  children: { total: number; ready: number; processing: number; pending: number; errors: number };
}

function IngestionTracker({
  progress,
  onDismiss,
}: {
  progress: ProcessingProgress;
  onDismiss: () => void;
}) {
  const c = progress.children;
  const allDone = c.total > 0 && c.ready + c.errors === c.total;
  const pct = c.total > 0 ? Math.round(((c.ready + c.errors) / c.total) * 100) : 0;

  const isExtracting =
    progress.parent_status === "pending" || progress.parent_status === "processing";

  return (
    <div className="px-3 py-2 bg-surface border-t border-rim flex items-center gap-3 text-sm">
      {isExtracting && c.total === 0 ? (
        <>
          <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500 shrink-0" />
          <span className="text-ink-2">
            Extracting <span className="font-medium text-ink">{progress.parent_filename}</span>...
          </span>
        </>
      ) : allDone ? (
        <>
          <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0" />
          <span className="text-ink-2">
            Done &mdash; {c.ready} file{c.ready !== 1 ? "s" : ""} processed
            {c.errors > 0 && <span className="text-red-600"> ({c.errors} failed)</span>}
          </span>
          <button onClick={onDismiss} className="ml-auto text-xs text-ink-3 hover:text-ink-2">
            Dismiss
          </button>
        </>
      ) : (
        <>
          <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500 shrink-0" />
          <span className="text-ink-2">
            Processing{" "}
            <span className="font-medium text-ink">
              {c.ready + c.errors}/{c.total}
            </span>{" "}
            files
            {c.processing > 0 && (
              <span className="text-blue-600"> ({c.processing} active)</span>
            )}
            {c.errors > 0 && (
              <span className="text-red-600"> ({c.errors} failed)</span>
            )}
          </span>
          <div className="flex-1 max-w-xs h-1.5 rounded-full bg-rim overflow-hidden">
            <div className="h-full flex">
              <div
                className="bg-green-500 transition-all duration-500"
                style={{ width: `${c.total > 0 ? (c.ready / c.total) * 100 : 0}%` }}
              />
              <div
                className="bg-blue-500 transition-all duration-500"
                style={{ width: `${c.total > 0 ? (c.processing / c.total) * 100 : 0}%` }}
              />
              <div
                className="bg-red-400 transition-all duration-500"
                style={{ width: `${c.total > 0 ? (c.errors / c.total) * 100 : 0}%` }}
              />
            </div>
          </div>
          <span className="text-xs text-ink-3 tabular-nums">{pct}%</span>
        </>
      )}
    </div>
  );
}

interface LearningStats {
  sessions_analyzed: number;
  total_learnings: number;
  distilled: number;
  duplicates: number;
  pending_conflicts: number;
  rejected: number;
  transcript_overlays: number;
  narratives: number;
}

interface ChatLearning {
  id: string;
  session_id: string;
  learning_text: string;
  suggested_scope: string;
  suggested_primitive_slug: string;
  confidence: string;
  status: string;
  created_at: string;
}

interface Overlay {
  id: string;
  primitive_type: string;
  primitive_id: string;
  scope: string;
  source: string;
  content: string;
  created_at: string;
}

function LearningsTab({
  activeClient,
  apiFetch,
  addToast,
}: {
  activeClient: string;
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
  addToast: (type: "error" | "success" | "info", title: string, message?: string) => void;
}) {
  interface SessionInfo {
    id: string;
    request_text: string;
    status: string;
    created_at: string;
    completed_at: string | null;
    learning_scanned_up_to: string | null;
    analysis_skip: boolean;
    analysis_failure_count: number;
    project_slug: string | null;
    learning_count: number;
    user_message_count: number;
    has_new_messages: boolean;
  }

  const [stats, setStats] = useState<LearningStats | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [learnings, setLearnings] = useState<ChatLearning[]>([]);
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  const [loading, setLoading] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [learningsPage, setLearningsPage] = useState(1);
  const [overlaysPage, setOverlaysPage] = useState(1);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [statsRes, sessionsRes, learningsRes, overlaysRes] = await Promise.all([
        apiFetch("/api/chat-learnings/stats"),
        apiFetch(`/api/chat-learnings/sessions?tenant_id=${activeClient}`),
        apiFetch(
          `/api/knowledge/observatory/chat_learnings?tenant_id=${activeClient}&page=${learningsPage}&limit=20`
        ),
        apiFetch(
          `/api/knowledge/observatory/overlays?tenant_id=${activeClient}&source=transcript&page=${overlaysPage}&limit=20`
        ),
      ]);

      if (statsRes.ok) {
        const data = await statsRes.json();
        setStats(data);
      }
      if (sessionsRes.ok) {
        const data = await sessionsRes.json();
        setSessions(data.sessions || []);
      }
      if (learningsRes.ok) {
        const data = await learningsRes.json();
        setLearnings(data.rows || []);
      }
      if (overlaysRes.ok) {
        const data = await overlaysRes.json();
        setOverlays(data.rows || []);
      }
    } catch {
      // network error
    }
    setLoading(false);
  }, [activeClient, apiFetch, learningsPage, overlaysPage]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleExtract = async () => {
    setExtracting(true);
    addToast("info", "Analyzing sessions...", "This may take a minute.");
    try {
      const res = await apiFetch("/api/chat-learnings/analyze-recent", {
        method: "POST",
        body: JSON.stringify({ tenant_id: activeClient, force: true }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.sessions_analyzed === 0) {
          addToast("info", "No new sessions to analyze", "All recent sessions have already been processed.");
        } else {
          addToast(
            "success",
            `Analyzed ${data.sessions_analyzed} session${data.sessions_analyzed !== 1 ? "s" : ""}`,
            `Extracted ${data.learnings_extracted} learning${data.learnings_extracted !== 1 ? "s" : ""}.`
          );
        }
        loadData();
      } else {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        addToast("error", "Analysis failed", err.error);
      }
    } catch {
      addToast("error", "Analysis failed", "Network error");
    }
    setExtracting(false);
  };

  if (loading && !stats) {
    return (
      <div className="flex items-center justify-center h-full text-ink-3 text-sm gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading learnings...
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* Left panel: stats + action */}
      <div className="w-72 border-r border-rim bg-page overflow-y-auto shrink-0">
        <div className="p-4 space-y-4">
          <button
            onClick={handleExtract}
            disabled={extracting}
            className={clsx(
              "w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors",
              extracting
                ? "bg-surface text-ink-3 cursor-wait"
                : "bg-brand text-white hover:bg-brand/90"
            )}
          >
            {extracting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4" />
            )}
            {extracting ? "Analyzing..." : "Extract from recent sessions"}
          </button>

          {stats && (
            <div className="space-y-3">
              <h4 className="text-xs font-semibold text-ink-3 uppercase tracking-wider">
                Learning Stats
              </h4>
              <div className="grid grid-cols-2 gap-2">
                <StatCard label="Sessions analyzed" value={stats.sessions_analyzed} />
                <StatCard label="Total learnings" value={stats.total_learnings} />
                <StatCard label="Distilled" value={stats.distilled} />
                <StatCard label="Active overlays" value={stats.transcript_overlays} />
                <StatCard label="Duplicates" value={stats.duplicates} />
                <StatCard label="Conflicts" value={stats.pending_conflicts} />
                <StatCard label="Rejected" value={stats.rejected} />
                <StatCard label="Narratives" value={stats.narratives} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Sessions section */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <FileText className="w-4 h-4 text-ink-3" />
            <h3 className="text-sm font-semibold">Recent Sessions</h3>
            <span className="text-xs text-ink-3">
              Execution sessions available for learning extraction
            </span>
            <button
              onClick={loadData}
              className="ml-auto p-1 rounded hover:bg-surface transition-colors text-ink-3 hover:text-ink-2"
              title="Refresh"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
          {sessions.length === 0 ? (
            <div className="text-center py-6 text-ink-3 text-sm border border-dashed border-rim rounded-lg">
              No recent sessions found.
            </div>
          ) : (
            <div className="border border-rim rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-surface text-left text-xs text-ink-3">
                    <th className="px-3 py-2 font-medium">Request</th>
                    <th className="px-3 py-2 font-medium w-24">Status</th>
                    <th className="px-3 py-2 font-medium w-20 text-center">Messages</th>
                    <th className="px-3 py-2 font-medium w-32">Analysis</th>
                    <th className="px-3 py-2 font-medium w-24 text-center">Learnings</th>
                    <th className="px-3 py-2 font-medium w-28">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id} className="border-t border-rim hover:bg-surface/50">
                      <td className="px-3 py-2">
                        <span className="line-clamp-1 text-ink" title={s.request_text}>
                          {s.request_text || "(no request text)"}
                        </span>
                        {s.project_slug && (
                          <span className="text-[11px] text-ink-3">{s.project_slug}</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <SessionStatusBadge status={s.status} />
                      </td>
                      <td className="px-3 py-2 text-center text-ink-2 tabular-nums">
                        {Number(s.user_message_count)}
                      </td>
                      <td className="px-3 py-2">
                        <AnalysisStatusBadge
                          scannedUpTo={s.learning_scanned_up_to}
                          skip={s.analysis_skip}
                          learningCount={Number(s.learning_count)}
                          hasNewMessages={s.has_new_messages}
                        />
                      </td>
                      <td className="px-3 py-2 text-center tabular-nums">
                        {Number(s.learning_count) > 0 ? (
                          <span className="text-green-700 font-medium">{Number(s.learning_count)}</span>
                        ) : (
                          <span className="text-ink-3">0</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-[11px] text-ink-3 whitespace-nowrap">
                        {new Date(s.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Learnings section */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <Brain className="w-4 h-4 text-purple-500" />
            <h3 className="text-sm font-semibold">Chat Learnings</h3>
            <span className="text-xs text-ink-3">
              Insights extracted from your conversations
            </span>
          </div>
          {learnings.length === 0 ? (
            <div className="text-center py-8 text-ink-3 text-sm border border-dashed border-rim rounded-lg">
              <Brain className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p>No learnings yet.</p>
              <p className="text-xs mt-1">
                Click &ldquo;Extract from recent sessions&rdquo; to analyze your conversations.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {learnings.map((l) => (
                <div
                  key={l.id}
                  className="p-3 border border-rim rounded-lg bg-surface"
                >
                  <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                    <LearningStatusBadge status={l.status} />
                    {l.suggested_primitive_slug && (
                      <span className="text-xs px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700">
                        {l.suggested_primitive_slug}
                      </span>
                    )}
                    {l.suggested_scope && (
                      <span
                        className={clsx(
                          "text-xs px-1.5 py-0.5 rounded-full",
                          SCOPE_BADGE[l.suggested_scope] || "bg-muted-subtle text-muted"
                        )}
                      >
                        {l.suggested_scope}
                      </span>
                    )}
                    {l.confidence && (
                      <span className="text-xs text-ink-3 ml-auto">
                        {l.confidence} confidence
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-ink">{l.learning_text}</p>
                  <p className="text-[11px] text-ink-3 mt-1.5">
                    {new Date(l.created_at).toLocaleString()}
                  </p>
                </div>
              ))}
              <div className="flex items-center justify-center gap-2 pt-2">
                <button
                  onClick={() => setLearningsPage((p) => Math.max(1, p - 1))}
                  disabled={learningsPage <= 1}
                  className="text-xs px-2 py-1 rounded border border-rim hover:bg-surface disabled:opacity-30"
                >
                  Prev
                </button>
                <span className="text-xs text-ink-3">Page {learningsPage}</span>
                <button
                  onClick={() => setLearningsPage((p) => p + 1)}
                  disabled={learnings.length < 20}
                  className="text-xs px-2 py-1 rounded border border-rim hover:bg-surface disabled:opacity-30"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Overlays section */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <Layers className="w-4 h-4 text-blue-500" />
            <h3 className="text-sm font-semibold">Active Overlays</h3>
            <span className="text-xs text-ink-3">
              Lessons applied to future agent runs
            </span>
          </div>
          {overlays.length === 0 ? (
            <div className="text-center py-8 text-ink-3 text-sm border border-dashed border-rim rounded-lg">
              <Layers className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p>No transcript overlays yet.</p>
              <p className="text-xs mt-1">
                Overlays are created when learnings are distilled into reusable rules.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {overlays.map((o) => (
                <div
                  key={o.id}
                  className="p-3 border border-rim rounded-lg bg-surface"
                >
                  <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                    <span className="text-xs px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700">
                      {o.source}
                    </span>
                    <span
                      className={clsx(
                        "text-xs px-1.5 py-0.5 rounded-full",
                        SCOPE_BADGE[o.scope] || "bg-muted-subtle text-muted"
                      )}
                    >
                      {o.scope}
                    </span>
                    {o.primitive_type && (
                      <span className="text-xs text-ink-3">
                        {o.primitive_type}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-ink whitespace-pre-wrap">{o.content}</p>
                  <p className="text-[11px] text-ink-3 mt-1.5">
                    {new Date(o.created_at).toLocaleString()}
                  </p>
                </div>
              ))}
              <div className="flex items-center justify-center gap-2 pt-2">
                <button
                  onClick={() => setOverlaysPage((p) => Math.max(1, p - 1))}
                  disabled={overlaysPage <= 1}
                  className="text-xs px-2 py-1 rounded border border-rim hover:bg-surface disabled:opacity-30"
                >
                  Prev
                </button>
                <span className="text-xs text-ink-3">Page {overlaysPage}</span>
                <button
                  onClick={() => setOverlaysPage((p) => p + 1)}
                  disabled={overlays.length < 20}
                  className="text-xs px-2 py-1 rounded border border-rim hover:bg-surface disabled:opacity-30"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="p-2.5 rounded-lg bg-surface border border-rim">
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      <p className="text-[11px] text-ink-3 leading-tight">{label}</p>
    </div>
  );
}

function LearningStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "distilled":
      return (
        <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">
          <CheckCircle2 className="w-3 h-3" /> Distilled
        </span>
      );
    case "duplicate":
      return (
        <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">
          Duplicate
        </span>
      );
    case "conflict":
      return (
        <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-red-100 text-red-700">
          <AlertCircle className="w-3 h-3" /> Conflict
        </span>
      );
    case "rejected":
      return (
        <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-muted-subtle text-muted">
          Rejected
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700">
          <Clock className="w-3 h-3" /> Pending
        </span>
      );
  }
}

function SessionStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return (
        <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">
          <CheckCircle2 className="w-3 h-3" /> Done
        </span>
      );
    case "failed":
      return (
        <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-red-100 text-red-700">
          <AlertCircle className="w-3 h-3" /> Failed
        </span>
      );
    case "stopped":
      return (
        <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">
          Stopped
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-muted-subtle text-muted">
          {status}
        </span>
      );
  }
}

function AnalysisStatusBadge({
  scannedUpTo,
  skip,
  learningCount,
  hasNewMessages,
}: {
  scannedUpTo: string | null;
  skip: boolean;
  learningCount: number;
  hasNewMessages: boolean;
}) {
  if (skip) {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-red-100 text-red-700">
        <AlertCircle className="w-3 h-3" /> Skipped
      </span>
    );
  }
  if (!scannedUpTo) {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-muted-subtle text-muted">
        Not scanned
      </span>
    );
  }
  if (hasNewMessages) {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700">
        <RefreshCw className="w-3 h-3" /> New messages
      </span>
    );
  }
  if (learningCount > 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">
        <CheckCircle2 className="w-3 h-3" /> Up to date
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">
      No learnings
    </span>
  );
}

export default function KnowledgePage() {
  const router = useRouter();
  const { activeClient, token, apiFetch } = useAuth();
  const { toasts, addToast, dismiss: dismissToast } = useToast();
  const [activeTab, setActiveTab] = useState<"corpus" | "learnings">("corpus");
  const [documents, setDocuments] = useState<KnowledgeDoc[]>([]);
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<KnowledgeDoc | null>(null);
  const [chunks, setChunks] = useState<ChunkInfo[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(true);

  const [uploadPath, setUploadPath] = useState("");
  const [uploadContent, setUploadContent] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [trackingDocId, setTrackingDocId] = useState<string | null>(null);
  const [processingProgress, setProcessingProgress] = useState<ProcessingProgress | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onboardingSeedAttempted = useRef<Set<string>>(new Set());
  const onboardingSeedInFlight = useRef(false);

  const tryOnboardingSeedAfterDocReady = useCallback(
    async (docId: string, fromUploadPoll = false) => {
      if (!activeClient) return;
      const fromQuery =
        typeof window !== "undefined" &&
        new URLSearchParams(window.location.search).get("onboarding") === "1";
      const fromStorage =
        typeof window !== "undefined" &&
        sessionStorage.getItem(ONBOARDING_STORAGE.ACTIVE) === "1";
      const inOnboardingContext =
        fromQuery || fromStorage || readOnboardingFlowActive();
      if (!fromUploadPoll && !inOnboardingContext) return;

      if (onboardingSeedAttempted.current.has(docId) || onboardingSeedInFlight.current) return;
      onboardingSeedInFlight.current = true;

      const inFlow = readOnboardingFlowActive();

      try {
        const res = await apiFetch("/api/onboarding/seed-session-from-document", {
          method: "POST",
          body: JSON.stringify({ document_id: docId, client_slug: activeClient }),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string; session_id?: string; suggested_integration_slugs?: string[]; mentions_clay?: boolean };
        if (!res.ok) {
          addToast(
            "error",
            inFlow ? "Onboarding plan not created" : "Execution plan not created",
            typeof body.error === "string" ? body.error : "Request failed"
          );
          if (inFlow) {
            markKnowledgeSowReady();
            setOnboardingStep(3);
            router.push("/onboarding");
          }
          return;
        }
        onboardingSeedAttempted.current.add(docId);
        if (body.session_id && inFlow) {
          sessionStorage.setItem(ONBOARDING_STORAGE.SESSION_ID, body.session_id);
        }
        if (inFlow) {
          markKnowledgeSowReady();
          sessionStorage.setItem(
            ONBOARDING_STORAGE.SUGGESTED_INTEGRATIONS,
            JSON.stringify(body.suggested_integration_slugs ?? [])
          );
          sessionStorage.setItem(
            ONBOARDING_STORAGE.MENTIONS_CLAY,
            body.mentions_clay ? "1" : "0"
          );
          setOnboardingActive("3");
          addToast("success", "Execution plan ready", "Continue to Integrations, then Execute.");
          router.push("/onboarding");
        } else if (fromUploadPoll && body.session_id) {
          addToast("success", "Execution plan ready", "Review and approve when you are ready.");
          router.push(`/execute/${body.session_id}`);
        }
      } catch {
        addToast(
          "error",
          inFlow ? "Onboarding plan failed" : "Execution plan failed",
          inFlow ? "Network error — try again from Get started." : "Network error — try uploading again."
        );
        if (inFlow) {
          markKnowledgeSowReady();
          setOnboardingStep(3);
          router.push("/onboarding");
        }
      } finally {
        onboardingSeedInFlight.current = false;
      }
    },
    [activeClient, apiFetch, addToast, router]
  );

  /** If a doc is already ready (e.g. user returned after processing), retry seed so SESSION_ID can appear. */
  useEffect(() => {
    if (typeof window === "undefined" || !activeClient) return;
    if (!readOnboardingFlowActive()) return;
    if (readOnboardingStep() > 2) return;
    if (sessionStorage.getItem(ONBOARDING_STORAGE.SESSION_ID)) return;
    const ready = documents.filter((d) => d.status === "ready");
    if (ready.length === 0) return;
    const newest = [...ready].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )[0];
    void tryOnboardingSeedAfterDocReady(newest.id, false);
  }, [documents, activeClient, tryOnboardingSeedAfterDocReady]);

  const loadDocuments = useCallback(async () => {
    if (!activeClient) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ tenant_id: activeClient });
      if (selectedFolder !== null) params.set("folder", selectedFolder);
      const res = await apiFetch(`/api/knowledge/documents?${params}`);
      const data = await res.json();
      setDocuments(data.documents || []);
    } catch {
      /* ignore */
    }
    setLoading(false);
  }, [activeClient, selectedFolder, apiFetch]);

  const loadFolders = useCallback(async () => {
    if (!activeClient) return;
    try {
      const res = await apiFetch(
        `/api/knowledge/folders?tenant_id=${activeClient}`
      );
      if (!res.ok) return;
      const data = await res.json();
      setFolders(data.folders || []);
    } catch {
      // network error — leave folders as-is
    }
  }, [activeClient, apiFetch]);

  useEffect(() => {
    loadDocuments();
    loadFolders();
  }, [loadDocuments, loadFolders]);

  const [, setShowChunks] = useState(false);
  const [docDetail, setDocDetail] = useState<KnowledgeDoc | null>(null);
  const [detailTab, setDetailTab] = useState<"markdown" | "chunks">("markdown");

  const loadDocDetail = useCallback(
    async (docId: string) => {
      try {
        const res = await apiFetch(
          `/api/knowledge/documents/${docId}?tenant_id=${activeClient}`
        );
        if (!res.ok) return;
        const data = await res.json();
        setDocDetail(data);
      } catch {
        setDocDetail(null);
      }
    },
    [apiFetch, activeClient]
  );

  const loadChunks = useCallback(
    async (docId: string) => {
      try {
        const res = await apiFetch(
          `/api/knowledge/documents/${docId}/chunks`
        );
        if (!res.ok) return;
        const data = await res.json();
        setChunks(data.chunks || []);
      } catch {
        setChunks([]);
      }
    },
    [apiFetch]
  );

  const handleSelectDoc = (doc: KnowledgeDoc) => {
    setSelectedDoc(doc);
    setDocDetail(null);
    setDetailTab("markdown");
    setShowChunks(false);
    loadDocDetail(doc.id);
    loadChunks(doc.id);
  };

  const handleDownloadOriginal = useCallback(
    async (docId: string, filename: string) => {
      try {
        const res = await apiFetch(`/api/knowledge/documents/${docId}/raw`);
        if (!res.ok) {
          addToast("error", "Download failed", "Original file not available");
          return;
        }
        const data = await res.json();
        const byteChars = atob(data.raw_content);
        const byteArray = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) {
          byteArray[i] = byteChars.charCodeAt(i);
        }
        const blob = new Blob([byteArray], { type: data.mime_type || "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      } catch {
        addToast("error", "Download failed");
      }
    },
    [apiFetch, addToast]
  );

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (docId: string) => {
      stopPolling();
      setTrackingDocId(docId);
      setProcessingProgress(null);

      const poll = async () => {
        try {
          const res = await apiFetch(`/api/knowledge/documents/${docId}/progress`);
          if (!res.ok) return;
          const data: ProcessingProgress = await res.json();
          setProcessingProgress(data);

          const c = data.children;
          const allDone = c.total > 0 && c.ready + c.errors === c.total;
          const parentDone = data.parent_status === "ready" || data.parent_status === "error";

          if (parentDone && (c.total === 0 || allDone)) {
            if (data.parent_status === "ready") {
              if (readOnboardingFlowActive()) {
                markKnowledgeSowReady();
              }
              void tryOnboardingSeedAfterDocReady(docId, true);
            }
            stopPolling();
            loadDocuments();
            loadFolders();
          }
        } catch {
          // ignore transient polling errors
        }
      };

      poll();
      pollRef.current = setInterval(poll, 2000);
    },
    [apiFetch, stopPolling, loadDocuments, loadFolders, tryOnboardingSeedAfterDocReady]
  );

  useEffect(() => () => stopPolling(), [stopPolling]);

  const handleUploadFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !activeClient) return;

      const path = uploadPath
        ? `${uploadPath.replace(/\/$/, "")}/${file.name}`
        : file.name;

      setUploading(true);
      setUploadProgress(0);

      const formData = new FormData();
      formData.append("tenant_id", activeClient);
      formData.append("source_path", path);
      formData.append("mime_type", file.type || "application/octet-stream");
      formData.append("file", file);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/knowledge/upload");
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);

      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) {
          setUploadProgress(Math.round((ev.loaded / ev.total) * 100));
        }
      };

      xhr.onload = () => {
        setUploading(false);
        setUploadProgress(null);
        if (fileInputRef.current) fileInputRef.current.value = "";

        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const resp = JSON.parse(xhr.responseText);
            loadDocuments();
            loadFolders();
            if (resp.id) startPolling(resp.id);
          } catch {
            loadDocuments();
            loadFolders();
          }
        } else {
          try {
            const err = JSON.parse(xhr.responseText);
            addToast("error", "Upload failed", err.error || `Server responded with ${xhr.status}`);
          } catch {
            addToast("error", "Upload failed", `Server responded with ${xhr.status}`);
          }
        }
      };

      xhr.onerror = () => {
        setUploading(false);
        setUploadProgress(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
        addToast("error", "Upload failed", "Network error — check your connection and try again.");
      };

      xhr.send(formData);
    },
    [activeClient, uploadPath, token, loadDocuments, loadFolders, startPolling, addToast]
  );

  const _handleUploadText = async () => {
    if (!activeClient || !uploadPath || !uploadContent) return;
    setUploading(true);
    try {
      await apiFetch("/api/knowledge/documents", {
        method: "POST",
        body: JSON.stringify({
          tenant_id: activeClient,
          source_path: uploadPath,
          content: uploadContent,
          mime_type: "text/markdown",
        }),
      });
      setUploadContent("");
      setUploadPath("");
      loadDocuments();
      loadFolders();
    } catch {
      /* ignore */
    }
    setUploading(false);
  };

  const handleDelete = async (docId: string) => {
    try {
      const res = await apiFetch(`/api/knowledge/documents/${docId}?tenant_id=${activeClient}`, {
        method: "DELETE",
      });
      if (!res.ok) return;
      if (selectedDoc?.id === docId) {
        setSelectedDoc(null);
        setChunks([]);
      }
      loadDocuments();
      loadFolders();
    } catch {
      // network error
    }
  };

  const handleDeleteFolder = async (folderPath: string) => {
    if (!activeClient) return;
    if (!confirm(`Delete all files in "${folderPath || "/"}"? This cannot be undone.`)) return;
    try {
      const res = await apiFetch("/api/knowledge/folders/delete", {
        method: "POST",
        body: JSON.stringify({ tenant_id: activeClient, folder: folderPath }),
      });
      if (res.ok) {
        const data = await res.json();
        addToast("success", `Deleted ${data.deleted} files`, `Folder "${folderPath || "/"}" removed.`);
        setSelectedDoc(null);
        setChunks([]);
        loadDocuments();
        loadFolders();
      } else {
        const err = await res.json().catch(() => ({ error: "Delete failed" }));
        addToast("error", "Delete failed", err.error);
      }
    } catch {
      addToast("error", "Delete failed", "Network error");
    }
  };

  const handleSearch = async () => {
    if (!activeClient || !searchQuery.trim()) return;
    setSearching(true);
    try {
      const res = await apiFetch("/api/knowledge/search", {
        method: "POST",
        body: JSON.stringify({
          query: searchQuery,
          tenant_id: activeClient,
          limit: 5,
        }),
      });
      const data = await res.json();
      setSearchResults(data.results || []);
    } catch {
      setSearchResults([]);
    }
    setSearching(false);
  };

  const tree = buildTree(folders);

  if (!activeClient) {
    return (
      <div className="p-8 text-ink-2 text-sm">
        Select a workspace to manage knowledge.
      </div>
    );
  }

  return (
    <>
    <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    <div className="flex flex-col h-[calc(100vh-57px)]">
      {/* Top tab bar */}
      <div className="flex items-center gap-1 px-4 border-b border-rim bg-page shrink-0">
        <button
          onClick={() => setActiveTab("corpus")}
          className={clsx(
            "flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
            activeTab === "corpus"
              ? "border-brand text-brand"
              : "border-transparent text-ink-3 hover:text-ink-2"
          )}
        >
          <BookOpen className="w-3.5 h-3.5" />
          Corpus
        </button>
        <button
          onClick={() => setActiveTab("learnings")}
          className={clsx(
            "flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
            activeTab === "learnings"
              ? "border-brand text-brand"
              : "border-transparent text-ink-3 hover:text-ink-2"
          )}
        >
          <Brain className="w-3.5 h-3.5" />
          Learnings
        </button>
      </div>

      {activeTab === "learnings" ? (
        <div className="flex-1 overflow-hidden">
          <LearningsTab activeClient={activeClient} apiFetch={apiFetch} addToast={addToast} />
        </div>
      ) : (
      <div className="flex flex-1 overflow-hidden">
      {/* Sidebar: folder tree */}
      <div className="w-64 border-r border-rim bg-page overflow-y-auto shrink-0">
        <div className="p-3 border-b border-rim">
          <h3 className="text-xs font-semibold text-ink-3 uppercase tracking-wider">
            Knowledge Corpus
          </h3>
        </div>
        <div className="p-2">
          <button
            onClick={() => setSelectedFolder(null)}
            className={clsx(
              "w-full flex items-center gap-1 px-2 py-1 text-sm rounded hover:bg-surface transition-colors",
              selectedFolder === null && "bg-brand-subtle text-brand"
            )}
          >
            <FolderOpen className="w-3.5 h-3.5" />
            All files
            <span className="ml-auto text-xs text-ink-3">
              {documents.length}
            </span>
          </button>
          {tree.map((node) => (
            <FolderNode
              key={node.path}
              node={node}
              selectedFolder={selectedFolder}
              onSelect={setSelectedFolder}
              onDelete={handleDeleteFolder}
              depth={0}
            />
          ))}
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Upload bar */}
        <div className="border-b border-rim">
          <div className="p-3 flex items-center gap-3">
            <input
              type="text"
              placeholder="Path (e.g. client/heyreach/brief.md)"
              value={uploadPath}
              onChange={(e) => setUploadPath(e.target.value)}
              className="flex-1 text-sm px-3 py-1.5 border border-rim rounded bg-surface text-ink placeholder:text-ink-3"
            />
            <label
              className={clsx(
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm border transition-colors cursor-pointer",
                uploading
                  ? "opacity-50 cursor-wait"
                  : "border-brand text-brand hover:bg-brand-subtle"
              )}
            >
              {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
              Upload file
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.txt,.pdf,.docx,.pptx,.xlsx,.csv,.zip,.json,.html,.xml,.yaml,.yml"
                className="hidden"
                onChange={handleUploadFile}
                disabled={uploading}
              />
            </label>

            <div className="border-l border-rim h-6" />

            <div className="flex items-center gap-1.5">
              <input
                type="text"
                placeholder="Search knowledge..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                className="text-sm px-3 py-1.5 border border-rim rounded bg-surface text-ink placeholder:text-ink-3 w-56"
              />
              <button
                onClick={handleSearch}
                disabled={searching}
                className="p-1.5 rounded border border-rim hover:bg-surface transition-colors"
              >
                {searching ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Search className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>
          {uploading && uploadProgress !== null && (
            <div className="px-3 py-2 bg-surface border-t border-rim flex items-center gap-3 text-sm">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-brand shrink-0" />
              <span className="text-ink-2">
                Uploading &mdash; <span className="font-medium text-ink tabular-nums">{uploadProgress}%</span>
              </span>
              <div className="flex-1 max-w-xs h-1.5 rounded-full bg-rim overflow-hidden">
                <div
                  className="h-full bg-brand transition-all duration-300 ease-out rounded-full"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            </div>
          )}
          {!uploading && processingProgress && trackingDocId && (
            <IngestionTracker
              progress={processingProgress}
              onDismiss={() => { setTrackingDocId(null); setProcessingProgress(null); stopPolling(); }}
            />
          )}
        </div>

        {/* Content area */}
        <div className="flex-1 flex overflow-hidden">
          {/* File list */}
          <div className="w-96 border-r border-rim overflow-y-auto shrink-0">
            {loading ? (
              <div className="p-4 text-ink-3 text-sm flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading...
              </div>
            ) : documents.length === 0 ? (
              <div className="p-4 text-ink-3 text-sm">
                No documents yet. Upload files to get started.
              </div>
            ) : (
              documents.map((doc) => (
                <button
                  key={doc.id}
                  onClick={() => handleSelectDoc(doc)}
                  className={clsx(
                    "w-full text-left p-3 border-b border-rim hover:bg-surface transition-colors",
                    selectedDoc?.id === doc.id && "bg-brand-subtle"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4 shrink-0 text-ink-3" />
                    <span className="text-sm font-medium truncate flex-1">
                      {doc.source_filename}
                    </span>
                    <StatusBadge status={doc.status} />
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-3">
                    <span className="truncate">{doc.source_path}</span>
                    <ScopeBadge scope={doc.inferred_scope} />
                    {doc.chunk_count > 0 && (
                      <span>{doc.chunk_count} chunks</span>
                    )}
                  </div>
                </button>
              ))
            )}
          </div>

          {/* Detail panel */}
          <div className="flex-1 overflow-y-auto p-4">
            {searchResults.length > 0 ? (
              <div>
                <h3 className="text-sm font-semibold mb-3">
                  Search Results
                </h3>
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {searchResults.map((r: any, i: number) => (
                  <div
                    key={i}
                    className="mb-3 p-3 border border-rim rounded-lg bg-surface"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-ink-2">
                        {r.source_path || r.source_filename}
                      </span>
                      {r.section_title && (
                        <span className="text-xs text-ink-3">
                          {r.section_title}
                        </span>
                      )}
                      <span className="text-xs text-ink-3 ml-auto">
                        {(Number(r.similarity) * 100).toFixed(1)}%
                      </span>
                    </div>
                    <p className="text-sm text-ink whitespace-pre-wrap">
                      {r.content}
                    </p>
                  </div>
                ))}
                <button
                  onClick={() => setSearchResults([])}
                  className="text-xs text-ink-3 hover:text-ink-2 mt-2"
                >
                  Clear results
                </button>
              </div>
            ) : selectedDoc ? (
              <div className="flex flex-col h-full">
                {/* Header */}
                <div className="flex items-start justify-between mb-3 shrink-0">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-lg font-semibold truncate">
                      {selectedDoc.source_filename}
                    </h3>
                    <p className="text-sm text-ink-2 mt-0.5 truncate">
                      {selectedDoc.source_path}
                    </p>
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      <StatusBadge status={selectedDoc.status} />
                      <ScopeBadge scope={selectedDoc.inferred_scope} />
                      <span className="text-xs text-ink-3">
                        {selectedDoc.chunk_count} chunks
                      </span>
                      <span className="text-xs text-ink-3">
                        {new Date(selectedDoc.created_at).toLocaleDateString()}
                      </span>
                    </div>
                    {selectedDoc.error_message && (
                      <p className="mt-2 text-sm text-red-600">
                        {selectedDoc.error_message}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 ml-3 shrink-0">
                    {docDetail?.has_raw_content && (
                      <button
                        onClick={() => handleDownloadOriginal(selectedDoc.id, selectedDoc.source_filename)}
                        className="p-1.5 rounded border border-rim text-ink-3 hover:text-blue-600 hover:border-blue-300 transition-colors"
                        title="Download original file"
                      >
                        <Download className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(selectedDoc.id)}
                      className="p-1.5 rounded border border-rim text-ink-3 hover:text-red-600 hover:border-red-300 transition-colors"
                      title="Delete document"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Tab bar */}
                <div className="flex items-center gap-1 mb-3 border-b border-rim shrink-0">
                  <button
                    onClick={() => setDetailTab("markdown")}
                    className={clsx(
                      "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors",
                      detailTab === "markdown"
                        ? "border-brand text-brand"
                        : "border-transparent text-ink-3 hover:text-ink-2"
                    )}
                  >
                    <Eye className="w-3.5 h-3.5" />
                    Markdown
                  </button>
                  <button
                    onClick={() => setDetailTab("chunks")}
                    className={clsx(
                      "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors",
                      detailTab === "chunks"
                        ? "border-brand text-brand"
                        : "border-transparent text-ink-3 hover:text-ink-2"
                    )}
                  >
                    <List className="w-3.5 h-3.5" />
                    Chunks ({chunks.length})
                  </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto min-h-0">
                  {detailTab === "markdown" ? (
                    docDetail?.normalized_markdown ? (
                      <article className="prose prose-sm max-w-none text-ink prose-headings:text-ink prose-p:text-ink prose-li:text-ink prose-strong:text-ink prose-code:text-ink-2 prose-code:bg-surface prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-pre:bg-surface prose-pre:border prose-pre:border-rim">
                        <ReactMarkdown>{docDetail.normalized_markdown}</ReactMarkdown>
                      </article>
                    ) : (
                      <div className="flex flex-col items-center justify-center py-12 text-ink-3">
                        <FileText className="w-8 h-8 mb-2 opacity-30" />
                        <p className="text-sm">
                          {selectedDoc.status === "pending" || selectedDoc.status === "processing"
                            ? "Document is still being processed..."
                            : "No markdown content available"}
                        </p>
                      </div>
                    )
                  ) : (
                    chunks.length > 0 ? (
                      <div className="space-y-2">
                        {chunks.map((chunk) => (
                          <div
                            key={chunk.id}
                            className="p-3 border border-rim rounded bg-surface"
                          >
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-xs text-ink-3 font-mono">
                                #{chunk.chunk_index}
                              </span>
                              {chunk.section_title && (
                                <span className="text-xs text-ink-2 font-medium">
                                  {chunk.section_title}
                                </span>
                              )}
                              {chunk.token_count && (
                                <span className="text-xs text-ink-3 ml-auto">
                                  ~{chunk.token_count} tokens
                                </span>
                              )}
                            </div>
                            <p className="text-sm text-ink whitespace-pre-wrap line-clamp-4">
                              {chunk.content}
                            </p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-ink-3 text-center py-8">No chunks</p>
                    )
                  )}
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-ink-3">
                <FileText className="w-10 h-10 mb-3 opacity-30" />
                <p className="text-sm">
                  Select a document or search your knowledge corpus
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
      </div>
      )}
    </div>
    </>
  );
}
