"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Activity, Brain, Layers, GitPullRequest } from "lucide-react";

interface ActionEvent {
  id: string;
  event_type: string;
  url: string | null;
  domain: string | null;
  dom_context: Record<string, unknown> | null;
  created_at: string;
}

interface Distillation {
  id: string;
  sequence_ref: number;
  narrator_text: string;
  expert_correction: string | null;
  created_at: string;
}

interface AbstractedTask {
  id: string;
  description: string;
  matched_agent_slug: string | null;
  match_confidence: number | null;
  status: string;
}

interface AgentPR {
  id: string;
  pr_type: string;
  target_agent_slug: string;
  gap_summary: string;
  confidence: number;
  status: string;
}

interface SessionDetail {
  id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  event_count: number;
  coverage_score: number | null;
}

export default function ObserveSessionPage() {
  const { session_id } = useParams();
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [events, setEvents] = useState<ActionEvent[]>([]);
  const [distillations, setDistillations] = useState<Distillation[]>([]);
  const [tasks, setTasks] = useState<AbstractedTask[]>([]);
  const [prs, setPrs] = useState<AgentPR[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/observe/session/${session_id}`)
      .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then((data) => {
        setSession(data.session);
        setEvents(data.events ?? []);
        setDistillations(data.distillations ?? []);
        setTasks(data.tasks ?? []);
        setPrs(data.prs ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [session_id]);

  if (loading) return <div className="p-8 text-ink-3 text-sm">Loading...</div>;
  if (!session) return <div className="p-8 text-ink-3 text-sm">Session not found.</div>;

  const matchedTasks = tasks.filter((t) => t.matched_agent_slug);
  const unmatchedTasks = tasks.filter((t) => !t.matched_agent_slug);

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <Link href="/observe" className="text-ink-3 text-sm hover:text-ink-2 mb-4 inline-block">
        {"\u2190"} Back to sessions
      </Link>

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-ink">Observation Session</h1>
          <p className="text-ink-2 text-sm mt-1">
            {new Date(session.started_at).toLocaleString()} {"\u00B7"} {session.event_count} events {"\u00B7"} {distillations.length} narrations
            {session.coverage_score != null && ` \u00B7 ${Math.round(session.coverage_score * 100)}% coverage`}
          </p>
        </div>
        <span className={`text-xs px-3 py-1 rounded-full ${
          session.status === "recording" ? "bg-red-100 text-red-700" :
          session.status === "completed" ? "bg-green-100 text-green-700" : "bg-surface text-ink-3"
        }`}>{session.status}</span>
      </div>

      {/* Pipeline summary bar */}
      <div className="grid grid-cols-4 gap-3 mb-8">
        {[
          { icon: Activity, label: "Events", count: events.length, color: "blue" },
          { icon: Brain, label: "Narrations", count: distillations.length, color: "purple" },
          { icon: Layers, label: "Tasks", count: tasks.length, color: "green" },
          { icon: GitPullRequest, label: "PRs", count: prs.length, color: "amber" },
        ].map(({ icon: Icon, label, count, color }) => (
          <div key={label} className={`border border-rim rounded-lg px-4 py-3 bg-${color}-50`}>
            <div className="flex items-center gap-2 mb-1">
              <Icon className={`w-3.5 h-3.5 text-${color}-600`} />
              <span className={`text-xs font-semibold text-${color}-700`}>{label}</span>
            </div>
            <span className={`text-2xl font-bold text-${color}-800`}>{count}</span>
          </div>
        ))}
      </div>

      {/* Events */}
      {events.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-ink-2 mb-3 flex items-center gap-2">
            <Activity className="w-4 h-4 text-blue-500" /> Captured Events
          </h2>
          <div className="border border-rim rounded-lg overflow-hidden">
            <div className="max-h-64 overflow-y-auto">
              {events.map((ev) => (
                <div key={ev.id} className="flex items-center gap-3 px-4 py-2 border-b border-rim last:border-0 text-xs">
                  <span className="text-ink-3 font-mono w-16 shrink-0">
                    {new Date(ev.created_at).toLocaleTimeString()}
                  </span>
                  <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded shrink-0">{ev.event_type}</span>
                  <span className="text-ink-2 truncate flex-1">
                    {(ev.dom_context as any)?.element_text || ev.url || ""}
                  </span>
                  {ev.domain && <span className="text-ink-3 shrink-0">{ev.domain}</span>}
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Narrations */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-ink-2 mb-3 flex items-center gap-2">
          <Brain className="w-4 h-4 text-purple-500" /> Narrations
        </h2>
        {distillations.length === 0 ? (
          <p className="text-ink-3 text-sm text-center py-6">No narrations recorded.</p>
        ) : (
          <div className="space-y-3">
            {distillations.map((d) => (
              <div key={d.id} className="border border-rim rounded-lg p-4 bg-page">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs text-ink-3 font-mono">seq:{d.sequence_ref}</span>
                  <span className="text-xs text-ink-3">{new Date(d.created_at).toLocaleTimeString()}</span>
                </div>
                <p className="text-sm text-ink-2 leading-relaxed">{d.narrator_text}</p>
                {d.expert_correction && (
                  <div className="mt-3 pt-3 border-t border-rim">
                    <p className="text-xs text-amber-600 font-medium mb-1">Expert correction:</p>
                    <p className="text-sm text-ink-2 leading-relaxed">{d.expert_correction}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Extracted Tasks */}
      {tasks.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-ink-2 mb-3 flex items-center gap-2">
            <Layers className="w-4 h-4 text-green-500" /> Extracted Tasks ({tasks.length})
          </h2>
          <div className="space-y-2">
            {matchedTasks.length > 0 && (
              <div className="space-y-2">
                {matchedTasks.map((t) => (
                  <div key={t.id} className="border border-green-200 bg-green-50 rounded-lg px-4 py-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-mono font-semibold text-green-700">
                        {t.match_confidence != null ? `${(t.match_confidence * 100).toFixed(0)}%` : "?"}
                      </span>
                      <span className="text-xs font-medium text-green-800">{t.matched_agent_slug}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                        t.status === "matched" ? "bg-green-200 text-green-800" : "bg-surface text-ink-3"
                      }`}>{t.status}</span>
                    </div>
                    <p className="text-sm text-ink-2 leading-relaxed">{t.description}</p>
                  </div>
                ))}
              </div>
            )}
            {unmatchedTasks.length > 0 && (
              <div className="space-y-2">
                {unmatchedTasks.map((t) => (
                  <div key={t.id} className="border border-rim rounded-lg px-4 py-3 bg-page">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">{t.status}</span>
                    </div>
                    <p className="text-sm text-ink-2 leading-relaxed">{t.description}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* Agent PRs */}
      {prs.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-ink-2 mb-3 flex items-center gap-2">
            <GitPullRequest className="w-4 h-4 text-amber-500" /> Agent PRs ({prs.length})
          </h2>
          <div className="space-y-2">
            {prs.map((pr) => (
              <Link key={pr.id} href={`/agent-prs/${pr.id}`} className="block border border-amber-200 bg-amber-50 rounded-lg px-4 py-3 hover:border-amber-300 transition-colors">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-mono font-semibold text-amber-700">{pr.target_agent_slug}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-200 text-amber-800">{pr.pr_type}</span>
                  <span className="text-xs text-amber-500">{(pr.confidence * 100).toFixed(0)}% confidence</span>
                  <div className="flex-1" />
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                    pr.status === "open" ? "bg-blue-100 text-blue-700" :
                    pr.status === "approved" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                  }`}>{pr.status}</span>
                </div>
                <p className="text-sm text-ink-2 leading-relaxed">{pr.gap_summary}</p>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
