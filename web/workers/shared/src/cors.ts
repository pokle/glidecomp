/**
 * Which origins may make credentialed requests to a GlideComp Worker.
 *
 * `credentials: true` means we MUST NOT reflect arbitrary origins, or any site
 * the user visits can make authenticated requests as them. So this is an
 * allowlist: production, Cloudflare Pages branch previews, and localhost (for
 * `bun run dev` against a live backend).
 *
 * It lives in the shared kit because auth-api and competition-api held
 * identical copies. That is the worst kind of duplication available: a domain
 * added to one and not the other is a genuine difference in who may act as a
 * signed-in user, in the half nobody edited, with no test to notice.
 */

const PAGES_PREVIEW = /^https:\/\/[a-z0-9-]+\.glidecomp\.pages\.dev$/;

export function isAllowedOrigin(origin: string): boolean {
  if (origin === "https://glidecomp.com") return true;
  if (PAGES_PREVIEW.test(origin)) return true;
  try {
    if (new URL(origin).hostname === "localhost") return true;
  } catch {
    /* malformed Origin — reject */
  }
  return false;
}

/**
 * The `origin` callback Hono's `cors()` takes: echo the caller's origin when
 * it is allowed, and an empty string (no `Access-Control-Allow-Origin` header
 * at all) when it is not.
 */
export function allowedOrigin(origin: string | undefined): string {
  return origin && isAllowedOrigin(origin) ? origin : "";
}
