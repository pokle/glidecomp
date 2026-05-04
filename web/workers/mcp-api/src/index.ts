import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import type { Env } from "./env";
import { extractBearerToken, verifyApiKey } from "./auth";
import { registerCompetitionTools } from "./tools/competitions";
import { registerTaskTools } from "./tools/tasks";
import { registerPilotTools } from "./tools/pilots";
import { registerTrackTools } from "./tools/tracks";
import { registerPilotStatusTools } from "./tools/pilot-status";
import { registerScoringTools } from "./tools/scoring";
import { registerAuditTools } from "./tools/audit";

function createServer(env: Env, apiKey: string | null): McpServer {
  const server = new McpServer({
    name: "GlideComp",
    version: "1.0.0",
  });

  registerCompetitionTools(server, env, apiKey);
  registerTaskTools(server, env, apiKey);
  registerPilotTools(server, env, apiKey);
  registerTrackTools(server, env, apiKey);
  registerPilotStatusTools(server, env, apiKey);
  registerScoringTools(server, env, apiKey);
  registerAuditTools(server, env, apiKey);

  return server;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/mcp/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Only handle /mcp routes
    if (!url.pathname.startsWith("/mcp")) {
      return new Response("Not Found", { status: 404 });
    }

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // Authenticate via API key. The key is verified once here so we can
    // 401 invalid keys at the MCP boundary, then threaded through to
    // competition-api as `x-api-key` for per-request authorisation.
    let apiKey: string | null = null;
    const token = extractBearerToken(request.headers);
    if (token) {
      const user = await verifyApiKey(env, token);
      if (!user) {
        return new Response(
          JSON.stringify({ error: "Invalid API key" }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      apiKey = token;
    }

    // Create a fresh server per request (required by agents SDK)
    const server = createServer(env, apiKey);
    const handler = createMcpHandler(server, { route: "/mcp" });
    return handler(request, env, ctx);
  },
};
