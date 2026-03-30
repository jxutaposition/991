"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

interface ObservationSession {
  id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  event_count: number;
  distillation_count: number;
  coverage_score: number | null;
}

const STATUS_COLORS: Record<string, string> = {
  recording:  "bg-red-900/40 text-red-400",
  completed:  "bg-green-900/40 text-green-400",
  flagged:    "bg-amber-900/40 text-amber-400",
  archived:   "bg-zinc-800 text-zinc-500",
};

export default function ObservePage() {
  const [sessions, setSessions] = useState<ObservationSession[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/observe/sessions")
      .then((r) => r.json())
      .then((data) => { setSessions(data.sessions ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Observation Sessions</h1>
        <p className="text-zinc-400 text-sm mt-1">Expert GTM sessions captured by the browser extension</p>
      </div>

      {loading ? (
        <div className="text-zinc-500 text-sm">Loading...</div>
      ) : sessions.length === 0 ? (
        <div className="text-center py-16 text-zinc-600">
          <p className="text-3xl mb-3">🔭</p>
          <p className="text-sm font-medium text-zinc-500 mb-1">No sessions yet</p>
          <p className="text-xs">Install the Chrome extension to start capturing expert behavior</p>
        </div>
      ) : (
        <div className="space-y-2">
          {sessions.map((session) => {
            const durationMin = session.ended_at
              ? Math.round((new Date(session.ended_at).getTime() - new Date(session.started_at).getTime()) / 60000)
              : null;
            return (
              <Link
                key={session.id}
                href={`/observe/${session.id}`}
                className="flex items-center gap-4 border border-zinc-800 rounded-xl px-5 py-4 hover:border-zinc-600 transition-colors bg-zinc-950"
              >
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${STATUS_COLORS[session.status] ?? "bg-zinc-800 text-zinc-400"}`}>
                  {session.status}
                </span>
                <span className="text-sm text-zinc-300 flex-1">
                  {new Date(session.started_at).toLocaleString()}
                </span>
                <div className="flex items-center gap-4 text-xs text-zinc-600 shrink-0">
                  <span>{session.event_count} events</span>
                  <span>{session.distillation_count} narrations</span>
                  {session.coverage_score != null && (
                    <span>{Math.round(session.coverage_score * 100)}% coverage</span>
                  )}
                  {durationMin != null && <span>{durationMin}m</span>}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
