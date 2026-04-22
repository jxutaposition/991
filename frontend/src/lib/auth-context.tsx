"use client";

import { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef } from "react";

import { agentDebugLog } from "@/lib/agent-debug-log";

const AUTH_TOKEN_KEY = "99percent_token";
const AUTH_ACTIVE_CLIENT_KEY = "99percent_active_client";
/** Legacy keys — migrated once on load */
const LEGACY_TOKEN_KEY = "lele_token";
const LEGACY_ACTIVE_CLIENT_KEY = "lele_active_client";

function migrateLegacyAuthStorage(): void {
  if (typeof window === "undefined") return;
  if (!localStorage.getItem(AUTH_TOKEN_KEY) && localStorage.getItem(LEGACY_TOKEN_KEY)) {
    localStorage.setItem(AUTH_TOKEN_KEY, localStorage.getItem(LEGACY_TOKEN_KEY)!);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
  }
  if (!localStorage.getItem(AUTH_ACTIVE_CLIENT_KEY) && localStorage.getItem(LEGACY_ACTIVE_CLIENT_KEY)) {
    localStorage.setItem(AUTH_ACTIVE_CLIENT_KEY, localStorage.getItem(LEGACY_ACTIVE_CLIENT_KEY)!);
    localStorage.removeItem(LEGACY_ACTIVE_CLIENT_KEY);
  }
}

interface User {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
}

interface ClientRole {
  slug: string;
  name: string;
  role: string;
  engagement_stage?: string | null;
}

