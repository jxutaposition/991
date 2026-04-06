"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { SESSION_STATUS_BADGE } from "@/lib/utils";
import {
  Mail,
  Target,
  Megaphone,
  BarChart3,
  RefreshCw,
  ArrowRight,
  Send,
} from "lucide-react";
import { ModelSelector, type ModelOption } from "@/components/ui/model-selector";

const CATEGORIES = [
  { label: "Outbound", icon: Mail, template: "Run a cold outbound campaign to " },
  { label: "Lead Gen", icon: Target, template: "Generate qualified leads for " },
  { label: "Ads", icon: Megaphone, template: "Launch a paid ads campaign for " },
  { label: "CRM Ops", icon: RefreshCw, template: "Sync and update our CRM with " },
  { label: "Analytics", icon: BarChart3, template: "Analyze our Q1 performance and " },
];

const EXAMPLE_PROMPTS = [
  "Run cold outbound to fintech companies 50-500 employees in NYC",
  "Launch a lead gen campaign on Meta and Google, $5k budget",
  "Qualify 200 SaaStr leads and reach out via email and LinkedIn",
];

interface SessionSummary {
  id: string;
  request_text: string;
  status: string;
  node_count: number;
  passed_count: number;
  created_at: string;
  client_slug?: string | null;
}

const STATUS_BADGE = SESSION_STATUS_BADGE;

export default function HomePage() {
  const router = useRouter();
  const { user, activeClient, loading: authLoading, apiFetch, token } = useAuth();
  const [request, setRequest] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [defaultModel, setDefaultModel] = useState<string>("");

  useEffect(() => {
    if (!token) return;
    apiFetch("/api/models")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.models) {
          setModels(data.models);
          setDefaultModel(data.default ?? data.models[0]?.id ?? "");
          setSelectedModel(data.default ?? data.models[0]?.id ?? "");
        }
      })
      .catch(() => {});
  }, [token, apiFetch]);

  useEffect(() => {
    if (!token) { setSessionsLoading(false); return; }
    apiFetch("/api/execute/sessions")
      .then((r) => {
        if (!r.ok) throw new Error(r.statusText);
        return r.json();
      })
      .then((data) => {
        setSessions((data.sessions ?? []).slice(0, 6));
        setSessionsLoading(false);
      })
      .catch(() => setSessionsLoading(false));
  }, [token, apiFetch]);

  const handleSubmit = async () => {
    if (!request.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/execute", {
        method: "POST",
        body: JSON.stringify({
          request_text: request,
          client_slug: activeClient || undefined,
          model: selectedModel || undefined,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      router.push(`/execute/${data.session_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setLoading(false);
    }
  };

  const greeting = user?.name
    ? `Hi ${user.name.split(" ")[0]}, what do you want to build?`
    : "What do you want to build?";

  return (
    <div className="flex flex-col items-center px-6 pt-[12vh] pb-12 min-h-full">
      {/* Workspace badge */}
      {activeClient && (
        <div className="flex items-center gap-2 mb-6">
          <span className="w-6 h-6 rounded-full flex items-center justify-center bg-brand text-white text-xs font-bold">
            {user?.name?.charAt(0).toUpperCase() ?? "L"}
          </span>
          <span className="text-xs text-ink-3">{activeClient}</span>
        </div>
      )}

      {/* Greeting */}
      <h1 className="text-3xl font-bold tracking-tight text-ink mb-8 text-center">
        {greeting}
      </h1>

      {/* Chat input */}
      <div className="w-full max-w-2xl mb-6">
        <div className="relative border border-rim rounded-2xl bg-page shadow-sm hover:border-rim-strong focus-within:border-brand focus-within:shadow-md transition-all">
          <textarea
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder="Describe your GTM flow, Lele will assemble your project..."
            rows={2}
            className="w-full bg-transparent px-5 pt-4 pb-12 text-sm text-ink placeholder-ink-3 resize-none focus:outline-none rounded-2xl"
          />
          <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              {!authLoading && !activeClient && (
                <span className="text-[11px] text-amber-600">
                  No workspace selected
                </span>
              )}
              {models.length > 0 && (
                <ModelSelector
                  models={models}
                  value={selectedModel}
                  onChange={setSelectedModel}
                  defaultModel={defaultModel}
                  compact
                  openUpward
                  label=""
                />
              )}
            </div>
            <button
              onClick={handleSubmit}
              disabled={loading || !request.trim() || authLoading}
              className="flex items-center gap-1.5 bg-brand text-white px-4 py-1.5 rounded-lg text-xs font-medium hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? "Starting..." : "Build plan"}
              <Send className="w-3 h-3" />
            </button>
          </div>
        </div>
        {error && (
          <p className="text-danger text-sm mt-2 text-center">{error}</p>
        )}
      </div>

      {/* Category pills */}
      <div className="flex flex-wrap items-center justify-center gap-2 mb-8">
        {CATEGORIES.map((cat) => {
          const Icon = cat.icon;
          return (
            <button
              key={cat.label}
              onClick={() => setRequest(cat.template)}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-full border border-rim bg-page text-xs text-ink-2 hover:border-rim-strong hover:text-ink hover:bg-surface transition-colors"
            >
              <Icon className="w-3.5 h-3.5" />
              {cat.label}
            </button>
          );
        })}
      </div>

      {/* Example prompts */}
      <div className="w-full max-w-2xl mb-12">
        <p className="text-xs text-ink-3 text-center mb-3">
          Try an example prompt
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          {EXAMPLE_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              onClick={() => setRequest(prompt)}
              className="px-3.5 py-2 rounded-full border border-rim bg-surface text-xs text-ink-2 hover:border-rim-strong hover:text-ink transition-colors max-w-xs truncate"
            >
              {prompt}
            </button>
          ))}
        </div>
      </div>

      {/* Recent sessions */}
      <div className="w-full max-w-4xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-ink">Your recent Projects</h2>
          {sessions.length > 0 && (
            <Link
              href="/execute"
              className="flex items-center gap-1 text-xs text-ink-3 hover:text-ink transition-colors"
            >
              View All <ArrowRight className="w-3 h-3" />
            </Link>
          )}
        </div>

        {sessionsLoading ? (
          <p className="text-ink-3 text-xs">Loading...</p>
        ) : sessions.length === 0 ? (
          <p className="text-ink-3 text-xs text-center py-8">
            No projects yet. Describe a GTM goal above to get started.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {sessions.map((session) => (
              <Link
                key={session.id}
                href={`/execute/${session.id}`}
                className="group border border-rim rounded-xl p-4 bg-page hover:border-rim-strong hover:shadow-sm transition-all"
              >
                <div className="flex items-center gap-2 mb-2">
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full capitalize ${
                      STATUS_BADGE[session.status] ?? "bg-gray-100 text-gray-600"
                    }`}
                  >
                    {session.status.replace(/_/g, " ")}
                  </span>
                  {session.client_slug && (
                    <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-violet-50 text-violet-600 border border-violet-200 truncate max-w-[120px]">
                      {session.client_slug}
                    </span>
                  )}
                  <span className="text-xs text-ink-3 ml-auto">
                    {new Date(session.created_at).toLocaleDateString()}
                  </span>
                </div>
                <p className="text-sm text-ink line-clamp-2 group-hover:text-brand transition-colors">
                  {session.request_text}
                </p>
                <p className="text-xs text-ink-3 mt-2">
                  {session.passed_count}/{session.node_count} steps passed
                </p>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
