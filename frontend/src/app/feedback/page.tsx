"use client";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { AUTHORITY_BADGE, SEVERITY_BADGE, SCOPE_BADGE, PR_TYPE_BADGE } from "@/lib/tokens";
import { useAuth } from "@/lib/auth-context";

interface SignalStat {
  agent_slug: string;
  signal_type: string;
  authority: string;
  count: number;
  total_weight: number;
  unresolved: number;
}

interface PendingPR {
  id: string;
  pr_type: string;
  target_agent_slug: string | null;
  gap_summary: string;
  confidence: number;
  evidence_count: number;
  auto_merge_eligible: boolean;
  created_at: string;
}

interface ActiveOverlay {
  id: string;
  primitive_type: string;
  primitive_id: string;
  scope: string;
  source: string;
  version: number;
  content: string;
  created_at: string;
  skill_slug: string | null;
  skill_name: string | null;
}

interface Pattern {
  id: string;
  agent_slug: string;
  pattern_type: string;
  description: string;
  session_count: number;
  severity: string;
  status: string;
  created_at: string;
}

interface WeightDist {
  agent_slug: string;
  ground_truth_weight: number | null;
  inferred_weight: number | null;
  user_weight: number | null;
  automated_weight: number | null;
  self_report_weight: number | null;
  total_weight: number;
  total_signals: number;
}

interface DashboardData {
  signal_stats: SignalStat[];
  pending_prs: PendingPR[];
  active_overlays: ActiveOverlay[];
  active_patterns: Pattern[];
  weight_distribution: WeightDist[];
}


