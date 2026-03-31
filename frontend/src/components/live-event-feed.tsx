"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Activity, Brain, GitPullRequest, Layers, RefreshCw } from "lucide-react";

interface LiveEvent {
  event_type: string;
  url: string | null;
  dom_context: Record<string, unknown> | null;
  created_at: string;
}

interface Distillation {
  sequence_ref: number;
  narrator_text: string;
  created_at: string;
}

interface AbstractedTask {
  description: string;
  matched_agent_slug: string | null;
  match_confidence: number | null;
}

interface AgentPR {
  target_agent_slug: string;
  gap_summary: string;
  confidence: number;
  status: string;
}

interface SessionInfo {
  status: string;
  event_count: number;
  coverage_score: number | null;
}

export function LiveEventFeed({ sessionId }: { sessionId: string | null }) {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [narrations, setNarrations] = useState<Distillation[]>([]);
  const [tasks, setTasks] = useState<AbstractedTask[]>([]);
  const [prs, setPrs] = useState<AgentPR[]>([]);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [polling, setPolling] = useState(true);
  const pollingRef = useRef(polling);
  const sessionIdRef = useRef(sessionId);
  pollingRef.current = polling;
  sessionIdRef.current = sessionId;

  const fetchAll = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;

    try {
      const res = await fetch(`/api/observe/session/${sid}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.session) setSession(data.session);
      if (data.distillations) setNarrations(data.distillations);
      if (data.events) setEvents(data.events);
      if (data.tasks) setTasks(data.tasks);
      if (data.prs) setPrs(data.prs);
    } catch { /* ignore — session may not exist yet */ }
  }, []);

  // Poll every 2 seconds
  useEffect(() => {
    if (!sessionId) return;
    fetchAll();
    const interval = setInterval(() => {
      if (pollingRef.current) fetchAll();
    }, 2000);
    return () => clearInterval(interval);
  }, [sessionId, fetchAll]);

  if (!sessionId) {
    return (
      <div className="flex items-center justify-center h-full text-ink-3 text-sm">
        <div className="text-center">
          <Activity className="w-8 h-8 mx-auto mb-3 opacity-30" />
          <p>Start a session to see live events</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-page overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-rim shrink-0">
        <span className="text-xs font-mono text-ink-3">{sessionId.slice(0, 8)}</span>
        {session && (
          <>
            <span className={`text-[10px] px-2 py-0.5 rounded-full ${
              session.status === "recording" ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"
            }`}>
              {session.status}
            </span>
            <span className="text-[10px] text-ink-3">{session.event_count} events</span>
          </>
        )}
        <div className="flex-1" />
        <button
          onClick={() => setPolling(!polling)}
          className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] ${
            polling ? "bg-green-100 text-green-700" : "bg-surface text-ink-3"
          }`}
        >
          <RefreshCw className={`w-2.5 h-2.5 ${polling ? "animate-spin" : ""}`} />
          {polling ? "Live" : "Paused"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Events */}
        <div className="px-4 py-3">
          <h3 className="text-[10px] font-semibold text-ink-3 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Activity className="w-3 h-3" /> Events ({events.length})
          </h3>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {events.length === 0 ? (
              <p className="text-[10px] text-ink-3">Waiting for events...</p>
            ) : events.map((ev, i) => (
              <div key={i} className="flex items-start gap-2 text-[10px]">
                <span className="text-ink-3 shrink-0 w-14 font-mono">
                  {new Date(ev.created_at).toLocaleTimeString()}
                </span>
                <span className="px-1.5 py-0.5 rounded shrink-0 bg-blue-100 text-blue-700">
                  {ev.event_type}
                </span>
                <span className="text-ink-3 truncate flex-1">
                  {(ev.dom_context as any)?.element_text || ev.url?.slice(0, 60) || ""}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Narrations */}
        <div className="px-4 py-3 border-t border-rim">
          <h3 className="text-[10px] font-semibold text-ink-3 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Brain className="w-3 h-3" /> Narrations ({narrations.length})
          </h3>
          <div className="space-y-2">
            {narrations.length === 0 ? (
              <p className="text-[10px] text-ink-3">Waiting for narrator...</p>
            ) : narrations.map((n, i) => (
              <div key={i} className="bg-purple-50 border border-purple-200 rounded-lg px-3 py-2">
                <p className="text-xs text-purple-900 leading-relaxed">{n.narrator_text}</p>
                <p className="text-[10px] text-purple-400 mt-1">seq:{n.sequence_ref}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Extracted Tasks */}
        {tasks.length > 0 && (
          <div className="px-4 py-3 border-t border-rim">
            <h3 className="text-[10px] font-semibold text-ink-3 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <Layers className="w-3 h-3" /> Extracted Tasks ({tasks.length})
            </h3>
            <div className="space-y-1.5">
              {tasks.map((t, i) => (
                <div key={i} className="flex items-start gap-2 text-[10px]">
                  <span className="bg-green-100 text-green-700 px-1.5 py-0.5 rounded shrink-0 font-mono">
                    {t.match_confidence != null ? `${(t.match_confidence * 100).toFixed(0)}%` : "?"}
                  </span>
                  <span className="text-ink-2 font-medium shrink-0">{t.matched_agent_slug ?? "unmatched"}</span>
                  <span className="text-ink-3 truncate flex-1">{t.description}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Agent PRs */}
        {prs.length > 0 && (
          <div className="px-4 py-3 border-t border-rim">
            <h3 className="text-[10px] font-semibold text-ink-3 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <GitPullRequest className="w-3 h-3" /> Agent PRs ({prs.length})
            </h3>
            <div className="space-y-1.5">
              {prs.map((pr, i) => (
                <div key={i} className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <div className="flex items-center gap-2 text-[10px] mb-1">
                    <span className="font-mono font-medium text-amber-700">{pr.target_agent_slug}</span>
                    <span className="text-amber-500">{(pr.confidence * 100).toFixed(0)}% conf</span>
                  </div>
                  <p className="text-xs text-amber-900 leading-relaxed">{pr.gap_summary}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
