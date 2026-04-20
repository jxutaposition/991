"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LegacyIntegrationsRedirectInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  useEffect(() => {
    const q = searchParams.toString();
    const base = q ? `/integrations?${q}` : "/integrations";
    router.replace(`${base}${typeof window !== "undefined" ? window.location.hash : ""}`);
  }, [router, searchParams]);
  return (
    <div className="p-6 text-sm text-ink-3">Redirecting to integrations…</div>
  );
}

/** Preserves query string and hash for bookmarks and OAuth return URLs. */
export default function LegacyIntegrationsRedirect() {
  return (
    <Suspense
      fallback={
        <div className="p-6 text-sm text-ink-3">Redirecting to integrations…</div>
      }
    >
      <LegacyIntegrationsRedirectInner />
    </Suspense>
  );
}