export default function FeedbackDashboardPage() {
  const { apiFetch } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [synthesizing, setSynthesizing] = useState(false);
  const [tab, setTab] = useState("signals");

  const loadDashboard = useCallback(() => {
    setLoading(true);
    apiFetch("/api/feedback/dashboard")
      .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then((d) => { setData(d); setLoading(false); })
      .catch((err) => { console.error("Failed to load dashboard:", err); setLoading(false); });
  }, [apiFetch]);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  const handleSynthesize = async () => {
    setSynthesizing(true);
    try {
      const res = await apiFetch("/api/feedback/synthesize", { method: "POST" });
      if (res.ok) {
        const result = await res.json();
        alert(`Pipeline complete: ${result.prs_count ?? 0} PRs created, ${result.signals_deduped ?? 0} deduped, ${result.patterns_detected ?? 0} patterns`);
        loadDashboard();
      }
    } catch (err) {
      console.error("Synthesis failed:", err);
    } finally {
      setSynthesizing(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold text-ink mb-2">Feedback Dashboard</h1>
        <p className="text-ink-3 text-sm">Loading...</p>
      </div>
    );
  }

  if (!data) return null;

  const totalSignals = data.weight_distribution.reduce((s, w) => s + (w.total_signals ?? 0), 0);
  const _totalWeight = data.weight_distribution.reduce((s, w) => s + (w.total_weight ?? 0), 0);
  const maxWeight = Math.max(...data.weight_distribution.map((w) => w.total_weight ?? 0), 1);

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-ink">Feedback Dashboard</h1>
          <p className="text-ink-2 text-sm mt-1">
            {totalSignals} signals across {data.weight_distribution.length} agents
            {" / "}{data.pending_prs.length} pending PRs
            {" / "}{data.active_overlays.length} active overlays
          </p>
        </div>
        <button
          onClick={handleSynthesize}
          disabled={synthesizing}
          className="px-4 py-2 bg-brand text-white text-sm rounded-lg hover:bg-brand-hover disabled:opacity-50 transition-colors"
        >
          {synthesizing ? "Running Pipeline..." : "Run Feedback Pipeline"}
        </button>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="mb-6">
        <TabsList className="w-fit">
          <TabsTrigger value="signals">Signals ({totalSignals})</TabsTrigger>
          <TabsTrigger value="prs">PRs ({data.pending_prs.length})</TabsTrigger>
          <TabsTrigger value="overlays">Overlays ({data.active_overlays.length})</TabsTrigger>
          <TabsTrigger value="patterns">Patterns ({data.active_patterns.length})</TabsTrigger>
        </TabsList>

      {/* Signal Overview + Weight Distribution */}
      <TabsContent value="signals">
        <div className="space-y-8">
          {/* Weight distribution bars */}
          <Section title="Weight Distribution by Agent">
            {data.weight_distribution.length === 0 ? (
              <p className="text-ink-3 text-sm py-4">No signals recorded yet</p>
            ) : (
              <div className="space-y-3">
                {data.weight_distribution.map((w) => (
                  <div key={w.agent_slug} className="flex items-center gap-3">
                    <Link href={`/catalog/${w.agent_slug}`} className="text-sm font-mono text-ink hover:text-blue-600 w-44 truncate shrink-0">
                      {w.agent_slug}
                    </Link>
                    <div className="flex-1 flex items-center gap-1 h-6">
                      <WeightBar label="GT" value={w.ground_truth_weight} max={maxWeight} color="bg-green-500" />
                      <WeightBar label="Inf" value={w.inferred_weight} max={maxWeight} color="bg-yellow-500" />
                      <WeightBar label="Usr" value={w.user_weight} max={maxWeight} color="bg-blue-500" />
                      <WeightBar label="Auto" value={w.automated_weight} max={maxWeight} color="bg-purple-500" />
                      <WeightBar label="Self" value={w.self_report_weight} max={maxWeight} color="bg-gray-400" />
                    </div>
                    <span className="text-xs text-ink-3 w-20 text-right shrink-0">
                      {(w.total_weight ?? 0).toFixed(1)}w / {w.total_signals}sig
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Signal breakdown table */}
          <Section title="Signal Breakdown">
            {data.signal_stats.length === 0 ? (
              <p className="text-ink-3 text-sm py-4">No signals</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-ink-3 text-xs border-b border-rim">
                      <th className="pb-2 pr-4">Agent</th>
                      <th className="pb-2 pr-4">Type</th>
                      <th className="pb-2 pr-4">Authority</th>
                      <th className="pb-2 pr-4 text-right">Count</th>
                      <th className="pb-2 pr-4 text-right">Weight</th>
                      <th className="pb-2 text-right">Unresolved</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.signal_stats.map((s, i) => (
                      <tr key={i} className="border-b border-rim/50 hover:bg-surface/50">
                        <td className="py-2 pr-4 font-mono text-ink">{s.agent_slug}</td>
                        <td className="py-2 pr-4 text-ink-2">{s.signal_type}</td>
                        <td className="py-2 pr-4">
                          <span className={`text-xs px-2 py-0.5 rounded-full ${AUTHORITY_BADGE[s.authority] ?? "bg-surface text-ink-2"}`}>
                            {s.authority}
                          </span>
                        </td>
                        <td className="py-2 pr-4 text-right text-ink">{s.count}</td>
                        <td className="py-2 pr-4 text-right text-ink">{(s.total_weight ?? 0).toFixed(1)}</td>
                        <td className="py-2 text-right">
                          {(s.unresolved ?? 0) > 0 ? (
                            <span className="text-amber-600 font-medium">{s.unresolved}</span>
                          ) : (
                            <span className="text-ink-3">0</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </div>
      </TabsContent>

      {/* Pending PRs */}
      <TabsContent value="prs">
        <Section title="Pending PRs">
          {data.pending_prs.length === 0 ? (
            <div className="text-center py-12 text-ink-3">
              <p className="text-3xl mb-2">{"\u2713"}</p>
              <p className="text-sm">No pending PRs</p>
            </div>
          ) : (
            <div className="space-y-2">
              {data.pending_prs.map((pr) => (
                <Link
                  key={pr.id}
                  href={`/agent-prs/${pr.id}`}
                  className="flex items-center gap-4 border border-rim rounded-xl px-5 py-4 hover:border-rim-strong transition-colors bg-page"
                >
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${PR_TYPE_BADGE[pr.pr_type] ?? "bg-surface text-ink-2"}`}>
                    {pr.pr_type.replace(/_/g, " ")}
                  </span>
                  <span className="text-sm font-medium text-ink shrink-0 w-40 truncate font-mono">
                    {pr.target_agent_slug ?? "unknown"}
                  </span>
                  <span className="text-sm text-ink-2 flex-1 truncate">{pr.gap_summary}</span>
                  <div className="flex items-center gap-3 shrink-0 text-xs text-ink-3">
                    {pr.auto_merge_eligible && (
                      <span className="text-green-600 font-medium">auto-eligible</span>
                    )}
                    <span>{Math.round((pr.confidence ?? 0) * 100)}% conf</span>
                    <span>{pr.evidence_count} evidence</span>
                    <span>{new Date(pr.created_at).toLocaleDateString()}</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Section>
      </TabsContent>

      {/* Active Overlays */}
      <TabsContent value="overlays">
        <Section title="Active Overlays">
          {data.active_overlays.length === 0 ? (
            <p className="text-ink-3 text-sm py-4">No overlays</p>
          ) : (
            <div className="space-y-2">
              {data.active_overlays.map((o) => (
                <div
                  key={o.id}
                  className="border border-rim rounded-xl px-5 py-4 bg-page"
                >
                  <div className="flex items-center gap-3 mb-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${SCOPE_BADGE[o.scope] ?? "bg-surface text-ink-2"}`}>
                      {o.scope}
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-surface text-ink-2">
                      {o.source}
                    </span>
                    {o.version > 1 && (
                      <span className="text-xs text-ink-3">v{o.version}</span>
                    )}
                    <span className="text-sm font-mono text-ink flex-1">
                      {o.skill_slug ?? o.primitive_id.slice(0, 8)}
                    </span>
                    {o.skill_name && (
                      <span className="text-xs text-ink-3">{o.skill_name}</span>
                    )}
                    <span className="text-xs text-ink-3">{new Date(o.created_at).toLocaleDateString()}</span>
                  </div>
                  <p className="text-sm text-ink-2 line-clamp-2">{o.content}</p>
                </div>
              ))}
            </div>
          )}
        </Section>
      </TabsContent>

      {/* Detected Patterns */}
      <TabsContent value="patterns">
        <Section title="Detected Patterns">
          {data.active_patterns.length === 0 ? (
            <div className="text-center py-12 text-ink-3">
              <p className="text-sm">No active patterns detected</p>
            </div>
          ) : (
            <div className="space-y-2">
              {data.active_patterns.map((p) => (
                <div
                  key={p.id}
                  className="border border-rim rounded-xl px-5 py-4 bg-page"
                >
                  <div className="flex items-center gap-3 mb-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${SEVERITY_BADGE[p.severity] ?? "bg-surface text-ink-2"}`}>
                      {p.severity}
                    </span>
                    <span className="text-sm font-mono text-ink">{p.agent_slug}</span>
                    <span className="text-xs text-ink-3">{p.pattern_type}</span>
                    <span className="ml-auto text-xs text-ink-3">{p.session_count} sessions</span>
                  </div>
                  <p className="text-sm text-ink-2">{p.description}</p>
                </div>
              ))}
            </div>
          )}
        </Section>
      </TabsContent>
      </Tabs>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-ink mb-3">{title}</h2>
      {children}
    </div>
  );
}

function WeightBar({ label, value, max, color }: { label: string; value: number | null; max: number; color: string }) {
  const v = value ?? 0;
  if (v === 0) return null;
  const pct = Math.max((v / max) * 100, 2);
  return (
    <div
      className={`${color} h-full rounded-sm relative group`}
      style={{ width: `${pct}%` }}
      title={`${label}: ${v.toFixed(1)}`}
    >
      <span className="absolute inset-0 flex items-center justify-center text-xs text-white font-medium opacity-0 group-hover:opacity-100 transition-opacity">
        {label}
      </span>
    </div>
  );
}
