/**
 * The MCP Server Card (SEP-2127, the `io.modelcontextprotocol/server-card`
 * extension): a small public document saying what this server is and where
 * to connect, so a client can go from "glidecomp.com" to a connection without
 * being handed the URL. Served at the reserved `<streamable-http-url>/server-card`
 * — https://glidecomp.com/mcp/server-card — and listed by the site's
 * /.well-known/ai-catalog.json (web/frontend/public/).
 *
 * Advisory only. It names no tools (a client lists those live, after sign-in)
 * and carries no credentials: connecting still starts with /mcp's 401 and the
 * OAuth discovery behind it.
 *
 * Built here rather than as a static file for two reasons: the origin comes
 * from auth-api's protected-resource metadata, so dev's card names
 * localhost:3000 and production's names glidecomp.com; and whatever reaches
 * /mcp/* — the Pages Function, or a Worker route straight to this worker —
 * gets the same answer.
 */
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";
import { resourceMetadata, type GateEnv } from "./gate";

/** Who the server says it is, on the card and in MCP's own `initialize`. */
export const SERVER_INFO = { name: "glidecomp", title: "GlideComp", version: "1.0.0" } as const;

export const SERVER_CARD_PATH = "/mcp/server-card";
const MEDIA_TYPE = "application/mcp-server-card+json";

/** Required on a hosted card (ext-server-card docs/discovery.md). */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET",
  "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
  "Access-Control-Expose-Headers": "ETag",
} as const;

export function cardFor(origin: string) {
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    // The name the official MCP Registry would list it under, verified by the domain.
    name: "com.glidecomp/glidecomp",
    version: SERVER_INFO.version,
    title: SERVER_INFO.title,
    description: "Hang gliding and paragliding competitions: find comps, read tasks, set routes.",
    websiteUrl: `${origin}/assistant`,
    repository: { url: "https://github.com/pokle/glidecomp", source: "github", subfolder: "web/workers/mcp-api" },
    icons: [{ src: `${origin}/icon.svg`, mimeType: "image/svg+xml", sizes: ["any"] }],
    remotes: [
      {
        type: "streamable-http",
        url: `${origin}/mcp`,
        supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      },
    ],
  };
}

export async function serverCard(request: Request, env: GateEnv): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { ...CORS, Allow: "GET" } });
  }
  let origin: string;
  try {
    origin = new URL((await resourceMetadata(env)).resource).origin;
  } catch (err) {
    console.error("[mcp-api] auth-api metadata unavailable (server card)", err);
    return new Response("Temporarily unavailable", { status: 503, headers: CORS });
  }

  const body = JSON.stringify(cardFor(origin), null, 2);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  const etag = `"${[...digest.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
  const headers = {
    ...CORS,
    "Content-Type": MEDIA_TYPE,
    "Cache-Control": "public, max-age=3600",
    ETag: etag,
  };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : body, { headers });
}
