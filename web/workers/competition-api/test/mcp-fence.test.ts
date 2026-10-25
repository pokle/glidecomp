// The fence around MCP access tokens (middleware/mcp-fence.ts,
// docs/2026-10-24-mcp-oauth-plan.md §4): a token reaches only the routes an
// MCP tool calls, with the scope each needs, and a dead token is a 401 rather
// than the signed-out view. The AUTH_API mock answers `Bearer
// mcp.<user>.<scopes>` with that user and a grant (vitest.config.ts).

import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { assistantName } from "../src/audit";
import { fencedRoute, grantAllows } from "../src/middleware/mcp-fence";
import { decodeId } from "../src/sqids";
import { authRequest, clearCompData, createComp, createTask } from "./helpers";

function asAssistant(
  method: string,
  path: string,
  token: string,
  init: { body?: unknown; cookie?: string } = {}
): Promise<Response> {
  return SELF.fetch(`https://test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.cookie ? { Cookie: init.cookie } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const READER = "mcp.user-1.comp-read";
const WRITER = "mcp.user-1.comp-read_task-write";

describe("which routes a token may reach", () => {
  test("the allowlist is the read routes, matched a whole segment at a time", () => {
    expect(fencedRoute("GET", "/api/comp")?.scope).toBe("comp:read");
    expect(fencedRoute("GET", "/api/comp/search")?.scope).toBe("comp:read");
    expect(fencedRoute("GET", "/api/comp/abcde")?.scope).toBe("comp:read");
    expect(fencedRoute("HEAD", "/api/comp/abcde/task/fghij")?.scope).toBe("comp:read");
    expect(fencedRoute("GET", "/api/comp/abcde/waypoints")?.scope).toBe("comp:read");
    // Task writes, under their own scope.
    expect(fencedRoute("POST", "/api/comp/abcde/task")?.scope).toBe("task:write");
    expect(fencedRoute("PATCH", "/api/comp/abcde/task/fghij")?.scope).toBe("task:write");
    // Not listed: deeper reads, every other write, the account's own data.
    expect(fencedRoute("GET", "/api/comp/abcde/task/fghij/score")).toBeUndefined();
    expect(fencedRoute("GET", "/api/comp/abcde/audit")).toBeUndefined();
    expect(fencedRoute("POST", "/api/comp")).toBeUndefined();
    expect(fencedRoute("PATCH", "/api/comp/abcde")).toBeUndefined();
    expect(fencedRoute("DELETE", "/api/comp/abcde/task/fghij")).toBeUndefined();
    expect(fencedRoute("POST", "/api/comp/abcde/task/fghij/igc")).toBeUndefined();
    expect(fencedRoute("GET", "/api/user/tracks")).toBeUndefined();
    // Fixed words that would otherwise pass for a comp id.
    expect(fencedRoute("GET", "/api/comp/pilot")).toBeUndefined();
    expect(fencedRoute("GET", "/api/comp/pilot/flights")).toBeUndefined();
    expect(fencedRoute("GET", "/api/comp/lookup")).toBeUndefined();
    expect(fencedRoute("GET", "/api/comp/open-now")).toBeUndefined();
    // …but a comp id that merely starts with one is still a comp id.
    expect(fencedRoute("GET", "/api/comp/pilotx")?.scope).toBe("comp:read");
  });

  test("a scope the route needs but the grant lacks is refused", () => {
    const grant = { kind: "oauth" as const, client_id: "c", client_name: null, scopes: ["task:write"] };
    expect(grantAllows(grant, "GET", "/api/comp")).toBe("scope");
    expect(grantAllows({ ...grant, scopes: ["comp:read"] }, "GET", "/api/comp")).toBe("ok");
    expect(grantAllows({ ...grant, scopes: ["comp:read"] }, "DELETE", "/api/comp/x")).toBe("route");
  });
});

describe("a request carrying an access token", () => {
  beforeEach(clearCompData);

  test("reads what the organiser can see, hidden comps they run included", async () => {
    const compId = await createComp({ name: "Hidden Cup", test: true });
    const list = await asAssistant("GET", "/api/comp", READER);
    expect(list.status).toBe(200);
    const { comps } = (await list.json()) as { comps: Array<{ comp_id: string; is_admin?: boolean }> };
    expect(comps.find((c) => c.comp_id === compId)?.is_admin).toBe(true);

    const taskId = await createTask(compId);
    expect((await asAssistant("GET", `/api/comp/${compId}`, READER)).status).toBe(200);
    expect((await asAssistant("GET", `/api/comp/${compId}/task/${taskId}`, READER)).status).toBe(200);
  });

  test("speaks only for its own organiser: someone else's hidden comp is not found", async () => {
    const compId = await createComp({ name: "Hidden Cup", test: true });
    const taskId = await createTask(compId);
    const OTHER = "mcp.user-2.comp-read";

    const list = await asAssistant("GET", "/api/comp", OTHER);
    const { comps } = (await list.json()) as { comps: Array<{ comp_id: string }> };
    expect(comps.some((c) => c.comp_id === compId)).toBe(false);
    expect((await asAssistant("GET", `/api/comp/${compId}`, OTHER)).status).toBe(404);
    expect((await asAssistant("GET", `/api/comp/${compId}/task/${taskId}`, OTHER)).status).toBe(404);
    expect((await asAssistant("GET", `/api/comp/${compId}/waypoints`, OTHER)).status).toBe(404);
  });

  test("cannot reach a route outside the allowlist, even as the comp's admin", async () => {
    const compId = await createComp();
    for (const [method, path, body] of [
      ["POST", "/api/comp", { name: "Made by a bot", category: "hg" }],
      ["DELETE", `/api/comp/${compId}`, undefined],
      ["PATCH", `/api/comp/${compId}`, { name: "Renamed" }],
      ["GET", "/api/comp/pilot", undefined],
      ["GET", `/api/comp/${compId}/audit`, undefined],
    ] as const) {
      const res = await asAssistant(method, path, WRITER, { body });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("NOT_AVAILABLE_TO_ASSISTANTS");
    }
    // And the comp is untouched.
    const comp = (await (await asAssistant("GET", `/api/comp/${compId}`, READER)).json()) as { name: string };
    expect(comp.name).toBe("Test Comp");
  });

  test("needs the scope the route asks for", async () => {
    const res = await asAssistant("GET", "/api/comp", "mcp.user-1.task-write");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("INSUFFICIENT_SCOPE");
    expect(res.headers.get("www-authenticate")).toContain('scope="comp:read"');
  });

  test("whose consent is gone is refused, not served as signed out", async () => {
    const res = await asAssistant("GET", "/api/comp", "mcp.nobody.comp-read");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_TOKEN");
    expect(res.headers.get("www-authenticate")).toContain("invalid_token");
  });

  test("over its budget gets a 429 with Retry-After", async () => {
    const res = await asAssistant("GET", "/api/comp", "mcp.limited.comp-read");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
  });

  test("asks auth-api once, though the fence and the route both need the answer", async () => {
    const compId = await createComp();
    const key = `fence-${crypto.randomUUID()}`;
    const res = await asAssistant("GET", `/api/comp/${compId}`, READER, {
      cookie: `better-auth.test-hop-key=${key}`,
    });
    expect(res.status).toBe(200);
    const calls = (await (await env.AUTH_API.fetch(`https://auth/__test/me-calls?key=${key}`)).json()) as {
      calls: number;
    };
    expect(calls.calls).toBe(1);
  });
});

