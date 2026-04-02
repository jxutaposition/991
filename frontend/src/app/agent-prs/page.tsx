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
  enhancement:      "bg-blue-100 text-blue-700",
  new_agent:        "bg-green-100 text-green-700",
  example_addition: "bg-purple-100 text-purple-700",
  reclassification: "bg-amber-100 text-amber-700",
};

export default function AgentPRsPage() {
  const [prs, setPrs] = useState<AgentPR[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("open");

  useEffect(() => {
    setLoading(true);
    fetch(`/api/agent-prs?status=${filter}`)
      .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then((data) => { setPrs(data.prs ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [filter]);

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-ink">Agent PRs</h1>
          <p className="text-ink-2 text-sm mt-1">Proposed agent updates from observation sessions</p>
        </div>
        <div className="flex gap-1 bg-surface rounded-lg p-1">
          {["open", "approved", "rejected"].map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`px-3 py-1 rounded-md text-xs capitalize transition-colors ${
                filter === s ? "bg-page text-ink shadow-sm" : "text-ink-3 hover:text-ink-2"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="text-ink-3 text-sm">Loading...</div>
      ) : prs.length === 0 ? (
        <div className="text-center py-16 text-ink-3">
          <p className="text-3xl mb-3">{"\u2713"}</p>
          <p className="text-sm">No {filter} PRs</p>
        </div>
      ) : (
        <div className="space-y-2">
          {prs.map((pr) => (
            <Link
              key={pr.id}
              href={`/agent-prs/${pr.id}`}
              className="flex items-center gap-4 border border-rim rounded-xl px-5 py-4 hover:border-rim-strong transition-colors bg-page"
            >
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${PR_TYPE_COLORS[pr.pr_type] ?? "bg-surface text-ink-2"}`}>
                {pr.pr_type.replace(/_/g, " ")}
              </span>
              <span className="text-sm font-medium text-ink shrink-0 w-40 truncate font-mono">
                {pr.target_agent_slug ?? pr.proposed_slug ?? "unknown"}
              </span>
              <span className="text-sm text-ink-2 flex-1 truncate">{pr.gap_summary}</span>
              <div className="flex items-center gap-3 shrink-0 text-xs text-ink-3">
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
