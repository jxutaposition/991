"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";
import { useAuth } from "@/lib/auth-context";
import {
  ChevronDown,
  Home,
  Play,
  BookOpen,
  Database,
  Eye,
  Settings,
  LogOut,
  LogIn,
  ChevronsLeft,
  ChevronsRight,
  Plus,
  Layers,
} from "lucide-react";
import { useState, useRef, useEffect } from "react";

const navLinks = [
  { href: "/", label: "Home", icon: Home },
  { href: "/execute", label: "Execute", icon: Play },
  { href: "/catalog", label: "Catalog", icon: BookOpen },
  { href: "/knowledge", label: "Knowledge", icon: Database },
  { href: "/knowledge/observatory", label: "Observatory", icon: Layers, indent: true },
  { href: "/observe", label: "Observe", icon: Eye },
];

export function Nav() {
  const pathname = usePathname();
  const { user, clients, activeClient, setActiveClient, signOut, apiFetch, refreshClients } = useAuth();
  const [wsOpen, setWsOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [showNewWs, setShowNewWs] = useState(false);
  const [newWsName, setNewWsName] = useState("");
  const [creatingWs, setCreatingWs] = useState(false);
  const wsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (wsRef.current && !wsRef.current.contains(e.target as Node)) {
        setWsOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const activeClientName = clients.find((c) => c.slug === activeClient)?.name;

  const isActive = (href: string) =>
    href === "/"
      ? pathname === "/"
      : pathname === href || pathname.startsWith(href + "/");

  const isSettingsActive =
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname.startsWith("/agent-prs") ||
    pathname.startsWith("/feedback") ||
    pathname.startsWith("/data-viewer") ||
    pathname.startsWith("/testing");

  const handleCreateWorkspace = async () => {
    if (!newWsName.trim() || creatingWs) return;
    setCreatingWs(true);
    try {
      const slug = newWsName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const res = await apiFetch("/api/auth/workspaces", {
        method: "POST",
        body: JSON.stringify({ slug, name: newWsName.trim() }),
      });
      if (!res.ok) return;
      const data = await res.json();
      setActiveClient(data.slug);
      setShowNewWs(false);
      setNewWsName("");
      await refreshClients();
    } finally {
      setCreatingWs(false);
    }
  };

  return (
    <aside
      className={clsx(
        "shrink-0 border-r border-rim bg-surface flex flex-col h-screen sticky top-0 transition-[width] duration-200",
        collapsed ? "w-14" : "w-[200px]"
      )}
    >
      {/* Workspace switcher */}
      <div className="px-2 pt-3 pb-2" ref={wsRef}>
        {clients.length > 0 ? (
          <div className="relative">
            <button
              onClick={() => {
                if (collapsed) setCollapsed(false);
                else setWsOpen(!wsOpen);
              }}
              className={clsx(
                "w-full flex items-center gap-2 py-2 rounded-lg hover:bg-raised transition-colors",
                collapsed ? "justify-center px-0" : "px-2"
              )}
              title={collapsed ? activeClientName : undefined}
            >
              <span className="w-7 h-7 rounded-full flex items-center justify-center bg-brand text-white text-xs font-bold shrink-0">
                {activeClientName?.charAt(0).toUpperCase() ?? "?"}
              </span>
              {!collapsed && (
                <>
                  <span className="flex-1 text-left text-sm font-medium text-ink truncate">
                    {activeClientName ?? "Select workspace"}
                  </span>
                  <ChevronDown className="w-3.5 h-3.5 text-ink-3 shrink-0" />
                </>
              )}
            </button>
            {wsOpen && !collapsed && (
              <div className="absolute left-0 right-0 top-full mt-1 bg-page border border-rim rounded-lg shadow-lg z-50 py-1">
                <p className="text-xs text-ink-3 uppercase tracking-wider px-3 py-1.5">
                  Workspaces
                </p>
                {clients.map((c) => (
                  <button
                    key={c.slug}
                    onClick={() => {
                      setActiveClient(c.slug);
                      setWsOpen(false);
                    }}
                    className={clsx(
                      "w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-raised transition-colors",
                      activeClient === c.slug && "bg-brand-subtle text-brand"
                    )}
                  >
                    <span
                      className={clsx(
                        "w-5 h-5 rounded flex items-center justify-center text-xs font-bold",
                        activeClient === c.slug
                          ? "bg-brand text-white"
                          : "bg-raised text-ink-3"
                      )}
                    >
                      {c.name.charAt(0).toUpperCase()}
                    </span>
                    <span className="flex-1 truncate">{c.name}</span>
                    {activeClient === c.slug && (
                      <span className="text-xs bg-brand text-white px-1.5 py-0.5 rounded-full">
                        active
                      </span>
                    )}
                  </button>
                ))}
                <div className="border-t border-rim mt-1 pt-1">
                  {showNewWs ? (
                    <div className="px-3 py-2 space-y-2">
                      <input
                        type="text"
                        value={newWsName}
                        onChange={(e) => setNewWsName(e.target.value)}
                        placeholder="Workspace name"
                        className="w-full bg-page border border-rim rounded px-2 py-1 text-xs text-ink focus:outline-none focus:border-brand"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleCreateWorkspace();
                          if (e.key === "Escape") { setShowNewWs(false); setNewWsName(""); }
                        }}
                        autoFocus
                      />
                      <div className="flex gap-1.5">
                        <button
                          onClick={handleCreateWorkspace}
                          disabled={!newWsName.trim() || creatingWs}
                          className="bg-brand text-white px-2.5 py-1 rounded text-xs font-medium hover:bg-brand-hover disabled:opacity-50"
                        >
                          {creatingWs ? "Creating..." : "Create"}
                        </button>
                        <button
                          onClick={() => { setShowNewWs(false); setNewWsName(""); }}
                          className="px-2.5 py-1 rounded text-xs text-ink-3 hover:text-ink border border-rim"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowNewWs(true)}
                      className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 text-ink-3 hover:text-brand hover:bg-raised transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      New workspace
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          <Link
            href="/"
            className={clsx(
              "flex items-center gap-2 py-2 rounded-lg hover:bg-raised transition-colors",
              collapsed ? "justify-center px-0" : "px-2"
            )}
          >
            <span className="w-7 h-7 rounded-full flex items-center justify-center bg-brand text-white text-[10px] font-bold leading-none">
              99
            </span>
            {!collapsed && (
              <span className="text-sm font-semibold text-ink">99percent</span>
            )}
          </Link>
        )}
      </div>

      {/* Main nav links */}
      <nav className="flex-1 px-2 space-y-0.5 overflow-y-auto">
        {navLinks.map((link) => {
          const Icon = link.icon;
          const indent = "indent" in link && link.indent;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={clsx(
                "flex items-center gap-2 py-2 rounded-lg transition-colors",
                indent ? "text-xs" : "text-sm",
                collapsed ? "justify-center px-0" : indent ? "pl-7 pr-2" : "px-2",
                isActive(link.href)
                  ? "bg-brand-subtle text-brand font-medium"
                  : "text-ink-2 hover:bg-raised hover:text-ink"
              )}
              title={collapsed ? link.label : undefined}
            >
              <Icon className={clsx("shrink-0", indent ? "w-3.5 h-3.5" : "w-4 h-4")} />
              {!collapsed && <span>{link.label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* Bottom section */}
      <div className="px-2 pb-3 pt-2 border-t border-rim space-y-0.5">
        <Link
          href="/settings"
          className={clsx(
            "flex items-center gap-2 py-2 rounded-lg text-sm transition-colors",
            collapsed ? "justify-center px-0" : "px-2",
            isSettingsActive
              ? "bg-brand-subtle text-brand font-medium"
              : "text-ink-2 hover:bg-raised hover:text-ink"
          )}
          title={collapsed ? "Settings" : undefined}
        >
          <Settings className="w-4 h-4 shrink-0" />
          {!collapsed && <span>Settings</span>}
        </Link>

        {user ? (
          <div
            className={clsx(
              "flex items-center gap-2 py-2 mt-1",
              collapsed ? "justify-center px-0" : "px-2"
            )}
          >
            <span
              className="w-6 h-6 rounded-full flex items-center justify-center bg-raised text-ink-3 text-xs font-bold shrink-0"
              title={collapsed ? (user.name || user.email) : undefined}
            >
              {user.name?.charAt(0).toUpperCase() ??
                user.email.charAt(0).toUpperCase()}
            </span>
            {!collapsed && (
              <>
                <span className="flex-1 text-xs text-ink-2 truncate">
                  {user.name || user.email}
                </span>
                <button
                  onClick={signOut}
                  className="p-1 rounded hover:bg-raised text-ink-3 hover:text-ink transition-colors"
                  title="Sign out"
                  aria-label="Sign out"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        ) : (
          <Link
            href="/login"
            className={clsx(
              "flex items-center gap-2 py-2 rounded-lg text-sm text-ink-2 hover:bg-raised hover:text-ink transition-colors",
              collapsed ? "justify-center px-0" : "px-2"
            )}
            title={collapsed ? "Sign in" : undefined}
          >
            <LogIn className="w-4 h-4 shrink-0" />
            {!collapsed && <span>Sign in</span>}
          </Link>
        )}

        {/* Collapse toggle */}
        <button
          onClick={() => setCollapsed((prev) => !prev)}
          className={clsx(
            "flex items-center gap-2 py-2 rounded-lg text-sm text-ink-3 hover:bg-raised hover:text-ink transition-colors w-full",
            collapsed ? "justify-center px-0" : "px-2"
          )}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? (
            <ChevronsRight className="w-4 h-4 shrink-0" />
          ) : (
            <ChevronsLeft className="w-4 h-4 shrink-0" />
          )}
        </button>
      </div>
    </aside>
  );
}
