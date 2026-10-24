/**
 * mcp-api against stand-ins for its two bindings: auth-api (what /me says
 * about a token) and competition-api (the routes the tools call). What is
 * pinned here is the worker's own job — who gets in, what each tool asks
 * competition-api for, with whose token, and what it hands back — not the
 * routes themselves, which competition-api's suite covers.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import worker, { type Env } from "../src/index";
import { resetResourceMetadata } from "../src/gate";

const ORIGIN = "https://glidecomp.test";

const USER = { id: "u1", name: "Org Aniser", email: "org@example.com", username: "org" };

/**
 * A stand-in access token: JWT-shaped with a real `exp`, as auth-api's are,
 * and a `kind` claim the fake /me below reads. Not signed — verifying is
 * auth-api's job, and /me is faked here.
 */
function token(kind: string): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64({ alg: "EdDSA", typ: "at+jwt" })}.${b64({ kind, exp: Math.floor(Date.now() / 1000) + 900 })}.sig`;
}

function kindOf(bearer: string): string {
  try {
    return (JSON.parse(atob(bearer.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as { kind: string }).kind;
  } catch {
    return bearer;
  }
}

/** The tokens auth-api's /me knows, and what it says about each. */
function meAnswer(bearer: string): Response {
  switch (kindOf(bearer)) {
    case "tok-ok":
      return Response.json({
        user: USER,
        grant: { kind: "oauth", client_id: "c1", client_name: "Claude", scopes: ["openid", "comp:read", "task:write"] },
      });
    case "tok-noscope":
      return Response.json({ user: USER, grant: { kind: "oauth", client_id: "c1", client_name: "Claude", scopes: ["openid"] } });
    case "tok-limited":
      return Response.json({ user: null, error: "Rate limit exceeded" }, { status: 429, headers: { "Retry-After": "9" } });
    case "tok-down":
      return new Response("boom", { status: 503 });
    case "glc_apikey":
      // An API key sent as a bearer value: /me answers with a user, but no grant.
      return Response.json({ user: USER });
    default:
      return Response.json({ user: null });
  }
}

const XCTSK = {
  taskType: "CLASSIC",
  version: 1,
  earthModel: "WGS84",
  turnpoints: [
    { type: "TAKEOFF", radius: 400, waypoint: { name: "ELLIOT", lat: -36.1856, lon: 147.9745, altSmoothed: 1290 } },
    { type: "SSS", radius: 5000, waypoint: { name: "ELLIOT", lat: -36.1856, lon: 147.9745 } },
    { radius: 400, waypoint: { name: "TOWONG", lat: -36.1236, lon: 147.9893, altSmoothed: 0 } },
    { type: "ESS", radius: 400, waypoint: { name: "GRGGRG", lat: -36.0901, lon: 147.8761 } },
    { radius: 400, waypoint: { name: "CORRY", lat: -36.1958, lon: 147.8975 } },
  ],
  sss: { type: "RACE", direction: "EXIT", timeGates: ["02:15:00Z"] },
  goal: { type: "CYLINDER", deadline: "07:00:00Z" },
};

interface Call {
  path: string;
  authorization: string | null;
}

function makeEnv(): { env: Env; compCalls: Call[] } {
  const compCalls: Call[] = [];
  const AUTH_API = {
    fetch: async (input: Request | string) => {
      const req = input instanceof Request ? input : new Request(input);
      const path = new URL(req.url).pathname;
      if (path === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource: `${ORIGIN}/mcp`,
          authorization_servers: [`${ORIGIN}/api/auth`],
          scopes_supported: ["comp:read", "task:write"],
        });
      }
      if (path === "/api/auth/me") {
        return meAnswer((req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, ""));
      }
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;

  const COMPETITION_API = {
    fetch: async (input: Request | string) => {
      const req = input instanceof Request ? input : new Request(input);
      const url = new URL(req.url);
      compCalls.push({ path: url.pathname + url.search, authorization: req.headers.get("authorization") });
      switch (url.pathname) {
        case "/api/comp":
          return Response.json({
            comps: [
              { comp_id: "abcde", name: "Corryong Cup", category: "hg", is_admin: true, test: false, pilot_classes: ["open"] },
              { comp_id: "zzzzz", name: "Someone Else's Open", category: "pg", test: false, pilot_classes: ["open"] },
            ],
          });
        case "/api/comp/search":
          return Response.json({
            terms: ["corryong"],
            comps: [{ comp_id: "abcde", name: "Corryong Cup", tasks: [{ task_id: "fghij", name: "Task 1" }] }],
            truncated: false,
          });
        case "/api/comp/abcde":
          return Response.json({
            comp_id: "abcde",
            name: "Corryong Cup",
            timezone: "Australia/Melbourne",
            tasks: [{ task_id: "fghij", name: "Task 1", task_date: "2026-01-05", has_xctsk: true }],
          });
        case "/api/comp/abcde/task/fghij":
          return Response.json({ task_id: "fghij", comp_id: "abcde", name: "Task 1", task_date: "2026-01-05", xctsk: XCTSK });
        case "/api/comp/abcde/waypoints":
          return Response.json({
            waypoints: [
              { code: "ELLIOT", name: "Mt Elliot", latitude: -36.1856, longitude: 147.9745, altitude: 1290 },
              { code: "TOWONG", name: "Towong", latitude: -36.1236, longitude: 147.9893, altitude: 0 },
              { code: "CORRY", name: "Corryong goal", latitude: -36.1958, longitude: 147.8975 },
            ],
          });
        default:
          return Response.json({ error: "Competition not found" }, { status: 404 });
      }
    },
  } as unknown as Fetcher;

  return { env: { AUTH_API, COMPETITION_API }, compCalls };
}

function post(body: unknown, token?: string): Request {
  return new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** One JSON-RPC exchange; the answer may come as JSON or as one SSE frame. */
async function rpc(env: Env, method: string, params: unknown, bearer = token("tok-ok")) {
  const res = await worker.fetch(post({ jsonrpc: "2.0", id: 1, method, params }, bearer), env);
  const text = await res.text();
  const json = text.trimStart().startsWith("{")
    ? JSON.parse(text)
    : JSON.parse(text.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
  return { status: res.status, json };
}

async function callTool(env: Env, name: string, args: Record<string, unknown> = {}) {
  const { json } = await rpc(env, "tools/call", { name, arguments: args });
  if (!json.result) throw new Error(`tools/call ${name}: ${JSON.stringify(json)}`);
  return json.result as { content: Array<{ text: string }>; structuredContent?: Record<string, any>; isError?: boolean };
}

beforeEach(() => resetResourceMetadata());

describe("the gate", () => {
  test("no token: 401 with the RFC 9728 challenge pointing at the resource metadata", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }), env);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`
    );
  });

  test("a token /me won't vouch for (expired, revoked, disconnected): 401, so the client signs in again", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, token("tok-dead")), env);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("invalid_token");
  });

  test("an API key is not a way in, though /me knows its owner", async () => {
    const { env } = makeEnv();
    expect((await worker.fetch(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "glc_apikey"), env)).status).toBe(401);
  });

  test("a grant without comp:read: 403 insufficient_scope", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, token("tok-noscope")), env);
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain("insufficient_scope");
  });

  test("a grant over its budget: 429 with auth-api's Retry-After", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, token("tok-limited")), env);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("9");
  });

  test("auth-api unable to answer: 503, never anonymous", async () => {
    const { env } = makeEnv();
    expect((await worker.fetch(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, token("tok-down")), env)).status).toBe(503);
  });

  test("only /mcp is served", async () => {
    const { env } = makeEnv();
    expect((await worker.fetch(new Request(`${ORIGIN}/elsewhere`), env)).status).toBe(404);
  });
});

