/**
 * Current-user context: one getCurrentUser() fetch per page load, shared by
 * the nav and every page (mirrors what initNav() returned in the vanilla app).
 *
 * Also hosts the superadmin "Preview as" support: a site super admin can view
 * the app as a signed-out visitor, a plain pilot, or a comp admin without
 * changing their real session. Presentation-only — the API still authenticates
 * the real superadmin, so nothing here grants or removes any actual access.
 */
import { createContext, useContext, useEffect, useState } from "react";
import { authClient, getCurrentUser, type AuthUser } from "../../auth/client";

/**
 * "actual" is no preview (render the real role). "admin" renders comp-admin
 * controls on every comp (the API lets a superadmin act on any comp, so the
 * buttons work); "pilot" hides them everywhere; "out" presents the user as
 * signed out.
 */
export type PreviewRole = "actual" | "admin" | "pilot" | "out";

const PREVIEW_KEY = "glidecomp:preview-role";

function readPreviewRole(): PreviewRole {
  try {
    const v = sessionStorage.getItem(PREVIEW_KEY);
    return v === "admin" || v === "pilot" || v === "out" ? v : "actual";
  } catch {
    return "actual";
  }
}

function writePreviewRole(role: PreviewRole) {
  try {
    if (role === "actual") sessionStorage.removeItem(PREVIEW_KEY);
    else sessionStorage.setItem(PREVIEW_KEY, role);
  } catch {
    // Session storage unavailable — preview just won't persist.
  }
}

interface UserState {
  /** The user as presented (null while previewing "signed out"). */
  user: AuthUser | null;
  /** True until the /api/auth/me round trip settles. */
  loading: boolean;
  /**
   * True when a signed-out view is only a preview — pages that normally
   * redirect straight into OAuth should show their sign-in prompt instead.
   */
  previewingSignedOut: boolean;
  /** Active preview role ("actual" = none). */
  previewRole: PreviewRole;
  /** True for real site super admins — reveals the "Preview as" pill. */
  isSuperAdmin: boolean;
  setPreviewRole: (role: PreviewRole) => void;
}

const UserContext = createContext<UserState>({
  user: null,
  loading: true,
  previewingSignedOut: false,
  previewRole: "actual",
  isSuperAdmin: false,
  setPreviewRole: () => {},
});

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

/** One whoami round trip per page load, only made once a user is known. */
let whoamiPromise: Promise<boolean> | null = null;
function fetchIsSuperAdminOnce(): Promise<boolean> {
  whoamiPromise ??= fetch("/api/admin/whoami", { credentials: "include" })
    .then((res) => (res.ok ? res.json() : { is_super_admin: false }))
    .then((data) => (data as { is_super_admin?: boolean }).is_super_admin === true)
    .catch(() => false);
  return whoamiPromise;
}

export function useUser(): UserState {
  return useContext(UserContext);
}

/**
 * Applies the preview role to a real comp-admin check. Call it wherever the
 * UI decides whether to show admin controls.
 */
export function useAdminView(realIsAdmin: boolean): boolean {
  const { previewRole, isSuperAdmin } = useUser();
  if (!isSuperAdmin || previewRole === "actual") return realIsAdmin;
  return previewRole === "admin";
}

export function signInWithGoogle() {
  // While a superadmin previews a signed-out/pilot view, "Sign in" means
  // "back to my real self", not a second OAuth round trip.
  if (readPreviewRole() !== "actual") {
    writePreviewRole("actual");
    window.location.reload();
    return Promise.resolve();
  }
  return authClient.signIn.social({ provider: "google", callbackURL: "/comp" });
}

/**
 * True in a local dev build (Vite replaces `import.meta.env.DEV` with a static
 * boolean at build time) and in branch-preview builds, where CI sets
 * `VITE_ENABLE_TEST_LOGIN=1` (per-branch preview stacks sign in via dev-login
 * instead of Google — see docs/preview-environment-plan.md). Production builds
 * set neither, so the dev sign-in button never renders there, and the endpoint
 * it calls (`/api/auth/dev-login`) 404s there regardless.
 */
export const DEV_SIGN_IN_ENABLED =
  import.meta.env.DEV || import.meta.env.VITE_ENABLE_TEST_LOGIN === "1";

/**
 * Dev/test-only sign-in that skips Google OAuth — the same path the e2e
 * tests use. Calls the auth worker's `/api/auth/dev-login` (enabled when
 * `BETTER_AUTH_URL` is localhost, or on preview stacks via
 * `ENABLE_TEST_LOGIN`) to mint a real session for a fixed account, then
 * reloads into the app. The default identity matches the repo's super-admin
 * allowlist (`SUPER_ADMIN_EMAILS`) so the dev session has admin rights, which
 * is what local testing usually needs.
 */
export async function signInAsDev(
  name = "Tushar Pokle",
  email = "tushar.pokle@gmail.com"
): Promise<void> {
  writePreviewRole("actual");
  const res = await fetch("/api/auth/dev-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ name, email }),
  });
  if (!res.ok) {
    console.error("dev sign-in failed", res.status, await res.text().catch(() => ""));
    return;
  }
  window.location.href = "/comp";
}

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<{ user: AuthUser | null; loading: boolean }>({
    user: null,
    loading: true,
  });
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [previewRole, setPreviewRoleState] = useState<PreviewRole>(readPreviewRole);

  useEffect(() => {
    let cancelled = false;
    fetchCurrentUserOnce().then((user) => {
      if (cancelled) return;
      setMe({ user, loading: false });
      if (user) {
        fetchIsSuperAdminOnce().then((isSuper) => {
          if (!cancelled) setIsSuperAdmin(isSuper);
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function setPreviewRole(role: PreviewRole) {
    writePreviewRole(role);
    setPreviewRoleState(role);
  }

  // The preview only ever *reduces* what a real superadmin sees; for
  // everyone else it is inert (and the pill that sets it never renders).
  const previewing = isSuperAdmin && previewRole !== "actual";
  const state: UserState = {
    user: previewing && previewRole === "out" ? null : me.user,
    loading: me.loading,
    previewingSignedOut: previewing && previewRole === "out",
    previewRole: previewing ? previewRole : "actual",
    isSuperAdmin,
    setPreviewRole,
  };

  return <UserContext.Provider value={state}>{children}</UserContext.Provider>;
}
