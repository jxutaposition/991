"use client";
import { useEffect, useState, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import Link from "next/link";
import {
  ChevronDown,
  ChevronRight,
  ArrowLeft,
  ArrowRight,
  Plus,
  Minus,
  Layers,
  Wrench,
  FileText,
  BookOpen,
  FlaskConical,
  ClipboardCheck,
  GitPullRequest,
  Lock,
  Unlock,
  Copy,
  Check,
  Brain,
  CheckCircle2,
} from "lucide-react";
import { IntegrationIcon } from "@/components/integration-icon";
import { PR_STATUS_BADGE, PR_TYPE_BADGE } from "@/lib/tokens";

// ── Types ────────────────────────────────────────────────────────────────────

interface ToolDetail {
  name: string;
  credential: string | null;
  display_name: string;
  icon: string;
}

interface JudgeConfig {
  threshold: number;
  rubric: string[];
  need_to_know: string[];
}

interface AgentExample {
  index: number;
  input: Record<string, unknown>;
  output: string;
}

interface KnowledgeDoc {
  index: number;
  preview: string;
  full: string;
  char_count: number;
}

interface CurrentAgent {
  slug: string;
  name: string;
  category: string;
  description: string;
  intents: string[];
  tools: ToolDetail[];
  required_integrations: string[];
  judge_config: JudgeConfig;
  max_iterations: number;
  model: string | null;
  skip_judge: boolean;
  flexible_tool_use: boolean;
  system_prompt: string;
  examples: AgentExample[];
  knowledge_docs: KnowledgeDoc[];
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  version: number;
}

interface FileDiff {
  file_path: string;
  old_content: string | null;
  new_content: string;
}

interface AgentPRDetail {
  id: string;
  pr_type: string;
  target_agent_slug: string | null;
  proposed_slug: string | null;
  file_diffs: FileDiff[];
  proposed_changes: Record<string, unknown> | null;
  reasoning: string;
  gap_summary: string;
  confidence: number;
  evidence_count: number;
  status: string;
  created_at: string;
  current_agent: CurrentAgent | null;
}

// ── Tab definitions ─────────────────────────────────────────────────────────

type Tab =
  | "changes"
  | "overview"
  | "tools"
  | "prompt"
  | "knowledge"
  | "examples"
  | "rubric";

const TAB_CONFIG: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: "changes", label: "Changes", icon: GitPullRequest },
  { id: "overview", label: "Overview", icon: Layers },
  { id: "tools", label: "Tools", icon: Wrench },
  { id: "prompt", label: "Prompt", icon: FileText },
  { id: "knowledge", label: "Knowledge", icon: BookOpen },
  { id: "examples", label: "Examples", icon: FlaskConical },
  { id: "rubric", label: "Rubric", icon: ClipboardCheck },
];

// ── Unified diff computation (LCS) ──────────────────────────────────────────

interface DiffLine {
  type: "same" | "added" | "removed";
  oldNum: number | null;
  newNum: number | null;
  text: string;
}

