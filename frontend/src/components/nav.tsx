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
  Plus,
  LogOut,
  LogIn,
} from "lucide-react";
import { useState, useRef, useEffect } from "react";

const navLinks = [
  { href: "/", label: "Home", icon: Home },
  { href: "/execute", label: "Execute", icon: Play },
  { href: "/catalog", label: "Catalog", icon: BookOpen },
  { href: "/knowledge", label: "Knowledge", icon: Database },
  { href: "/observe", label: "Observe", icon: Eye },
];

export function Nav() {
  const pathname = usePathname();
  const { user, clients, activeClient, setActiveClient, signOut } = useAuth();
  const [wsOpen, setWsOpen] = useState(false);
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

  return (
    <aside className="w-[250px] shrink-0 border-r border-rim bg-surface flex flex-col h-screen sticky top-0">
      {/* Workspace switcher */}
      <div className="px-3 pt-4 pb-2" ref={wsRef}>
        {clients.length > 0 ? (
          <div className="relative">
            <button
              onClick={() => setWsOpen(!wsOpen)}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-raised transition-colors"
            >
              <span className="w-7 h-7 rounded-full flex items-center justify-center bg-brand text-white text-xs font-bold shrink-0">
                {activeClientName?.charAt(0).toUpperCase() ?? "?"}
              </span>
              <span className="flex-1 text-left text-sm font-medium text-ink truncate">
                {activeClientName ?? "Select workspace"}
              </span>
              <ChevronDown className="w-3.5 h-3.5 text-ink-3 shrink-0" />
            </button>
            {wsOpen && (
              <div className="absolute left-0 right-0 top-full mt-1 bg-page border border-rim rounded-lg shadow-lg z-50 py-1">
                <p className="text-[10px] text-ink-3 uppercase tracking-wider px-3 py-1.5">
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
                        "w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold",
                        activeClient === c.slug
                          ? "bg-brand text-white"
                          : "bg-raised text-ink-3"
                      )}
                    >
                      {c.name.charAt(0).toUpperCase()}
                    </span>
                    <span className="flex-1 truncate">{c.name}</span>
                    {activeClient === c.slug && (
                      <span className="text-[9px] bg-brand text-white px-1.5 py-0.5 rounded-full">
                        active
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <Link
            href="/"
            className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-raised transition-colors"
          >
            <span className="w-7 h-7 rounded-full flex items-center justify-center bg-brand text-white text-xs font-bold">
              L
            </span>
            <span className="text-sm font-semibold text-ink">lele</span>
          </Link>
        )}
      </div>

      {/* New workflow button */}
      <div className="px-3 pb-2">
        <Link
          href="/execute"
          className="flex items-center gap-2 w-full px-2.5 py-2 rounded-lg text-sm text-ink-2 hover:bg-raised hover:text-ink transition-colors"
        >
          <Plus className="w-4 h-4" />
          <span>Create new workflow</span>
        </Link>
      </div>

      {/* Main nav links */}
      <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto">
        {navLinks.map((link) => {
          const Icon = link.icon;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={clsx(
                "flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm transition-colors",
                isActive(link.href)
                  ? "bg-brand-subtle text-brand font-medium"
                  : "text-ink-2 hover:bg-raised hover:text-ink"
              )}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span>{link.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Bottom section */}
      <div className="px-3 pb-4 pt-2 border-t border-rim space-y-0.5">
        <Link
          href="/settings"
          className={clsx(
            "flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm transition-colors",
            isSettingsActive
              ? "bg-brand-subtle text-brand font-medium"
              : "text-ink-2 hover:bg-raised hover:text-ink"
          )}
        >
          <Settings className="w-4 h-4 shrink-0" />
          <span>Settings</span>
        </Link>

        {user ? (
          <div className="flex items-center gap-2 px-2.5 py-2 mt-1">
            <span className="w-6 h-6 rounded-full flex items-center justify-center bg-raised text-ink-3 text-[10px] font-bold shrink-0">
              {user.name?.charAt(0).toUpperCase() ?? user.email.charAt(0).toUpperCase()}
            </span>
            <span className="flex-1 text-xs text-ink-2 truncate">
              {user.name || user.email}
            </span>
            <button
              onClick={signOut}
              className="p-1 rounded hover:bg-raised text-ink-3 hover:text-ink transition-colors"
              title="Sign out"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <Link
            href="/login"
            className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm text-ink-2 hover:bg-raised hover:text-ink transition-colors"
          >
            <LogIn className="w-4 h-4 shrink-0" />
            <span>Sign in</span>
          </Link>
        )}
      </div>
    </aside>
  );
}
