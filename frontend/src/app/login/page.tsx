"use client";

import { useAuth } from "@/lib/auth-context";
import { GoogleOAuthProvider, GoogleLogin } from "@react-oauth/google";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "";

export default function LoginPage() {
  const { user, loading, signIn } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && user) router.push("/");
  }, [loading, user, router]);

  if (loading) return <div className="flex items-center justify-center min-h-[60vh] text-ink-3">Loading...</div>;
  if (user) return null;

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
              if (response.credential) {
                try {
                  await signIn(response.credential);
                  router.push("/");
                } catch (e) {
                  console.error("Sign-in failed:", e);
                }
              }
            }}
            onError={() => console.error("Google login failed")}
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
    </div>
  );
}