describe("the protocol", () => {
  test("initialize answers on the 2025 protocol, and lists the read tools", async () => {
    const { env } = makeEnv();
    const init = await rpc(env, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.status).toBe(200);
    expect(init.json.result.serverInfo.name).toBe("glidecomp");
    const { json } = await rpc(env, "tools/list", {});
    const tools = json.result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["get_competition", "get_task", "list_competitions", "list_waypoints", "search", "whoami"].sort()
    );
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });
});

describe("the tools", () => {
  test("every competition-api call carries the caller's own token", async () => {
    const { env, compCalls } = makeEnv();
    await callTool(env, "get_task", { comp_id: "abcde", task_id: "fghij" });
    expect(compCalls.length).toBeGreaterThan(0);
    expect(compCalls.every((c) => c.authorization?.startsWith("Bearer ") && kindOf(c.authorization.slice(7)) === "tok-ok")).toBe(true);
  });

  test("whoami names the organiser and what the connection may do", async () => {
    const { env } = makeEnv();
    const r = await callTool(env, "whoami");
    expect(r.structuredContent).toMatchObject({ name: "Org Aniser", email: "org@example.com", client: "Claude" });
    expect(r.content[0]!.text).toContain("comp:read, task:write");
  });

  test("search passes the query through and links each result", async () => {
    const { env, compCalls } = makeEnv();
    const r = await callTool(env, "search", { query: "corryong cup" });
    expect(compCalls[0]!.path).toBe("/api/comp/search?q=corryong%20cup");
    expect(r.structuredContent!.comps[0].url).toBe(`${ORIGIN}/comp/corryong-cup-abcde`);
    expect(r.structuredContent!.comps[0].tasks[0].url).toBe(`${ORIGIN}/comp/corryong-cup-abcde/task/task-1-fghij`);
  });

  test("list_competitions can narrow to the comps the account organises", async () => {
    const { env } = makeEnv();
    const all = await callTool(env, "list_competitions");
    expect(all.structuredContent!.comps).toHaveLength(2);
    const mine = await callTool(env, "list_competitions", { mine: true });
    expect(mine.structuredContent!.comps.map((c: { comp_id: string }) => c.comp_id)).toEqual(["abcde"]);
    expect(mine.structuredContent!.comps[0]).toMatchObject({ organiser: true, url: `${ORIGIN}/comp/corryong-cup-abcde` });
  });

  test("get_task reads the route as the route editor would", async () => {
    const { env } = makeEnv();
    const r = await callTool(env, "get_task", { comp_id: "abcde", task_id: "fghij" });
    const route = r.structuredContent!.route;
    expect(route.turnpoints.map((t: { name: string; role: string }) => `${t.name}:${t.role}`)).toEqual([
      "ELLIOT:TAKEOFF",
      "ELLIOT:SSS",
      "TOWONG:TURNPOINT",
      "GRGGRG:ESS",
      "CORRY:GOAL",
    ]);
    // A known 0 m altitude is kept; an unknown one is absent, never 0.
    expect(route.turnpoints[2].altitude_m).toBe(0);
    expect("altitude_m" in route.turnpoints[1]).toBe(false);
    // The start gate, 02:15 UTC, is said comp-local: 13:15 in a January Corryong.
    expect(route.quick_task).toContain("13:15");
    expect(route.quick_task).toContain("ELLIOT 5k");
    expect(route.start).toContain("Race to goal");
    expect(route.distance_km).toBeGreaterThan(0);
    expect(route.route_rev).toMatch(/^[0-9a-f]{16}$/);
    expect(r.structuredContent!.url).toBe(`${ORIGIN}/comp/corryong-cup-abcde/task/task-1-fghij`);
    expect("xctsk" in r.structuredContent!).toBe(false);
  });

  test("list_waypoints filters by code or name and keeps unknown altitudes absent", async () => {
    const { env } = makeEnv();
    const r = await callTool(env, "list_waypoints", { comp_id: "abcde", query: "corr" });
    expect(r.structuredContent).toMatchObject({ total: 3 });
    expect(r.structuredContent!.waypoints).toEqual([{ code: "CORRY", name: "Corryong goal", lat: -36.1958, lon: 147.8975 }]);
  });

  test("a comp the account can't see is a tool error the model can read, not a protocol failure", async () => {
    const { env } = makeEnv();
    const r = await callTool(env, "get_competition", { comp_id: "hidden" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("Not found");
  });
});
