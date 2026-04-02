"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import Link from "next/link";
import { IntegrationIcon } from "@/components/integration-icon";

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
}

interface ConnectedCredential {
  integration_slug: string;
  credential_type: string;
  metadata: Record<string, unknown>;
  updated_at: string;
  validated?: boolean;
}

export default function IntegrationsPage() {
  const { activeClient, apiFetch } = useAuth();
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [connected, setConnected] = useState<Map<string, ConnectedCredential>>(new Map());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});

  useEffect(() => {
    apiFetch("/api/integrations")
      .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then((data) => setIntegrations(data.integrations ?? []))
      .catch(() => {});
  }, [apiFetch]);

  useEffect(() => {
    if (!activeClient) return;
    apiFetch(`/api/clients/${activeClient}/credentials`)
      .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then((data) => {
        const map = new Map<string, ConnectedCredential>();
        for (const cred of data.credentials ?? []) {
          map.set(cred.integration_slug, cred);
        }
        setConnected(map);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [activeClient, apiFetch]);

  const [error, setError] = useState<string | null>(null);

  const [savingLabel, setSavingLabel] = useState<string>("");

  const saveApiKey = async (slug: string) => {
    const value = inputValues[slug];
    if (!value || !activeClient) return;
    setSaving(slug);
    setSavingLabel("Validating...");
    setError(null);
    try {
      const res = await apiFetch(`/api/clients/${activeClient}/credentials`, {
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
      const res = await apiFetch(`/api/clients/${activeClient}/credentials/${slug}`, { method: "DELETE" });
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
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    }
  };

  const startOAuth = async (slug: string) => {
    if (!activeClient) return;
    setError(null);
    try {
      const res = await apiFetch(`/api/oauth/${slug}/authorize?client_slug=${activeClient}&redirect=${encodeURIComponent(window.location.href)}`);
      if (res.ok) {
        const data = await res.json();
        window.location.href = data.authorize_url;
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `OAuth failed for ${slug}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    }
  };

  if (!activeClient) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-8">
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
    <div className="max-w-3xl mx-auto px-6 py-8">
      <Link href="/settings" className="text-ink-3 text-sm hover:text-ink-2 mb-4 inline-block">
        {"\u2190"} Settings
      </Link>
      <h1 className="text-xl font-bold text-ink mb-2">Integrations</h1>
      <p className="text-ink-2 text-sm mb-6">
        Connect external tools so agents can execute real actions for <span className="font-medium">{activeClient}</span>.
      </p>

      {error && (
        <div className="border border-red-200 bg-red-50 rounded-lg p-3 mb-4">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {loading ? (
        <p className="text-ink-3 text-sm">Loading...</p>
      ) : (
        <div className="space-y-4">
          {integrations.map((integration) => {
            const cred = connected.get(integration.slug);
            const isConnected = !!cred;

            return (
              <div key={integration.slug} id={integration.slug} className="border border-rim rounded-lg p-4 bg-page">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    <IntegrationIcon slug={integration.slug} size={28} />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-ink">{integration.name}</span>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                          integration.auth_type === "oauth2"
                            ? "bg-purple-50 text-purple-600"
                            : "bg-surface text-ink-3"
                        }`}>
                          {integration.auth_type === "oauth2" ? "OAuth" : "API Key"}
                        </span>
                        {isConnected ? (
                          <>
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">Connected</span>
                            {cred?.validated === true && (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 font-medium" title="Key was verified against the service">
                                Verified
                              </span>
                            )}
                            {cred?.validated === false && (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-600 font-medium" title="Key was saved but could not be verified against the service">
                                Unverified
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-surface text-ink-3">Not connected</span>
                        )}
                      </div>
                      <p className="text-xs text-ink-3 mt-0.5">{integration.description}</p>
                    </div>
                  </div>
                  {isConnected && (
                    <button
                      onClick={() => disconnect(integration.slug)}
                      className="text-xs text-red-500 hover:text-red-700"
                    >
                      Disconnect
                    </button>
                  )}
                </div>

                {!isConnected && integration.auth_type === "api_key" && (
                  <div className="mt-3 space-y-2">
                    {(integration.key_url || integration.key_help) && (
                      <p className="text-xs text-ink-3">
                        {integration.key_url ? (
                          <>{integration.key_help ?? `Get your ${integration.name} API key`} at{" "}
                            <a href={integration.key_url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                              {integration.key_url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                            </a>
                          </>
                        ) : (
                          integration.key_help
                        )}
                      </p>
                    )}
                    <div className="flex gap-2">
                      <input
                        type="password"
                        value={inputValues[integration.slug] ?? ""}
                        onChange={(e) => setInputValues((prev) => ({ ...prev, [integration.slug]: e.target.value }))}
                        placeholder={`Paste ${integration.name} API key`}
                        className="flex-1 bg-surface border border-rim rounded px-3 py-1.5 text-xs font-mono text-ink focus:outline-none focus:border-brand"
                      />
                      <button
                        onClick={() => saveApiKey(integration.slug)}
                        disabled={!inputValues[integration.slug] || saving === integration.slug}
                        className="bg-brand text-white px-4 py-1.5 rounded text-xs font-medium hover:bg-brand-hover disabled:opacity-50"
                      >
                        {saving === integration.slug ? (savingLabel || "Saving...") : "Save"}
                      </button>
                    </div>
                  </div>
                )}

                {!isConnected && integration.auth_type === "oauth2" && (
                  <div className="mt-3 space-y-2">
                    {integration.oauth_configured ? (
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => startOAuth(integration.slug)}
                          className="bg-brand text-white px-4 py-1.5 rounded text-xs font-medium hover:bg-brand-hover"
                        >
                          Connect {integration.name}
                        </button>
                      </div>
                    ) : (
                      <div>
                        <p className="text-xs text-ink-3 mb-2">
                          Paste your {integration.name} integration token
                          {integration.key_url && (
                            <> — {integration.key_help ?? "get one"} at{" "}
                            <a href={integration.key_url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                              {integration.key_url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                            </a>
                            </>
                          )}
                          {!integration.key_url && integration.key_help && (
                            <> — {integration.key_help}</>
                          )}
                        </p>
                        <div className="flex gap-2">
                          <input
                            type="password"
                            value={inputValues[integration.slug] ?? ""}
                            onChange={(e) => setInputValues((prev) => ({ ...prev, [integration.slug]: e.target.value }))}
                            placeholder={`Paste ${integration.name} token`}
                            className="flex-1 bg-surface border border-rim rounded px-3 py-1.5 text-xs font-mono text-ink focus:outline-none focus:border-brand"
                          />
                          <button
                            onClick={() => saveApiKey(integration.slug)}
                            disabled={!inputValues[integration.slug] || saving === integration.slug}
                            className="bg-brand text-white px-4 py-1.5 rounded text-xs font-medium hover:bg-brand-hover disabled:opacity-50"
                          >
                            {saving === integration.slug ? (savingLabel || "Saving...") : "Save"}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {isConnected && cred && (
                  <p className="text-[10px] text-ink-3 mt-2">
                    Last updated: {new Date(cred.updated_at).toLocaleDateString()}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
