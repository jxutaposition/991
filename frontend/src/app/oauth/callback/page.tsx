"use client";

import Link from "next/link";
import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";

function OAuthCallbackContent() {
  const params = useSearchParams();
  const integration = params.get("integration") ?? "";
  const status = params.get("status") ?? "";
  const error = params.get("error");
  const hasOAuthResult = Boolean(integration || status || error);

  useEffect(() => {
    const payload = {
      type: "oauth_complete" as const,
      integration,
      status,
      error,
    };

    if (window.opener) {
      window.opener.postMessage(payload, window.location.origin);
      window.close();
      return;
    }

    // Popup blocked: OAuth ran in this tab, so there is no opener — return to integrations.
    if (!integration && !status && !error) return;

    const sp = new URLSearchParams();
    if (integration) sp.set("integration", integration);
    if (status) sp.set("status", status);
    if (error) sp.set("error", error);
    const qs = sp.toString();
    window.location.replace(qs ? `/integrations?${qs}` : "/integrations");
  }, [integration, status, error]);

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-page">
        <div className="text-center space-y-3 max-w-sm">
          <div className="text-4xl">&#10060;</div>
          <h1 className="text-lg font-semibold text-ink">Connection Failed</h1>
          <p className="text-sm text-ink-2">{error}</p>
          <p className="text-xs text-ink-3">You can close this window.</p>
          <Link href="/integrations" className="text-sm text-brand hover:underline">
            Back to Integrations
          </Link>
        </div>
      </div>
    );
  }

  if (!hasOAuthResult) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-page px-4">
        <div className="text-center space-y-3 max-w-md">
          <h1 className="text-lg font-semibold text-ink">Integration OAuth return URL</h1>
          <p className="text-sm text-ink-2">
            This address is opened automatically after you connect Slack, Notion, HubSpot, and similar
            integrations from the Integrations page. It is not used for Google account sign-in — use{" "}
            <Link href="/login" className="text-brand hover:underline">
              /login
            </Link>{" "}
            for that.
          </p>
          <p className="text-xs text-ink-3">
            &quot;Close manually&quot; only works for popup windows opened by the app; a tab you opened yourself
            cannot be closed by the browser.
          </p>
          <div className="flex flex-wrap justify-center gap-4 pt-2">
            <Link href="/integrations" className="text-sm text-brand hover:underline">
              Integrations
            </Link>
            <Link href="/login" className="text-sm text-brand hover:underline">
              Sign in
            </Link>
            <Link href="/" className="text-sm text-brand hover:underline">
              Home
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-page">
      <div className="text-center space-y-3 max-w-sm">
        <div className="text-4xl">&#10003;</div>
        <h1 className="text-lg font-semibold text-ink">
          {integration ? `${integration} connected` : "Connected"}
        </h1>
        <p className="text-sm text-ink-2">
          This window will close automatically.
        </p>
        <button type="button" onClick={() => window.close()} className="text-xs text-brand hover:underline block w-full">
          Close manually
        </button>
        <Link href="/integrations" className="text-xs text-ink-3 hover:text-brand hover:underline">
          Open Integrations instead
        </Link>
      </div>
    </div>
  );
}

export default function OAuthCallbackPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-screen bg-page"><p className="text-sm text-ink-3">Loading...</p></div>}>
      <OAuthCallbackContent />
    </Suspense>
  );
}