function computeUnifiedDiff(
  oldText: string | null,
  newText: string
): DiffLine[] {
  if (!oldText) {
    return newText.split("\n").map((line, i) => ({
      type: "added" as const,
      oldNum: null,
      newNum: i + 1,
      text: line,
    }));
  }

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const m = oldLines.length;
  const n = newLines.length;

  const dp: number[][] = [];
  for (let i = 0; i <= m; i++) {
    dp[i] = new Array(n + 1).fill(0);
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const stack: DiffLine[] = [];
  let i = m,
    j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      stack.push({
        type: "same",
        oldNum: i,
        newNum: j,
        text: oldLines[i - 1],
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({
        type: "added",
        oldNum: null,
        newNum: j,
        text: newLines[j - 1],
      });
      j--;
    } else {
      stack.push({
        type: "removed",
        oldNum: i,
        newNum: null,
        text: oldLines[i - 1],
      });
      i--;
    }
  }

  stack.reverse();
  return stack;
}

// ── Diff table renderer (GitHub-style) ──────────────────────────────────────

function DiffTable({
  lines,
  maxHeight,
}: {
  lines: DiffLine[];
  maxHeight?: string;
}) {
  return (
    <div className={`overflow-auto ${maxHeight ?? "max-h-[600px]"}`}>
      <table className="w-full text-xs font-mono border-collapse">
        <tbody>
          {lines.map((line, idx) => (
            <tr
              key={idx}
              className={
                line.type === "added"
                  ? "bg-green-50 dark:bg-green-950/30"
                  : line.type === "removed"
                    ? "bg-red-50 dark:bg-red-950/30"
                    : ""
              }
            >
              <td className="text-ink-3 text-right px-2 py-0 select-none w-10 border-r border-rim align-top opacity-50">
                {line.oldNum ?? ""}
              </td>
              <td className="text-ink-3 text-right px-2 py-0 select-none w-10 border-r border-rim align-top opacity-50">
                {line.newNum ?? ""}
              </td>
              <td
                className={`px-1 py-0 select-none w-4 text-center align-top ${
                  line.type === "added"
                    ? "text-green-600"
                    : line.type === "removed"
                      ? "text-red-500"
                      : "text-ink-3"
                }`}
              >
                {line.type === "added"
                  ? "+"
                  : line.type === "removed"
                    ? "-"
                    : " "}
              </td>
              <td className="px-2 py-0 whitespace-pre-wrap break-all">
                <span
                  className={
                    line.type === "added"
                      ? "text-green-800 dark:text-green-300"
                      : line.type === "removed"
                        ? "text-red-700 dark:text-red-300"
                        : "text-ink-2"
                  }
                >
                  {line.text || "\u00A0"}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── File diff block (GitHub-style header + diff table) ──────────────────────

function FileDiffBlock({
  label,
  oldText,
  newText,
  defaultOpen,
}: {
  label: string;
  oldText: string | null;
  newText: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? true);
  const lines = useMemo(
    () => computeUnifiedDiff(oldText, newText),
    [oldText, newText]
  );
  const addedCount = lines.filter((l) => l.type === "added").length;
  const removedCount = lines.filter((l) => l.type === "removed").length;
  const isNew = oldText === null;
  const Icon = open ? ChevronDown : ChevronRight;

  return (
    <div className="border border-rim rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full bg-surface px-4 py-2.5 border-b border-rim flex items-center gap-2 text-left hover:bg-surface/80 transition-colors"
      >
        <Icon className="w-3.5 h-3.5 text-ink-3 shrink-0" />
        <span className="text-xs font-medium font-mono text-ink flex-1">
          {label}
        </span>
        <span
          className={`text-xs font-medium px-1.5 py-0.5 rounded-full ${
            isNew
              ? "bg-green-100 text-green-700"
              : "bg-blue-100 text-blue-700"
          }`}
        >
          {isNew ? "new" : "modified"}
        </span>
        <div className="flex items-center gap-2 text-xs ml-2">
          {addedCount > 0 && (
            <span className="text-green-600 font-medium">+{addedCount}</span>
          )}
          {removedCount > 0 && (
            <span className="text-red-500 font-medium">-{removedCount}</span>
          )}
        </div>
      </button>
      {open && <DiffTable lines={lines} />}
    </div>
  );
}

// ── Scalar field diff (before -> after) ─────────────────────────────────────

function FieldDiff({
  label,
  oldVal,
  newVal,
}: {
  label: string;
  oldVal: string | number | boolean | null;
  newVal: string | number | boolean | null;
}) {
  const oldStr = oldVal == null ? "" : String(oldVal);
  const newStr = newVal == null ? "" : String(newVal);
  if (oldStr === newStr) return null;
  const isNew = oldVal == null || oldStr === "";

  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="text-ink-3 w-32 shrink-0 text-xs font-medium pt-0.5">
        {label}
      </span>
      {isNew ? (
        <span className="bg-green-100 dark:bg-green-950/40 text-green-800 dark:text-green-300 px-2 py-0.5 rounded text-xs font-mono">
          + {newStr}
        </span>
      ) : (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-300 px-2 py-0.5 rounded text-xs font-mono line-through">
            {oldStr}
          </span>
          <ArrowRight className="w-3 h-3 text-ink-3 shrink-0" />
          <span className="bg-green-100 dark:bg-green-950/40 text-green-800 dark:text-green-300 px-2 py-0.5 rounded text-xs font-mono">
            {newStr}
          </span>
        </div>
      )}
    </div>
  );
}

// ── List diff (array items added/removed) ───────────────────────────────────

function ListDiff({
  label,
  oldItems,
  newItems,
}: {
  label: string;
  oldItems: string[];
  newItems: string[];
}) {
  const oldSet = new Set(oldItems);
  const newSet = new Set(newItems);
  const added = newItems.filter((x) => !oldSet.has(x));
  const removed = oldItems.filter((x) => !newSet.has(x));
  const kept = oldItems.filter((x) => newSet.has(x));

  if (added.length === 0 && removed.length === 0) return null;

  return (
    <div className="border border-rim rounded-xl overflow-hidden">
      <div className="bg-surface px-4 py-2 border-b border-rim flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-ink-2">{label}</span>
          <span className="text-xs font-medium px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700">
            modified
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {added.length > 0 && (
            <span className="text-green-600">+{added.length}</span>
          )}
          {removed.length > 0 && (
            <span className="text-red-500">-{removed.length}</span>
          )}
        </div>
      </div>
      <div className="px-4 py-3 space-y-1.5">
        {removed.map((item) => (
          <div
            key={`r-${item}`}
            className="flex items-start gap-2 bg-red-50 dark:bg-red-950/30 rounded px-2 py-1"
          >
            <Minus className="w-3.5 h-3.5 text-red-500 mt-0.5 shrink-0" />
            <span className="text-xs text-red-700 dark:text-red-300">
              {item}
            </span>
          </div>
        ))}
        {kept.map((item) => (
          <div
            key={`k-${item}`}
            className="flex items-start gap-2 rounded px-2 py-1"
          >
            <span className="w-3.5 shrink-0" />
            <span className="text-xs text-ink-3">{item}</span>
          </div>
        ))}
        {added.map((item) => (
          <div
            key={`a-${item}`}
            className="flex items-start gap-2 bg-green-50 dark:bg-green-950/30 rounded px-2 py-1"
          >
            <Plus className="w-3.5 h-3.5 text-green-600 mt-0.5 shrink-0" />
            <span className="text-xs text-green-800 dark:text-green-300">
              {item}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="text-ink-3 hover:text-ink-2 transition-colors p-1 rounded"
      title="Copy to clipboard"
    >
      {copied ? (
        <Check className="w-3.5 h-3.5 text-green-500" />
      ) : (
        <Copy className="w-3.5 h-3.5" />
      )}
    </button>
  );
}

function MetaChip({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div className="flex flex-col gap-0.5 bg-surface border border-rim rounded-lg px-3 py-2">
      <span className="text-xs font-medium text-ink-3 uppercase tracking-wider">
        {label}
      </span>
      <span className="text-sm font-semibold text-ink">{value}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`text-xs font-medium px-2 py-0.5 rounded-full ${PR_STATUS_BADGE[status] ?? "bg-surface text-ink-3"}`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

function proposed<T>(
  changes: Record<string, unknown> | null,
  key: string,
  current: T
): T {
  if (!changes || !(key in changes)) return current;
  return changes[key] as T;
}

function hasChange(
  changes: Record<string, unknown> | null,
  key: string
): boolean {
  return !!changes && key in changes;
}

function extractTitle(markdown: string): string | null {
  const firstLine = markdown.trimStart().split("\n")[0];
  const match = firstLine.match(/^#+\s+(.+)/);
  return match ? match[1].trim() : null;
}

// ── Main page ───────────────────────────────────────────────────────────────

export default function PRDetailPage() {
  const { pr_id } = useParams();
  const router = useRouter();
  const { apiFetch } = useAuth();
  const [pr, setPR] = useState<AgentPRDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [actioning, setActioning] = useState(false);
  const [tab, setTab] = useState<Tab>("changes");

  useEffect(() => {
    apiFetch(`/api/agent-prs/${pr_id}`)
      .then((r) => {
        if (!r.ok) throw new Error(r.statusText);
        return r.json();
      })
      .then((data) => {
        setPR(data);
        setLoading(false);
      })
      .catch((err) => { console.error("Failed to load PR:", err); setLoading(false); });
  }, [pr_id, apiFetch]);

  const action = async (act: "approve" | "reject") => {
    setActioning(true);
    try {
      const res = await apiFetch(`/api/agent-prs/${pr_id}/${act}`, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      router.push("/agent-prs");
    } catch (e) {
      console.error(`Failed to ${act} PR:`, e);
      setActioning(false);
    }
  };

  // Determine which sections have changes
  const changes = pr?.proposed_changes ?? null;
  const agent = pr?.current_agent ?? null;
  const isNewAgent = pr?.pr_type === "new_agent";

  const changedTabs = useMemo(() => {
    const set = new Set<Tab>();
    if (!changes) return set;
    if (
      hasChange(changes, "name") ||
      hasChange(changes, "category") ||
      hasChange(changes, "description") ||
      hasChange(changes, "intents")
    )
      set.add("overview");
    if (hasChange(changes, "system_prompt")) set.add("prompt");
    if (
      hasChange(changes, "judge_config") ||
      hasChange(changes, "rubric") ||
      hasChange(changes, "need_to_know")
    )
      set.add("rubric");
    if (hasChange(changes, "examples")) set.add("examples");
    if (isNewAgent) {
      set.add("overview");
      set.add("prompt");
      set.add("rubric");
      set.add("examples");
    }
    return set;
  }, [changes, isNewAgent]);

  const tabCounts = useMemo(() => {
    if (!agent) return {};
    return {
      tools: agent.tools.length,
      knowledge: agent.knowledge_docs.length,
      examples: agent.examples.length,
      rubric: agent.judge_config.rubric.length,
    } as Record<string, number>;
  }, [agent]);

  if (loading)
    return <div className="p-8 text-ink-3 text-sm">Loading...</div>;
  if (!pr)
    return <div className="p-8 text-ink-3 text-sm">PR not found.</div>;

  const agentSlug =
    pr.target_agent_slug ?? pr.proposed_slug ?? "unknown";

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      {/* Back link */}
      <Link
        href="/agent-prs"
        className="text-ink-3 text-sm hover:text-ink-2 mb-4 inline-flex items-center gap-1"
      >
        <ArrowLeft className="w-3.5 h-3.5" /> Back to PRs
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded-full ${PR_TYPE_BADGE[pr.pr_type] ?? "bg-surface text-ink-2"}`}
            >
              {pr.pr_type.replace(/_/g, " ")}
            </span>
            <h1 className="text-xl font-bold text-ink">
              <span className="font-mono">{agentSlug}</span>
            </h1>
            <StatusBadge status={pr.status} />
          </div>
          <p className="text-ink-2 text-sm mt-1">{pr.gap_summary}</p>
          <div className="flex items-center gap-3 mt-2 text-xs text-ink-3">
            <span>
              {Math.round((pr.confidence ?? 0) * 100)}% confidence
            </span>
            <span>{"\u00B7"}</span>
            <span>{pr.evidence_count} evidence</span>
            <span>{"\u00B7"}</span>
            <span>{new Date(pr.created_at).toLocaleDateString()}</span>
            {!isNewAgent && agent && (
              <>
                <span>{"\u00B7"}</span>
                <span>current v{agent.version}</span>
              </>
            )}
            {changedTabs.size > 0 && (
              <>
                <span>{"\u00B7"}</span>
                <span className="text-blue-600">
                  {changedTabs.size} section
                  {changedTabs.size !== 1 ? "s" : ""} changed
                </span>
              </>
            )}
          </div>
        </div>
        {pr.status === "open" && (
          <div className="flex gap-2 shrink-0 ml-4">
            <button
              onClick={() => action("reject")}
              disabled={actioning}
              className="border border-rim text-ink-2 px-3 py-1.5 rounded-lg text-sm hover:border-rim-strong disabled:opacity-50"
            >
              Reject
            </button>
            <button
              onClick={() => action("approve")}
              disabled={actioning}
              className="bg-green-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-green-700 disabled:opacity-50"
            >
              Approve & Merge
            </button>
          </div>
        )}
      </div>

      {/* Analysis */}
      <div className="bg-surface rounded-xl p-4 border border-rim mb-6">
        <h3 className="text-xs font-medium text-ink-3 uppercase tracking-wider mb-3">
          Analysis
        </h3>
        <p className="text-sm text-ink-2 leading-relaxed whitespace-pre-wrap">
          {pr.reasoning}
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-0.5 mb-6 border-b border-rim overflow-x-auto scrollbar-hide">
        {TAB_CONFIG.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px whitespace-nowrap ${
              tab === id
                ? "border-brand text-ink"
                : "border-transparent text-ink-3 hover:text-ink-2"
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
            {changedTabs.has(id) && (
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
            )}
            {tabCounts[id] != null && tabCounts[id] > 0 && (
              <span className="text-xs bg-surface text-ink-3 px-1.5 py-0.5 rounded-full ml-0.5">
                {tabCounts[id]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "changes" && (
        <ChangesTab
          pr={pr}
          agent={agent}
          changes={changes}
          isNewAgent={isNewAgent}
        />
      )}
      {tab === "overview" && (
        <OverviewTab
          pr={pr}
          agent={agent}
          changes={changes}
          isNewAgent={isNewAgent}
        />
      )}
      {tab === "tools" && <ToolsTab agent={agent} isNewAgent={isNewAgent} changes={changes} />}
      {tab === "prompt" && (
        <PromptTab
          agent={agent}
          changes={changes}
          isNewAgent={isNewAgent}
        />
      )}
      {tab === "knowledge" && <KnowledgeTab agent={agent} isNewAgent={isNewAgent} changes={changes} />}
      {tab === "examples" && (
        <ExamplesTab
          agent={agent}
          changes={changes}
          isNewAgent={isNewAgent}
        />
      )}
      {tab === "rubric" && (
        <RubricTab
          agent={agent}
          changes={changes}
          isNewAgent={isNewAgent}
        />
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: Changes — GitHub-style diff summary of everything that changed
// ══════════════════════════════════════════════════════════════════════════════

function ChangesTab({
  pr,
  agent,
  changes,
  isNewAgent,
}: {
  pr: AgentPRDetail;
  agent: CurrentAgent | null;
  changes: Record<string, unknown> | null;
  isNewAgent: boolean;
}) {
  // Collect all the diff blocks
  const diffs = useMemo(() => {
  const diffs: {
    label: string;
    oldText: string | null;
    newText: string;
  }[] = [];

  // Metadata fields as a mini "file"
  const metaFields = ["name", "category", "description"] as const;
  const metaChanged = metaFields.some((k) => hasChange(changes, k));
  if (metaChanged || isNewAgent) {
    const oldLines = isNewAgent
      ? null
      : metaFields
          .map(
            (k) =>
              `${k}: ${agent?.[k] ?? ""}`
          )
          .join("\n");
    const newLines = metaFields
      .map(
        (k) =>
          `${k}: ${proposed(changes, k, agent?.[k] ?? "")}`
      )
      .join("\n");
    diffs.push({
      label: "agent.toml — metadata",
      oldText: oldLines,
      newText: newLines,
    });
  }

  // Intents
  if (hasChange(changes, "intents") || isNewAgent) {
    const oldIntents = isNewAgent ? null : (agent?.intents ?? []).join("\n");
    const newIntents = (
      proposed(changes, "intents", agent?.intents ?? []) as string[]
    ).join("\n");
    if (oldIntents !== newIntents) {
      diffs.push({
        label: "agent.toml — intents",
        oldText: oldIntents,
        newText: newIntents,
      });
    }
  }

  // System prompt
  if (hasChange(changes, "system_prompt") || isNewAgent) {
    diffs.push({
      label: "prompt.md",
      oldText: isNewAgent ? null : (agent?.system_prompt ?? null),
      newText: proposed(
        changes,
        "system_prompt",
        agent?.system_prompt ?? ""
      ) as string,
    });
  }

  // Judge config
  if (hasChange(changes, "judge_config") || isNewAgent) {
    const oldJc = isNewAgent ? null : agent?.judge_config;
    const newJc = proposed(
      changes,
      "judge_config",
      agent?.judge_config ?? { threshold: 7, rubric: [], need_to_know: [] }
    ) as JudgeConfig;
    const fmtJc = (jc: JudgeConfig) =>
      [
        `threshold = ${jc.threshold}`,
        "",
        "rubric = [",
        ...jc.rubric.map((r) => `  "${r}",`),
        "]",
        "",
        "need_to_know = [",
        ...jc.need_to_know.map((n) => `  "${n}",`),
        "]",
      ].join("\n");
    diffs.push({
      label: "agent.toml — judge_config",
      oldText: oldJc ? fmtJc(oldJc) : null,
      newText: fmtJc(newJc),
    });
  }

  // Examples
  if (hasChange(changes, "examples") || isNewAgent) {
    const oldExamples = isNewAgent ? [] : (agent?.examples ?? []);
    const newExamples = proposed(
      changes,
      "examples",
      agent?.examples ?? []
    ) as AgentExample[];
    const fmtEx = (exs: AgentExample[]) =>
      exs
        .map(
          (ex, i) =>
            `--- Example ${i + 1} ---\nInput:\n${JSON.stringify(ex.input, null, 2)}\n\nOutput:\n${typeof ex.output === "string" ? ex.output : JSON.stringify(ex.output, null, 2)}`
        )
        .join("\n\n");
    const oldText = oldExamples.length > 0 ? fmtEx(oldExamples) : null;
    const newText = fmtEx(newExamples);
    if (oldText !== newText && newText) {
      diffs.push({
        label: "examples/",
        oldText,
        newText,
      });
    }
  }

  // File diffs from PR (backend-generated actual file diffs)
  if (pr.file_diffs && pr.file_diffs.length > 0) {
    for (const fd of pr.file_diffs) {
      // Avoid duplicating if we already rendered from proposed_changes
      const alreadyCovered = diffs.some((d) =>
        fd.file_path.includes("prompt") ? d.label === "prompt.md" : false
      );
      if (!alreadyCovered) {
        diffs.push({
          label: fd.file_path,
          oldText: fd.old_content,
          newText: fd.new_content,
        });
      }
    }
  }

  return diffs;
  }, [pr, agent, changes, isNewAgent]);

  // Summary bar — compute diffs once and derive both counts
  const { totalAdded, totalRemoved } = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const d of diffs) {
      const lines = computeUnifiedDiff(d.oldText, d.newText);
      for (const l of lines) {
        if (l.type === "added") added++;
        else if (l.type === "removed") removed++;
      }
    }
    return { totalAdded: added, totalRemoved: removed };
  }, [diffs]);

  if (diffs.length === 0) {
    return (
      <div className="text-center py-16 text-ink-3">
        <p className="text-3xl mb-3">{"\u2713"}</p>
        <p className="text-sm">No changes detected in this PR.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      <div className="flex items-center gap-4 text-xs text-ink-3 mb-2">
        <span>
          {diffs.length} file{diffs.length !== 1 ? "s" : ""} changed
        </span>
        {totalAdded > 0 && (
          <span className="text-green-600 font-medium">
            +{totalAdded} additions
          </span>
        )}
        {totalRemoved > 0 && (
          <span className="text-red-500 font-medium">
            -{totalRemoved} deletions
          </span>
        )}
      </div>

      {/* Each diff block */}
      {diffs.map((d, i) => (
        <FileDiffBlock
          key={i}
          label={d.label}
          oldText={d.oldText}
          newText={d.newText}
          defaultOpen={diffs.length <= 4}
        />
      ))}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: Overview — full agent profile with inline diffs on changed fields
// ══════════════════════════════════════════════════════════════════════════════

function OverviewTab({
  pr,
  agent,
  changes,
  isNewAgent,
}: {
  pr: AgentPRDetail;
  agent: CurrentAgent | null;
  changes: Record<string, unknown> | null;
  isNewAgent: boolean;
}) {
  const agentSlug =
    pr.target_agent_slug ?? pr.proposed_slug ?? "unknown";

  const resolvedName = proposed(changes, "name", agent?.name ?? "") as string;
  const resolvedCategory = proposed(
    changes,
    "category",
    agent?.category ?? ""
  ) as string;
  const resolvedDesc = proposed(
    changes,
    "description",
    agent?.description ?? ""
  ) as string;
  const resolvedIntents = proposed(
    changes,
    "intents",
    agent?.intents ?? []
  ) as string[];

  return (
    <div className="space-y-6">
      {/* Agent identity */}
      <div>
        <div className="flex items-center gap-3 mb-2">
          <h2 className="text-lg font-bold text-ink">{resolvedName || agentSlug}</h2>
          <span className="text-xs bg-surface text-ink-3 px-2 py-0.5 rounded-full border border-rim">
            {resolvedCategory || "uncategorized"}
          </span>
        </div>
        <p className="text-xs text-ink-3 font-mono mb-2">{agentSlug}</p>
        <p className="text-sm text-ink-2 leading-relaxed">{resolvedDesc}</p>
      </div>

      {/* Inline diffs for changed metadata */}
      {(hasChange(changes, "name") ||
        hasChange(changes, "category") ||
        hasChange(changes, "description")) &&
        !isNewAgent && (
          <div className="border border-blue-200 dark:border-blue-800 rounded-xl p-4 bg-blue-50/30 dark:bg-blue-950/10 space-y-2">
            <span className="text-xs font-medium text-blue-600 uppercase tracking-wider">
              Proposed changes
            </span>
            <FieldDiff label="Name" oldVal={agent?.name ?? null} newVal={proposed(changes, "name", agent?.name ?? "") as string} />
            <FieldDiff label="Category" oldVal={agent?.category ?? null} newVal={proposed(changes, "category", agent?.category ?? "") as string} />
            <FieldDiff label="Description" oldVal={agent?.description ?? null} newVal={proposed(changes, "description", agent?.description ?? "") as string} />
          </div>
        )}

      {/* Quick stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <MetaChip label="Model" value={agent?.model ?? "default"} />
        <MetaChip
          label="Max Iters"
          value={agent?.max_iterations ?? 3}
        />
        <MetaChip label="Tools" value={agent?.tools.length ?? 0} />
        <MetaChip
          label="Version"
          value={isNewAgent ? "new" : `v${agent?.version ?? 0}`}
        />
      </div>

      {/* Flags */}
      <div className="flex flex-wrap gap-2">
        {agent?.skip_judge && (
          <span className="text-xs bg-amber-100 text-amber-700 px-2 py-1 rounded-full">
            skip judge
          </span>
        )}
        {agent?.flexible_tool_use && (
          <span className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded-full">
            flexible tools
          </span>
        )}
        {agent?.required_integrations.map((ri) => (
          <span
            key={ri}
            className="text-xs bg-surface border border-rim text-ink-2 px-2 py-1 rounded-full inline-flex items-center gap-1"
          >
            <IntegrationIcon slug={ri} size={12} /> {ri}
          </span>
        ))}
      </div>

      {/* Intents */}
      <div>
        <h3 className="text-xs font-medium text-ink-3 uppercase tracking-wider mb-3">
          Intent Keywords
          {hasChange(changes, "intents") && !isNewAgent && (
            <span className="ml-2 text-xs font-medium px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700">
              changed
            </span>
          )}
        </h3>
        {hasChange(changes, "intents") && !isNewAgent ? (
          <ListDiff
            label="Intents"
            oldItems={agent?.intents ?? []}
            newItems={changes!.intents as string[]}
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            {resolvedIntents.map((intent) => (
              <span
                key={intent}
                className={`text-xs px-2 py-1 rounded ${isNewAgent ? "bg-green-50 dark:bg-green-950/30 text-green-800 dark:text-green-300 border border-green-200 dark:border-green-800" : "bg-surface text-ink-2"}`}
              >
                {intent}
              </span>
            ))}
            {resolvedIntents.length === 0 && (
              <p className="text-xs text-ink-3">No intents configured.</p>
            )}
          </div>
        )}
      </div>

      {/* Input / Output schemas */}
      {agent &&
        Object.keys(agent.input_schema).length > 0 && (
          <div>
            <h3 className="text-xs font-medium text-ink-3 uppercase tracking-wider mb-3">
              Input Schema
            </h3>
            <pre className="text-xs text-ink-2 whitespace-pre-wrap bg-surface rounded-lg p-3 border border-rim overflow-auto max-h-60">
              {JSON.stringify(agent.input_schema, null, 2)}
            </pre>
          </div>
        )}
      {agent &&
        Object.keys(agent.output_schema).length > 0 && (
          <div>
            <h3 className="text-xs font-medium text-ink-3 uppercase tracking-wider mb-3">
              Output Schema
            </h3>
            <pre className="text-xs text-ink-2 whitespace-pre-wrap bg-surface rounded-lg p-3 border border-rim overflow-auto max-h-60">
              {JSON.stringify(agent.output_schema, null, 2)}
            </pre>
          </div>
        )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: Tools — full tool list (read-only, same as catalog)
// ══════════════════════════════════════════════════════════════════════════════

function ToolsTab({
  agent,
  isNewAgent: _isNewAgent,
  changes: _changes,
}: {
  agent: CurrentAgent | null;
  isNewAgent: boolean;
  changes: Record<string, unknown> | null;
}) {
  const tools = agent?.tools ?? [];
  if (tools.length === 0) {
    return <p className="text-ink-3 text-sm">No tools configured.</p>;
  }

  return (
    <div className="space-y-2">
      {tools.map((tool) => (
        <div
          key={tool.name}
          className="flex items-center gap-3 bg-surface border border-rim rounded-lg px-4 py-3"
        >
          <IntegrationIcon slug={tool.icon ?? "generic"} size={20} />
          <div className="flex-1 min-w-0">
            <span className="text-sm font-mono text-ink">{tool.name}</span>
            {tool.display_name && tool.display_name !== tool.name && (
              <span className="text-xs text-ink-3 ml-2">
                {tool.display_name}
              </span>
            )}
          </div>
          {tool.credential ? (
            <span className="text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full inline-flex items-center gap-1">
              <Lock className="w-3 h-3" /> {tool.credential}
            </span>
          ) : (
            <span className="text-xs text-green-600 bg-green-50 px-2 py-0.5 rounded-full inline-flex items-center gap-1">
              <Unlock className="w-3 h-3" /> No auth needed
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: Prompt — full prompt with inline diff if changed
// ══════════════════════════════════════════════════════════════════════════════

function PromptTab({
  agent,
  changes,
  isNewAgent,
}: {
  agent: CurrentAgent | null;
  changes: Record<string, unknown> | null;
  isNewAgent: boolean;
}) {
  const promptChanged = hasChange(changes, "system_prompt");
  const currentPrompt = agent?.system_prompt ?? "";
  const proposedPrompt = proposed(
    changes,
    "system_prompt",
    currentPrompt
  ) as string;

  // If changed, show the diff view
  if (promptChanged || (isNewAgent && proposedPrompt)) {
    const lines = computeUnifiedDiff(
      isNewAgent ? null : currentPrompt,
      proposedPrompt
    );
    const addedCount = lines.filter((l) => l.type === "added").length;
    const removedCount = lines.filter((l) => l.type === "removed").length;

    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700">
              {isNewAgent ? "new" : "modified"}
            </span>
            <span className="text-xs text-ink-3">
              {proposedPrompt.length.toLocaleString()} characters
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs">
            {addedCount > 0 && (
              <span className="text-green-600 font-medium">
                +{addedCount} lines
              </span>
            )}
            {removedCount > 0 && (
              <span className="text-red-500 font-medium">
                -{removedCount} lines
              </span>
            )}
            <CopyButton text={proposedPrompt} />
          </div>
        </div>
        <div className="border border-rim rounded-xl overflow-hidden">
          <DiffTable lines={lines} maxHeight="max-h-[70vh]" />
        </div>
      </div>
    );
  }

  // No changes — show the static prompt (same as catalog)
  if (!currentPrompt) {
    return <p className="text-ink-3 text-sm">No system prompt configured.</p>;
  }

  return (
    <div className="relative">
      <div className="absolute top-2 right-2 z-10">
        <CopyButton text={currentPrompt} />
      </div>
      <pre className="text-xs text-ink-2 whitespace-pre-wrap bg-surface rounded-xl p-4 leading-relaxed overflow-auto max-h-[70vh] border border-rim">
        {currentPrompt}
      </pre>
      <p className="text-xs text-ink-3 mt-2">
        {currentPrompt.length.toLocaleString()} characters
      </p>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: Knowledge — full knowledge docs (same as catalog)
// ══════════════════════════════════════════════════════════════════════════════

function KnowledgeTab({
  agent,
  isNewAgent: _isNewAgent,
  changes: _changes,
}: {
  agent: CurrentAgent | null;
  isNewAgent: boolean;
  changes: Record<string, unknown> | null;
}) {
  const docs = agent?.knowledge_docs ?? [];
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggle = (i: number) =>
    setExpanded((prev) => {
      const s = new Set(prev);
      if (s.has(i)) { s.delete(i); } else { s.add(i); }
      return s;
    });
  const expandAll = () => setExpanded(new Set(docs.map((d) => d.index)));
  const collapseAll = () => setExpanded(new Set());

  if (docs.length === 0) {
    return (
      <p className="text-ink-3 text-sm">
        No knowledge documents attached to this agent.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-ink-3">
          {docs.length} document{docs.length !== 1 ? "s" : ""} &middot;{" "}
          {docs
            .reduce((s, d) => s + d.char_count, 0)
            .toLocaleString()}{" "}
          total chars
        </p>
        <div className="flex gap-2">
          <button
            onClick={expandAll}
            className="text-xs text-brand hover:underline"
          >
            Expand all
          </button>
          <button
            onClick={collapseAll}
            className="text-xs text-brand hover:underline"
          >
            Collapse all
          </button>
        </div>
      </div>
      {docs.map((doc) => {
        const title =
          extractTitle(doc.full) ?? `Document ${doc.index + 1}`;
        const isOpen = expanded.has(doc.index);
        return (
          <div
            key={doc.index}
            className="border border-rim rounded-lg overflow-hidden"
          >
            <button
              onClick={() => toggle(doc.index)}
              className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-surface transition-colors"
            >
              {isOpen ? (
                <ChevronDown className="w-4 h-4 text-ink-3" />
              ) : (
                <ChevronRight className="w-4 h-4 text-ink-3" />
              )}
              <BookOpen className="w-4 h-4 text-brand shrink-0" />
              <span className="text-sm text-ink font-medium truncate">
                {title}
              </span>
              <span className="text-xs text-ink-3 ml-auto shrink-0">
                {doc.char_count.toLocaleString()} chars
              </span>
            </button>
            {!isOpen && (
              <p className="text-xs text-ink-3 px-4 pb-3 pl-11 -mt-1 line-clamp-2">
                {doc.preview}
              </p>
            )}
            {isOpen && (
              <div className="border-t border-rim bg-surface/30">
                <div className="flex justify-end px-4 pt-2">
                  <CopyButton text={doc.full} />
                </div>
                <div className="px-4 pb-4 overflow-auto max-h-[60vh]">
                  <pre className="text-xs text-ink-2 whitespace-pre-wrap leading-relaxed font-mono">
                    {doc.full}
                  </pre>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: Examples — full examples with diff highlighting for new/changed ones
// ══════════════════════════════════════════════════════════════════════════════

function ExamplesTab({
  agent,
  changes,
  isNewAgent,
}: {
  agent: CurrentAgent | null;
  changes: Record<string, unknown> | null;
  isNewAgent: boolean;
}) {
  const examplesChanged = hasChange(changes, "examples");
  const currentExamples = agent?.examples ?? [];
  const proposedExamples = examplesChanged || isNewAgent
    ? (proposed(changes, "examples", currentExamples) as AgentExample[])
    : currentExamples;
  const allExamples = Array.isArray(proposedExamples) ? proposedExamples : currentExamples;
  const showDiff = examplesChanged || isNewAgent;
  const oldCount = isNewAgent ? 0 : currentExamples.length;

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggle = (i: number) =>
    setExpanded((prev) => {
      const s = new Set(prev);
      if (s.has(i)) { s.delete(i); } else { s.add(i); }
      return s;
    });

  if (allExamples.length === 0) {
    return (
      <div className="border border-dashed border-rim rounded-lg px-6 py-8 text-center">
        <FlaskConical className="w-8 h-8 text-ink-3 mx-auto mb-2" />
        <p className="text-sm text-ink-3 mb-1">
          No examples configured for this agent.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {showDiff && (
        <div className="flex items-center gap-2 text-xs text-ink-3">
          <span>
            {oldCount} existing &rarr; {allExamples.length} proposed
          </span>
          {allExamples.length > oldCount && (
            <span className="text-green-600">
              +{allExamples.length - oldCount} added
            </span>
          )}
        </div>
      )}
      {allExamples.map((ex, i) => {
        const isAdded = showDiff && i >= oldCount;
        const isOpen = expanded.has(i);
        return (
          <div
            key={i}
            className={`border rounded-lg overflow-hidden ${isAdded ? "border-green-300 dark:border-green-700" : "border-rim"}`}
          >
            <button
              onClick={() => toggle(i)}
              className={`w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-surface transition-colors ${
                isAdded
                  ? "bg-green-50/50 dark:bg-green-950/20"
                  : ""
              }`}
            >
              {isOpen ? (
                <ChevronDown className="w-4 h-4 text-ink-3" />
              ) : (
                <ChevronRight className="w-4 h-4 text-ink-3" />
              )}
              <FlaskConical className="w-4 h-4 text-ink-3" />
              <span
                className={`text-sm font-medium ${isAdded ? "text-green-700 dark:text-green-300" : "text-ink"}`}
              >
                Example {i + 1}
              </span>
              {isAdded && (
                <span className="text-xs px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">
                  new
                </span>
              )}
            </button>
            {isOpen && (
              <div className="border-t border-rim divide-y divide-rim">
                <div className="px-4 py-3">
                  <span className="text-xs font-medium text-ink-3 uppercase tracking-wider mb-1 block">
                    Input
                  </span>
                  <pre className="text-xs text-ink-2 whitespace-pre-wrap bg-surface rounded p-2 max-h-60 overflow-auto">
                    {JSON.stringify(ex.input, null, 2)}
                  </pre>
                </div>
                <div className="px-4 py-3">
                  <span className="text-xs font-medium text-ink-3 uppercase tracking-wider mb-1 block">
                    Expected Output
                  </span>
                  <pre className="text-xs text-ink-2 whitespace-pre-wrap bg-surface rounded p-2 max-h-60 overflow-auto">
                    {typeof ex.output === "string"
                      ? ex.output
                      : JSON.stringify(ex.output, null, 2)}
                  </pre>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: Rubric — full judge config with inline diffs
// ══════════════════════════════════════════════════════════════════════════════

function RubricTab({
  agent,
  changes,
  isNewAgent,
}: {
  agent: CurrentAgent | null;
  changes: Record<string, unknown> | null;
  isNewAgent: boolean;
}) {
  const judgeChanged = hasChange(changes, "judge_config");
  const currentConfig = agent?.judge_config ?? {
    threshold: 7,
    rubric: [],
    need_to_know: [],
  };
  const proposedConfig = (
    judgeChanged || isNewAgent
      ? proposed(changes, "judge_config", currentConfig)
      : currentConfig
  ) as JudgeConfig;
  const showDiff = judgeChanged && !isNewAgent;

  return (
    <div className="space-y-6">
      {agent?.skip_judge && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-700">
          Judge evaluation is skipped for this agent.
        </div>
      )}

      {/* Threshold */}
      <div className="flex items-center gap-4">
        <MetaChip
          label="Pass Threshold"
          value={`${proposedConfig.threshold}/10`}
        />
        <MetaChip label="Rubric Items" value={proposedConfig.rubric.length} />
        <MetaChip
          label="Need-to-Know"
          value={proposedConfig.need_to_know.length}
        />
      </div>

      {showDiff && currentConfig.threshold !== proposedConfig.threshold && (
        <FieldDiff
          label="Threshold"
          oldVal={currentConfig.threshold}
          newVal={proposedConfig.threshold}
        />
      )}

      {/* Rubric items */}
      <div>
        <h3 className="text-xs font-medium text-ink-3 uppercase tracking-wider mb-3">
          Quality Criteria
          {showDiff && (
            <span className="ml-2 text-xs font-medium px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700">
              changed
            </span>
          )}
        </h3>
        {showDiff ? (
          <ListDiff
            label="Rubric"
            oldItems={currentConfig.rubric}
            newItems={proposedConfig.rubric}
          />
        ) : proposedConfig.rubric.length > 0 ? (
          <div className="space-y-2">
            {proposedConfig.rubric.map((item, i) => (
              <div
                key={i}
                className={`flex items-start gap-2 text-sm text-ink-2 rounded-lg px-3 py-2 border ${
                  isNewAgent
                    ? "bg-green-50/50 dark:bg-green-950/10 border-green-200 dark:border-green-800"
                    : "bg-surface border-rim"
                }`}
              >
                <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 shrink-0" />
                <span>{item}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-ink-3">No rubric criteria defined.</p>
        )}
      </div>

      {/* Need to know */}
      <div>
        <h3 className="text-xs font-medium text-ink-3 uppercase tracking-wider mb-3">
          Need to Know
          {showDiff && (
            <span className="ml-2 text-xs font-medium px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700">
              changed
            </span>
          )}
        </h3>
        {showDiff ? (
          <ListDiff
            label="Need to Know"
            oldItems={currentConfig.need_to_know}
            newItems={proposedConfig.need_to_know}
          />
        ) : proposedConfig.need_to_know.length > 0 ? (
          <div className="space-y-2">
            {proposedConfig.need_to_know.map((item, i) => (
              <div
                key={i}
                className={`flex items-start gap-2 text-sm text-ink-2 rounded-lg px-3 py-2 border ${
                  isNewAgent
                    ? "bg-green-50/50 dark:bg-green-950/10 border-green-200 dark:border-green-800"
                    : "bg-surface border-rim"
                }`}
              >
                <Brain className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                <span>{item}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-ink-3">No need-to-know items defined.</p>
        )}
      </div>
    </div>
  );
}
