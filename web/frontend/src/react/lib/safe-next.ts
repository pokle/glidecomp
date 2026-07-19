// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Sanitise a caller-supplied post-sign-in `next` target down to a same-origin,
 * site-relative path. Used both to build the `/signin?next=` link
 * (`goToSignIn`) and to decide where `window.location` navigates after a
 * successful sign-in (`SignIn.tsx`).
 *
 * The naive guard `raw.startsWith("/") && !raw.startsWith("//")` is NOT
 * enough. Browsers — and the WHATWG URL parser they share — fold a leading
 * `"/\"` into `"//"` for http(s) schemes, so `next=/\evil.example` slips past
 * that check (second char is `\`, not `/`) and then, when assigned to
 * `window.location.href`, resolves to `https://evil.example/`: an open
 * redirect that turns the sign-in page into a phishing bounce.
 *
 * Resolve `raw` against a throwaway origin using the same parser the browser
 * uses; reject anything that lands off that origin, and return only the
 * normalised path so a caller can never be handed a full absolute URL.
 */
export function safeNext(
  raw: string | null | undefined,
  fallback = "/comp"
): string {
  if (!raw) return fallback;
  try {
    // A syntactically-invalid host that can never match a real origin, so a
    // crafted `next` pointing back at it would still be rejected downstream.
    const base = "https://glidecomp.invalid";
    const u = new URL(raw, base);
    // Off-origin: absolute URL, protocol-relative "//host", backslash
    // "/\\host", or a non-http scheme like "javascript:" (origin "null").
    if (u.origin !== base) return fallback;
    return u.pathname + u.search + u.hash;
  } catch {
    return fallback;
  }
}