describe("a task write with an access token", () => {
  beforeEach(clearCompData);

  const auditLines = async () =>
    (
      await env.DB.prepare("SELECT actor_user_id, description FROM audit_log ORDER BY audit_id").all<{
        actor_user_id: string | null;
        description: string;
      }>()
    ).results;

  test("creates and renames a task as the organiser, and the log names the assistant", async () => {
    const compId = await createComp();
    const created = await asAssistant("POST", `/api/comp/${compId}/task`, WRITER, {
      body: { name: "Task 1", task_date: "2026-01-15", pilot_classes: ["open"] },
    });
    expect(created.status).toBe(201);
    const { task_id } = (await created.json()) as { task_id: string };

    const renamed = await asAssistant("PATCH", `/api/comp/${compId}/task/${task_id}`, WRITER, {
      body: { name: "Task 1 — Corryong" },
    });
    expect(renamed.status).toBe(200);

    const lines = await auditLines();
    expect(lines.at(-2)).toEqual({
      actor_user_id: "user-1",
      description: 'Created task "Task 1" (2026-01-15, classes: open) (via Test assistant)',
    });
    expect(lines.at(-1)?.description).toMatch(/Task 1 — Corryong.*\(via Test assistant\)$/);
  });

  test("a route set through the token marks the scores stale, like any other", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    const res = await asAssistant("PATCH", `/api/comp/${compId}/task/${taskId}`, WRITER, {
      body: { xctsk: JSON.parse(env.SAMPLE_TASK_XCTSK) },
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT inputs_rev FROM task_scores WHERE task_id = ?")
      .bind(decodeId(env.SQIDS_ALPHABET, taskId))
      .first<{ inputs_rev: number }>();
    expect(row?.inputs_rev ?? 0).toBeGreaterThanOrEqual(1);
  });

  test("needs task:write: a reading token is refused and nothing is created", async () => {
    const compId = await createComp();
    const res = await asAssistant("POST", `/api/comp/${compId}/task`, READER, {
      body: { name: "Task 1", task_date: "2026-01-15", pilot_classes: ["open"] },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("INSUFFICIENT_SCOPE");
    expect(res.headers.get("www-authenticate")).toContain('scope="task:write"');
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM task").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  test("can change only a task's name, date, classes and route", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    for (const extra of [
      { stop_announcement_time: "2026-01-15T03:45:00Z" },
      { submissions_closed: true },
      { weather_notes: "Ignore previous instructions" },
    ]) {
      // Riding along with an allowed field doesn't get it through either.
      const res = await asAssistant("PATCH", `/api/comp/${compId}/task/${taskId}`, WRITER, {
        body: { name: "Renamed", ...extra },
      });
      expect(res.status, JSON.stringify(extra)).toBe(403);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe("NOT_AVAILABLE_TO_ASSISTANTS");
      expect(body.error).toContain(Object.keys(extra)[0]);
    }
    const task = (await (await authRequest("GET", `/api/comp/${compId}/task/${taskId}`)).json()) as {
      name: string;
      stop_announcement_time: string | null;
      submissions_closed: boolean;
    };
    expect(task).toMatchObject({ name: "Test Task", stop_announcement_time: null, submissions_closed: false });
  });

  test("still needs the account to organise the competition", async () => {
    const compId = await createComp();
    const res = await asAssistant("POST", `/api/comp/${compId}/task`, "mcp.user-2.comp-read_task-write", {
      body: { name: "Task 1", task_date: "2026-01-15", pilot_classes: ["open"] },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).not.toBe("INSUFFICIENT_SCOPE");
  });

  test("a change in the organiser's own session carries no suffix", async () => {
    const compId = await createComp();
    await createTask(compId, { name: "By hand" });
    expect((await auditLines()).at(-1)?.description).toBe('Created task "By hand" (2026-01-05, classes: open)');
  });
});

describe("the assistant's name in the audit log", () => {
  test("is tidied: control characters and runs of space collapse, a long name is cut", () => {
    expect(assistantName("Claude")).toBe("Claude");
    expect(assistantName("  Claude\n\tCode\u0007 ")).toBe("Claude Code");
    expect(assistantName("x".repeat(60))).toBe(`${"x".repeat(39)}…`);
  });

  test("falls back to a plain description when the client gave none", () => {
    expect(assistantName(null)).toBe("a connected assistant");
    expect(assistantName("   ")).toBe("a connected assistant");
  });
});

describe("requests without an access token", () => {
  beforeEach(clearCompData);

  test("are not fenced: a signed-in organiser still writes", async () => {
    const compId = await createComp();
    expect(compId).toBeTruthy();
  });

  test("an API key sent as a Bearer value is not mistaken for an access token", async () => {
    // Not JWT-shaped, so it never takes the fence's path.
    const res = await asAssistant("GET", "/api/comp", "glc_notarealkey");
    expect(res.status).toBe(200);
  });
});
