import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, refreshSession, setAccessToken, setSessionLostHandler } from "../lib/api";
import type { Me } from "../lib/types";

type Status = "loading" | "anonymous" | "authenticated";

type AuthValue = {
  status: Status;
  me: Me | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>; // re-reads "who am I and which group" (after creating or joining a group)
};

const AuthContext = createContext<AuthValue | null>(null);

// Runs once per page load, even if React renders twice in development.
let bootstrap: Promise<Me | null> | null = null;
function bootstrapSession(): Promise<Me | null> {
  bootstrap ??= (async () => {
    if (!(await refreshSession())) return null; // no valid refresh cookie: not logged in
    return api<Me>("/api/auth/me");
  })().catch(() => null);
  return bootstrap;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [me, setMe] = useState<Me | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    let active = true;
    void bootstrapSession().then((m) => {
      if (!active) return;
      setMe(m);
      setStatus(m ? "authenticated" : "anonymous");
    });
    return () => {
      active = false;
    };
  }, []);

  // If a refresh ever fails mid-session, drop everything and show the login page.
  useEffect(() => {
    setSessionLostHandler(() => {
      setAccessToken(null);
      setMe(null);
      setStatus("anonymous");
      queryClient.clear();
    });
    return () => setSessionLostHandler(null);
  }, [queryClient]);

  const login = useCallback(async (email: string, password: string) => {
    const data = await api<{ accessToken: string }>("/api/auth/login", {
      method: "POST",
      body: { email, password },
      auth: false,
    });
    setAccessToken(data.accessToken);
    const m = await api<Me>("/api/auth/me");
    setMe(m);
    setStatus("authenticated");
  }, []);

  const logout = useCallback(async () => {
    try {
      await api("/api/auth/logout", { method: "POST", auth: false });
    } catch {
      // even if the server can't be reached, log out locally
    }
    setAccessToken(null);
    setMe(null);
    setStatus("anonymous");
    queryClient.clear(); // never leave one person's data in memory for the next
  }, [queryClient]);

  const reload = useCallback(async () => {
    setMe(await api<Me>("/api/auth/me"));
  }, []);

  const value = useMemo(() => ({ status, me, login, logout, reload }), [status, me, login, logout, reload]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
