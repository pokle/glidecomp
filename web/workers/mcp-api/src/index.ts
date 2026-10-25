/**
 * mcp-api — the MCP endpoint at /mcp (docs/2026-10-24-mcp-oauth-plan.md,
 * docs/mcp.md): how an organiser's own assistant (Claude, ChatGPT, Claude
 * Code) reads GlideComp as them.
 *
 * Stateless: each POST is served by a fresh McpServer (the SDK's
 * createMcpHandler, which also serves the 2025 protocol revisions statelessly),
 * so there is no session to keep and no Durable Object. The gate (gate.ts)
 * decides who the request speaks for; the tools (tools.ts) only ever call
 * competition-api as that person.
 */
import { createMcpHandler } from "@modelcontextprotocol/server";
import { gate, type GateEnv } from "./gate";
import { SERVER_CARD_PATH, serverCard } from "./server-card";
import { buildServer, type ToolsEnv } from "./tools";

export type Env = GateEnv & ToolsEnv;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    // Public, and before the gate: a client reads it to learn where to sign in.
    if (pathname === SERVER_CARD_PATH) return serverCard(request, env);
    if (pathname !== "/mcp") return new Response("Not found", { status: 404 });

    const admitted = await gate(request, env);
    if (admitted instanceof Response) return admitted;

    const { caller, authInfo, origin } = admitted;
    const handler = createMcpHandler(() => buildServer(env, caller, authInfo, origin));
    return handler.fetch(request, { authInfo });
  },
};
