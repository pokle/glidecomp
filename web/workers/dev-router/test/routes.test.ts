/**
 * The dev-router's whole job is a prefix table, and a prefix table is exactly
 * the kind of thing that looks right and silently drops one route. This pins
 * every path the local stack actually serves to the Worker that must answer it.
 *
 * It earns its keep: the first version of the table wrote the public-track
 * prefix as `/api/u/`, which — matched as `prefix + "/"` — could only ever have
 * matched `/api/u//…`. Every public track link 404'd, and it took a full e2e
 * run to notice.
 */
import { describe, expect, it } from "bun:test";
import router from "../src/index";

/** Stand-in bindings: each records the request and reports which one it was. */
function stubEnv() {
  const seen: Array<{ binding: string; url: string }> = [];
  const make = (binding: string) => ({
    fetch: (request: Request) => {
      seen.push({ binding, url: request.url });
      return Promise.resolve(new Response(binding));
    },
  });
  return {
    seen,
    env: {
      AUTH_API: make("AUTH_API"),
      COMPETITION_API: make("COMPETITION_API"),
      AIRSCORE_API: make("AIRSCORE_API"),
    },
  };
}

async function routeOf(path: string): Promise<string> {
  const { env } = stubEnv();
  const res = await router.fetch(
    new Request(`http://localhost:8790${path}`),
    env as never
  );
  return res.status === 404 ? "404" : await res.text();
}

describe("dev-router dispatch", () => {
  const cases: Array<[string, string]> = [
    // auth-api
    ["/api/auth/me", "AUTH_API"],
    ["/api/auth/dev-login", "AUTH_API"],
    ["/api/auth/api-key/create", "AUTH_API"],
    // competition-api — comps, tasks, scores
    ["/api/comp", "COMPETITION_API"],
    ["/api/comp/abcd", "COMPETITION_API"],
    ["/api/comp/abcd/task/efgh/score", "COMPETITION_API"],
    // competition-api — the signed-in user's own files
    ["/api/user/tracks", "COMPETITION_API"],
    ["/api/user/tasks/xyz", "COMPETITION_API"],
    // competition-api — public-by-link files. Distinct from /api/user, and the
    // one this table got wrong first time round.
    [`/api/u/some-pilot/track/${"a".repeat(64)}`, "COMPETITION_API"],
    ["/api/u/some-pilot/task/abc", "COMPETITION_API"],
    // competition-api — admin
    ["/api/admin/cache", "COMPETITION_API"],
    // airscore-api
    ["/api/airscore/task/1/2", "AIRSCORE_API"],
  ];

  for (const [path, binding] of cases) {
    it(`${path} → ${binding}`, async () => {
      expect(await routeOf(path)).toBe(binding);
    });
  }

  it("query strings and methods don't affect dispatch", async () => {
    expect(await routeOf("/api/comp?limit=5")).toBe("COMPETITION_API");
  });

  it("passes the request through untouched", async () => {
    const { env, seen } = stubEnv();
    const url = "http://localhost:8790/api/comp/abcd/task/efgh/igc";
    await router.fetch(new Request(url, { method: "POST" }), env as never);
    expect(seen).toEqual([{ binding: "COMPETITION_API", url }]);
  });

  it("404s an unmapped path rather than guessing a worker", async () => {
    expect(await routeOf("/not-an-api-path")).toBe("404");
    expect(await routeOf("/api/unknown")).toBe("404");
  });
});

/**
 * The readiness contract, which the Playwright configs and the serve scripts
 * depend on: 200 ONLY when every Worker answers. A probe that goes green while
 * a sibling is still loading lets a test hit a loading Worker, and that kills
 * `wrangler dev` outright — see the comment on readiness() in src/index.ts.
 */
describe("dev-router readiness", () => {
  /** Bindings where each named worker fails instead of answering. */
  function envWith(broken: string[] = []) {
    const make = (binding: string) => ({
      fetch: () =>
        broken.includes(binding)
          ? Promise.reject(new Error("Network connection lost."))
          : Promise.resolve(new Response("ok")),
    });
    return {
      AUTH_API: make("AUTH_API"),
      COMPETITION_API: make("COMPETITION_API"),
      AIRSCORE_API: make("AIRSCORE_API"),
    };
  }

  async function probe(broken: string[] = []) {
    const res = await router.fetch(
      new Request("http://localhost:8790/__ready"),
      envWith(broken) as never
    );
    return { status: res.status, body: await res.json() };
  }

  it("200s when all three Workers answer", async () => {
    const { status, body } = await probe();
    expect(status).toBe(200);
    expect(body).toEqual({
      ready: true,
      workers: { AUTH_API: "ok", COMPETITION_API: "ok", AIRSCORE_API: "ok" },
    });
  });

  it("503s while ANY single Worker is still loading, and names it", async () => {
    for (const worker of ["AUTH_API", "COMPETITION_API", "AIRSCORE_API"]) {
      const { status, body } = await probe([worker]);
      // 503 matters specifically: Playwright treats 200–403 as "server is up",
      // so anything in that range would end the wait early.
      expect(status).toBe(503);
      expect((body as { ready: boolean }).ready).toBe(false);
      expect((body as { workers: Record<string, string> }).workers[worker]).toBe(
        "Network connection lost."
      );
    }
  });

  it("treats a Worker's own 4xx as a sign of life, not a failure", async () => {
    // airscore-api 404s its own root; that still proves it is loaded.
    const env = {
      AUTH_API: { fetch: () => Promise.resolve(new Response("ok")) },
      COMPETITION_API: { fetch: () => Promise.resolve(new Response("ok")) },
      AIRSCORE_API: {
        fetch: () => Promise.resolve(new Response("nope", { status: 404 })),
      },
    };
    const res = await router.fetch(
      new Request("http://localhost:8790/__ready"),
      env as never
    );
    expect(res.status).toBe(200);
  });

  it("503s when a Worker answers but is erroring", async () => {
    const env = {
      AUTH_API: { fetch: () => Promise.resolve(new Response("ok")) },
      COMPETITION_API: {
        fetch: () => Promise.resolve(new Response("boom", { status: 500 })),
      },
      AIRSCORE_API: { fetch: () => Promise.resolve(new Response("ok")) },
    };
    const res = await router.fetch(
      new Request("http://localhost:8790/__ready"),
      env as never
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { workers: Record<string, string> };
    expect(body.workers.COMPETITION_API).toBe("status 500");
  });
});
