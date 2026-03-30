"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";

const links = [
  { href: "/execute", label: "Execute" },
  { href: "/catalog", label: "Catalog" },
  { href: "/agent-prs", label: "Agent PRs" },
  { href: "/observe", label: "Observe" },
  { href: "/data-viewer", label: "Data" },
  { href: "/testing", label: "Testing" },
];

export function Nav() {
  const pathname = usePathname();
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
    </nav>
  );
}
