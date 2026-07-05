/**
 * Current-user context: one getCurrentUser() fetch per page load, shared by
 * the nav and every page (mirrors what initNav() returned in the vanilla app).
 */
import { createContext, useContext, useEffect, useState } from "react";
import { authClient, getCurrentUser, type AuthUser } from "../../auth/client";

interface UserState {
  user: AuthUser | null;
  /** True until the /api/auth/me round trip settles. */
  loading: boolean;
}

const UserContext = createContext<UserState>({ user: null, loading: true });

/**
 * One /api/auth/me round trip per page load, shared across StrictMode's
 * double effect run. Two concurrent calls aren't just wasteful — under
 * load the local auth worker can answer one of them with user:null, and
 * whichever response lands last would win.
 */
let mePromise: Promise<AuthUser | null> | null = null;
function fetchCurrentUserOnce(): Promise<AuthUser | null> {
  mePromise ??= getCurrentUser();
  return mePromise;
}

export function useUser(): UserState {
  return useContext(UserContext);
}

export function signInWithGoogle() {
  return authClient.signIn.social({ provider: "google", callbackURL: "/u/me" });
}

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<UserState>({ user: null, loading: true });

  useEffect(() => {
    let cancelled = false;
    fetchCurrentUserOnce().then((user) => {
      if (!cancelled) setState({ user, loading: false });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return <UserContext.Provider value={state}>{children}</UserContext.Provider>;
}
