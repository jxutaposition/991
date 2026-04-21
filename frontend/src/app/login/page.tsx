import LoginClient from "./login-client";

export default function LoginPage() {
  const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || "";
  const showGoogleDebug = process.env.NEXT_PUBLIC_GOOGLE_DEBUG === "1";
  return <LoginClient googleClientId={googleClientId} showGoogleDebug={showGoogleDebug} />;
}
