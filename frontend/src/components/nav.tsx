"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";

const links = [
  { href: "/execute", label: "Execute" },
  { href: "/catalog", label: "Catalog" },
  { href: "/agent-prs", label: "Agent PRs" },
  { href: "/observe", label: "Observe" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="border-b border-zinc-800 bg-zinc-950 px-6 py-3 flex items-center gap-8">
      <Link href="/" className="text-white font-semibold text-lg tracking-tight">
        lele
      </Link>
      <div className="flex items-center gap-1">
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={clsx(
              "px-3 py-1.5 rounded-md text-sm transition-colors",
              pathname.startsWith(link.href)
                ? "bg-zinc-800 text-white"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
            )}
          >
            {link.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
