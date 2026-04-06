"use client";

import Link from "next/link";
import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/lib/auth-context";
import {
  KeyRound,
  User,
  ChevronRight,
  Plus,
  GitPullRequest,
  MessageSquare,
  Table2,
  FlaskConical,
  Hash,
} from "lucide-react";

const settingsSections = [
  {
    href: "/settings/integrations",
    icon: KeyRound,
    label: "Integrations",
    description: "Manage API keys and OAuth connections for your agents",
    requiresWorkspace: true,
  },
  {
    href: "/agent-prs",
    icon: GitPullRequest,
    label: "Agent PRs",
    description: "Review proposed agent updates from observation sessions",
  },
  {
    href: "/feedback",
    icon: MessageSquare,
    label: "Feedback",
    description: "Signals, patterns, and the feedback synthesis pipeline",
  },
  {
    href: "/data-viewer",
    icon: Table2,
    label: "Data Viewer",
    description: "Browse database tables and run ad-hoc SQL queries",
  },
  {
    href: "/testing",
    icon: FlaskConical,
    label: "Testing",
    description: "Scripted demos, live tests, and shadow sessions",
  },
];

export default function SettingsPage() {
  const { user, clients, activeClient, setActiveClient, apiFetch } = useAuth();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  // Slack channel settings
  const [clientSlackChannel, setClientSlackChannel] = useState("");
  const [clientSlackLoaded, setClientSlackLoaded] = useState(false);
  const [savingSlack, setSavingSlack] = useState(false);
  const [slackSaved, setSlackSaved] = useState(false);
  const [projects, setProjects] = useState<{ id: string; slug: string; name: string; slack_channel_id: string | null }[]>([]);
  const [projectSlackValues, setProjectSlackValues] = useState<Record<string, string>>({});
  const [savingProjectSlack, setSavingProjectSlack] = useState<string | null>(null);

  // Load client slack_channel_id and projects when activeClient changes
  useEffect(() => {
    if (!activeClient) return;
    setClientSlackLoaded(false);
    apiFetch(`/api/clients/${activeClient}`)
      .then((r) => r.json())
      .then((data) => {
        setClientSlackChannel(data.client?.slack_channel_id || "");
        setClientSlackLoaded(true);
      })
      .catch(() => setClientSlackLoaded(true));

    apiFetch(`/api/projects?client_slug=${activeClient}`)
      .then((r) => r.json())
      .then((data) => {
        const list = data.projects ?? [];
        setProjects(list);
        const vals: Record<string, string> = {};
        for (const p of list) {
          vals[p.id] = p.slack_channel_id || "";
        }
        setProjectSlackValues(vals);
      })
      .catch(() => {});
  }, [activeClient, apiFetch]);

  const saveClientSlack = useCallback(async () => {
    if (!activeClient) return;
    setSavingSlack(true);
    try {
      await apiFetch(`/api/clients/${activeClient}`, {
        method: "PATCH",
        body: JSON.stringify({ slack_channel_id: clientSlackChannel || "" }),
      });
      setSlackSaved(true);
      setTimeout(() => setSlackSaved(false), 2000);
    } catch { /* ignore */ }
    setSavingSlack(false);
  }, [activeClient, clientSlackChannel, apiFetch]);

  const saveProjectSlack = useCallback(async (projectId: string) => {
    setSavingProjectSlack(projectId);
    try {
      await apiFetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify({ slack_channel_id: projectSlackValues[projectId] || "" }),
      });
    } catch { /* ignore */ }
    setSavingProjectSlack(null);
  }, [projectSlackValues, apiFetch]);

  const createWorkspace = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setCreateError("");
    try {
      const slug = newName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const res = await apiFetch("/api/auth/workspaces", {
        method: "POST",
        body: JSON.stringify({ slug, name: newName.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to create workspace");
      }
      const data = await res.json();
      setActiveClient(data.slug);
      setShowCreate(false);
      setNewName("");
      window.location.reload();
    } catch (e: unknown) {
      setCreateError(
        e instanceof Error ? e.message : "Failed to create workspace"
      );
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <h1 className="text-xl font-bold text-ink mb-6">Settings</h1>

      {/* Profile */}
      <section className="border border-rim rounded-lg p-5 bg-page mb-6">
        <h2 className="text-sm font-semibold text-ink-3 uppercase tracking-wider mb-4">
          Profile
        </h2>
        {user ? (
          <div className="flex items-center gap-4">
            {user.avatar_url ? (
              <img
                src={user.avatar_url}
                alt=""
                className="w-12 h-12 rounded-full"
              />
            ) : (
              <div className="w-12 h-12 rounded-full bg-brand-subtle flex items-center justify-center">
                <User className="w-6 h-6 text-brand" />
              </div>
            )}
            <div>
              <p className="text-sm font-medium text-ink">{user.name}</p>
              <p className="text-xs text-ink-3">{user.email}</p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-ink-3">
            <Link href="/login" className="text-brand hover:underline">
              Sign in
            </Link>{" "}
            to manage your profile.
          </p>
        )}
      </section>

      {/* Workspace */}
      <section className="border border-rim rounded-lg p-5 bg-page mb-6">
        <h2 className="text-sm font-semibold text-ink-3 uppercase tracking-wider mb-4">
          Workspace
        </h2>
        {clients.length > 0 ? (
          <div className="space-y-2">
            {clients.map((c) => (
              <button
                key={c.slug}
                onClick={() => setActiveClient(c.slug)}
                className={`w-full text-left flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors ${
                  activeClient === c.slug
                    ? "border-brand bg-brand-subtle"
                    : "border-rim hover:border-rim-strong bg-surface"
                }`}
              >
                <div
                  className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold ${
                    activeClient === c.slug
                      ? "bg-brand text-white"
                      : "bg-surface text-ink-3"
                  }`}
                >
                  {c.name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-ink">{c.name}</p>
                  <p className="text-xs text-ink-3 capitalize">{c.role}</p>
                </div>
                {activeClient === c.slug && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-brand text-white font-medium">
                    Active
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-ink-3 mb-3">
            {user
              ? "No workspace linked to your account. Create one to manage integrations and run agents."
              : "Sign in to create or join a workspace."}
          </p>
        )}

        {user && !showCreate && (
          <button
            onClick={() => setShowCreate(true)}
            className="mt-3 flex items-center gap-2 text-sm text-brand hover:text-brand-hover transition-colors"
          >
            <Plus className="w-4 h-4" />
            Create workspace
          </button>
        )}

        {showCreate && (
          <div className="mt-3 p-4 border border-rim rounded-lg bg-surface space-y-3">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Workspace name (e.g. My Company)"
              className="w-full bg-page border border-rim rounded px-3 py-2 text-sm text-ink focus:outline-none focus:border-brand"
              onKeyDown={(e) => e.key === "Enter" && createWorkspace()}
              autoFocus
            />
            {createError && (
              <p className="text-xs text-red-500">{createError}</p>
            )}
            <div className="flex gap-2">
              <button
                onClick={createWorkspace}
                disabled={!newName.trim() || creating}
                className="bg-brand text-white px-4 py-1.5 rounded text-xs font-medium hover:bg-brand-hover disabled:opacity-50"
              >
                {creating ? "Creating..." : "Create"}
              </button>
              <button
                onClick={() => {
                  setShowCreate(false);
                  setNewName("");
                  setCreateError("");
                }}
                className="px-4 py-1.5 rounded text-xs font-medium text-ink-3 hover:text-ink border border-rim"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Slack Notifications */}
      {activeClient && clientSlackLoaded && (
        <section className="border border-rim rounded-lg p-5 bg-page mb-6">
          <h2 className="text-sm font-semibold text-ink-3 uppercase tracking-wider mb-4">
            Slack Notifications
          </h2>
          <p className="text-xs text-ink-3 mb-4">
            Execution updates will be posted to the configured Slack channel. Set a default at the workspace level, or override per-project.
          </p>

          {/* Workspace default */}
          <div className="mb-4">
            <label className="text-xs font-medium text-ink-3 block mb-1">
              Workspace default channel
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Hash className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-3" />
                <input
                  type="text"
                  value={clientSlackChannel}
                  onChange={(e) => { setClientSlackChannel(e.target.value); setSlackSaved(false); }}
                  placeholder="C01ABCDEF"
                  className="w-full bg-page border border-rim rounded px-3 py-1.5 pl-8 text-sm text-ink focus:outline-none focus:border-brand font-mono"
                />
              </div>
              <button
                onClick={saveClientSlack}
                disabled={savingSlack}
                className="bg-brand text-white px-4 py-1.5 rounded text-xs font-medium hover:bg-brand-hover disabled:opacity-50"
              >
                {slackSaved ? "Saved" : savingSlack ? "Saving..." : "Save"}
              </button>
            </div>
          </div>

          {/* Per-project overrides */}
          {projects.length > 0 && (
            <div>
              <label className="text-xs font-medium text-ink-3 block mb-2">
                Per-project overrides
              </label>
              <div className="space-y-2">
                {projects.map((p) => (
                  <div key={p.id} className="flex items-center gap-2">
                    <span className="text-xs text-ink w-32 truncate" title={p.name}>{p.name}</span>
                    <div className="relative flex-1">
                      <Hash className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-3" />
                      <input
                        type="text"
                        value={projectSlackValues[p.id] || ""}
                        onChange={(e) => setProjectSlackValues((prev) => ({ ...prev, [p.id]: e.target.value }))}
                        placeholder={clientSlackChannel || "C01ABCDEF"}
                        className="w-full bg-page border border-rim rounded px-3 py-1 pl-8 text-xs text-ink focus:outline-none focus:border-brand font-mono"
                      />
                    </div>
                    <button
                      onClick={() => saveProjectSlack(p.id)}
                      disabled={savingProjectSlack === p.id}
                      className="text-xs text-brand hover:text-brand-hover disabled:opacity-50 font-medium whitespace-nowrap"
                    >
                      {savingProjectSlack === p.id ? "..." : "Save"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Sub-section navigation */}
      <section className="space-y-2">
        {settingsSections.map((section) => {
          const Icon = section.icon;
          const disabled = section.requiresWorkspace && !activeClient;
          return (
            <Link
              key={section.href}
              href={section.href}
              className={`flex items-center gap-3 px-5 py-4 border border-rim rounded-lg bg-page hover:border-rim-strong transition-colors group ${
                disabled ? "opacity-50 pointer-events-none" : ""
              }`}
            >
              <Icon className="w-5 h-5 text-ink-3 group-hover:text-brand transition-colors shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-medium text-ink">{section.label}</p>
                <p className="text-xs text-ink-3">{section.description}</p>
              </div>
              <ChevronRight className="w-4 h-4 text-ink-3 shrink-0" />
            </Link>
          );
        })}
      </section>
    </div>
  );
}
