/**
 * mcp-api — the MCP endpoint at /mcp (docs/2026-10-24-mcp-oauth-plan.md).
 *
 * SPIKE: phase 0. Enough to connect a real client end to end: a bearer token
 * from auth-api's mcp() plugin, checked here, and a handful of read-only
 * tools. Not reviewed, not tested, not for merging.
 *
 * The design rule the spike keeps anyway: this worker only speaks the public
 * API. Every tool is a call to an existing competition-api route over the
 * service binding, carrying the caller's own bearer token, so every rule those
 * routes enforce (visibility of hidden comps, admin checks, audit, the score
 * bump) holds here without being restated. It never reads D1.
 */
import {
  McpServer,
  OAuthError,
  OAuthErrorCode,
  createMcpHandler,
  requireBearerAuth,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import * as z from "zod";
import { verifyAccessToken } from "@glidecomp/worker-kit/access-token";
import { compPath, taskPath } from "@glidecomp/client/slug";

interface Env {
  AUTH_API: Fetcher;
  COMPETITION_API: Fetcher;
}

/** What auth-api says about the resource this worker protects (RFC 9728). */
interface ResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
}

const METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";

/**
 * The resource identifier and issuer come from auth-api's own metadata, so
 * BETTER_AUTH_URL stays the one place that names this deployment's origin —
 * localhost in dev, a tunnel when one is used, glidecomp.com in production.
 * Per isolate; the document only changes with a redeploy.
 */
let metadata: Promise<ResourceMetadata> | null = null;
function resourceMetadata(env: Env): Promise<ResourceMetadata> {
  metadata ??= env.AUTH_API.fetch(new Request(`https://auth${METADATA_PATH}`))
    .then(async (res) => {
      if (!res.ok) throw new Error(`protected-resource metadata: ${res.status}`);
      return (await res.json()) as ResourceMetadata;
    })
    .catch((err) => {
      metadata = null;
      throw err;
    });
  return metadata;
}

/** One competition-api call as the caller: their token, nothing else. */
async function api(env: Env, auth: AuthInfo, path: string): Promise<unknown> {
  const res = await env.COMPETITION_API.fetch(
    new Request(`https://comp${path}`, { headers: { authorization: `Bearer ${auth.token}` } })
  );
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body;
}

/** A tool answer: a line for the model, and the data as structured content. */
function answer(text: string, data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], structuredContent: data };
}

function buildServer(env: Env, auth: AuthInfo, origin: string): McpServer {
  const server = new McpServer(
    { name: "glidecomp", version: "0.0.1-spike" },
    { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() }
  );
  const url = (path: string) => `${origin}${path}`;

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description: "The GlideComp account this connection acts as, and what it has been allowed to do.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const me = (await env.AUTH_API.fetch(
        new Request("https://auth/api/auth/me", { headers: { authorization: `Bearer ${auth.token}` } })
      ).then((r) => r.json())) as { user: { name?: string; email?: string; username?: string } | null };
      return answer(
        me.user ? `Signed in as ${me.user.name ?? me.user.email}. Scopes: ${auth.scopes.join(" ")}` : "Not signed in.",
        { user: me.user, scopes: auth.scopes, client_id: auth.clientId }
      );
    }
  );

  server.registerTool(
    "search",
    {
      title: "Search GlideComp",
      description:
        "Full-text search over competitions, tasks (including the turnpoints on their routes) and pilots. " +
        "A query of turnpoint codes finds the tasks that fly through them.",
      inputSchema: z.object({ query: z.string().min(1).max(200) }),
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => {
      const data = (await api(env, auth, `/api/comp/search?q=${encodeURIComponent(query)}`)) as Record<string, unknown>;
      return answer(`Search results for "${query}".`, data);
    }
  );

  server.registerTool(
    "get_competition",
    {
      title: "Get a competition",
      description: "One competition: its settings summary, admins and every task (date, classes, whether it has a route).",
      inputSchema: z.object({ comp_id: z.string().min(1).max(32) }),
      annotations: { readOnlyHint: true },
    },
    async ({ comp_id }) => {
      const comp = (await api(env, auth, `/api/comp/${encodeURIComponent(comp_id)}`)) as {
        name?: string;
        tasks?: Array<{ task_id: string; name: string }>;
      } & Record<string, unknown>;
      return answer(`${comp.name ?? comp_id}: ${url(compPath(comp_id, comp.name))}`, {
        ...comp,
        url: url(compPath(comp_id, comp.name)),
      });
    }
  );

  server.registerTool(
    "get_task",
    {
      title: "Get a task",
      description: "One task's metadata and its route (the XCTrack task definition), or null when no route is set.",
      inputSchema: z.object({ comp_id: z.string().min(1).max(32), task_id: z.string().min(1).max(32) }),
      annotations: { readOnlyHint: true },
    },
    async ({ comp_id, task_id }) => {
      const task = (await api(
        env,
        auth,
        `/api/comp/${encodeURIComponent(comp_id)}/task/${encodeURIComponent(task_id)}`
      )) as { name?: string } & Record<string, unknown>;
      const link = url(taskPath(comp_id, null, task_id, task.name));
      return answer(`${task.name ?? task_id}: ${link}`, { ...task, url: link });
    }
  );

  return server;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname !== "/mcp") return new Response("Not found", { status: 404 });

    let meta: ResourceMetadata;
    try {
      meta = await resourceMetadata(env);
    } catch (err) {
      console.error("[mcp-api] auth-api metadata unavailable", err);
      return new Response("Authorisation server unavailable", { status: 503 });
    }
    const resource = new URL(meta.resource);
    const issuer = meta.authorization_servers[0];

    const gate = requireBearerAuth({
      resourceMetadataUrl: `${resource.origin}${METADATA_PATH}`,
      expectedResource: resource,
      requiredScopes: ["comp:read"],
      verifier: {
        async verifyAccessToken(token: string): Promise<AuthInfo> {
          const grant = await verifyAccessToken(token, {
            issuer,
            audience: meta.resource,
            fetchJwks: () => env.AUTH_API.fetch(new Request("https://auth/api/auth/jwks")),
          });
          if (!grant) throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid or expired access token");
          return {
            token,
            clientId: grant.clientId ?? "",
            scopes: grant.scopes,
            expiresAt: grant.claims.exp,
            resource,
            extra: { userId: grant.userId },
          };
        },
      },
    });
    const auth = await gate(request);
    if (auth instanceof Response) return auth;

    const handler = createMcpHandler(() => buildServer(env, auth, resource.origin));
    return handler.fetch(request, { authInfo: auth });
  },
};
