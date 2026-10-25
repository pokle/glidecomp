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
import { PROTOCOL_VERSIONS } from "../src/server-card";

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
    case "tok-read":
      return Response.json({ user: USER, grant: { kind: "oauth", client_id: "c1", client_name: "Claude", scopes: ["openid", "comp:read"] } });
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
  method: string;
  path: string;
  authorization: string | null;
  body?: any;
}

const WAYPOINTS = [
  { code: "ELLIOT", name: "Mt Elliot", latitude: -36.1856, longitude: 147.9745, altitude: 1290 },
  { code: "TOWONG", name: "Towong", latitude: -36.1236, longitude: 147.9893, altitude: 0 },
  { code: "CORRY", name: "Corryong goal", latitude: -36.1958, longitude: 147.8975 },
];

function makeEnv(opts: { waypoints?: object[] } = {}): {
  env: Env;
  compCalls: Call[];
  writes: () => Call[];
  /** The token kind behind each /me lookup, in order. */
  meCalls: string[];
} {
  const compCalls: Call[] = [];
  const meCalls: string[] = [];
  // The task as competition-api holds it; a PATCH changes it, as the real one would.
  let task: Record<string, any> = { task_id: "fghij", comp_id: "abcde", name: "Task 1", task_date: "2026-01-05", pilot_classes: ["open"], xctsk: XCTSK };
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
        const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
        meCalls.push(kindOf(bearer));
        return meAnswer(bearer);
      }
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;

  const COMPETITION_API = {
    fetch: async (input: Request | string) => {
      const req = input instanceof Request ? input : new Request(input);
      const url = new URL(req.url);
      const body = req.method === "GET" ? undefined : ((await req.json()) as Record<string, any>);
      compCalls.push({
        method: req.method,
        path: url.pathname + url.search,
        authorization: req.headers.get("authorization"),
        ...(body !== undefined ? { body } : {}),
      });
      if (req.method === "POST" && url.pathname === "/api/comp/abcde/task") {
        return Response.json({ task_id: "newid", comp_id: "abcde", ...body, xctsk: null }, { status: 201 });
      }
      if (req.method === "PATCH" && url.pathname === "/api/comp/abcde/task/fghij") {
        task = { ...task, ...body };
        return Response.json(task);
      }
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
            scoring_format: "gap",
            pilot_classes: ["open", "sport"],
            tasks: [{ task_id: "fghij", name: "Task 1", task_date: "2026-01-05", has_xctsk: true }],
          });
        case "/api/comp/abcde/task/fghij":
          return Response.json(task);
        case "/api/comp/abcde/waypoints":
          return Response.json({ waypoints: opts.waypoints ?? WAYPOINTS });
        default:
          return Response.json({ error: "Competition not found" }, { status: 404 });
      }
    },
  } as unknown as Fetcher;

  return { env: { AUTH_API, COMPETITION_API }, compCalls, writes: () => compCalls.filter((c) => c.method !== "GET"), meCalls };
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

async function callTool(env: Env, name: string, args: Record<string, unknown> = {}, bearer = token("tok-ok")) {
  const { json } = await rpc(env, "tools/call", { name, arguments: args }, bearer);
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
  test("initialize answers on the 2025 protocol; a reading grant lists only the read tools", async () => {
    const { env } = makeEnv();
    const init = await rpc(env, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.status).toBe(200);
    expect(init.json.result.serverInfo.name).toBe("glidecomp");
    const { json } = await rpc(env, "tools/list", {}, token("tok-read"));
    const tools = json.result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["get_competition", "get_task", "list_competitions", "list_waypoints", "search", "whoami"].sort()
    );
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  test("a grant with task:write adds the write tools, and says which ones change things", async () => {
    const { env } = makeEnv();
    const { json } = await rpc(env, "tools/list", {});
    const tools = Object.fromEntries(
      (json.result.tools as Array<{ name: string; annotations?: Record<string, boolean> }>).map((t) => [t.name, t.annotations])
    );
    expect(Object.keys(tools)).toEqual(expect.arrayContaining(["create_task", "update_task", "preview_route", "set_task_route"]));
    expect(tools.preview_route).toMatchObject({ readOnlyHint: true });
    expect(tools.create_task).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(tools.update_task).toMatchObject({ destructiveHint: true, idempotentHint: true });
    expect(tools.set_task_route).toMatchObject({ destructiveHint: true, idempotentHint: true });
  });
});

