/**
 * Which sign-in method this browser last used successfully, so the sign-in
 * page can tag it "Last used" — a pilot who can't remember whether they came
 * in through Google or by email code otherwise risks making a second account.
 *
 * Browser-only and a hint: it grants nothing and never leaves the device.
 *
 * Written only by the two sign-in ACTIONS, on success — never by the readers
 * of "who is signed in" (getCurrentUser / seedCurrentUser), which stay free of
 * this concern:
 * - an email code succeeds on the sign-in page, so `signInWithOtp` writes it;
 * - Google succeeds on the far side of a redirect, so `signInWithGoogle`
 *   returns through `/signin?via=google`, and the page writes it on arrival.
 *   better-auth sends a pilot to the callback URL only once the session
 *   exists — a cancel or an error goes to its error URL instead — so an
 *   abandoned Google attempt never relabels the page.
 *
 * SSR-safe: no storage access at module scope, and every access is guarded
 * (Safari private mode throws on write).
 */
export type SignInMethod = "google" | "email";

export const LAST_SIGN_IN_KEY = "glidecomp:last-sign-in";

/** The `/signin` query param a completed OAuth sign-in returns with. */
export const SIGNED_IN_VIA_PARAM = "via";

function isMethod(v: unknown): v is SignInMethod {
  return v === "google" || v === "email";
}

export function parseSignInMethod(v: string | null): SignInMethod | null {
  return isMethod(v) ? v : null;
}

export function readLastSignInMethod(): SignInMethod | null {
  try {
    return parseSignInMethod(localStorage.getItem(LAST_SIGN_IN_KEY));
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
