/**
 * Resuming an MCP client's OAuth request after sign-in
 * (docs/2026-10-24-mcp-oauth-plan.md §8).
 *
 * auth-api's mcp() provider sends a signed-out organiser to /signin with the
 * authorisation request in the query, signed (`sig`, `exp`, `ba_iat`). Once
 * they are signed in, sending the browser back to /oauth2/authorize with the
 * same request carries on: with a session now, the provider goes straight on
 * to consent. The provider re-validates the client and its redirect URI there,
 * so nothing here is trusted; this only refuses anything that isn't an
 * authorisation request, and only ever builds a same-origin path.
 */
const SIGNING_PARAMS = ["sig", "exp", "ba_iat", "ba_pl"];

export function oauthResumePath(params: URLSearchParams): string | null {
  if (!params.has("sig") || !params.get("client_id") || params.get("response_type") !== "code") {
    return null;
  }
  const query = new URLSearchParams(params);
  for (const name of SIGNING_PARAMS) query.delete(name);
  query.delete("next");
  return `/api/auth/oauth2/authorize?${query.toString()}`;
}
