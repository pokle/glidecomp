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
 */
const PROD_ALIAS = "glidecomp.pages.dev";
const CANONICAL_ORIGIN = "https://glidecomp.com";

export const onRequest: PagesFunction = async (context) => {
  const url = new URL(context.request.url);
  if (url.hostname === PROD_ALIAS) {
    return Response.redirect(`${CANONICAL_ORIGIN}${url.pathname}${url.search}`, 301);
  }
  return context.next();
};