/**
 * Stateless with auth: no session holds a sign-in, so each request is
 * authorised on its own. A client that proved itself once proves nothing for
 * the next request, and a grant changed or revoked in between is seen at once.
 */
describe("stateless, with auth", () => {
  test("the 2025 revision needs no initialize, and mints no session", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(
      post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_competition", arguments: { comp_id: "abcde" } } }, token("tok-ok")),
      env
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    expect(await res.text()).toContain("Corryong Cup");
  });

  test("every request asks /me again, and what one request proved never carries to the next", async () => {
    const { env, meCalls } = makeEnv();
    const full = await rpc(env, "tools/list", {}, token("tok-ok"));
    expect((full.json.result.tools as Array<{ name: string }>).map((t) => t.name)).toContain("set_task_route");
    // The same client, straight after, without its token: no session lets it in.
    const bare = await worker.fetch(post({ jsonrpc: "2.0", id: 2, method: "tools/list" }), env);
    expect(bare.status).toBe(401);
    // A narrower grant is seen on the very next request.
    const narrow = await rpc(env, "tools/list", {}, token("tok-read"));
    expect((narrow.json.result.tools as Array<{ name: string }>).map((t) => t.name)).not.toContain("set_task_route");
    // And a revoked one is refused, though the same client was served a moment ago.
    expect((await worker.fetch(post({ jsonrpc: "2.0", id: 3, method: "tools/list" }, token("tok-dead")), env)).status).toBe(401);
    expect(meCalls).toEqual(["tok-ok", "tok-read", "tok-dead"]);
  });

  test("a session id a client invents opens nothing", async () => {
    const { env } = makeEnv();
    const req = post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    req.headers.set("mcp-session-id", "made-up");
    expect((await worker.fetch(req, env)).status).toBe(401);
  });

  test("GET /mcp, the 2025 session stream, has no session to attach to: 405 even when signed in", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "GET",
        headers: { accept: "text/event-stream", "mcp-protocol-version": "2025-11-25", authorization: `Bearer ${token("tok-ok")}` },
      }),
      env
    );
    expect(res.status).toBe(405);
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

