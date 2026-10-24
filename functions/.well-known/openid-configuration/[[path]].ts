/**
 * Pages Function forwarding /.well-known/openid-configuration (and its sub-paths) to the
 * auth-api worker over the service binding. MCP clients fetch OAuth discovery
 * documents from the origin root (RFC 8414 / RFC 9728), and auth-api's mcp()
 * provider is what answers them; auth-api itself decides which paths it
 * serves (isDiscoveryPath in web/workers/auth-api/src/endpoints.ts) and
 * 404s the rest. See docs/2026-10-24-mcp-oauth-plan.md §3.
 */

interface Env {
  AUTH_API: Fetcher;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  return context.env.AUTH_API.fetch(context.request);
};
