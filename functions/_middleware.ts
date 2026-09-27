/**
 * Host-level dedup: the production Pages alias (glidecomp.pages.dev) serves an
 * exact duplicate of glidecomp.com and — unlike branch preview hosts
 * (<branch>.glidecomp.pages.dev), which Cloudflare marks noindex — is
 * indexable, so it is 301'd to the real domain. Branch previews don't match
 * the exact-host check and are untouched. This middleware only sees requests
 * routed to Functions — _routes.json includes the indexable static content
 * pages (/, /about, /legal, /scoring/*) alongside /api/*, /comp* and
 * /sitemap.xml precisely so they get this redirect (Pages _redirects can't
 * match on host); on any other hostname next() falls through to the asset.
 *
 * It also gives HTML the site's security headers, CSP included. Pages applies
 * public/_headers to static assets only, never to a Function's response, so
 * without this the SSR'd /comp* pages went out with no CSP at all. A header
 * the response already carries (a static asset, from _headers) is left alone.
 */
import { SECURITY_HEADERS } from "../web/frontend/src/security-headers";

const PROD_ALIAS = "glidecomp.pages.dev";
const CANONICAL_ORIGIN = "https://glidecomp.com";

export const onRequest: PagesFunction = async (context) => {
  const url = new URL(context.request.url);
  if (url.hostname === PROD_ALIAS) {
    return Response.redirect(`${CANONICAL_ORIGIN}${url.pathname}${url.search}`, 301);
  }
  const res = await context.next();
  if (!(res.headers.get("content-type") ?? "").startsWith("text/html")) return res;
  const missing = Object.entries(SECURITY_HEADERS).filter(([k]) => !res.headers.has(k));
  if (missing.length === 0) return res;
  // A response from next() can have immutable headers; copy before editing.
  const out = new Response(res.body, res);
  for (const [k, v] of missing) out.headers.set(k, v);
  return out;
};