describe("the write tools", () => {
  const EXACT = "ELLIOT 400m to, ELLIOT 5k sss exit 13:30, TOWONG 400m, CORRY 400m goal";
  const revOf = async (env: Env) =>
    (await callTool(env, "get_task", { comp_id: "abcde", task_id: "fghij" })).structuredContent!.route.route_rev as string;

  test("create_task adds a task with every class by default, and no route", async () => {
    const { env, writes } = makeEnv();
    const r = await callTool(env, "create_task", { comp_id: "abcde", name: "Task 2", task_date: "2026-01-06" });
    expect(writes()).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/api/comp/abcde/task",
        body: { name: "Task 2", task_date: "2026-01-06", pilot_classes: ["open", "sport"] },
      }),
    ]);
    expect(r.structuredContent).toMatchObject({ task_id: "newid", route: null, url: `${ORIGIN}/comp/corryong-cup-abcde/task/task-2-newid` });
  });

  test("update_task sends only what it was given, and never a route", async () => {
    const { env, writes } = makeEnv();
    const nothing = await callTool(env, "update_task", { comp_id: "abcde", task_id: "fghij" });
    expect(nothing.isError).toBe(true);
    await callTool(env, "update_task", { comp_id: "abcde", task_id: "fghij", name: "Task 1 (re-run)" });
    expect(writes().map((w) => w.body)).toEqual([{ name: "Task 1 (re-run)" }]);
  });

  test("preview_route writes nothing, and shows the guesses behind a name that isn't exact", async () => {
    const { env, writes } = makeEnv();
    const r = await callTool(env, "preview_route", { comp_id: "abcde", task_id: "fghij", line: "ELL to, ELLIOT 5k sss, towo, CORRY goal" });
    expect(writes()).toEqual([]);
    const p = r.structuredContent!;
    expect(p.ready).toBe(false);
    expect(p.turnpoints.map((t: { typed: string; read_as: string; exact: boolean }) => [t.typed, t.read_as, t.exact])).toEqual([
      ["ELL", "ELLIOT", false],
      ["ELLIOT", "ELLIOT", true],
      ["towo", "TOWONG", false],
      ["CORRY", "CORRY", true],
    ]);
    expect(r.content[0]!.text).toContain('"ELL" isn\'t exactly a waypoint code');
    expect("xctsk" in p).toBe(false);
  });

  test("preview_route on an exact line is ready, and says what it removes", async () => {
    const { env } = makeEnv();
    const r = await callTool(env, "preview_route", { comp_id: "abcde", task_id: "fghij", line: EXACT });
    const p = r.structuredContent!;
    expect(p.ready).toBe(true);
    expect(p.removes).toEqual(["GRGGRG"]);
    expect(p.line).toContain("13:30");
    expect(p.distance_km).toBeGreaterThan(0);
    expect(p.current_route_rev).toBe(await revOf(env));
  });

  test("a name matching nothing is reported, not dropped", async () => {
    const { env } = makeEnv();
    const p = (await callTool(env, "preview_route", { comp_id: "abcde", task_id: "fghij", line: "ELLIOT, QQQQQ, CORRY" })).structuredContent!;
    expect(p.unmatched).toEqual(["QQQQQ"]);
    expect(p.ready).toBe(false);
  });

  test("a name the route already has is kept as that turnpoint, whatever the waypoint file holds", async () => {
    const { env } = makeEnv({
      waypoints: [...WAYPOINTS, { code: "CORRY", name: "Corryong showground", latitude: -36.2, longitude: 147.9 }],
    });
    const p = (await callTool(env, "preview_route", { comp_id: "abcde", task_id: "fghij", line: EXACT })).structuredContent!;
    expect(p.turnpoints.find((t: { typed: string }) => t.typed === "CORRY")).toMatchObject({ exact: true });
    expect(p.ready).toBe(true);
  });

  test("set_task_route saves an exact line over the stored route, the way the editor would", async () => {
    const { env, writes } = makeEnv();
    const r = await callTool(env, "set_task_route", { comp_id: "abcde", task_id: "fghij", line: EXACT, route_rev: await revOf(env) });
    expect(r.isError).toBeUndefined();
    const [patch] = writes();
    expect(Object.keys(patch!.body)).toEqual(["xctsk"]);
    const xctsk = patch!.body.xctsk;
    expect(xctsk.turnpoints.map((t: { waypoint: { name: string } }) => t.waypoint.name)).toEqual(["ELLIOT", "ELLIOT", "TOWONG", "CORRY"]);
    // Reconciled, not rebuilt: the stored turnpoints keep what the line can't say.
    expect(xctsk.turnpoints[0].waypoint.altSmoothed).toBe(1290);
    expect(xctsk.turnpoints[2].waypoint.altSmoothed).toBe(0);
    // 13:30 in a January Corryong is 02:30 UTC; the goal deadline survives.
    expect(xctsk.sss).toMatchObject({ type: "RACE", direction: "EXIT", timeGates: ["02:30:00Z"] });
    expect(xctsk.goal).toMatchObject({ deadline: "07:00:00Z" });
    expect(r.structuredContent!.route.quick_task).toContain("13:30");
    expect(r.structuredContent!.route.route_rev).not.toBe(await routeRevOfOriginal());
  });

  test("set_task_route refuses a stale route_rev, and saves nothing", async () => {
    const { env, writes } = makeEnv();
    for (const route_rev of ["0123456789abcdef", null]) {
      const r = await callTool(env, "set_task_route", { comp_id: "abcde", task_id: "fghij", line: EXACT, route_rev });
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toContain("changed since you read it");
      expect(r.structuredContent!.current_route_rev).toBe(await revOf(env));
    }
    expect(writes()).toEqual([]);
  });

  test("set_task_route refuses a fuzzy name even with the right route_rev", async () => {
    const { env, writes } = makeEnv();
    const r = await callTool(env, "set_task_route", {
      comp_id: "abcde",
      task_id: "fghij",
      line: "ELLIOT 400m to, ELLIOT 5k sss, towo, CORRY goal",
      route_rev: await revOf(env),
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("Nothing was saved");
    expect(writes()).toEqual([]);
  });

  test("the write tools aren't there for a grant without task:write", async () => {
    const { env, writes } = makeEnv();
    const { json } = await rpc(env, "tools/call", { name: "create_task", arguments: { comp_id: "abcde", name: "x", task_date: "2026-01-06" } }, token("tok-read"));
    expect(json.result?.isError ?? !!json.error).toBe(true);
    expect(writes()).toEqual([]);
  });
});

async function routeRevOfOriginal(): Promise<string> {
  const { routeRevision } = await import("../src/route-summary");
  return routeRevision(XCTSK);
}

