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

  // Use a ref for the token so apiFetch has a stable identity and doesn't
  // cause cascading re-renders / EventSource reconnects when the token changes.
  const tokenRef = useRef(token);
  useEffect(() => { tokenRef.current = token; }, [token]);

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
    () => ({ user, clients, activeClient, token, loading, signIn, signOut, setActiveClient, apiFetch }),
    [user, clients, activeClient, token, loading, signIn, signOut, setActiveClient, apiFetch]
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
