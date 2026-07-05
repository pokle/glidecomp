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

export function useUser(): UserState {
  return useContext(UserContext);
}

/** Google sign-in that lands back in the React app rather than the vanilla dashboard. */
export function signInWithGoogle() {
  return authClient.signIn.social({ provider: "google", callbackURL: "/react/u/me" });
}

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<UserState>({ user: null, loading: true });

  useEffect(() => {
    let cancelled = false;
    getCurrentUser().then((user) => {
      if (!cancelled) setState({ user, loading: false });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return <UserContext.Provider value={state}>{children}</UserContext.Provider>;
}
