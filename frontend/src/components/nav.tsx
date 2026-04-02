"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";
import { useAuth } from "@/lib/auth-context";
import { ChevronDown } from "lucide-react";
import { useState, useRef, useEffect } from "react";

const links = [
  { href: "/execute", label: "Execute" },
  { href: "/catalog", label: "Catalog" },
  { href: "/agent-prs", label: "Agent PRs" },
  { href: "/observe", label: "Observe" },
  { href: "/data-viewer", label: "Data" },
  { href: "/testing", label: "Testing" },
  { href: "/settings", label: "Settings" },
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

  return (
    <nav className="border-b border-rim bg-page px-6 py-3 flex items-center gap-8">
      <Link href="/" className="text-ink font-semibold text-lg tracking-tight">
        lele
      </Link>
      <div className="flex items-center gap-1">
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={clsx(
              "px-3 py-1.5 rounded-md text-sm transition-colors",
              pathname === link.href || pathname.startsWith(link.href + "/")
                ? "bg-brand-subtle text-brand"
                : "text-ink-2 hover:text-ink hover:bg-surface"
            )}
          >
            {link.label}
          </Link>
        ))}
      </div>
      <div className="flex-1" />

      {/* Workspace switcher */}
      {clients.length > 0 && (
        <div className="relative" ref={wsRef}>
          <button
            onClick={() => setWsOpen(!wsOpen)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-rim hover:border-rim-strong text-xs text-ink-2 hover:text-ink transition-colors bg-surface"
          >
            <span
              className="w-5 h-5 rounded flex items-center justify-center bg-brand text-white text-[10px] font-bold"
            >
              {activeClientName?.charAt(0).toUpperCase() ?? "?"}
            </span>
            <span className="max-w-[120px] truncate font-medium">{activeClientName ?? "Select workspace"}</span>
            <ChevronDown className="w-3 h-3" />
          </button>
          {wsOpen && (
            <div className="absolute right-0 top-full mt-1 w-56 bg-page border border-rim rounded-lg shadow-lg z-50 py-1">
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
                    "w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-surface transition-colors",
                    activeClient === c.slug && "bg-brand-subtle text-brand"
                  )}
                >
                  <span
                    className={clsx(
                      "w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold",
                      activeClient === c.slug
                        ? "bg-brand text-white"
                        : "bg-surface text-ink-3"
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
      )}

      {user ? (
        <div className="flex items-center gap-3">
          <span className="text-xs text-ink-2">{user.name || user.email}</span>
          <button
            onClick={signOut}
            className="text-xs text-ink-3 hover:text-ink-2"
          >
            Sign out
          </button>
        </div>
      ) : (
        <Link href="/login" className="text-xs text-ink-3 hover:text-ink-2">
          Sign in
        </Link>
      )}
    </nav>
  );
}
