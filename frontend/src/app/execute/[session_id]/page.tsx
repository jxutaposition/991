"use client";
import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { ExecutionCanvas } from "@/components/execution-canvas";

interface ExecutionNode {
  id: string;
  agent_slug: string;
  task_description: string;
  status: string;
  requires: string[];
  judge_score: number | null;
  judge_feedback: string | null;
  output: unknown;
  attempt_count: number;
}

interface ExecutionSession {
  id: string;
  request_text: string;
  status: string;
  nodes: ExecutionNode[];
  plan_approved_at: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  planning: "text-zinc-400",
  awaiting_approval: "text-amber-400",
  executing: "text-blue-400",
  completed: "text-green-400",
  failed: "text-red-400",
};

export default function SessionPage() {
  const { session_id } = useParams();
  const [session, setSession] = useState<ExecutionSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);

  const fetchSession = useCallback(() => {
    fetch(`/api/execute/${session_id}`)
      .then((r) => r.json())
      .then((data) => {
        setSession(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [session_id]);

  useEffect(() => {
    fetchSession();
  }, [fetchSession]);

  useEffect(() => {
    if (!session || session.status === "planning" || session.status === "awaiting_approval") return;
    const es = new EventSource(`/api/execute/${session_id}/events`);
    es.onmessage = () => fetchSession();
    es.onerror = () => es.close();
    return () => es.close();
  }, [session_id, session?.status, fetchSession]);

  const handleApprove = async () => {
    setApproving(true);
    try {
      await fetch(`/api/execute/${session_id}/approve`, { method: "POST" });
      fetchSession();
    } finally {
      setApproving(false);
    }
  };

  if (loading) return <div className="p-8 text-zinc-500 text-sm">Loading plan...</div>;
  if (!session) return <div className="p-8 text-zinc-500 text-sm">Session not found.</div>;

  return (
    <div className="flex flex-col h-[calc(100vh-49px)]">
      {/* Header */}
      <div className="border-b border-zinc-800 px-6 py-3 flex items-center justify-between bg-zinc-950 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <span className={`text-xs font-medium ${STATUS_COLORS[session.status] ?? "text-zinc-400"}`}>
            {session.status.replace(/_/g, " ").toUpperCase()}
          </span>
          <span className="text-zinc-700">·</span>
          <span className="text-sm text-zinc-400 truncate max-w-xl">{session.request_text}</span>
        </div>
        {session.status === "awaiting_approval" && (
          <button
            onClick={handleApprove}
            disabled={approving}
            className="bg-white text-zinc-950 px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 shrink-0 ml-4"
          >
            {approving ? "Approving..." : "Approve & Execute →"}
          </button>
        )}
      </div>

      {/* Canvas */}
      <div className="flex-1 overflow-hidden">
        <ExecutionCanvas nodes={session.nodes} sessionStatus={session.status} />
      </div>

      {/* Plan list — shown while awaiting approval */}
      {session.status === "awaiting_approval" && (
        <div className="border-t border-zinc-800 bg-zinc-950 p-4 shrink-0 max-h-60 overflow-auto">
          <p className="text-xs text-zinc-500 uppercase tracking-wider mb-3">Execution Plan — {session.nodes.length} steps</p>
          <div className="space-y-2">
            {session.nodes.map((node, i) => (
              <div key={node.id} className="flex items-start gap-3 text-sm">
                <span className="text-zinc-700 shrink-0 w-5 pt-0.5">{i + 1}</span>
                <span className="text-zinc-300 font-mono font-medium shrink-0 w-52 text-xs pt-0.5">{node.agent_slug}</span>
                <span className="text-zinc-500 text-xs leading-relaxed">{node.task_description}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
