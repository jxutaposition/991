"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

interface Distillation {
  id: string;
  sequence_ref: number;
  narrator_text: string;
  expert_correction: string | null;
  created_at: string;
}

interface ObservationSessionDetail {
  id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  event_count: number;
  distillation_count: number;
  coverage_score: number | null;
  distillations: Distillation[];
}

export default function ObserveSessionPage() {
  const { session_id } = useParams();
  const [session, setSession] = useState<ObservationSessionDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/observe/sessions/${session_id}`)
      .then((r) => r.json())
      .then((data) => { setSession(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [session_id]);

  if (loading) return <div className="p-8 text-zinc-500 text-sm">Loading...</div>;
  if (!session) return <div className="p-8 text-zinc-500 text-sm">Session not found.</div>;

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <Link href="/observe" className="text-zinc-500 text-sm hover:text-zinc-300 mb-4 inline-block">
        ← Back to sessions
      </Link>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">Observation Session</h1>
          <p className="text-zinc-400 text-sm mt-1">
            {new Date(session.started_at).toLocaleString()} · {session.event_count} events · {session.distillation_count} narrations
            {session.coverage_score != null && ` · ${Math.round(session.coverage_score * 100)}% coverage`}
          </p>
        </div>
        <span className="text-xs text-zinc-500 bg-zinc-900 px-3 py-1 rounded-full">{session.status}</span>
      </div>

      <div className="space-y-3">
        {session.distillations.map((d) => (
          <div key={d.id} className="border border-zinc-800 rounded-xl p-4 bg-zinc-950">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs text-zinc-700 font-mono">seq:{d.sequence_ref}</span>
              <span className="text-xs text-zinc-700">{new Date(d.created_at).toLocaleTimeString()}</span>
            </div>
            <p className="text-sm text-zinc-300 leading-relaxed">{d.narrator_text}</p>
            {d.expert_correction && (
              <div className="mt-3 pt-3 border-t border-zinc-800">
                <p className="text-xs text-amber-500 font-medium mb-1">Expert correction:</p>
                <p className="text-sm text-zinc-400 leading-relaxed">{d.expert_correction}</p>
              </div>
            )}
          </div>
        ))}
        {session.distillations.length === 0 && (
          <p className="text-zinc-600 text-sm text-center py-8">No narrations recorded for this session.</p>
        )}
      </div>
    </div>
  );
}
