"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Trash2, ArrowLeft } from "lucide-react";
import { useAuth } from "@/lib/auth-context";

interface SessionSummary {
  id: string;
  request_text: string;
  status: string;
  node_count: number;
  passed_count: number;
  created_at: string;
  completed_at: string | null;
}

const STATUS_BADGE: Record<string, string> = {
  awaiting_approval: "bg-amber-50 text-amber-700",
  executing: "bg-blue-50 text-blue-700",
  completed: "bg-green-50 text-green-700",
  failed: "bg-red-50 text-red-700",
  planning: "bg-gray-100 text-gray-600",
};

export default function ExecutePage() {
  const { apiFetch } = useAuth();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  useEffect(() => {
    apiFetch("/api/execute/sessions")
      .then((r) => {
        if (!r.ok) throw new Error(r.statusText);
        return r.json();
      })
      .then((data) => {
        setSessions(data.sessions ?? []);
        setSessionsLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load sessions:", err);
        setSessionsLoading(false);
      });
  }, [apiFetch]);

  const handleDeleteSession = async (
    e: React.MouseEvent,
    sessionId: string
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm("Delete this session? This cannot be undone.")) return;
    try {
      const res = await apiFetch(`/api/execute/${sessionId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(await res.text());
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    } catch (err) {
      console.error("Failed to delete session:", err);
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="flex items-center gap-3 mb-6">
        <Link
          href="/"
          className="p-1.5 rounded-lg text-ink-3 hover:text-ink hover:bg-surface transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div>
          <h1 className="text-xl font-bold text-ink">All Sessions</h1>
          <p className="text-ink-2 text-sm mt-0.5">
            View and manage your workflow sessions
          </p>
        </div>
      </div>

      {sessionsLoading ? (
        <p className="text-ink-3 text-sm">Loading...</p>
      ) : sessions.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-ink-3 text-sm mb-3">No sessions yet.</p>
          <Link
            href="/"
            className="text-sm text-brand hover:text-brand-hover transition-colors"
          >
            Create your first workflow
          </Link>
        </div>
      ) : (
        <div className="space-y-2">
          {sessions.map((session) => (
            <Link
              key={session.id}
              href={`/execute/${session.id}`}
              className="flex items-center gap-4 border border-rim rounded-xl px-5 py-4 hover:border-rim-strong transition-colors bg-page group"
            >
              <span
                className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 capitalize ${
                  STATUS_BADGE[session.status] ?? "bg-gray-100 text-gray-600"
                }`}
              >
                {session.status.replace(/_/g, " ")}
              </span>
              <span className="text-sm text-ink flex-1 truncate group-hover:text-brand transition-colors">
                {session.request_text}
              </span>
              <div className="flex items-center gap-3 shrink-0 text-xs text-ink-3">
                <span>
                  {session.passed_count}/{session.node_count} passed
                </span>
                <span>
                  {new Date(session.created_at).toLocaleDateString()}
                </span>
                <button
                  onClick={(e) => handleDeleteSession(e, session.id)}
                  className="p-1 rounded hover:bg-red-50 hover:text-red-500 text-ink-3 transition-colors"
                  title="Delete session"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
