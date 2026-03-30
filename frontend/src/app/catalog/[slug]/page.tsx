"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

interface AgentDetail {
  slug: string;
  name: string;
  category: string;
  description: string;
  intents: string[];
  tools: string[];
  max_iterations: number;
  skip_judge: boolean;
  judge_config: {
    threshold: number;
    rubric: string[];
    need_to_know: string[];
  };
  system_prompt: string;
}

type Tab = "overview" | "prompt" | "rubric";

export default function AgentDetailPage() {
  const { slug } = useParams();
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("overview");

  useEffect(() => {
    fetch(`/api/catalog/${slug}`)
      .then((r) => r.json())
      .then((data) => { setAgent(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [slug]);

  if (loading) return <div className="p-8 text-ink-3 text-sm">Loading...</div>;
  if (!agent) return <div className="p-8 text-ink-3 text-sm">Agent not found.</div>;

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <Link href="/catalog" className="text-ink-3 text-sm hover:text-ink-2 mb-4 inline-block">
        \u2190 Back to catalog
      </Link>
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-ink">{agent.name}</h1>
          <p className="text-ink-3 text-xs font-mono mt-1">{agent.slug}</p>
        </div>
        <div className="flex gap-2 text-xs shrink-0 ml-4">
          <span className="bg-surface text-ink-2 px-2 py-1 rounded">{agent.max_iterations} max iters</span>
          {agent.skip_judge && (
            <span className="bg-amber-100 text-amber-700 px-2 py-1 rounded">skip judge</span>
          )}
        </div>
      </div>

      <p className="text-ink-2 text-sm leading-relaxed mb-6">{agent.description}</p>

      <div className="flex gap-1 mb-6 border-b border-rim">
        {(["overview", "prompt", "rubric"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm transition-colors capitalize border-b-2 -mb-px ${
              tab === t ? "border-brand text-ink" : "border-transparent text-ink-3 hover:text-ink-2"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="space-y-6">
          <div>
            <h3 className="text-xs font-medium text-ink-3 uppercase tracking-wider mb-2">Tools</h3>
            <div className="flex flex-wrap gap-2">
              {agent.tools.map((tool) => (
                <span key={tool} className="text-xs bg-surface border border-rim text-ink-2 px-2 py-1 rounded font-mono">
                  {tool}
                </span>
              ))}
            </div>
          </div>
          <div>
            <h3 className="text-xs font-medium text-ink-3 uppercase tracking-wider mb-2">Intent Keywords</h3>
            <div className="flex flex-wrap gap-2">
              {agent.intents.map((intent) => (
                <span key={intent} className="text-xs bg-surface text-ink-2 px-2 py-1 rounded">
                  {intent}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === "prompt" && (
        <pre className="text-xs text-ink-2 whitespace-pre-wrap bg-surface rounded-xl p-4 leading-relaxed overflow-auto max-h-[600px] border border-rim">
          {agent.system_prompt}
        </pre>
      )}

      {tab === "rubric" && (
        <div className="space-y-6">
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-medium text-ink-3 uppercase tracking-wider">Quality Rubric</h3>
              <span className="text-xs text-ink-3">Pass threshold: {agent.judge_config.threshold}/10</span>
            </div>
            <ul className="space-y-2">
              {agent.judge_config.rubric.map((item, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-ink-2">
                  <span className="text-green-500 mt-0.5 shrink-0">{"\u2713"}</span>
                  {item}
                </li>
              ))}
            </ul>
          </div>
          {agent.judge_config.need_to_know.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-ink-3 uppercase tracking-wider mb-3">Need to Know</h3>
              <ul className="space-y-2">
                {agent.judge_config.need_to_know.map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-ink-2">
                    <span className="text-amber-500 mt-0.5 shrink-0">?</span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
