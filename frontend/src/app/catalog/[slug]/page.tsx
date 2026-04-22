"use client";
import { useEffect, useState, useMemo } from "react";
import { useParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import Link from "next/link";
import {
  ArrowLeft, Wrench, FileText, BookOpen, FlaskConical,
  ClipboardCheck, History, GitPullRequest, MessageSquare,
  ChevronDown, ChevronRight, CheckCircle2, XCircle,
  SkipForward, Clock, Brain, Layers, Lock, Unlock,
  ExternalLink, Copy, Check,
} from "lucide-react";
import { IntegrationIcon } from "@/components/integration-icon";
import { RESULT_STATUS_BADGE, PR_STATUS_BADGE } from "@/lib/tokens";

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

interface AgentDetail {
  slug: string;
  name: string;
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
  git_sha: string;
  expert_id: string | null;
  expert: { slug: string; name: string } | null;
}

interface RunRecord {
  id: string;
  session_id: string;
  status: string;
  judge_score: number | null;
  judge_feedback: string | null;
  task_description: string;
  attempt_count: number;
  model: string;
  started_at: string | null;
  completed_at: string | null;
  session_request: string;
}

interface Stats {
  total_runs: string;
  passed: string;
  failed: string;
  skipped: string;
  avg_score: string | null;
  min_score: number | null;
  max_score: number | null;
  avg_duration_secs: string | null;
  last_run_at: string | null;
}

interface FeedbackSignal {
  id: string;
  agent_slug: string;
  signal_type: string;
  description: string;
  agent_approach: string | null;
  expert_approach: string | null;
  authority: string | null;
  impact: string | null;
  weight: number | null;
  session_id: string | null;
  resolution: string | null;
  resolved_pr_id: string | null;
  created_at: string;
}

interface AgentPR {
  id: string;
  pr_type: string;
  gap_summary: string;
  confidence: number;
  status: string;
  created_at: string;
}

interface AgentStats {
  stats: Stats;
  recent_runs: RunRecord[];
  feedback: FeedbackSignal[];
  prs: AgentPR[];
}

type Tab = "overview" | "tools" | "prompt" | "knowledge" | "examples" | "rubric" | "runs" | "versions" | "feedback";

const TAB_CONFIG: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: "overview", label: "Overview", icon: Layers },
  { id: "tools", label: "Tools", icon: Wrench },
  { id: "prompt", label: "Prompt", icon: FileText },
  { id: "knowledge", label: "Knowledge", icon: BookOpen },
  { id: "examples", label: "Examples", icon: FlaskConical },
  { id: "rubric", label: "Rubric", icon: ClipboardCheck },
  { id: "runs", label: "Runs", icon: History },
  { id: "versions", label: "Versions", icon: GitPullRequest },
  { id: "feedback", label: "Feedback", icon: MessageSquare },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const styles = { ...RESULT_STATUS_BADGE, ...PR_STATUS_BADGE };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${styles[status] ?? "bg-surface text-ink-3"}`}>
      {status}
    </span>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === "passed") return <CheckCircle2 className="w-4 h-4 text-success" />;
  if (status === "failed") return <XCircle className="w-4 h-4 text-danger" />;
  if (status === "skipped") return <SkipForward className="w-4 h-4 text-warning" />;
  return <Clock className="w-4 h-4 text-ink-3" />;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="text-ink-3 hover:text-ink-2 transition-colors p-1 rounded"
      title="Copy to clipboard"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function MetaChip({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-0.5 bg-surface border border-rim rounded-lg px-3 py-2">
      <span className="text-xs font-medium text-ink-3 uppercase tracking-wider">{label}</span>
      <span className="text-sm font-semibold text-ink">{value}</span>
    </div>
  );
}

function relativeTime(dateStr: string | null): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ── Main Page ────────────────────────────────────────────────────────────────

export default function AgentDetailPage() {
  const { slug } = useParams();
  const { apiFetch } = useAuth();
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [agentStats, setAgentStats] = useState<AgentStats | null>(null);
  const [versions, setVersions] = useState<{ version: number; change_summary: string; change_source: string; created_at: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("overview");

  useEffect(() => {
    Promise.all([
      apiFetch(`/api/catalog/${slug}`).then((r) => r.ok ? r.json() : null),
      apiFetch(`/api/catalog/${slug}/stats`).then((r) => r.ok ? r.json() : null),
      apiFetch(`/api/catalog/${slug}/versions`).then((r) => r.ok ? r.json() : null),
    ]).then(([agentData, statsData, versionsData]) => {
      setAgent(agentData);
      setAgentStats(statsData);
      setVersions(versionsData?.versions ?? []);
      setLoading(false);
    }).catch((err) => { console.error("Failed to load agent:", err); setLoading(false); });
  }, [slug, apiFetch]);

  const tabCounts = useMemo(() => {
    if (!agent) return {};
    return {
      tools: agent.tools.length,
      knowledge: agent.knowledge_docs.length,
      examples: agent.examples.length,
      rubric: agent.judge_config.rubric.length,
      runs: agentStats?.recent_runs.length ?? 0,
      versions: versions.length,
      feedback: agentStats?.feedback.length ?? 0,
    } as Record<string, number>;
  }, [agent, agentStats, versions]);

  if (loading) return <div className="p-8 text-ink-3 text-sm">Loading agent...</div>;
  if (!agent) return <div className="p-8 text-ink-3 text-sm">Agent not found.</div>;

  const stats = agentStats?.stats;
  const totalRuns = parseInt(stats?.total_runs ?? "0", 10);
  const passRate = totalRuns > 0 ? Math.round((parseInt(stats?.passed ?? "0", 10) / totalRuns) * 100) : null;

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      {/* Header */}
      <Link href="/catalog" className="text-ink-3 text-sm hover:text-ink-2 mb-4 inline-flex items-center gap-1">
        <ArrowLeft className="w-3.5 h-3.5" /> Back to catalog
      </Link>

      <div className="flex items-start justify-between mb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-ink truncate">{agent.name}</h1>
          </div>
          <p className="text-ink-3 text-xs font-mono mt-1">{agent.slug}</p>
          {agent.expert && (
            <p className="text-xs text-ink-3 mt-1">
              Expert: <span className="text-ink-2 font-medium">{agent.expert.name}</span>
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1 items-end shrink-0 ml-4">
          <span className="text-xs text-ink-3">v{agent.version} &middot; {agent.git_sha}</span>
        </div>
      </div>

      <p className="text-ink-2 text-sm leading-relaxed mb-4">{agent.description}</p>

      {/* Quick stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2 mb-6">
        <MetaChip label="Model" value={agent.model ?? "default"} />
        <MetaChip label="Max Iters" value={agent.max_iterations} />
        <MetaChip label="Tools" value={agent.tools.length} />
        {totalRuns > 0 && <MetaChip label="Runs" value={totalRuns} />}
        {passRate !== null && <MetaChip label="Pass Rate" value={`${passRate}%`} />}
        {stats?.avg_score && <MetaChip label="Avg Score" value={stats.avg_score} />}
      </div>

      {/* Flags row */}
      <div className="flex flex-wrap gap-2 mb-6">
        {agent.skip_judge && (
          <span className="text-xs bg-amber-100 text-amber-700 px-2 py-1 rounded-full">skip judge</span>
        )}
        {agent.flexible_tool_use && (
          <span className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded-full">flexible tools</span>
        )}
        {agent.required_integrations.map((ri) => (
          <span key={ri} className="text-xs bg-surface border border-rim text-ink-2 px-2 py-1 rounded-full inline-flex items-center gap-1">
            <IntegrationIcon slug={ri} size={12} /> {ri}
          </span>
        ))}
      </div>

      {/* Tab bar */}
      <div className="flex gap-0.5 mb-6 border-b border-rim overflow-x-auto scrollbar-hide">
        {TAB_CONFIG.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px whitespace-nowrap ${
              tab === id ? "border-brand text-ink" : "border-transparent text-ink-3 hover:text-ink-2"
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
            {tabCounts[id] != null && tabCounts[id] > 0 && (
              <span className="text-xs bg-surface text-ink-3 px-1.5 py-0.5 rounded-full ml-0.5">{tabCounts[id]}</span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "overview" && <OverviewTab agent={agent} stats={stats} totalRuns={totalRuns} passRate={passRate} />}
      {tab === "tools" && <ToolsTab tools={agent.tools} />}
      {tab === "prompt" && <PromptTab prompt={agent.system_prompt} />}
      {tab === "knowledge" && <KnowledgeTab docs={agent.knowledge_docs} />}
      {tab === "examples" && <ExamplesTab examples={agent.examples} />}
      {tab === "rubric" && <RubricTab config={agent.judge_config} skipJudge={agent.skip_judge} />}
      {tab === "runs" && <RunsTab runs={agentStats?.recent_runs ?? []} />}
      {tab === "versions" && <VersionsTab versions={versions} />}
      {tab === "feedback" && <FeedbackTab feedback={agentStats?.feedback ?? []} prs={agentStats?.prs ?? []} />}
    </div>
  );
}

// ── Tab Components ───────────────────────────────────────────────────────────

function OverviewTab({ agent, stats, totalRuns, passRate }: { agent: AgentDetail; stats?: Stats; totalRuns: number; passRate: number | null }) {
  const hasSchemaFields = (schema: Record<string, unknown>) => Object.keys(schema).length > 0;

  return (
    <div className="space-y-6">
      {/* Intent keywords */}
      <Section title="Intent Keywords">
        <div className="flex flex-wrap gap-2">
          {agent.intents.map((intent) => (
            <span key={intent} className="text-xs bg-surface text-ink-2 px-2 py-1 rounded">{intent}</span>
          ))}
        </div>
      </Section>

      {/* Schemas */}
      {hasSchemaFields(agent.input_schema) && (
        <Section title="Input Schema">
          <pre className="text-xs text-ink-2 whitespace-pre-wrap bg-surface rounded-lg p-3 border border-rim overflow-auto max-h-60">
            {JSON.stringify(agent.input_schema, null, 2)}
          </pre>
        </Section>
      )}
      {hasSchemaFields(agent.output_schema) && (
        <Section title="Output Schema">
          <pre className="text-xs text-ink-2 whitespace-pre-wrap bg-surface rounded-lg p-3 border border-rim overflow-auto max-h-60">
            {JSON.stringify(agent.output_schema, null, 2)}
          </pre>
        </Section>
      )}

      {/* Run performance summary */}
      {totalRuns > 0 && stats && (
        <Section title="Performance Summary">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Total Runs" value={totalRuns.toString()} />
            <StatCard label="Passed" value={stats.passed} color="text-green-600" />
            <StatCard label="Failed" value={stats.failed} color="text-red-600" />
            {passRate !== null && <StatCard label="Pass Rate" value={`${passRate}%`} color={passRate >= 80 ? "text-green-600" : passRate >= 50 ? "text-yellow-600" : "text-red-600"} />}
            {stats.avg_score && <StatCard label="Avg Score" value={stats.avg_score} />}
            {stats.avg_duration_secs && <StatCard label="Avg Duration" value={`${stats.avg_duration_secs}s`} />}
            {stats.last_run_at && <StatCard label="Last Run" value={relativeTime(stats.last_run_at)} />}
          </div>
        </Section>
      )}
    </div>
  );
}

function ToolsTab({ tools }: { tools: ToolDetail[] }) {
  return (
    <div className="space-y-2">
      {tools.length === 0 && <p className="text-ink-3 text-sm">No tools configured.</p>}
      {tools.map((tool) => (
        <div key={tool.name} className="flex items-center gap-3 bg-surface border border-rim rounded-lg px-4 py-3">
          <IntegrationIcon slug={tool.icon ?? "generic"} size={20} />
          <div className="flex-1 min-w-0">
            <span className="text-sm font-mono text-ink">{tool.name}</span>
            {tool.display_name && tool.display_name !== tool.name && (
              <span className="text-xs text-ink-3 ml-2">{tool.display_name}</span>
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

function PromptTab({ prompt }: { prompt: string }) {
  return (
    <div className="relative">
      <div className="absolute top-2 right-2 z-10">
        <CopyButton text={prompt} />
      </div>
      <pre className="text-xs text-ink-2 whitespace-pre-wrap bg-surface rounded-xl p-4 leading-relaxed overflow-auto max-h-[70vh] border border-rim">
        {prompt}
      </pre>
      <p className="text-xs text-ink-3 mt-2">{prompt.length.toLocaleString()} characters</p>
    </div>
  );
}

function extractTitle(markdown: string): string | null {
  const firstLine = markdown.trimStart().split("\n")[0];
  const match = firstLine.match(/^#+\s+(.+)/);
  return match ? match[1].trim() : null;
}

function KnowledgeTab({ docs }: { docs: KnowledgeDoc[] }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggle = (i: number) => setExpanded((prev) => { const s = new Set(prev); if (s.has(i)) { s.delete(i); } else { s.add(i); } return s; });
  const expandAll = () => setExpanded(new Set(docs.map((d) => d.index)));
  const collapseAll = () => setExpanded(new Set());

  if (docs.length === 0) return <p className="text-ink-3 text-sm">No knowledge documents attached to this agent.</p>;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-ink-3">{docs.length} document{docs.length !== 1 ? "s" : ""} &middot; {docs.reduce((s, d) => s + d.char_count, 0).toLocaleString()} total chars</p>
        <div className="flex gap-2">
          <button onClick={expandAll} className="text-xs text-brand hover:underline">Expand all</button>
          <button onClick={collapseAll} className="text-xs text-brand hover:underline">Collapse all</button>
        </div>
      </div>
      {docs.map((doc) => {
        const title = extractTitle(doc.full) ?? `Document ${doc.index + 1}`;
        const isOpen = expanded.has(doc.index);
        return (
          <div key={doc.index} className="border border-rim rounded-lg overflow-hidden">
            <button
              onClick={() => toggle(doc.index)}
              className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-surface transition-colors"
            >
              {isOpen ? <ChevronDown className="w-4 h-4 text-ink-3" /> : <ChevronRight className="w-4 h-4 text-ink-3" />}
              <BookOpen className="w-4 h-4 text-brand shrink-0" />
              <span className="text-sm text-ink font-medium truncate">{title}</span>
              <span className="text-xs text-ink-3 ml-auto shrink-0">{doc.char_count.toLocaleString()} chars</span>
            </button>
            {!isOpen && (
              <p className="text-xs text-ink-3 px-4 pb-3 pl-11 -mt-1 line-clamp-2">{doc.preview}</p>
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

function ExamplesTab({ examples }: { examples: AgentExample[] }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggle = (i: number) => setExpanded((prev) => { const s = new Set(prev); if (s.has(i)) { s.delete(i); } else { s.add(i); } return s; });

  if (examples.length === 0) {
    return (
      <div className="border border-dashed border-rim rounded-lg px-6 py-8 text-center">
        <FlaskConical className="w-8 h-8 text-ink-3 mx-auto mb-2" />
        <p className="text-sm text-ink-3 mb-1">No examples configured for this agent.</p>
        <p className="text-xs text-ink-3">Add <code className="bg-surface px-1 py-0.5 rounded text-[11px]">examples/*.json</code> files to the agent directory to provide input/output training pairs.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {examples.map((ex) => (
        <div key={ex.index} className="border border-rim rounded-lg overflow-hidden">
          <button
            onClick={() => toggle(ex.index)}
            className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-surface transition-colors"
          >
            {expanded.has(ex.index) ? <ChevronDown className="w-4 h-4 text-ink-3" /> : <ChevronRight className="w-4 h-4 text-ink-3" />}
            <FlaskConical className="w-4 h-4 text-ink-3" />
            <span className="text-sm text-ink font-medium">Example {ex.index + 1}</span>
          </button>
          {expanded.has(ex.index) && (
            <div className="border-t border-rim divide-y divide-rim">
              <div className="px-4 py-3">
                <span className="text-xs font-medium text-ink-3 uppercase tracking-wider mb-1 block">Input</span>
                <pre className="text-xs text-ink-2 whitespace-pre-wrap bg-surface rounded p-2 max-h-60 overflow-auto">
                  {JSON.stringify(ex.input, null, 2)}
                </pre>
              </div>
              <div className="px-4 py-3">
                <span className="text-xs font-medium text-ink-3 uppercase tracking-wider mb-1 block">Expected Output</span>
                <pre className="text-xs text-ink-2 whitespace-pre-wrap bg-surface rounded p-2 max-h-60 overflow-auto">
                  {ex.output}
                </pre>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function RubricTab({ config, skipJudge }: { config: JudgeConfig; skipJudge: boolean }) {
  const hasRubric = config.rubric.length > 0;
  const hasNeedToKnow = config.need_to_know.length > 0;
  const isEmpty = !hasRubric && !hasNeedToKnow;

  return (
    <div className="space-y-6">
      {skipJudge && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-700">
          Judge evaluation is skipped for this agent. Outputs are accepted without scoring.
        </div>
      )}

      <div className="flex items-center gap-4">
        <MetaChip label="Pass Threshold" value={`${config.threshold}/10`} />
        <MetaChip label="Rubric Items" value={config.rubric.length} />
        <MetaChip label="Need-to-Know" value={config.need_to_know.length} />
      </div>

      {isEmpty && (
        <div className="border border-dashed border-rim rounded-lg px-6 py-8 text-center">
          <ClipboardCheck className="w-8 h-8 text-ink-3 mx-auto mb-2" />
          <p className="text-sm text-ink-3 mb-1">No quality rubric or need-to-know criteria defined.</p>
          <p className="text-xs text-ink-3">
            Add a <code className="bg-surface px-1 py-0.5 rounded text-[11px]">judge_config.toml</code> file with <code className="bg-surface px-1 py-0.5 rounded text-[11px]">rubric</code> and <code className="bg-surface px-1 py-0.5 rounded text-[11px]">need_to_know</code> arrays. The judge uses these to score agent outputs.
          </p>
        </div>
      )}

      {hasRubric && (
        <Section title="Quality Criteria">
          <div className="space-y-2">
            {config.rubric.map((item, i) => (
              <div key={i} className="flex items-start gap-2 text-sm text-ink-2 bg-surface rounded-lg px-3 py-2 border border-rim">
                <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 shrink-0" />
                <span>{item}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {hasNeedToKnow && (
        <Section title="Need to Know">
          <div className="space-y-2">
            {config.need_to_know.map((item, i) => (
              <div key={i} className="flex items-start gap-2 text-sm text-ink-2 bg-surface rounded-lg px-3 py-2 border border-rim">
                <Brain className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                <span>{item}</span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function RunsTab({ runs }: { runs: RunRecord[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setExpanded((prev) => { const s = new Set(prev); if (s.has(id)) { s.delete(id); } else { s.add(id); } return s; });

  if (runs.length === 0) {
    return (
      <div className="border border-dashed border-rim rounded-lg px-6 py-8 text-center">
        <History className="w-8 h-8 text-ink-3 mx-auto mb-2" />
        <p className="text-sm text-ink-3">No execution history yet for this agent.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {runs.map((run) => {
        const isOpen = expanded.has(run.id);
        return (
          <div key={run.id} className="border border-rim rounded-lg overflow-hidden">
            <button
              onClick={() => toggle(run.id)}
              className="w-full text-left px-4 py-3 hover:bg-surface transition-colors"
            >
              <div className="flex items-center gap-3">
                {isOpen ? <ChevronDown className="w-4 h-4 text-ink-3 shrink-0" /> : <ChevronRight className="w-4 h-4 text-ink-3 shrink-0" />}
                <StatusIcon status={run.status} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-ink truncate">{run.task_description}</p>
                  <p className="text-xs text-ink-3 truncate mt-0.5">{run.session_request}</p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {run.judge_score != null && (
                    <span className={`text-xs font-semibold ${run.judge_score >= 7 ? "text-green-600" : run.judge_score >= 5 ? "text-yellow-600" : "text-red-600"}`}>
                      {run.judge_score}/10
                    </span>
                  )}
                  <StatusBadge status={run.status} />
                  <span className="text-xs text-ink-3">{relativeTime(run.completed_at)}</span>
                </div>
              </div>
            </button>

            {isOpen && (
              <div className="border-t border-rim bg-surface/30 px-4 py-3 space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  <div><span className="text-ink-3 block">Model</span><span className="text-ink font-medium">{run.model}</span></div>
                  <div><span className="text-ink-3 block">Attempts</span><span className="text-ink font-medium">{run.attempt_count}</span></div>
                  <div><span className="text-ink-3 block">Started</span><span className="text-ink font-medium">{run.started_at ? new Date(run.started_at).toLocaleString() : "—"}</span></div>
                  <div><span className="text-ink-3 block">Completed</span><span className="text-ink font-medium">{run.completed_at ? new Date(run.completed_at).toLocaleString() : "—"}</span></div>
                </div>

                {run.judge_feedback && (
                  <div>
                    <span className="text-xs font-medium text-ink-3 uppercase tracking-wider block mb-1">Judge Feedback</span>
                    <p className="text-xs text-ink-2 bg-surface rounded-lg p-3 border border-rim whitespace-pre-wrap leading-relaxed">{run.judge_feedback}</p>
                  </div>
                )}

                <div className="flex justify-end">
                  <Link
                    href={`/execute/${run.session_id}`}
                    className="text-xs text-brand hover:underline inline-flex items-center gap-1"
                  >
                    View full session <ExternalLink className="w-3 h-3" />
                  </Link>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function VersionsTab({ versions }: { versions: { version: number; change_summary: string; change_source: string; created_at: string }[] }) {
  if (versions.length === 0) return <p className="text-ink-3 text-sm">No version history.</p>;

  return (
    <div className="relative">
      <div className="absolute left-4 top-0 bottom-0 w-px bg-rim" />
      <div className="space-y-3 pl-8">
        {versions.map((v, i) => (
          <div key={v.version} className="relative">
            <div className={`absolute -left-8 top-3 w-3 h-3 rounded-full border-2 ${i === 0 ? "bg-brand border-brand" : "bg-page border-rim-strong"}`} />
            <div className="bg-page border border-rim rounded-lg px-4 py-3">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-semibold text-ink">v{v.version}</span>
                <span className="text-xs text-ink-3 bg-surface px-2 py-0.5 rounded">{v.change_source}</span>
                <span className="text-xs text-ink-3 ml-auto">{relativeTime(v.created_at)}</span>
              </div>
              <p className="text-xs text-ink-2">{v.change_summary}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FeedbackTab({ feedback, prs }: { feedback: FeedbackSignal[]; prs: AgentPR[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setExpanded((prev) => { const s = new Set(prev); if (s.has(id)) { s.delete(id); } else { s.add(id); } return s; });

  const impactStyles: Record<string, string> = {
    prompt: "bg-purple-100 text-purple-700",
    example: "bg-blue-100 text-blue-700",
    tool: "bg-amber-100 text-amber-700",
    rubric: "bg-green-100 text-green-700",
    knowledge: "bg-teal-100 text-teal-700",
  };

  return (
    <div className="space-y-8">
      {/* Agent PRs */}
      {prs.length > 0 && (
        <Section title="Agent PRs">
          <div className="space-y-2">
            {prs.map((pr) => (
              <Link
                key={pr.id}
                href={`/agent-prs/${pr.id}`}
                className="flex items-center gap-3 bg-page border border-rim rounded-lg px-4 py-3 hover:border-rim-strong transition-colors group"
              >
                <GitPullRequest className="w-4 h-4 text-ink-3 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-ink truncate">{pr.gap_summary}</p>
                  <p className="text-xs text-ink-3 mt-0.5">{pr.pr_type} &middot; confidence: {Math.round(pr.confidence * 100)}%</p>
                </div>
                <StatusBadge status={pr.status} />
                <span className="text-xs text-ink-3">{relativeTime(pr.created_at)}</span>
              </Link>
            ))}
          </div>
        </Section>
      )}

      {/* Feedback signals */}
      <Section title={`Feedback Signals (${feedback.length})`}>
        {feedback.length === 0 ? (
          <p className="text-ink-3 text-sm">No feedback signals recorded.</p>
        ) : (
          <div className="space-y-2">
            {feedback.map((f) => {
              const isOpen = expanded.has(f.id);
              return (
                <div key={f.id} className="border border-rim rounded-lg overflow-hidden">
                  <button
                    onClick={() => toggle(f.id)}
                    className="w-full text-left px-4 py-3 hover:bg-surface transition-colors"
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      {isOpen ? <ChevronDown className="w-4 h-4 text-ink-3 shrink-0" /> : <ChevronRight className="w-4 h-4 text-ink-3 shrink-0" />}
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${impactStyles[f.impact ?? ""] ?? "bg-surface text-ink-3"}`}>
                        {f.impact ?? "general"}
                      </span>
                      <span className="text-xs text-ink-3 bg-surface px-2 py-0.5 rounded">{f.signal_type}</span>
                      {f.authority && <span className="text-xs text-ink-3 bg-surface px-2 py-0.5 rounded">{f.authority}</span>}
                      {f.resolution ? <span className="text-xs text-green-600 ml-auto">Resolved</span> : <span className="text-xs text-amber-600 ml-auto">Open</span>}
                      <span className="text-xs text-ink-3">{relativeTime(f.created_at)}</span>
                    </div>
                    <p className="text-sm text-ink-2 line-clamp-2 pl-6">{f.description}</p>
                  </button>

                  {isOpen && (
                    <div className="border-t border-rim bg-surface/50">
                      {/* Full description */}
                      <div className="px-4 py-3 border-b border-rim">
                        <span className="text-xs font-medium text-ink-3 uppercase tracking-wider block mb-1">Description</span>
                        <p className="text-sm text-ink-2 leading-relaxed whitespace-pre-wrap">{f.description}</p>
                      </div>

                      {/* Expert approach vs Agent approach side-by-side */}
                      {(f.expert_approach || f.agent_approach) && (
                        <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-rim">
                          {f.expert_approach && (
                            <div className="px-4 py-3">
                              <span className="text-xs font-medium text-green-600 uppercase tracking-wider block mb-1">Expert Approach</span>
                              <p className="text-xs text-ink-2 leading-relaxed whitespace-pre-wrap">{f.expert_approach}</p>
                            </div>
                          )}
                          {f.agent_approach && (
                            <div className="px-4 py-3">
                              <span className="text-xs font-medium text-amber-600 uppercase tracking-wider block mb-1">Agent Approach (Current)</span>
                              <p className="text-xs text-ink-2 leading-relaxed whitespace-pre-wrap">{f.agent_approach}</p>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Metadata row */}
                      <div className="px-4 py-2 border-t border-rim flex flex-wrap gap-3 text-xs text-ink-3">
                        {f.weight != null && <span>Weight: {f.weight}</span>}
                        {f.session_id && (
                          <Link href={`/execute/${f.session_id}`} className="text-brand hover:underline inline-flex items-center gap-1">
                            View session <ExternalLink className="w-3 h-3" />
                          </Link>
                        )}
                        {f.resolved_pr_id && (
                          <Link href={`/agent-prs/${f.resolved_pr_id}`} className="text-brand hover:underline inline-flex items-center gap-1">
                            Resolved by PR <ExternalLink className="w-3 h-3" />
                          </Link>
                        )}
                        {f.resolution && <span className="text-green-600">Resolution: {f.resolution}</span>}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
}

// ── Shared Building Blocks ───────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-medium text-ink-3 uppercase tracking-wider mb-3">{title}</h3>
      {children}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-surface border border-rim rounded-lg px-3 py-2">
      <p className="text-xs text-ink-3 uppercase tracking-wider">{label}</p>
      <p className={`text-lg font-bold ${color ?? "text-ink"}`}>{value}</p>
    </div>
  );
}
