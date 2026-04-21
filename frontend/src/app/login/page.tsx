"use client";

import { useAuth } from "@/lib/auth-context";
import { GoogleOAuthProvider, GoogleLogin } from "@react-oauth/google";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "";
const DEBUG_ENDPOINT = "http://127.0.0.1:7924/ingest/2f5fe76c-0c9d-4511-bb6b-6e08dd27dd37";
const SHOW_GOOGLE_DEBUG = process.env.NEXT_PUBLIC_GOOGLE_DEBUG === "1";

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

export default function LoginPage() {
  const { user, loading, signIn } = useAuth();
  const router = useRouter();

  useEffect(() => {
    debugLog("pre-fix", "H1", "frontend/src/app/login/page.tsx:35", "Login page effect state", {
      loading,
      hasUser: Boolean(user),
      host: typeof window !== "undefined" ? window.location.host : "unknown",
      hasGoogleClientId: Boolean(GOOGLE_CLIENT_ID),
      googleClientIdLength: GOOGLE_CLIENT_ID.length,
    });

    if (!loading && user) router.push("/");
  }, [loading, user, router]);

  if (loading) return <div className="flex items-center justify-center min-h-[60vh] text-ink-3">Loading...</div>;
  if (user) return null;

  debugLog("pre-fix", "H2", "frontend/src/app/login/page.tsx:49", "Login page render branch", {
    branch: GOOGLE_CLIENT_ID ? "google-enabled" : "google-disabled",
    hasGoogleClientId: Boolean(GOOGLE_CLIENT_ID),
    googleClientIdLength: GOOGLE_CLIENT_ID.length,
    isLikelyPlaceholder:
      GOOGLE_CLIENT_ID.toLowerCase().includes("your_") || GOOGLE_CLIENT_ID.toLowerCase().includes("example"),
  });

  const googleClientIdPreview = GOOGLE_CLIENT_ID
    ? `${GOOGLE_CLIENT_ID.slice(0, 12)}...${GOOGLE_CLIENT_ID.slice(-18)}`
    : "(empty)";
  const looksLikeGoogleWebClientId = GOOGLE_CLIENT_ID.includes(".apps.googleusercontent.com");

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-8">
      <div className="text-center space-y-2">
        <h1 className="text-3xl font-bold text-ink">Sign in to 99percent</h1>
        <p className="text-ink-2">Expert-trained GTM agents for the whole funnel</p>
      </div>

      {GOOGLE_CLIENT_ID ? (
        <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
          <GoogleLogin
            onSuccess={async (response) => {
              debugLog("pre-fix", "H4", "frontend/src/app/login/page.tsx:66", "Google login success callback", {
                hasCredential: Boolean(response.credential),
              });
              if (response.credential) {
                try {
                  await signIn(response.credential);
                  router.push("/");
                } catch (e) {
                  console.error("Sign-in failed:", e);
                }
              }
            }}
            onError={() => {
              debugLog("pre-fix", "H4", "frontend/src/app/login/page.tsx:78", "Google login widget error callback", {});
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

      {SHOW_GOOGLE_DEBUG ? (
        <div className="w-full max-w-2xl rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-left text-amber-100">
          <p className="font-semibold mb-1">Google Auth Debug</p>
          <p>host: {typeof window !== "undefined" ? window.location.host : "unknown"}</p>
          <p>hasGoogleClientId: {String(Boolean(GOOGLE_CLIENT_ID))}</p>
          <p>googleClientIdLength: {GOOGLE_CLIENT_ID.length}</p>
          <p>looksLikeGoogleWebClientId: {String(looksLikeGoogleWebClientId)}</p>
          <p>googleClientIdPreview: {googleClientIdPreview}</p>
        </div>
      ) : null}
    </div>
  );
}
