"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

interface AgentSummary {
  slug: string;
  name: string;
  category: string;
  description: string;
  intents: string[];
}

const CATEGORY_LABELS: Record<string, string> = {
  research: "Research",
  lead_management: "Lead Management",
  email_outreach: "Email Outreach",
  social_outreach: "Social / Direct",
  content_creative: "Content & Creative",
  advertising: "Advertising",
  analytics: "Analytics",
};

export default function CatalogPage() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/catalog")
      .then((r) => r.json())
      .then((data) => {
        setAgents(data.agents ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const categories = Array.from(new Set(agents.map((a) => a.category)));
  const filtered = agents.filter((a) => {
    const q = search.toLowerCase();
    const matchesSearch =
      !q ||
      a.name.toLowerCase().includes(q) ||
      a.description.toLowerCase().includes(q) ||
      a.intents.some((i) => i.toLowerCase().includes(q));
    const matchesCategory = !selectedCategory || a.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Agent Catalog</h1>
          <p className="text-zinc-400 text-sm mt-1">{agents.length} expert-trained agents</p>
        </div>
        <input
          type="text"
          placeholder="Search agents..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 w-64 focus:outline-none focus:border-zinc-500"
        />
      </div>

      <div className="flex gap-2 mb-6 flex-wrap">
        <button
          onClick={() => setSelectedCategory(null)}
          className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
            !selectedCategory ? "bg-zinc-100 text-zinc-900" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
          }`}
        >
          All
        </button>
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setSelectedCategory(cat === selectedCategory ? null : cat)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              selectedCategory === cat ? "bg-zinc-100 text-zinc-900" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
            }`}
          >
            {CATEGORY_LABELS[cat] ?? cat}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-zinc-500 text-sm">Loading catalog...</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((agent) => (
            <Link
              key={agent.slug}
              href={`/catalog/${agent.slug}`}
              className="border border-zinc-800 rounded-xl p-4 hover:border-zinc-600 transition-colors bg-zinc-950 group"
            >
              <div className="flex items-start justify-between mb-2">
                <h3 className="text-sm font-semibold text-white group-hover:text-zinc-100">
                  {agent.name}
                </h3>
                <span className="text-xs text-zinc-500 bg-zinc-900 px-2 py-0.5 rounded-full ml-2 shrink-0">
                  {CATEGORY_LABELS[agent.category] ?? agent.category}
                </span>
              </div>
              <p className="text-xs text-zinc-400 leading-relaxed line-clamp-3">{agent.description}</p>
              <div className="flex flex-wrap gap-1 mt-3">
                {agent.intents.slice(0, 3).map((intent) => (
                  <span key={intent} className="text-xs text-zinc-600 bg-zinc-900 px-2 py-0.5 rounded-full">
                    {intent}
                  </span>
                ))}
              </div>
            </Link>
          ))}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="text-zinc-500 text-sm py-12 text-center">No agents match your search.</div>
      )}
    </div>
  );
}
