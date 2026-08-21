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
 * Has this account still to be onboarded? The ONE definition of the gate —
 * Shell, the dashboard, the analysis page and onboarding itself all ask here,
 * so they can't drift apart and strand someone in a redirect loop.
 *
 * Both halves matter, and each is the sole signal for a different sign-up
 * path. A username is auto-derived at sign-up so a Google user never has to
 * pick one by hand — but that derivation also fires for email-OTP sign-ups,
 * which arrive with `name: ""` and so used to sail past a username-only gate
 * with nothing but a handle guessed off their email address. Nothing else in
 * the app ever asks for a display name, so the account stayed nameless.
 *
 * `name` is `"user".name` (the account's own display name, what /api/auth/me
 * and the header show), NOT the pilot profile's — those are separate fields.
 * Onboarding writes both.
 */
export function needsOnboarding(user: AuthUser): boolean {
  return !user.username || user.name.trim() === "";
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

const ME_ATTEMPTS = 3;
const ME_RETRY_DELAY_MS = 200;

/**
 * Who is signed in — asked once per page load (see UserProvider).
 *
 * **A failure to ask is not an answer (issue #481).** This runs exactly once,
 * and everything downstream keys off it: the header, and every admin control
 * on every comp page. So a single dropped request or 5xx used to render the
 * app permanently signed out — no retry, no recovery short of a reload, and
 * no sign to the user that anything had gone wrong. Transient failures are
 * therefore retried, and only a real 2xx answer decides.
 *
 * A 4xx is a real answer (it includes the 429 an over-limit API key gets) and
 * is not retried. After the last attempt this still resolves `null` rather
 * than throwing: "we couldn't tell" has to render as *something*, and the
 * signed-out chrome is the safe thing to show.
 */
export async function getCurrentUser(): Promise<AuthUser | null> {
  for (let attempt = 0; attempt < ME_ATTEMPTS; attempt++) {
    try {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      if (res.status >= 500) throw new Error(`/api/auth/me responded ${res.status}`);
      if (!res.ok) return null;
      const data: { user: AuthUser | null } = await res.json();
      const user = data.user ?? null;
      writeAccountHint(user);
      return user;
    } catch {
      // A network blip is not evidence of being signed out — leave the hint
      // be, wait a moment, and ask again.
      if (attempt < ME_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, ME_RETRY_DELAY_MS * (attempt + 1)));
      }
    }
  }
  return null;
}

/**
 * The one answer to "who is this visitor", shared by every caller on the page.
 *
 * Two concurrent calls aren't merely wasteful: under load the auth worker can
 * answer one of them with `user: null`, and whichever response lands last
 * wins. This used to be deduped inside UserProvider, which left the
 * preferences-sync bootstrap — imported by every React page via
 * analysis/config — making a second, independent round trip on every single
 * page load. Keeping the promise here means there is one flight per page no
 * matter who asks or in what order.
 */
let mePromise: Promise<AuthUser | null> | null = null;

export function getCurrentUserOnce(): Promise<AuthUser | null> {
  mePromise ??= getCurrentUser();
  return mePromise;
}

/**
 * Answer `getCurrentUserOnce()` from a value the server already resolved,
 * with no round trip at all. The server-rendered comp pages forward the
 * visitor's cookie while loading the page, so they know the answer before the
 * browser could even ask for it.
 */
export function seedCurrentUser(user: AuthUser | null): void {
  mePromise = Promise.resolve(user);
  writeAccountHint(user);
}

/**
 * Fold a change the client just made into the cached account, without asking
 * /api/auth/me again.
 *
 * The account is resolved once per page load, so a Settings rename used to be
 * invisible in the header — and in the static Astro chrome, which reads the
 * localStorage hint — until the next full reload. Both are updated here, so
 * every later reader of getCurrentUserOnce() sees the saved name too.
 *
 * Only ever call this with what the SERVER said it stored: this writes no
 * account state, it just stops the page from showing a value it knows is out
 * of date. A no-op when nobody is signed in.
 */
export function patchCurrentUser(patch: Partial<AuthUser>): void {
  const pending = mePromise ?? Promise.resolve(null);
  mePromise = pending.then((user) => {
    if (!user) return user;
    const next = { ...user, ...patch };
    writeAccountHint(next);
    return next;
  });
}

// Seed at module load, before any consumer can ask — the preferences-sync
// bootstrap runs during import and would otherwise race ahead of the entry.
// `user` is absent on a classic SPA boot, which means "unknown, go and ask"
// and must NOT be read as "signed out". Window-guarded because the SSR comp
// pages import this module and it has to stay inert in workerd.
if (typeof window !== "undefined") {
  const ssr = (window as { __SSR_DATA__?: { user?: AuthUser | null } }).__SSR_DATA__;
  if (ssr && "user" in ssr) seedCurrentUser(ssr.user ?? null);
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

/**
 * Set the account's username, and its display name when one is given. Sent
 * together (never as two requests) so the account can't be left holding one
 * half of what needsOnboarding() checks.
 */
export async function setUsername(
  username: string,
  name?: string
): Promise<{ username?: string; name?: string; error?: string }> {
  const res = await fetch("/api/auth/set-username", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(name === undefined ? { username } : { username, name }),
  });
  return res.json();
}
