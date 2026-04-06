"use client";

import { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef } from "react";

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
          const stored = localStorage.getItem("lele_active_client");
          return stored ?? data.clients[0].slug;
        });
      }
    } catch {
      localStorage.removeItem("lele_token");
      setUser(null);
      setToken(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem("lele_token");
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
    localStorage.setItem("lele_token", data.token);
    await loadUser(data.token);
  }, [loadUser]);

  const signOut = useCallback(() => {
    localStorage.removeItem("lele_token");
    localStorage.removeItem("lele_active_client");
    setUser(null);
    setToken(null);
    setClients([]);
    setActiveClientState(null);
  }, []);

  const setActiveClient = useCallback((slug: string) => {
    setActiveClientState(slug);
    localStorage.setItem("lele_active_client", slug);
  }, []);

  const refreshClients = useCallback(async () => {
    const jwt = tokenRef.current ?? localStorage.getItem("lele_token");
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
