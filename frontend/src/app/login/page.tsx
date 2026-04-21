import LoginClient from "./login-client";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  const nextPublicClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "";
  const serverClientId = process.env.GOOGLE_CLIENT_ID || "";
  const googleClientId = nextPublicClientId || serverClientId;
  const googleClientIdSource = nextPublicClientId
    ? "NEXT_PUBLIC_GOOGLE_CLIENT_ID"
    : serverClientId
      ? "GOOGLE_CLIENT_ID"
      : "none";
  const showGoogleDebug = process.env.NEXT_PUBLIC_GOOGLE_DEBUG === "1";
  return (
    <LoginClient
      googleClientId={googleClientId}
      showGoogleDebug={showGoogleDebug}
      googleClientIdSource={googleClientIdSource}
    />
  );
}
