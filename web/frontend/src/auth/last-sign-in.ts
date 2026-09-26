/**
 * Which sign-in method this browser last used successfully, so the sign-in
 * page can tag it "Last used" — a pilot who can't remember whether they came
 * in through Google or by email code otherwise risks making a second account.
 *
 * Browser-only and a hint: it grants nothing and never leaves the device.
 *
 * Recorded on SUCCESS, never on a click. An email code succeeds on this page,
 * so it is written directly. Google succeeds on the far side of a redirect,
 * so the click only parks a *pending* marker in sessionStorage (same tab,
 * survives the round trip) and the first signed-in /api/auth/me promotes it.
 * A cancelled Google attempt therefore never relabels the page.
 *
 * SSR-safe: no storage access at module scope, and every access is guarded
 * (Safari private mode throws on write).
 */
export type SignInMethod = "google" | "email";

export const LAST_SIGN_IN_KEY = "glidecomp:last-sign-in";
export const PENDING_SIGN_IN_KEY = "glidecomp:pending-sign-in";

function isMethod(v: unknown): v is SignInMethod {
  return v === "google" || v === "email";
}

export function readLastSignInMethod(): SignInMethod | null {
  try {
    const v = localStorage.getItem(LAST_SIGN_IN_KEY);
    return isMethod(v) ? v : null;
  } catch {
    return null;
  }
}

export function writeLastSignInMethod(method: SignInMethod): void {
  try {
    localStorage.setItem(LAST_SIGN_IN_KEY, method);
  } catch {
    // Storage blocked — the page just shows no pill.
  }
}

/** Called just before leaving for an OAuth provider. */
export function markPendingSignIn(method: SignInMethod): void {
  try {
    sessionStorage.setItem(PENDING_SIGN_IN_KEY, method);
  } catch {
    // Storage blocked — nothing to promote later.
  }
}

/** Called once a session is confirmed: a pending attempt becomes the answer. */
export function confirmPendingSignIn(): void {
  try {
    const pending = sessionStorage.getItem(PENDING_SIGN_IN_KEY);
    if (pending === null) return;
    sessionStorage.removeItem(PENDING_SIGN_IN_KEY);
    if (isMethod(pending)) writeLastSignInMethod(pending);
  } catch {
    // Storage blocked.
  }
}
