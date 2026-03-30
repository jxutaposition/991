"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

interface AgentPR {
  id: string;
  pr_type: string;
  target_agent_slug: string | null;
  proposed_slug: string | null;
  gap_summary: string;
  confidence: number;
  evidence_count: number;
  status: string;
  created_at: string;
}

const PR_TYPE_COLORS: Record<string, string> = {
  enhancement:      "bg-blue-900/40 text-blue-400",
  new_agent:        "bg-green-900/40 text-green-400",
  example_addition: "bg-purple-900/40 text-purple-400",
  reclassification: "bg-amber-900/40 text-amber-400",
};

export default function AgentPRsPage() {
  const [prs, setPrs] = useState<AgentPR[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("open");

  useEffect(() => {
    fetch(`/api/agent-prs?status=${filter}`)
      .then((r) => r.json())
      .then((data) => { setPrs(data.prs ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [filter]);

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Agent PRs</h1>
          <p className="text-zinc-400 text-sm mt-1">Proposed agent updates from observation sessions</p>
        </div>
        <div className="flex gap-1 bg-zinc-900 rounded-lg p-1">
          {["open", "approved", "rejected"].map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`px-3 py-1 rounded-md text-xs capitalize transition-colors ${
                filter === s ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="text-zinc-500 text-sm">Loading...</div>
      ) : prs.length === 0 ? (
        <div className="text-center py-16 text-zinc-600">
          <p className="text-3xl mb-3">✓</p>
          <p className="text-sm">No {filter} PRs</p>
        </div>
      ) : (
        <div className="space-y-2">
          {prs.map((pr) => (
            <Link
              key={pr.id}
              href={`/agent-prs/${pr.id}`}
              className="flex items-center gap-4 border border-zinc-800 rounded-xl px-5 py-4 hover:border-zinc-600 transition-colors bg-zinc-950"
            >
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${PR_TYPE_COLORS[pr.pr_type] ?? "bg-zinc-800 text-zinc-400"}`}>
                {pr.pr_type.replace(/_/g, " ")}
              </span>
              <span className="text-sm font-medium text-zinc-300 shrink-0 w-40 truncate font-mono">
                {pr.target_agent_slug ?? pr.proposed_slug ?? "unknown"}
              </span>
              <span className="text-sm text-zinc-500 flex-1 truncate">{pr.gap_summary}</span>
              <div className="flex items-center gap-3 shrink-0 text-xs text-zinc-600">
                <span>{Math.round((pr.confidence ?? 0) * 100)}% conf</span>
                <span>{pr.evidence_count} evidence</span>
                <span>{new Date(pr.created_at).toLocaleDateString()}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
