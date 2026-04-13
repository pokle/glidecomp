import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import type { Env, AuthUser } from "./env";
import { extractBearerToken, verifyApiKey } from "./auth";
import { registerCompetitionTools } from "./tools/competitions";
import { registerTaskTools } from "./tools/tasks";
import { registerPilotTools } from "./tools/pilots";
import { registerTrackTools } from "./tools/tracks";
import { registerPilotStatusTools } from "./tools/pilot-status";
import { registerScoringTools } from "./tools/scoring";
import { registerAuditTools } from "./tools/audit";

function createServer(env: Env, user: AuthUser | null): McpServer {
  const server = new McpServer({
    name: "GlideComp",
    version: "1.0.0",
  });

  registerCompetitionTools(server, env, user);
  registerTaskTools(server, env, user);
  registerPilotTools(server, env, user);
  registerTrackTools(server, env, user);
  registerPilotStatusTools(server, env, user);
  registerScoringTools(server, env, user);
  registerAuditTools(server, env, user);

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

    // Authenticate via API key (optional — unauthenticated users get read-only public access)
    let user: AuthUser | null = null;
    const token = extractBearerToken(request.headers);
    if (token) {
      user = await verifyApiKey(env, token);
      if (!user) {
        return new Response(
          JSON.stringify({ error: "Invalid API key" }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    // Create a fresh server per request (required by agents SDK)
    const server = createServer(env, user);
    const handler = createMcpHandler(server, { route: "/mcp" });
    return handler(request, env, ctx);
  },
};
