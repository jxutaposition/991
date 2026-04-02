"use client";

import { useEffect, useState } from "react";
import { Eye, Radio, Clock } from "lucide-react";

interface SessionSummary {
  id: string;
  status: string;
  event_count: number;
  distillation_count: number;
  coverage_score: number | null;
  started_at: string;
  ended_at: string | null;
}

export function ShadowSessionPanel({
  onSessionSelect,
  selectedSessionId,
}: {
  onSessionSelect: (id: string) => void;
  selectedSessionId: string | null;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchSessions = () => {
      fetch("/api/observe/sessions")
        .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
        .then((data) => {
          setSessions(data.sessions ?? []);
          setLoading(false);
        })
        .catch(() => setLoading(false));
    };

    fetchSessions();
    const interval = setInterval(fetchSessions, 5000); // Refresh session list every 5s
    return () => clearInterval(interval);
  }, []);

  const recording = sessions.filter((s) => s.status === "recording");
  const completed = sessions.filter((s) => s.status === "completed").slice(0, 10);

  return (
    <div className="flex flex-col h-full bg-page overflow-y-auto">
      <div className="px-4 py-3 border-b border-rim">
        <h3 className="text-xs font-semibold text-ink uppercase tracking-wider flex items-center gap-1.5">
          <Eye className="w-3.5 h-3.5" /> Shadow a Session
        </h3>
        <p className="text-[10px] text-ink-3 mt-1">
          Watch an expert&apos;s session in real-time, or review a completed session
        </p>
      </div>

      {loading ? (
        <div className="p-4 text-xs text-ink-3">Loading sessions...</div>
      ) : (
        <>
          {/* Active recording sessions */}
          <div className="px-4 py-3">
            <h4 className="text-[10px] font-semibold text-ink-3 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <Radio className="w-3 h-3 text-red-500" /> Live Sessions ({recording.length})
            </h4>
            {recording.length === 0 ? (
              <p className="text-[10px] text-ink-3">No active recording sessions</p>
            ) : (
              <div className="space-y-1.5">
                {recording.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => onSessionSelect(s.id)}
                    className={`w-full text-left px-3 py-2 rounded-lg border transition-colors ${
                      selectedSessionId === s.id
                        ? "border-red-400 bg-red-50"
                        : "border-rim hover:border-rim-strong bg-surface"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                      <span className="text-xs font-mono text-ink">{s.id.slice(0, 8)}</span>
                      <span className="text-[10px] text-ink-3 ml-auto">{s.event_count} events</span>
                    </div>
                    <div className="text-[10px] text-ink-3 mt-1">
                      Started {new Date(s.started_at).toLocaleTimeString()}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Completed sessions */}
          <div className="px-4 py-3 border-t border-rim">
            <h4 className="text-[10px] font-semibold text-ink-3 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <Clock className="w-3 h-3" /> Recent Completed ({completed.length})
            </h4>
            {completed.length === 0 ? (
              <p className="text-[10px] text-ink-3">No completed sessions</p>
            ) : (
              <div className="space-y-1.5">
                {completed.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => onSessionSelect(s.id)}
                    className={`w-full text-left px-3 py-2 rounded-lg border transition-colors ${
                      selectedSessionId === s.id
                        ? "border-brand bg-blue-50"
                        : "border-rim hover:border-rim-strong bg-surface"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-ink">{s.id.slice(0, 8)}</span>
                      <span className="text-[10px] text-green-600">{s.event_count} events</span>
                      <span className="text-[10px] text-purple-600">{s.distillation_count} narrations</span>
                      {s.coverage_score != null && (
                        <span className="text-[10px] text-ink-3 ml-auto">{Math.round(s.coverage_score * 100)}% coverage</span>
                      )}
                    </div>
                    <div className="text-[10px] text-ink-3 mt-1">
                      {new Date(s.started_at).toLocaleString()}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