describe("the server card (SEP-2127)", () => {
  const card = (init: RequestInit = {}) => {
    const { env } = makeEnv();
    return worker.fetch(new Request(`${ORIGIN}/mcp/server-card`, init), env);
  };

  test("is public, says where to connect, and names no tools", async () => {
    const res = await card();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/mcp-server-card+json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-expose-headers")).toBe("ETag");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    const body = (await res.json()) as Record<string, any>;
    expect(body.$schema).toBe("https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json");
    expect(body.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(body.description.length).toBeLessThanOrEqual(100);
    expect(body.websiteUrl).toBe(`${ORIGIN}/assistant`);
    expect(body.remotes).toEqual([
      { type: "streamable-http", url: `${ORIGIN}/mcp`, supportedProtocolVersions: expect.arrayContaining(["2026-07-28", "2025-11-25"]) },
    ]);
    expect("tools" in body).toBe(false);
  });

  test("answers a matching If-None-Match with 304, and refuses anything but GET", async () => {
    const etag = (await card()).headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]+"$/);
    expect((await card({ headers: { "if-none-match": etag } })).status).toBe(304);
    expect((await card({ method: "POST" })).status).toBe(405);
    const preflight = await card({ method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET");
  });
});

/**
 * The 2026-07-28 wire: no initialize, every request carries its revision and
 * the client's capabilities in `_meta`, and the method (and a tool's name) in
 * headers the transport checks against the body.
 */
describe("the 2026-07-28 protocol", () => {
  async function rpc2026(env: Env, method: string, params: Record<string, unknown> = {}, bearer: string | null = token("tok-ok")) {
    const name = typeof params.name === "string" ? params.name : undefined;
    const res = await worker.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": method,
          ...(name ? { "mcp-name": name } : {}),
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
            },
          },
        }),
      }),
      env
    );
    const text = await res.text();
    if (res.status !== 200) return { status: res.status, headers: res.headers, json: null };
    const json = text.trimStart().startsWith("{")
      ? JSON.parse(text)
      : JSON.parse(text.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
    return { status: res.status, headers: res.headers, json };
  }

  test("the gate stands in front of it too: no token is a 401 with the same challenge", async () => {
    const { env } = makeEnv();
    const res = await rpc2026(env, "server/discover", {}, null);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`
    );
  });

  test("server/discover names the revisions the card advertises, and who the server is", async () => {
    const { env } = makeEnv();
    const { status, json } = await rpc2026(env, "server/discover");
    expect(status).toBe(200);
    const modern = json.result.supportedVersions as string[];
    expect(modern).toContain("2026-07-28");
    // The card lists the modern revisions first, then the SDK's 2025-era list.
    expect(PROTOCOL_VERSIONS.slice(0, modern.length)).toEqual(modern);
    expect(json.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("glidecomp");
  });

  test("tools/list answers per grant, privately cacheable only", async () => {
    const { env } = makeEnv();
    const read = await rpc2026(env, "tools/list", {}, token("tok-read"));
    expect(read.json.result.resultType).toBe("complete");
    // The list differs by grant, so no shared cache may keep it.
    expect(read.json.result.cacheScope).toBe("private");
    expect((read.json.result.tools as Array<{ name: string }>).map((t) => t.name).sort()).toEqual(
      ["get_competition", "get_task", "list_competitions", "list_waypoints", "search", "whoami"].sort()
    );
    const write = await rpc2026(env, "tools/list", {});
    expect((write.json.result.tools as Array<{ name: string }>).map((t) => t.name)).toContain("set_task_route");
  });

  test("each request carries its own sign-in: a served client without its token is refused", async () => {
    const { env, meCalls } = makeEnv();
    expect((await rpc2026(env, "tools/list", {})).status).toBe(200);
    expect((await rpc2026(env, "tools/list", {}, null)).status).toBe(401);
    expect((await rpc2026(env, "tools/list", {}, token("tok-dead"))).status).toBe(401);
    expect(meCalls).toEqual(["tok-ok", "tok-dead"]);
  });

  test("a tool call reaches competition-api as the caller", async () => {
    const { env, compCalls } = makeEnv();
    const { json } = await rpc2026(env, "tools/call", { name: "get_competition", arguments: { comp_id: "abcde" } });
    expect(json.result.resultType).toBe("complete");
    expect(json.result.structuredContent).toMatchObject({ name: "Corryong Cup" });
    expect(compCalls.some((c) => c.method === "GET" && c.path === "/api/comp/abcde")).toBe(true);
  });
});
