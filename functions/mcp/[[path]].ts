/**
 * Pages Function forwarding /mcp and /mcp/* to the mcp-api worker over its
 * service binding: the MCP endpoint an organiser's own assistant (Claude,
 * ChatGPT, Claude Code) connects to, and its public server card at
 * /mcp/server-card (docs/mcp.md). The worker does its own authentication —
 * OAuth access tokens from auth-api — so this only forwards.
 */

interface Env {
  MCP_API: Fetcher;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  return context.env.MCP_API.fetch(context.request);
};
