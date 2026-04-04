"use client";

import { useEffect, useState, useCallback } from "react";
import { useAuth } from "@/lib/auth-context";
import Link from "next/link";
import { IntegrationIcon } from "@/components/integration-icon";
import { Check, X, ExternalLink, ChevronDown, Search } from "lucide-react";

interface SetupStep {
  label: string;
  help?: string;
  doc_url?: string;
  required?: boolean;
}

interface Integration {
  slug: string;
  name: string;
  auth_type: "api_key" | "oauth2";
  icon: string;
  description: string;
  extra_fields?: string[];
  oauth_configured?: boolean;
  key_url?: string;
  key_help?: string;
  setup_steps?: SetupStep[];
}

interface ConnectedCredential {
  integration_slug: string;
  credential_type: string;
  metadata: Record<string, unknown>;
  updated_at: string;
  validated?: boolean;
}

interface ProbeResultEntry {
  status: string;
  ok: boolean;
  http_status?: number | null;
  error?: string | null;
  hint?: string | null;
  latency_ms?: number;
}

interface Project {
  id: string;
  slug: string;
  name: string;
  client_id: string;
}

export default function IntegrationsPage() {
  const { activeClient, apiFetch } = useAuth();
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [connected, setConnected] = useState<Map<string, ConnectedCredential>>(new Map());
  const [credScopes, setCredScopes] = useState<Record<string, "project" | "inherited">>({});
  const [probeResults, setProbeResults] = useState<Record<string, ProbeResultEntry>>({});
  const [probing, setProbing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [extraFieldValues, setExtraFieldValues] = useState<Record<string, Record<string, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [savingLabel, setSavingLabel] = useState<string>("");
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [connectingOAuth, setConnectingOAuth] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<string | null>(null);

  // Load projects for this client
  useEffect(() => {
    if (!activeClient) return;
    apiFetch(`/api/projects?client_slug=${activeClient}`)
      .then((r) => r.json())
      .then((data) => {
        const list = (data.projects ?? []) as Project[];
        setProjects(list);
      })
      .catch(() => {});
  }, [activeClient, apiFetch]);

  useEffect(() => {
    apiFetch("/api/integrations")
      .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then((data) => setIntegrations(data.integrations ?? []))
      .catch((err) => console.error("Failed to load integrations:", err));
  }, [apiFetch]);

  const credentialBase = activeProject
    ? `/api/projects/${activeProject}`
    : `/api/clients/${activeClient}`;

  const runProbes = useCallback(() => {
    if (!activeClient) return;
    setProbing(true);
    const url = activeProject
      ? `/api/projects/${activeProject}/credential-check?verify=true`
      : `/api/clients/${activeClient}/credential-check?verify=true`;
    apiFetch(url)
      .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then((data) => {
        setProbeResults(data.probe_results ?? {});
        if (data.scopes) setCredScopes(data.scopes);
      })
      .catch((err) => console.error("Failed to run probes:", err))
      .finally(() => setProbing(false));
  }, [activeClient, activeProject, apiFetch]);

  const refreshCredentials = useCallback(() => {
    if (!activeClient) return;
    const url = activeProject
      ? `/api/projects/${activeProject}/credentials`
      : `/api/clients/${activeClient}/credentials`;
    apiFetch(url)
      .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then((data) => {
        const map = new Map<string, ConnectedCredential>();
        const scopes: Record<string, "project" | "inherited"> = {};
        for (const cred of data.credentials ?? []) {
          map.set(cred.integration_slug, cred);
          if (cred.scope) scopes[cred.integration_slug] = cred.scope;
        }
        setConnected(map);
        setCredScopes((prev) => ({ ...prev, ...scopes }));
        setLoading(false);
      })
      .catch((err) => { console.error("Failed to load credentials:", err); setLoading(false); });
  }, [activeClient, activeProject, apiFetch]);

  useEffect(() => {
    setLoading(true);
    setConnected(new Map());
    setProbeResults({});
    setCredScopes({});
    refreshCredentials();
  }, [refreshCredentials]);

  // Run probes once credentials are loaded
  const hasConnected = connected.size > 0;
  useEffect(() => {
    if (hasConnected) runProbes();
  }, [hasConnected, runProbes]);

  // Listen for popup OAuth completions
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type === "oauth_complete") {
        setConnectingOAuth(null);
        if (e.data.status === "connected") {
          refreshCredentials();
          setTimeout(runProbes, 500);
        } else if (e.data.error) {
          setError(`OAuth failed for ${e.data.integration}: ${e.data.error}`);
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [refreshCredentials]);

  const saveApiKey = async (slug: string) => {
    const rawKey = inputValues[slug];
    if (!rawKey || !activeClient) return;
    setSaving(slug);
    setSavingLabel("Validating...");
    setError(null);
    try {
      const extras = extraFieldValues[slug] ?? {};
      const hasExtras = Object.values(extras).some((v) => v.trim());
      const value = hasExtras
        ? JSON.stringify({ api_key: rawKey, ...Object.fromEntries(Object.entries(extras).filter(([, v]) => v.trim())) })
        : rawKey;
      const res = await apiFetch(`${credentialBase}/credentials`, {
        method: "POST",
        body: JSON.stringify({ integration_slug: slug, value }),
      });
      if (res.ok) {
        const result = await res.json().catch(() => ({}));
        setConnected((prev) => {
          const next = new Map(prev);
          next.set(slug, {
            integration_slug: slug,
            credential_type: "api_key",
            metadata: {},
            updated_at: new Date().toISOString(),
            validated: result.validated ?? undefined,
          });
          return next;
        });
        setInputValues((prev) => ({ ...prev, [slug]: "" }));
        setExtraFieldValues((prev) => ({ ...prev, [slug]: {} }));
        setExpandedSlug(null);
        setTimeout(runProbes, 300);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `Failed to save ${slug} credential`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSaving(null);
      setSavingLabel("");
    }
  };

  const disconnect = async (slug: string) => {
    if (!activeClient) return;
    try {
      const res = await apiFetch(`${credentialBase}/credentials/${slug}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `Failed to disconnect ${slug}`);
        return;
      }
      setConnected((prev) => {
        const next = new Map(prev);
        next.delete(slug);
        return next;
      });
      setProbeResults((prev) => {
        const next = { ...prev };
        delete next[slug];
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    }
  };

  const startOAuth = async (slug: string) => {
    if (!activeClient) return;
    setError(null);
    setConnectingOAuth(slug);
    try {
      const callbackUrl = `${window.location.origin}/oauth/callback`;
      const res = await apiFetch(
        `/api/oauth/${slug}/authorize?client_slug=${activeClient}&redirect=${encodeURIComponent(callbackUrl)}`,
      );
      if (res.ok) {
        const data = await res.json();
        const w = 600;
        const h = 700;
        const left = window.screenX + (window.outerWidth - w) / 2;
        const top = window.screenY + (window.outerHeight - h) / 2;
        const popup = window.open(
          data.authorize_url,
          `oauth_${slug}`,
          `width=${w},height=${h},left=${left},top=${top},popup=yes,toolbar=no,menubar=no`,
        );
        if (!popup) {
          window.location.href = data.authorize_url;
        }
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `OAuth failed for ${slug}`);
        setConnectingOAuth(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setConnectingOAuth(null);
    }
  };

  const filtered = integrations.filter(
    (i) =>
      !searchQuery ||
      i.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      i.slug.toLowerCase().includes(searchQuery.toLowerCase()) ||
      i.description.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const connectedList = filtered.filter((i) => connected.has(i.slug));
  const availableList = filtered.filter((i) => !connected.has(i.slug));

  if (!activeClient) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <Link href="/settings" className="text-ink-3 text-sm hover:text-ink-2 mb-4 inline-block">
          {"\u2190"} Settings
        </Link>
        <h1 className="text-xl font-bold text-ink mb-2">Integrations</h1>
        <div className="border border-amber-200 bg-amber-50 rounded-lg p-4 mt-4">
          <p className="text-sm text-amber-800 font-medium">No workspace selected</p>
          <p className="text-sm text-amber-700 mt-1">
            Go to{" "}
            <Link href="/settings" className="text-brand hover:underline font-medium">
              Settings
            </Link>{" "}
            to create or select a workspace before managing integrations.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <Link href="/settings" className="text-ink-3 text-sm hover:text-ink-2 mb-4 inline-block">
        {"\u2190"} Settings
      </Link>
      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-ink">Integrations</h1>
          <p className="text-ink-2 text-sm mt-1">
            Connect external tools so agents can execute real actions
            {activeProject ? (
              <> for project <span className="font-medium">{projects.find(p => p.id === activeProject)?.name ?? activeProject}</span></>
            ) : (
              <> for <span className="font-medium">{activeClient}</span> (workspace defaults)</>
            )}
            .
          </p>
        </div>
        <div className="flex items-center gap-3">
          {projects.length > 0 && (
            <select
              value={activeProject ?? ""}
              onChange={(e) => setActiveProject(e.target.value || null)}
              className="bg-surface border border-rim rounded-lg px-3 py-1.5 text-xs text-ink focus:outline-none focus:border-brand"
            >
              <option value="">Workspace defaults</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          )}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-3" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search integrations..."
              className="pl-8 pr-3 py-1.5 bg-surface border border-rim rounded-lg text-xs text-ink focus:outline-none focus:border-brand w-56"
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="border border-red-200 bg-red-50 rounded-lg p-3 mb-5 flex items-center gap-2">
          <X className="w-4 h-4 text-red-500 shrink-0" />
          <p className="text-sm text-red-700 flex-1">{error}</p>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {loading ? (
        <p className="text-ink-3 text-sm">Loading...</p>
      ) : (
        <>
          {/* Connected integrations */}
          {connectedList.length > 0 && (
            <div className="mb-8">
              <div className="flex items-center gap-3 mb-3">
                <h2 className="text-xs font-semibold text-ink-3 uppercase tracking-wider">
                  Connected ({connectedList.length})
                </h2>
                <button
                  onClick={runProbes}
                  disabled={probing}
                  className="text-[10px] text-ink-3 hover:text-brand transition-colors disabled:opacity-50"
                >
                  {probing ? "Checking..." : "Re-check all"}
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {connectedList.map((integration) => (
                  <IntegrationCard
                    key={integration.slug}
                    integration={integration}
                    credential={connected.get(integration.slug)}
                    probeResult={probeResults[integration.slug]}
                    probing={probing}
                    credScope={activeProject ? credScopes[integration.slug] : undefined}
                    isConnected
                    isExpanded={expandedSlug === integration.slug}
                    onToggleExpand={() => setExpandedSlug(expandedSlug === integration.slug ? null : integration.slug)}
                    onDisconnect={() => disconnect(integration.slug)}
                    onReconnect={() =>
                      integration.auth_type === "oauth2" && integration.oauth_configured
                        ? startOAuth(integration.slug)
                        : setExpandedSlug(integration.slug)
                    }
                    onSaveApiKey={() => saveApiKey(integration.slug)}
                    inputValue={inputValues[integration.slug] ?? ""}
                    onInputChange={(v) => setInputValues((prev) => ({ ...prev, [integration.slug]: v }))}
                    extraFieldValues={extraFieldValues[integration.slug] ?? {}}
                    onExtraFieldChange={(field, v) => setExtraFieldValues((prev) => ({ ...prev, [integration.slug]: { ...(prev[integration.slug] ?? {}), [field]: v } }))}
                    saving={saving === integration.slug}
                    savingLabel={savingLabel}
                    connectingOAuth={connectingOAuth === integration.slug}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Available integrations */}
          {availableList.length > 0 && (
            <div>
              <h2 className="text-xs font-semibold text-ink-3 uppercase tracking-wider mb-3">
                Available ({availableList.length})
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {availableList.map((integration) => (
                  <IntegrationCard
                    key={integration.slug}
                    integration={integration}
                    credential={undefined}
                    isConnected={false}
                    isExpanded={expandedSlug === integration.slug}
                    onToggleExpand={() => setExpandedSlug(expandedSlug === integration.slug ? null : integration.slug)}
                    onStartOAuth={() => startOAuth(integration.slug)}
                    onSaveApiKey={() => saveApiKey(integration.slug)}
                    inputValue={inputValues[integration.slug] ?? ""}
                    onInputChange={(v) => setInputValues((prev) => ({ ...prev, [integration.slug]: v }))}
                    extraFieldValues={extraFieldValues[integration.slug] ?? {}}
                    onExtraFieldChange={(field, v) => setExtraFieldValues((prev) => ({ ...prev, [integration.slug]: { ...(prev[integration.slug] ?? {}), [field]: v } }))}
                    saving={saving === integration.slug}
                    savingLabel={savingLabel}
                    connectingOAuth={connectingOAuth === integration.slug}
                  />
                ))}
              </div>
            </div>
          )}

          {filtered.length === 0 && searchQuery && (
            <p className="text-ink-3 text-sm text-center py-8">No integrations match &ldquo;{searchQuery}&rdquo;</p>
          )}

          {/* Project members section */}
          {activeProject && (
            <ProjectMembersPanel projectId={activeProject} apiFetch={apiFetch} />
          )}
        </>
      )}
    </div>
  );
}

function ProjectMembersPanel({ projectId, apiFetch }: { projectId: string; apiFetch: (url: string, init?: RequestInit) => Promise<Response> }) {
  const [members, setMembers] = useState<{ user_id: string; email: string; name: string; avatar_url?: string; role: string; scope: string }[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    apiFetch(`/api/projects/${projectId}/members`)
      .then((r) => r.json())
      .then((data) => setMembers(data.members ?? []))
      .catch(() => {});
  }, [projectId, apiFetch]);

  useEffect(() => { refresh(); }, [refresh]);

  const invite = async () => {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/members`, {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Failed to invite");
        return;
      }
      setInviteEmail("");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setInviting(false);
    }
  };

  const remove = async (userId: string) => {
    await apiFetch(`/api/projects/${projectId}/members/${userId}`, { method: "DELETE" });
    refresh();
  };

  return (
    <div className="mt-8 border-t border-rim pt-6">
      <h2 className="text-xs font-semibold text-ink-3 uppercase tracking-wider mb-3">
        Project Members
      </h2>
      <p className="text-[11px] text-ink-3 mb-4">
        People with access to this project and its credentials. Workspace-level members are inherited automatically.
      </p>

      {error && (
        <div className="border border-red-200 bg-red-50 rounded-lg p-2 mb-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Invite form */}
      <div className="flex gap-2 mb-4">
        <input
          type="email"
          value={inviteEmail}
          onChange={(e) => setInviteEmail(e.target.value)}
          placeholder="Email address"
          className="flex-1 bg-surface border border-rim rounded-lg px-3 py-1.5 text-xs text-ink focus:outline-none focus:border-brand"
          onKeyDown={(e) => e.key === "Enter" && invite()}
        />
        <select
          value={inviteRole}
          onChange={(e) => setInviteRole(e.target.value)}
          className="bg-surface border border-rim rounded-lg px-2 py-1.5 text-xs text-ink"
        >
          <option value="viewer">Viewer</option>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <button
          onClick={invite}
          disabled={!inviteEmail.trim() || inviting}
          className="bg-brand text-white px-4 py-1.5 rounded-lg text-xs font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors"
        >
          {inviting ? "Inviting..." : "Invite"}
        </button>
      </div>

      {/* Members list */}
      <div className="space-y-1">
        {members.length === 0 && (
          <p className="text-ink-3 text-xs py-2">No members yet. Invite someone by email above.</p>
        )}
        {members.map((m) => (
          <div key={m.user_id} className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-surface transition-colors">
            <div className="w-7 h-7 rounded-full bg-brand/10 flex items-center justify-center text-xs font-medium text-brand shrink-0">
              {m.avatar_url ? (
                <img src={m.avatar_url} alt="" className="w-7 h-7 rounded-full" />
              ) : (
                m.name?.[0]?.toUpperCase() ?? m.email[0].toUpperCase()
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-ink truncate">{m.name || m.email}</p>
              {m.name && <p className="text-[10px] text-ink-3 truncate">{m.email}</p>}
            </div>
            <span
              className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${
                m.scope === "inherited"
                  ? "bg-gray-50 text-ink-3 border border-gray-100"
                  : "bg-blue-50 text-blue-600 border border-blue-100"
              }`}
            >
              {m.scope === "inherited" ? "Workspace" : m.role}
            </span>
            {m.scope !== "inherited" && (
              <button
                onClick={() => remove(m.user_id)}
                className="text-[10px] text-red-400 hover:text-red-600 px-1"
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const EXTRA_FIELD_LABELS: Record<string, { label: string; placeholder: string }> = {
  project_url: { label: "Project URL", placeholder: "https://your-project.supabase.co" },
  base_url: { label: "Instance URL", placeholder: "https://your-n8n-instance.com" },
};

function IntegrationCard({
  integration,
  credential,
  probeResult,
  probing,
  credScope,
  isConnected,
  isExpanded,
  onToggleExpand,
  onDisconnect,
  onReconnect,
  onStartOAuth,
  onSaveApiKey,
  inputValue,
  onInputChange,
  extraFieldValues,
  onExtraFieldChange,
  saving,
  savingLabel,
  connectingOAuth,
}: {
  integration: Integration;
  credential?: ConnectedCredential;
  probeResult?: ProbeResultEntry;
  probing?: boolean;
  credScope?: "project" | "inherited";
  isConnected: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onDisconnect?: () => void;
  onReconnect?: () => void;
  onStartOAuth?: () => void;
  onSaveApiKey: () => void;
  inputValue: string;
  onInputChange: (v: string) => void;
  extraFieldValues: Record<string, string>;
  onExtraFieldChange: (field: string, v: string) => void;
  saving: boolean;
  savingLabel: string;
  connectingOAuth: boolean;
}) {
  const isOAuth = integration.auth_type === "oauth2";
  const hasOAuthConfig = isOAuth && integration.oauth_configured;

  return (
    <div
      id={integration.slug}
      className={`rounded-xl border transition-all ${
        isConnected
          ? probeResult && !probeResult.ok
            ? "border-red-200 bg-red-50/20"
            : "border-green-200 bg-green-50/30"
          : "border-rim bg-page hover:border-rim-strong"
      }`}
    >
      {/* Card header */}
      <div className="flex items-center gap-3 p-4">
        <div className="shrink-0 w-10 h-10 rounded-lg bg-surface border border-rim flex items-center justify-center">
          <IntegrationIcon slug={integration.slug} size={24} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm text-ink">{integration.name}</span>
            <span
              className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${
                isOAuth
                  ? "bg-purple-50 text-purple-600 border border-purple-100"
                  : "bg-gray-50 text-ink-3 border border-gray-100"
              }`}
            >
              {isOAuth ? "OAuth" : "API Key"}
            </span>
            {credScope && (
              <span
                className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${
                  credScope === "project"
                    ? "bg-blue-50 text-blue-600 border border-blue-100"
                    : "bg-gray-50 text-ink-3 border border-gray-100"
                }`}
              >
                {credScope === "project" ? "Project" : "Inherited"}
              </span>
            )}
          </div>
          <p className="text-[11px] text-ink-3 mt-0.5 truncate">{integration.description}</p>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          {isConnected ? (
            <>
              <StatusBadge credential={credential} probeResult={probeResult} probing={probing} />
              <div className="flex items-center gap-1">
                {onReconnect && (
                  <button
                    onClick={onReconnect}
                    className="text-[10px] text-ink-3 hover:text-brand px-1.5 py-0.5"
                  >
                    Reconnect
                  </button>
                )}
                {onDisconnect && (
                  <button
                    onClick={onDisconnect}
                    className="text-[10px] text-red-400 hover:text-red-600 px-1.5 py-0.5"
                  >
                    Disconnect
                  </button>
                )}
              </div>
            </>
          ) : hasOAuthConfig ? (
            <button
              onClick={onStartOAuth}
              disabled={connectingOAuth}
              className="bg-brand text-white px-4 py-1.5 rounded-lg text-xs font-medium hover:bg-brand-hover disabled:opacity-60 transition-colors flex items-center gap-1.5"
            >
              {connectingOAuth ? (
                <>
                  <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Connecting...
                </>
              ) : (
                <>Connect</>
              )}
            </button>
          ) : (
            <button
              onClick={onToggleExpand}
              className="text-ink-3 hover:text-ink transition-colors p-1"
            >
              <ChevronDown
                className={`w-4 h-4 transition-transform ${isExpanded ? "rotate-180" : ""}`}
              />
            </button>
          )}
        </div>
      </div>

      {/* Expanded: API key input or OAuth fallback */}
      {isExpanded && !isConnected && (
        <div className="px-4 pb-4 pt-0 border-t border-rim">
          <div className="pt-3 space-y-2">
            {(integration.key_url || integration.key_help) && (
              <p className="text-[11px] text-ink-3">
                {integration.key_help ?? `Get your ${integration.name} API key`}
                {integration.key_url && (
                  <>
                    {" "}at{" "}
                    <a
                      href={integration.key_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-brand hover:underline inline-flex items-center gap-0.5"
                    >
                      {integration.key_url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                      <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  </>
                )}
              </p>
            )}
            {integration.extra_fields?.map((field) => {
              const meta = EXTRA_FIELD_LABELS[field] ?? { label: field, placeholder: field };
              return (
                <div key={field}>
                  <label className="text-[11px] font-medium text-ink-2 mb-1 block">{meta.label}</label>
                  <input
                    type="text"
                    value={extraFieldValues[field] ?? ""}
                    onChange={(e) => onExtraFieldChange(field, e.target.value)}
                    placeholder={meta.placeholder}
                    className="w-full bg-surface border border-rim rounded-lg px-3 py-1.5 text-xs font-mono text-ink focus:outline-none focus:border-brand"
                  />
                </div>
              );
            })}
            <div className="flex gap-2">
              <input
                type="password"
                value={inputValue}
                onChange={(e) => onInputChange(e.target.value)}
                placeholder={`Paste ${integration.name} ${isOAuth ? "token" : "API key"}`}
                className="flex-1 bg-surface border border-rim rounded-lg px-3 py-1.5 text-xs font-mono text-ink focus:outline-none focus:border-brand"
              />
              <button
                onClick={onSaveApiKey}
                disabled={!inputValue || saving}
                className="bg-brand text-white px-4 py-1.5 rounded-lg text-xs font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors"
              >
                {saving ? savingLabel || "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Expanded reconnect for connected API-key integrations */}
      {isExpanded && isConnected && !hasOAuthConfig && (
        <div className="px-4 pb-4 pt-0 border-t border-rim">
          <div className="pt-3 space-y-2">
            <p className="text-[11px] text-ink-3">Update your {integration.name} credentials:</p>
            {integration.extra_fields?.map((field) => {
              const meta = EXTRA_FIELD_LABELS[field] ?? { label: field, placeholder: field };
              return (
                <div key={field}>
                  <label className="text-[11px] font-medium text-ink-2 mb-1 block">{meta.label}</label>
                  <input
                    type="text"
                    value={extraFieldValues[field] ?? ""}
                    onChange={(e) => onExtraFieldChange(field, e.target.value)}
                    placeholder={meta.placeholder}
                    className="w-full bg-surface border border-rim rounded-lg px-3 py-1.5 text-xs font-mono text-ink focus:outline-none focus:border-brand"
                  />
                </div>
              );
            })}
            <div className="flex gap-2">
              <input
                type="password"
                value={inputValue}
                onChange={(e) => onInputChange(e.target.value)}
                placeholder={`Paste new ${integration.name} ${isOAuth ? "token" : "API key"}`}
                className="flex-1 bg-surface border border-rim rounded-lg px-3 py-1.5 text-xs font-mono text-ink focus:outline-none focus:border-brand"
              />
              <button
                onClick={onSaveApiKey}
                disabled={!inputValue || saving}
                className="bg-brand text-white px-4 py-1.5 rounded-lg text-xs font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors"
              >
                {saving ? savingLabel || "Saving..." : "Update"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Probe failure detail */}
      {isConnected && probeResult && !probeResult.ok && (
        <div className="mx-4 mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2">
          <p className="text-[11px] font-medium text-red-700">
            {probeResult.error || `Probe status: ${probeResult.status}`}
          </p>
          {probeResult.hint && (
            <p className="text-[10px] text-red-600 mt-0.5">{probeResult.hint}</p>
          )}
        </div>
      )}

      {/* Post-connect setup steps — hide once probe confirms access */}
      {integration.setup_steps && integration.setup_steps.length > 0 && isConnected && !(probeResult?.ok) && (
        <div className="mx-4 mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
          <p className="text-[11px] font-semibold text-amber-800 mb-1.5">
            Required setup in {integration.name}
          </p>
          <ul className="space-y-1.5">
            {integration.setup_steps.map((step, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold bg-amber-200 text-amber-800">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-medium text-amber-900">
                    {step.label}
                    {step.required && (
                      <span className="ml-1.5 text-[9px] px-1.5 py-0.5 rounded-full font-semibold bg-amber-200 text-amber-800">
                        Required
                      </span>
                    )}
                  </p>
                  {step.help && (
                    <p className="text-[11px] mt-0.5 leading-snug text-amber-700">{step.help}</p>
                  )}
                  {step.doc_url && (
                    <a
                      href={step.doc_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] text-brand hover:underline mt-0.5 inline-flex items-center gap-0.5"
                    >
                      View docs <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const PROBE_STATUS_LABELS: Record<string, { label: string; color: string }> = {
  verified: { label: "Verified", color: "bg-green-100 text-green-700" },
  rate_limited: { label: "Verified", color: "bg-green-100 text-green-700" },
  auth_failed: { label: "Auth failed", color: "bg-red-100 text-red-700" },
  endpoint_not_found: { label: "Endpoint error", color: "bg-red-100 text-red-700" },
  server_error: { label: "Server error", color: "bg-amber-100 text-amber-700" },
  client_error: { label: "Error", color: "bg-red-100 text-red-700" },
  network_error: { label: "Unreachable", color: "bg-red-100 text-red-700" },
  config_missing: { label: "Config needed", color: "bg-amber-100 text-amber-700" },
};

function StatusBadge({ credential, probeResult, probing }: {
  credential?: ConnectedCredential;
  probeResult?: ProbeResultEntry;
  probing?: boolean;
}) {
  if (!credential) return null;

  if (probing && !probeResult) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-ink-3 font-medium">
        <span className="w-2.5 h-2.5 border border-ink-3/40 border-t-ink-3 rounded-full animate-spin" />
        Checking...
      </span>
    );
  }

  if (probeResult) {
    const meta = PROBE_STATUS_LABELS[probeResult.status] ?? { label: probeResult.status, color: "bg-gray-100 text-ink-3" };
    const icon = probeResult.ok ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />;
    return (
      <span
        className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-medium ${meta.color}`}
        title={probeResult.hint || probeResult.error || undefined}
      >
        {icon} {meta.label}
        {probeResult.latency_ms != null && (
          <span className="text-[8px] opacity-60 ml-0.5">{probeResult.latency_ms}ms</span>
        )}
      </span>
    );
  }

  if (credential.validated === true) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">
        <Check className="w-3 h-3" /> Verified
      </span>
    );
  }
  if (credential.validated === false) {
    return (
      <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-600 font-medium border border-amber-200">
        Saved, not verified
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">
      <Check className="w-3 h-3" /> Connected
    </span>
  );
}
