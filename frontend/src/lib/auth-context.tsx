"use client";

import { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef } from "react";

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
      setClients(data.clients ?? []);
      setToken(jwt);
      // Default to first client if none active (functional setState avoids dep on activeClient)
      if (data.clients?.length > 0) {
        setActiveClientState(prev => {
          if (prev) return prev;
          const stored = localStorage.getItem(AUTH_ACTIVE_CLIENT_KEY);
          return stored ?? data.clients[0].slug;
        });
      }
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
    if (!res.ok) throw new Error("Authentication failed");
    const data = await res.json();
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
