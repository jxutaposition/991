"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";

function OAuthCallbackContent() {
  const params = useSearchParams();
  const integration = params.get("integration") ?? "";
  const status = params.get("status") ?? "";
  const error = params.get("error");

  useEffect(() => {
    if (window.opener) {
      window.opener.postMessage(
        { type: "oauth_complete", integration, status, error },
        window.location.origin,
      );
      window.close();
    }
  }, [integration, status, error]);

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-page">
        <div className="text-center space-y-3 max-w-sm">
          <div className="text-4xl">&#10060;</div>
          <h1 className="text-lg font-semibold text-ink">Connection Failed</h1>
          <p className="text-sm text-ink-2">{error}</p>
          <p className="text-xs text-ink-3">You can close this window.</p>
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
        <button
          onClick={() => window.close()}
          className="text-xs text-brand hover:underline"
        >
          Close manually
        </button>
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
