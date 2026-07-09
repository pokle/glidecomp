import { describe, it, expect } from "vitest";
import {
  loadCompetitions,
  loadCompDetail,
  loadTaskDetail,
  loadPilotScoreDetail,
  NotFoundError,
  type FetchFn,
} from "./loaders";

/**
 * A fake FetchFn backed by a path → {status, body, etag} table. Records the
 * paths requested so tests can assert the loader hit the right endpoints.
 */
function fakeFetch(
  table: Record<string, { status?: number; body?: unknown; etag?: string }>
): { fetch: FetchFn; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchFn = (path) => {
    calls.push(path);
    const entry = table[path];
    if (!entry) return Promise.resolve(new Response("not mapped", { status: 500 }));
    const headers = new Headers();
    if (entry.etag) headers.set("ETag", entry.etag);
    const status = entry.status ?? 200;
    const body = status === 200 && entry.body !== undefined ? JSON.stringify(entry.body) : "";
    return Promise.resolve(new Response(body, { status, headers }));
  };
  return { fetch, calls };
}

describe("loadCompetitions", () => {
  it("GETs /api/comp and returns the comps", async () => {
    const { fetch, calls } = fakeFetch({
      "/api/comp": { body: { comps: [{ comp_id: "a", name: "Alpha" }] } },
    });
    const data = await loadCompetitions(fetch);
    expect(calls).toEqual(["/api/comp"]);
    expect(data.comps[0].name).toBe("Alpha");
  });
});

describe("loadCompDetail", () => {
  it("fetches comp + scores in parallel and computes today", async () => {
    const { fetch, calls } = fakeFetch({
      "/api/comp/abc": {
        body: { comp_id: "abc", name: "Corryong", timezone: "Australia/Melbourne", tasks: [] },
      },
      "/api/comp/abc/scores": {
        body: { comp_id: "abc", tasks: [], standings: [], computed_at: null, stale: false },
        etag: 'W/"v1"',
      },
    });
    const data = await loadCompDetail(fetch, "abc");
    expect(calls).toContain("/api/comp/abc");
    expect(calls).toContain("/api/comp/abc/scores");
    expect(data.comp.name).toBe("Corryong");
    expect(data.scores).not.toBeNull();
    expect(data.scoresEtag).toBe('W/"v1"');
    // "today" is a bare YYYY-MM-DD string.
    expect(data.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("tolerates unavailable scores (null), still returns the comp", async () => {
    const { fetch } = fakeFetch({
      "/api/comp/abc": { body: { comp_id: "abc", name: "Corryong", timezone: null, tasks: [] } },
      "/api/comp/abc/scores": { status: 503 },
    });
    const data = await loadCompDetail(fetch, "abc");
    expect(data.comp.name).toBe("Corryong");
    expect(data.scores).toBeNull();
    expect(data.scoresEtag).toBeNull();
  });

  it("throws NotFoundError when the comp is 404 (missing / hidden test comp)", async () => {
    const { fetch } = fakeFetch({
      "/api/comp/abc": { status: 404 },
      "/api/comp/abc/scores": { status: 404 },
    });
    await expect(loadCompDetail(fetch, "abc")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError when the comp id is invalid (API 400)", async () => {
    const { fetch } = fakeFetch({
      "/api/comp/zzz": { status: 400 },
      "/api/comp/zzz/scores": { status: 400 },
    });
    await expect(loadCompDetail(fetch, "zzz")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("loadTaskDetail", () => {
  it("returns task + comp + score; task drives the 404", async () => {
    const { fetch, calls } = fakeFetch({
      "/api/comp/abc/task/t1": { body: { task_id: "t1", name: "Task 1" } },
      "/api/comp/abc": { body: { comp_id: "abc", name: "Corryong" } },
      "/api/comp/abc/task/t1/score": { body: { task_id: "t1", classes: [] } },
    });
    const data = await loadTaskDetail(fetch, "abc", "t1");
    expect(calls).toContain("/api/comp/abc/task/t1");
    expect(data.task.name).toBe("Task 1");
    expect(data.comp?.name).toBe("Corryong");
    expect(data.score).not.toBeNull();
  });

  it("throws NotFoundError when the task is missing", async () => {
    const { fetch } = fakeFetch({
      "/api/comp/abc/task/t1": { status: 404 },
      "/api/comp/abc": { body: { name: "Corryong" } },
      "/api/comp/abc/task/t1/score": { status: 404 },
    });
    await expect(loadTaskDetail(fetch, "abc", "t1")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("loadPilotScoreDetail", () => {
  it("fetches comp + task + score + analysis", async () => {
    const { fetch, calls } = fakeFetch({
      "/api/comp/abc": { body: { comp_id: "abc", name: "Corryong" } },
      "/api/comp/abc/task/t1": { body: { task_id: "t1", name: "Task 1" } },
      "/api/comp/abc/task/t1/score": { body: { task_id: "t1", classes: [] } },
      "/api/comp/abc/task/t1/pilot/p1/analysis": { body: { comp_pilot_id: "p1" } },
    });
    const data = await loadPilotScoreDetail(fetch, "abc", "t1", "p1");
    expect(calls).toContain("/api/comp/abc/task/t1/pilot/p1/analysis");
    expect(data.analysis.comp_pilot_id).toBe("p1");
  });

  it("throws NotFoundError when the analysis is 404", async () => {
    const { fetch } = fakeFetch({
      "/api/comp/abc": { body: { name: "Corryong" } },
      "/api/comp/abc/task/t1": { body: { name: "Task 1" } },
      "/api/comp/abc/task/t1/score": { body: { classes: [] } },
      "/api/comp/abc/task/t1/pilot/p1/analysis": { status: 404 },
    });
    await expect(loadPilotScoreDetail(fetch, "abc", "t1", "p1")).rejects.toBeInstanceOf(
      NotFoundError
    );
  });
});
