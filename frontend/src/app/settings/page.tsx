"use client";

import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";
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
  Trash2,
} from "lucide-react";
import {
  DEFAULT_ENGAGEMENT_STAGE,
  ENGAGEMENT_STAGE_OPTIONS,
  type EngagementStageValue,
} from "@/lib/engagement-stage";
import { readOnboardingFlowActive } from "@/lib/onboarding-storage";

const settingsSections = [
  {
    href: "/integrations",
    icon: KeyRound,
    label: "Integrations",
    description: "Manage API keys and OAuth connections for your agents for this client",
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
  const router = useRouter();
  const { user, clients, activeClient, setActiveClient, apiFetch, refreshClients } = useAuth();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [engagementStage, setEngagementStage] = useState<EngagementStageValue>(DEFAULT_ENGAGEMENT_STAGE);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  // Delete workspace state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const activeRole = clients.find((c) => c.slug === activeClient)?.role;
  const activeClientName = clients.find((c) => c.slug === activeClient)?.name;

  const deleteWorkspace = async () => {
    const conf = deleteConfirmText.trim().toLowerCase();
    if (!activeClient || (conf !== "delete workspace" && conf !== "delete client")) return;
    setDeleting(true);
    setDeleteError("");
    try {
      const res = await apiFetch(`/api/auth/workspaces/${activeClient}`, {
        method: "DELETE",
        body: JSON.stringify({ confirmation: deleteConfirmText.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to delete client");
      }
      setShowDeleteConfirm(false);
      setDeleteConfirmText("");
      await refreshClients();
    } catch (e: unknown) {
      setDeleteError(e instanceof Error ? e.message : "Failed to delete client");
    } finally {
      setDeleting(false);
    }
  };

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
        body: JSON.stringify({
          slug,
          name: newName.trim(),
          engagement_stage: engagementStage,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to create client");
      }
      const data = await res.json();
      setActiveClient(data.slug);
      setShowCreate(false);
      setNewName("");
      setEngagementStage(DEFAULT_ENGAGEMENT_STAGE);
      await refreshClients();
      if (readOnboardingFlowActive()) {
        router.push("/onboarding");
      }
    } catch (e: unknown) {
      setCreateError(
        e instanceof Error ? e.message : "Failed to create client"
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
              <Image
                src={user.avatar_url}
                alt=""
                width={48}
                height={48}
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

      {/* Client */}
      <section className="border border-rim rounded-lg p-5 bg-page mb-6">
        <h2 className="text-sm font-semibold text-ink-3 uppercase tracking-wider mb-4">
          Client
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
              ? "No client linked to your account. Create one to manage integrations and run agents."
              : "Sign in to create or join a client."}
          </p>
        )}

        {user && !showCreate && (
          <button
            onClick={() => setShowCreate(true)}
            className="mt-3 flex items-center gap-2 text-sm text-brand hover:text-brand-hover transition-colors"
          >
            <Plus className="w-4 h-4" />
            Create client
          </button>
        )}

        {showCreate && (
          <div className="mt-3 p-4 border border-rim rounded-lg bg-surface space-y-3">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Client name (e.g. Acme Corp)"
              className="w-full bg-page border border-rim rounded px-3 py-2 text-sm text-ink focus:outline-none focus:border-brand"
              onKeyDown={(e) => e.key === "Enter" && createWorkspace()}
              autoFocus
            />
            <div>
              <label className="text-xs font-medium text-ink-3 block mb-1">Engagement stage</label>
              <select
                value={engagementStage}
                onChange={(e) => setEngagementStage(e.target.value as EngagementStageValue)}
                className="w-full bg-page border border-rim rounded px-3 py-2 text-sm text-ink focus:outline-none focus:border-brand"
              >
                {ENGAGEMENT_STAGE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
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
                  setEngagementStage(DEFAULT_ENGAGEMENT_STAGE);
                  setCreateError("");
                }}
                className="px-4 py-1.5 rounded text-xs font-medium text-ink-3 hover:text-ink border border-rim"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Delete client (admin only) */}
        {activeClient && activeRole === "admin" && !showDeleteConfirm && (
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="mt-4 flex items-center gap-2 text-xs text-red-500 hover:text-red-600 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete client
          </button>
        )}

        {showDeleteConfirm && (
          <div className="mt-4 p-4 border border-red-300 rounded-lg bg-red-50 dark:bg-red-950/20 dark:border-red-800 space-y-3">
            <p className="text-sm font-medium text-red-600 dark:text-red-400">
              Delete &ldquo;{activeClientName}&rdquo;?
            </p>
            <p className="text-xs text-red-500 dark:text-red-400/80">
              This client will be recoverable for 30 days, after which it will be permanently removed along with all associated data.
            </p>
            <div>
              <label className="text-xs text-ink-3 block mb-1">
                Type <span className="font-mono font-medium text-ink">delete client</span> or{" "}
                <span className="font-mono font-medium text-ink">delete workspace</span> to confirm
              </label>
              <input
                type="text"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder="delete client"
                className="w-full bg-page border border-rim rounded px-3 py-2 text-sm text-ink focus:outline-none focus:border-red-400"
                onKeyDown={(e) => e.key === "Enter" && deleteWorkspace()}
                autoFocus
              />
            </div>
            {deleteError && (
              <p className="text-xs text-red-500">{deleteError}</p>
            )}
            <div className="flex gap-2">
              <button
                onClick={deleteWorkspace}
                disabled={
                  (deleteConfirmText.trim().toLowerCase() !== "delete workspace" &&
                    deleteConfirmText.trim().toLowerCase() !== "delete client") ||
                  deleting
                }
                className="bg-red-600 text-white px-4 py-1.5 rounded text-xs font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deleting ? "Deleting..." : "Delete client"}
              </button>
              <button
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setDeleteConfirmText("");
                  setDeleteError("");
                }}
                className="px-4 py-1.5 rounded text-xs font-medium text-ink-3 hover:text-ink border border-rim"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

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
