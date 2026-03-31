"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

const EXAMPLE_REQUESTS = [
  "Run cold outbound to fintech companies 50-500 employees in NYC \u2014 get me 50 personalized emails ready to send",
  "Launch a lead gen campaign on Meta and Google for our new product, $5k budget",
  "We got 200 leads from SaaStr, qualify them and reach out via email and LinkedIn within 48 hours",
  "Analyze our Q1 outbound performance and build a Q2 campaign plan",
];

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
  const router = useRouter();
  const [request, setRequest] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [models, setModels] = useState<{ id: string; name: string; description: string }[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  useEffect(() => {
    fetch("/api/models")
      .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then((data) => {
        setModels(data.models ?? []);
        setSelectedModel(data.default ?? "");
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/execute/sessions")
      .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then((data) => {
        setSessions(data.sessions ?? []);
        setSessionsLoading(false);
      })
      .catch(() => setSessionsLoading(false));
  }, []);

  const handleSubmit = async () => {
    if (!request.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_text: request, model: selectedModel || undefined }),
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
    <div className="max-w-4xl mx-auto px-6 py-12">
      <h1 className="text-2xl font-bold text-ink mb-2">New Workflow</h1>
      <p className="text-ink-2 text-sm mb-8">
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
          className="w-full bg-page border border-rim rounded-xl px-4 py-3 text-sm text-ink placeholder-ink-3 resize-none focus:outline-none focus:border-brand"
        />

        {error && <p className="text-danger text-sm">{error}</p>}

        <div className="flex items-center gap-3">
          <button
            onClick={handleSubmit}
            disabled={loading || !request.trim()}
            className="bg-brand text-white px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? "Planning\u2026" : "Build plan \u2192"}
          </button>
          {models.length > 0 && (
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="bg-page border border-rim rounded-lg px-3 py-2 text-xs text-ink-2 focus:outline-none focus:border-brand"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div className="mt-10">
        <p className="text-xs text-ink-3 uppercase tracking-wider mb-3">Example requests</p>
        <div className="space-y-2">
          {EXAMPLE_REQUESTS.map((example) => (
            <button
              key={example}
              onClick={() => setRequest(example)}
              className="w-full text-left text-sm text-ink-2 hover:text-ink bg-surface hover:bg-raised rounded-lg px-4 py-3 transition-colors border border-rim hover:border-rim-strong"
            >
              {example}
            </button>
          ))}
        </div>
      </div>

      {/* Previous Sessions */}
      <div className="mt-12">
        <h2 className="text-lg font-semibold text-ink mb-4">Previous Sessions</h2>
        {sessionsLoading ? (
          <p className="text-ink-3 text-sm">Loading...</p>
        ) : sessions.length === 0 ? (
          <p className="text-ink-3 text-sm">No previous sessions. Create your first workflow above.</p>
        ) : (
          <div className="space-y-2">
            {sessions.map((session) => (
              <Link
                key={session.id}
                href={`/execute/${session.id}`}
                className="flex items-center gap-4 border border-rim rounded-xl px-5 py-4 hover:border-rim-strong transition-colors bg-page group"
              >
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 capitalize ${STATUS_BADGE[session.status] ?? "bg-gray-100 text-gray-600"}`}>
                  {session.status.replace(/_/g, " ")}
                </span>
                <span className="text-sm text-ink flex-1 truncate group-hover:text-brand transition-colors">
                  {session.request_text}
                </span>
                <div className="flex items-center gap-3 shrink-0 text-xs text-ink-3">
                  <span>{session.passed_count}/{session.node_count} passed</span>
                  <span>{new Date(session.created_at).toLocaleDateString()}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
