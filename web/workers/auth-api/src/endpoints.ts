/**
 * Which of Better Auth's own endpoints auth-api serves (SEC-55).
 *
 * Better Auth and the configured plugins mount dozens of endpoints under
 * /api/auth (47 at 1.7.6), and the catch-all in index.ts used to hand every
 * one of them to the library.
 * GlideComp uses the handful below; everything else now answers 404. It is an
 * allowlist rather than a blocklist because the library's surface grows with
 * its releases and nobody reviews an upgrade route by route. Before this,
 * endpoints nobody called were live:
 *
 * - `/update-user` wrote the account's display name with none of the checks
 *   SEC-49 put on `/set-name` and `/set-username`, plus an arbitrary `image`;
 * - `/get-access-token`, `/refresh-token` and `/account-info` handed the stored
 *   Google OAuth tokens and profile to any session or API key;
 * - `/email-otp/check-verification-otp` tested a sign-in code outside the
 *   per-address failure budget (SEC-56), and the other email-OTP flows minted
 *   codes of types nothing here uses.
 *
 * A feature that needs another Better Auth endpoint adds it here, in a change
 * a reviewer can see. GlideComp's own routes in index.ts (/me, /set-name,
 * /preferences, …) are registered ahead of the catch-all and never reach this.
 */

const BASE_PATH = "/api/auth";

const SERVED: ReadonlyArray<readonly [method: "GET" | "POST", path: RegExp]> = [
  // Google sign-in. A branch preview's sign-in comes back through
  // /callback/google/oauth-proxy (the oAuthProxy plugin, auth.ts), and
  // /oauth-proxy-callback is that plugin's deprecated alias, kept so a sign-in
  // in flight across an upgrade still lands. /error is where Better Auth sends
  // a failed OAuth round trip.
  ["POST", /^\/sign-in\/social$/],
  ["GET", /^\/callback\/[a-z0-9-]+$/],
  ["POST", /^\/callback\/[a-z0-9-]+$/],
  ["GET", /^\/callback\/[a-z0-9-]+\/oauth-proxy$/],
  ["GET", /^\/oauth-proxy-callback$/],
  ["GET", /^\/error$/],
  // Email-OTP sign-in — the two endpoints the per-address budgets guard.
  ["POST", /^\/email-otp\/send-verification-otp$/],
  ["POST", /^\/sign-in\/email-otp$/],
  // The session. Better Auth's client reads /get-session itself.
  ["GET", /^\/get-session$/],
  ["POST", /^\/get-session$/],
  ["POST", /^\/sign-out$/],
  // The public keys that verify the session-cache cookie (competition-api and
  // the SSR Function read them over the service binding).
  ["GET", /^\/jwks$/],
  // Settings → API keys.
  ["POST", /^\/api-key\/create$/],
  ["GET", /^\/api-key\/list$/],
  ["POST", /^\/api-key\/delete$/],
  ["GET", /^\/ok$/],
  // The OAuth 2.1 provider behind the MCP endpoint (mcp() in auth.ts,
  // docs/2026-10-24-mcp-oauth-plan.md §3). SPIKE: only what an MCP client's
  // sign-in uses — authorise, consent (and resuming after sign-in), the token
  // exchange, dynamic registration, revocation and userinfo, plus the client's
  // public name for the consent page. The provider's client-management and
  // introspection endpoints stay unserved.
  ["GET", /^\/oauth2\/authorize$/],
  ["POST", /^\/oauth2\/consent$/],
  ["POST", /^\/oauth2\/continue$/],
  ["POST", /^\/oauth2\/token$/],
  ["POST", /^\/oauth2\/register$/],
  ["POST", /^\/oauth2\/revoke$/],
  ["GET", /^\/oauth2\/userinfo$/],
  ["POST", /^\/oauth2\/userinfo$/],
  ["GET", /^\/oauth2\/public-client$/],
  // OpenID discovery relative to the issuer (which carries the base path).
  ["GET", /^\/\.well-known\/openid-configuration$/],
];

/**
 * The discovery documents MCP clients fetch from the ORIGIN root rather than
 * under /api/auth: RFC 8414 authorisation-server metadata (at the issuer's
 * path, /api/auth), and RFC 9728 protected-resource metadata (bare, and at the
 * resource's path, /mcp). The mcp() plugin answers them from its onRequest
 * hook; index.ts routes exactly these to the handler.
 */
const DISCOVERY: ReadonlyArray<RegExp> = [
  /^\/\.well-known\/oauth-authorization-server(\/api\/auth)?$/,
  /^\/\.well-known\/openid-configuration(\/api\/auth)?$/,
  /^\/\.well-known\/oauth-protected-resource(\/mcp)?$/,
];

/** Whether a root-level discovery request belongs to Better Auth. */
export function isDiscoveryPath(method: string, pathname: string): boolean {
  const verb = method.toUpperCase();
  return (verb === "GET" || verb === "HEAD") && DISCOVERY.some((p) => p.test(pathname));
}

/** Whether the Better Auth catch-all may handle this request. */
export function isServedAuthEndpoint(method: string, pathname: string): boolean {
  if (!pathname.startsWith(`${BASE_PATH}/`)) return false;
  const path = pathname.slice(BASE_PATH.length);
  const verb = method.toUpperCase();
  return SERVED.some(([m, pattern]) => m === verb && pattern.test(path));
}

/**
 * Routes an API key may not use, whatever it is otherwise allowed (SEC-57).
 *
 * The apiKey plugin turns an `x-api-key` header into a full session, so
 * without this a key could mint further keys (which outlive revoking it),
 * revoke its owner's other keys, rename the account or its public handle, and
 * delete the account with every file in it. A key is handed to agents, and an
 * agent that reads untrusted text inherits whatever its key can do. Managing
 * the account, keys included, takes a signed-in browser.
 *
 * Covers GlideComp's own routes in index.ts as well as the plugin's, so it is
 * checked ahead of both rather than in the catch-all.
 */
const BROWSER_SESSION_ONLY: ReadonlyArray<RegExp> = [
  /^\/api-key\//,
  /^\/delete-account$/,
  /^\/set-username$/,
  /^\/set-name$/,
];

/** Whether this path refuses a request that carries an API key. */
export function requiresBrowserSession(pathname: string): boolean {
  if (!pathname.startsWith(`${BASE_PATH}/`)) return false;
  const path = pathname.slice(BASE_PATH.length);
  return BROWSER_SESSION_ONLY.some((pattern) => pattern.test(path));
}
