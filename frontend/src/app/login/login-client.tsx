"use client";

import { useAuth } from "@/lib/auth-context";
import { GoogleOAuthProvider, GoogleLogin } from "@react-oauth/google";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

const DEBUG_ENDPOINT = "http://127.0.0.1:7924/ingest/2f5fe76c-0c9d-4511-bb6b-6e08dd27dd37";

function debugLog(runId: string, hypothesisId: string, location: string, message: string, data: Record<string, unknown>) {
  // #region agent log
  fetch(DEBUG_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "9c95a4",
    },
    body: JSON.stringify({
      sessionId: "9c95a4",
      runId,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
}

type LoginClientProps = {
  googleClientId: string;
  showGoogleDebug: boolean;
  googleClientIdSource: string;
};

export default function LoginClient({ googleClientId, showGoogleDebug, googleClientIdSource }: LoginClientProps) {
  const { user, loading, signIn } = useAuth();
  const router = useRouter();
  const [signInError, setSignInError] = useState<string | null>(null);

  useEffect(() => {
    debugLog("pre-fix", "H1", "frontend/src/app/login/login-client.tsx:39", "Login page effect state", {
      loading,
      hasUser: Boolean(user),
      host: typeof window !== "undefined" ? window.location.host : "unknown",
      hasGoogleClientId: Boolean(googleClientId),
      googleClientIdLength: googleClientId.length,
    });

    if (!loading && user) router.push("/");
  }, [loading, user, router, googleClientId]);

  if (loading) return <div className="flex items-center justify-center min-h-[60vh] text-ink-3">Loading...</div>;
  if (user) return null;

  debugLog("pre-fix", "H2", "frontend/src/app/login/login-client.tsx:55", "Login page render branch", {
    branch: googleClientId ? "google-enabled" : "google-disabled",
    hasGoogleClientId: Boolean(googleClientId),
    googleClientIdLength: googleClientId.length,
    isLikelyPlaceholder:
      googleClientId.toLowerCase().includes("your_") || googleClientId.toLowerCase().includes("example"),
  });

  const googleClientIdPreview = googleClientId
    ? `${googleClientId.slice(0, 12)}...${googleClientId.slice(-18)}`
    : "(empty)";
  const looksLikeGoogleWebClientId = googleClientId.includes(".apps.googleusercontent.com");

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-8">
      <div className="text-center space-y-2">
        <h1 className="text-3xl font-bold text-ink">Sign in to 99percent</h1>
        <p className="text-ink-2">Expert-trained GTM agents for the whole funnel</p>
      </div>

      {googleClientId ? (
        <GoogleOAuthProvider clientId={googleClientId}>
          <GoogleLogin
            onSuccess={async (response) => {
              if (response.credential) {
                try {
                  setSignInError(null);
                  await signIn(response.credential);
                  router.push("/");
                } catch (e) {
                  setSignInError(e instanceof Error ? e.message : "Authentication failed");
                  console.error("Sign-in failed:", e);
                }
              }
            }}
            onError={() => {
              setSignInError("Google login widget failed before token exchange");
              console.error("Google login failed");
            }}
            theme="outline"
            size="large"
            text="signin_with"
          />
        </GoogleOAuthProvider>
      ) : (
        <div className="text-center text-ink-3 text-sm">
          <p>Google Sign-In not configured.</p>
          <p className="mt-1">Set <code className="bg-surface px-1 rounded">NEXT_PUBLIC_GOOGLE_CLIENT_ID</code> to enable.</p>
        </div>
      )}

      {showGoogleDebug ? (
        <div className="w-full max-w-2xl rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-left text-amber-100">
          <p className="font-semibold mb-1">Google Auth Debug</p>
          <p>host: {typeof window !== "undefined" ? window.location.host : "unknown"}</p>
          <p>hasGoogleClientId: {String(Boolean(googleClientId))}</p>
          <p>googleClientIdLength: {googleClientId.length}</p>
          <p>googleClientIdSource: {googleClientIdSource}</p>
          <p>looksLikeGoogleWebClientId: {String(looksLikeGoogleWebClientId)}</p>
          <p>googleClientIdPreview: {googleClientIdPreview}</p>
          <p>signInError: {signInError ?? "(none)"}</p>
        </div>
      ) : null}
    </div>
  );
}
