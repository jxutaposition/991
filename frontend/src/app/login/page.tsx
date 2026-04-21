import LoginClient from "./login-client";

export const dynamic = "force-dynamic";
const GOOGLE_CLIENT_ID_FALLBACK = "155021216015-0mu4n0m5csbc7rnbbjk652govm8haqpp.apps.googleusercontent.com";

export default function LoginPage() {
  const nextPublicClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "";
  const serverClientId = process.env.GOOGLE_CLIENT_ID || "";
  const googleClientId = nextPublicClientId || serverClientId || GOOGLE_CLIENT_ID_FALLBACK;
  const googleClientIdSource = nextPublicClientId
    ? "NEXT_PUBLIC_GOOGLE_CLIENT_ID"
    : serverClientId
      ? "GOOGLE_CLIENT_ID"
      : "fallback";
  const showGoogleDebug = process.env.NEXT_PUBLIC_GOOGLE_DEBUG === "1";
  return (
    <LoginClient
      googleClientId={googleClientId}
      showGoogleDebug={showGoogleDebug}
      googleClientIdSource={googleClientIdSource}
    />
  );
}
