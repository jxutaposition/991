"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

const EXAMPLE_REQUESTS = [
  "Run cold outbound to fintech companies 50-500 employees in NYC — get me 50 personalized emails ready to send",
  "Launch a lead gen campaign on Meta and Google for our new product, $5k budget",
  "We got 200 leads from SaaStr, qualify them and reach out via email and LinkedIn within 48 hours",
  "Analyze our Q1 outbound performance and build a Q2 campaign plan",
];

export default function ExecutePage() {
  const router = useRouter();
  const [request, setRequest] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!request.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      router.push(`/execute/${data.session_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setLoading(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      <h1 className="text-2xl font-bold text-white mb-2">New Workflow</h1>
      <p className="text-zinc-400 text-sm mb-8">
        Describe your GTM goal. lele will build a plan and show it to you before executing.
      </p>

      <div className="space-y-4">
        <textarea
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.metaKey) handleSubmit();
          }}
          placeholder="What do you want to accomplish?"
          rows={4}
          className="w-full bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 resize-none focus:outline-none focus:border-zinc-500"
        />

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button
          onClick={handleSubmit}
          disabled={loading || !request.trim()}
          className="bg-white text-zinc-950 px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? "Planning..." : "Build plan →"}
        </button>
      </div>

      <div className="mt-10">
        <p className="text-xs text-zinc-600 uppercase tracking-wider mb-3">Example requests</p>
        <div className="space-y-2">
          {EXAMPLE_REQUESTS.map((example) => (
            <button
              key={example}
              onClick={() => setRequest(example)}
              className="w-full text-left text-sm text-zinc-400 hover:text-zinc-200 bg-zinc-900 hover:bg-zinc-800 rounded-lg px-4 py-3 transition-colors border border-zinc-800 hover:border-zinc-700"
            >
              {example}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
