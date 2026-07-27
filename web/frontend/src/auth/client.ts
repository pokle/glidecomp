import { createAuthClient } from "better-auth/client";
import { emailOTPClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [emailOTPClient()],
});

export function signInWithGoogle(callbackURL = "/comp") {
  return authClient.signIn.social({ provider: "google", callbackURL });
}

/** Email a one-time sign-in code. Returns better-auth's { data, error }. */
export function sendSignInOtp(email: string) {
  return authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
}

/** Exchange an emailed code for a session. Returns { data, error }. */
export function signInWithOtp(email: string, otp: string) {
  return authClient.signIn.emailOtp({ email, otp });
}

export async function signOut() {
  const result = await authClient.signOut();
  writeAccountHint(null);
  return result;
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  username: string | null;
}

/**
 * Last-known account state, mirrored into localStorage so the *static* Astro
 * chrome can render the right thing before (or without) an API round trip —
 * the prerendered pages have no session at build time, and calling
 * /api/auth/me on every marketing-page hit would tax the auth worker for the
 * overwhelming majority of visitors who are signed out.
 *
 * A hint, not a credential: it grants nothing, and the header reconciles it
 * against the real answer. Kept in sync here because getCurrentUser/signOut
 * are the only two places that learn whether there's a session.
 * Read by static/src/components/SiteHeader.astro — keep the shape in sync.
 */
export const ACCOUNT_HINT_KEY = "glidecomp:account";

export function writeAccountHint(user: AuthUser | null) {
  try {
    if (user) localStorage.setItem(ACCOUNT_HINT_KEY, JSON.stringify({ name: user.name || user.email }));
    else localStorage.removeItem(ACCOUNT_HINT_KEY);
  } catch {
    // Storage blocked (Safari private mode) — the static header just falls
    // back to showing "Sign in", which is the pre-existing behaviour.
  }
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  try {
    const res = await fetch("/api/auth/me", { credentials: "include" });
    if (!res.ok) return null;
    const data: { user: AuthUser | null } = await res.json();
    const user = data.user ?? null;
    writeAccountHint(user);
    return user;
  } catch {
    // A network blip is not evidence of being signed out — leave the hint be.
    return null;
  }
}

export async function deleteAccount(): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch("/api/auth/delete-account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { success: false, error: (data as { error?: string }).error || "Failed to delete account" };
    }
    return { success: true };
  } catch {
    return { success: false, error: "Network error" };
  }
}

export async function setUsername(
  username: string
): Promise<{ username?: string; error?: string }> {
  const res = await fetch("/api/auth/set-username", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ username }),
  });
  return res.json();
}