interface AuthContextValue {
  user: User | null;
  clients: ClientRole[];
  activeClient: string | null;
  token: string | null;
  loading: boolean;
  signIn: (idToken: string) => Promise<void>;
  signOut: () => void;
  setActiveClient: (slug: string) => void;
  refreshClients: () => Promise<void>;
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  clients: [],
  activeClient: null,
  token: null,
  loading: true,
  signIn: async () => {},
  signOut: () => {},
  setActiveClient: () => {},
  refreshClients: async () => {},
  apiFetch: (url, init) => fetch(url, init),
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [clients, setClients] = useState<ClientRole[]>([]);
  const [activeClient, setActiveClientState] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadUser = useCallback(async (jwt: string) => {
    try {
      const res = await fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (!res.ok) throw new Error("Invalid token");
      const data = await res.json();
      setUser(data.user);
      const freshClients: ClientRole[] = data.clients ?? [];
      setClients(freshClients);
      setToken(jwt);
      // Pick active client: must exist in fresh list (stale localStorage slug → 404 on /api/clients/:slug/*)
      setActiveClientState((prev) => {
        let next: string | null = null;
        if (prev && freshClients.some((c) => c.slug === prev)) {
          next = prev;
        } else {
          const stored = localStorage.getItem(AUTH_ACTIVE_CLIENT_KEY);
          if (stored && freshClients.some((c) => c.slug === stored)) {
            next = stored;
          } else {
            next = freshClients[0]?.slug ?? null;
          }
        }
        if (next) {
          localStorage.setItem(AUTH_ACTIVE_CLIENT_KEY, next);
        } else {
          localStorage.removeItem(AUTH_ACTIVE_CLIENT_KEY);
        }
        return next;
      });
    } catch {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      setUser(null);
      setToken(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    migrateLegacyAuthStorage();
    const stored = localStorage.getItem(AUTH_TOKEN_KEY);
    if (stored) {
      loadUser(stored);
    } else {
      setLoading(false);
    }
  }, [loadUser]);

  const signIn = useCallback(async (idToken: string) => {
    const res = await fetch("/api/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id_token: idToken }),
    });
    const responseText = await res.text();
    let backendError = "Authentication failed";
    try {
      const parsed = JSON.parse(responseText) as { error?: string; code?: string };
      if (typeof parsed.error === "string" && parsed.error.trim()) {
        backendError = parsed.error.trim();
      }
    } catch {
      if (responseText.trim()) backendError = responseText.trim();
    }
    const contentType = res.headers.get("content-type") ?? "";
    const snippet = responseText.slice(0, 280).replace(/[^\x20-\x7E]/g, "?");
    let hypothesisId = "H0-unknown";
    if (!res.ok && res.status >= 500 && /<\s*html/i.test(responseText)) {
      hypothesisId = "H1-next-proxy-html-or-unreachable-backend";
    } else if (!res.ok && res.status >= 500 && responseText.includes("internal_error")) {
      hypothesisId = "H2-backend-json-internal-error";
    } else if (!res.ok && res.status >= 500) {
      hypothesisId = "H3-backend-5xx-non-html";
    } else if (!res.ok) {
      hypothesisId = "H4-client-or-auth-4xx";
    } else {
      hypothesisId = "H5-success";
    }
    // #region agent log
    agentDebugLog(
      "auth-google-repro",
      hypothesisId,
      "frontend/src/lib/auth-context.tsx:signIn",
      "google exchange response",
      {
        idTokenLength: idToken.length,
        status: res.status,
        ok: res.ok,
        contentType,
        bodyLength: responseText.length,
        bodySnippet: snippet,
        backendError,
      },
      { persistSession: !res.ok },
    );
    fetch("http://127.0.0.1:7924/ingest/2f5fe76c-0c9d-4511-bb6b-6e08dd27dd37", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "8025bc" },
      body: JSON.stringify({
        sessionId: "8025bc",
        runId: "pre-fix",
        hypothesisId: backendError.includes("stub:") ? "H1" : "H2",
        location: "frontend/src/lib/auth-context.tsx:signIn",
        message: "google POST result (no token payload)",
        data: {
          httpStatus: res.status,
          ok: res.ok,
          backendErrorPrefix: backendError.slice(0, 80),
          stubShapedError: backendError.includes("stub:"),
          idTokenSegmentCount: idToken.split(".").length,
          idTokenLength: idToken.length,
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    if (!res.ok) throw new Error(`Authentication failed: ${backendError}`);
    const data = JSON.parse(responseText);
    localStorage.setItem(AUTH_TOKEN_KEY, data.token);
    await loadUser(data.token);
  }, [loadUser]);

  const signOut = useCallback(() => {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_ACTIVE_CLIENT_KEY);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    localStorage.removeItem(LEGACY_ACTIVE_CLIENT_KEY);
    setUser(null);
    setToken(null);
    setClients([]);
    setActiveClientState(null);
  }, []);

  const setActiveClient = useCallback((slug: string) => {
    setActiveClientState(slug);
    localStorage.setItem(AUTH_ACTIVE_CLIENT_KEY, slug);
  }, []);

  const refreshClients = useCallback(async () => {
    const jwt = tokenRef.current ?? localStorage.getItem(AUTH_TOKEN_KEY);
    if (!jwt) return;
    try {
      const res = await fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      setUser(data.user);
      const fresh: ClientRole[] = data.clients ?? [];
      setClients(fresh);
      setActiveClientState(prev => {
        if (prev && fresh.some(c => c.slug === prev)) return prev;
        return fresh[0]?.slug ?? null;
      });
    } catch { /* ignore */ }
  }, []);

  // Use a ref for the token so apiFetch has a stable identity and doesn't
  // cause cascading re-renders / EventSource reconnects when the token changes.
  // Updated synchronously during render (not in an effect) so that child
  // effects calling apiFetch always see the current value.
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const apiFetch = useCallback(
    (url: string, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      if (tokenRef.current && !headers.has("Authorization")) {
        headers.set("Authorization", `Bearer ${tokenRef.current}`);
      }
      if (!headers.has("Content-Type") && init?.body && typeof init.body === "string") {
        headers.set("Content-Type", "application/json");
      }
      return fetch(url, { ...init, headers });
    },
    []
  );

  const value = useMemo(
    () => ({ user, clients, activeClient, token, loading, signIn, signOut, setActiveClient, refreshClients, apiFetch }),
    [user, clients, activeClient, token, loading, signIn, signOut, setActiveClient, refreshClients, apiFetch]
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
