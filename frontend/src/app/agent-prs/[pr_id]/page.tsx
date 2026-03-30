"use client";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

interface FileDiff {
  file_path: string;
  old_content: string | null;
  new_content: string;
}

interface AgentPRDetail {
  id: string;
  pr_type: string;
  target_agent_slug: string | null;
  proposed_slug: string | null;
  file_diffs: FileDiff[];
  reasoning: string;
  gap_summary: string;
  confidence: number;
  evidence_count: number;
  status: string;
  created_at: string;
}

export default function PRDetailPage() {
  const { pr_id } = useParams();
  const router = useRouter();
  const [pr, setPR] = useState<AgentPRDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [actioning, setActioning] = useState(false);

  useEffect(() => {
    fetch(`/api/agent-prs/${pr_id}`)
      .then((r) => r.json())
      .then((data) => { setPR(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [pr_id]);

  const action = async (act: "approve" | "reject") => {
    setActioning(true);
    await fetch(`/api/agent-prs/${pr_id}/${act}`, { method: "POST" }).catch(() => null);
    router.push("/agent-prs");
  };

  if (loading) return <div className="p-8 text-zinc-500 text-sm">Loading...</div>;
  if (!pr) return <div className="p-8 text-zinc-500 text-sm">PR not found.</div>;

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <Link href="/agent-prs" className="text-zinc-500 text-sm hover:text-zinc-300 mb-4 inline-block">
        ← Back to PRs
      </Link>
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">
            {pr.pr_type.replace(/_/g, " ")} — <span className="font-mono">{pr.target_agent_slug ?? pr.proposed_slug}</span>
          </h1>
          <p className="text-zinc-400 text-sm mt-1">{pr.gap_summary}</p>
          <div className="flex items-center gap-3 mt-2 text-xs text-zinc-600">
            <span>{Math.round((pr.confidence ?? 0) * 100)}% confidence</span>
            <span>·</span>
            <span>{pr.evidence_count} evidence tasks</span>
            <span>·</span>
            <span>{new Date(pr.created_at).toLocaleDateString()}</span>
          </div>
        </div>
        {pr.status === "open" && (
          <div className="flex gap-2 shrink-0 ml-4">
            <button
              onClick={() => action("reject")}
              disabled={actioning}
              className="border border-zinc-700 text-zinc-400 px-3 py-1.5 rounded-lg text-sm hover:border-zinc-500 disabled:opacity-50"
            >
              Reject
            </button>
            <button
              onClick={() => action("approve")}
              disabled={actioning}
              className="bg-green-700 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-green-600 disabled:opacity-50"
            >
              Approve & Merge
            </button>
          </div>
        )}
      </div>

      <div className="space-y-6">
        <div className="bg-zinc-900 rounded-xl p-4">
          <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-3">Analysis</h3>
          <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">{pr.reasoning}</p>
        </div>

        <div>
          <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-3">File Changes</h3>
          {pr.file_diffs.map((diff, i) => (
            <div key={i} className="border border-zinc-800 rounded-xl overflow-hidden mb-3">
              <div className="bg-zinc-900 px-4 py-2 border-b border-zinc-800 flex items-center justify-between">
                <span className="text-xs font-mono text-zinc-400">{diff.file_path}</span>
                <span className="text-xs text-zinc-600">{diff.old_content ? "modified" : "new file"}</span>
              </div>
              <div className="overflow-auto max-h-80">
                <pre className="text-xs text-zinc-300 p-4 whitespace-pre-wrap leading-relaxed">
                  {diff.new_content}
                </pre>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
