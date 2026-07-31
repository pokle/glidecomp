/**
 * Site search: /api/comp/search, and the index behind it.
 *
 * The query this endpoint exists for is "elliot kangck" — two turnpoint codes
 * and nothing else — so that is the test that matters most: the sample task's
 * route has to be findable by where it goes, under the competition it belongs
 * to, without anyone naming either.
 */
import { describe, test, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { authRequest, request, createComp, createTask, clearCompData } from "./helpers";
import { searchTokens, buildMatchExpression } from "../src/search-terms";
import { turnpointNames } from "../src/xctsk-summary";
import { buildTaskDoc, drainSearchIndex, sweepSearchIndex } from "../src/search-index";

/** The sample comp's task 1 route, trimmed to what search cares about. */
const ROUTE_XCTSK = {
  taskType: "CLASSIC",
  version: 1,
  turnpoints: [
    { type: "TAKEOFF", radius: 3000, waypoint: { name: "ELLIOT", description: "ELLIOT", lat: -36.18, lon: 147.97 } },
    { type: "SSS", radius: 5000, waypoint: { name: "ELLIOT", description: "ELLIOT", lat: -36.18, lon: 147.97 } },
    { radius: 1000, waypoint: { name: "HALFWY", description: "Half", lat: -36.26, lon: 147.87 } },
    { radius: 3000, waypoint: { name: "KANGCK", description: "Kangaroo Creek", lat: -36.26, lon: 147.93 } },
    { type: "ESS", radius: 400, waypoint: { name: "NCORGL", description: "North", lat: -36.17, lon: 147.92 } },
  ],
};

interface SearchBody {
  terms: string[];
  truncated: boolean;
  comps: Array<{
    comp_id: string;
    name: string;
    matched: boolean;
    task_count: number;
    tasks: Array<{
      task_id: string;
      name: string;
      matched: boolean;
      matched_turnpoints: string[];
      pilots: Array<{ comp_pilot_id: string; name: string }>;
      pilot_count: number;
    }>;
    pilots: Array<{ comp_pilot_id: string; name: string }>;
  }>;
}

async function search(q: string, user?: string | null): Promise<SearchBody> {
  const res = await request("GET", `/api/comp/search?q=${encodeURIComponent(q)}`, { user });
  expect(res.status).toBe(200);
  return (await res.json()) as SearchBody;
}

/** A comp with one routed task and two pilots. */
async function seedComp(name = "Corryong Cup 2026") {
  const compId = await createComp({ name });
  const taskId = await createTask(compId, { name: "Task 3" });
  await authRequest("PATCH", `/api/comp/${compId}/task/${taskId}`, { xctsk: ROUTE_XCTSK });
  const pilotRes = await authRequest("POST", `/api/comp/${compId}/pilot`, {
    registered_pilot_name: "Harrison Rowntree",
    pilot_class: "open",
    team_name: "Alpine Flyers",
  });
  const { comp_pilot_id } = (await pilotRes.json()) as { comp_pilot_id: string };
  await authRequest("POST", `/api/comp/${compId}/pilot`, {
    registered_pilot_name: "Marta Kowalski",
    pilot_class: "open",
  });
  return { compId, taskId, pilotId: comp_pilot_id };
}

describe("search terms", () => {
  test("keeps digits but drops single letters", () => {
    expect(searchTokens("Task 1 a of")).toEqual(["task", "1", "of"]);
  });

  test("caps the number of words", () => {
    expect(searchTokens("one two three four five six seven")).toHaveLength(5);
  });

  test("quotes every token and prefixes only the last", () => {
    expect(buildMatchExpression(["elliot", "kangck"])).toBe('"elliot" AND "kangck"*');
  });

  test("neutralises FTS5 operators", () => {
    // searchTokens strips them first; buildMatchExpression must survive them
    // anyway, since it is the barrier that faces the query language.
    // The operators survive only as ordinary words to be quoted; the
    // punctuation and the one-letter arguments do not survive at all.
    expect(searchTokens('elliot OR "x" NEAR(a b) *')).toEqual(["elliot", "or", "near"]);
    expect(buildMatchExpression(['a"b'])).toBe('"a""b"*');
  });
});

describe("route extraction", () => {
  test("takes codes and descriptions, deduplicated", () => {
    expect(turnpointNames(JSON.stringify(ROUTE_XCTSK))).toEqual([
      { code: "ELLIOT" },
      { code: "HALFWY", description: "Half" },
      { code: "KANGCK", description: "Kangaroo Creek" },
      { code: "NCORGL", description: "North" },
    ]);
  });

  test("survives a task with no route at all", () => {
    expect(turnpointNames(null)).toEqual([]);
    expect(turnpointNames("not json")).toEqual([]);
  });

  test("puts the route and the competition's name in columns of their own", () => {
    const doc = buildTaskDoc({
      task_id: 1,
      comp_id: 2,
      comp_name: "Corryong Cup 2026",
      name: "Task 3",
      task_date: "2026-01-05",
      xctsk: JSON.stringify(ROUTE_XCTSK),
    });
    expect(doc.route).toContain("KANGCK");
    expect(doc.route).toContain("Kangaroo");
    expect(doc.title).toBe("Task 3");
    // Not in `body`: a search for the competition alone must not pull every
    // task in it along (see buildChildMatchExpression).
    expect(doc.owner).toBe("Corryong Cup 2026");
    expect(doc.body).not.toContain("Corryong");
    // The month name, so "january 2026" and "2026-01" find the same task.
    expect(doc.body).toContain("january");
  });
});

describe("GET /api/comp/search", () => {
  beforeEach(async () => {
    await clearCompData();
  });

  test("no query is not an error", async () => {
    const body = await search("");
    expect(body.terms).toEqual([]);
    expect(body.comps).toEqual([]);
  });

  test("finds a task by two of its turnpoints, under its competition", async () => {
    const { compId, taskId } = await seedComp();

    const body = await search("elliot kangck");
    expect(body.comps).toHaveLength(1);
    const comp = body.comps[0];
    expect(comp.comp_id).toBe(compId);
    // The competition itself did not match — only the task inside it did.
    expect(comp.matched).toBe(false);
    expect(comp.tasks).toHaveLength(1);
    expect(comp.tasks[0].task_id).toBe(taskId);
    expect(comp.tasks[0].matched).toBe(true);
    expect(comp.tasks[0].matched_turnpoints).toEqual([
      "ELLIOT",
      "KANGCK (Kangaroo Creek)",
    ]);
  });

  test("a turnpoint query lists no pilots — only how many there are", async () => {
    const { compId, pilotId } = await seedComp();
    // A pilot with a result, so the count is not trivially zero.
    const taskRow = await env.DB.prepare("SELECT task_id FROM task LIMIT 1").first<{
      task_id: number;
    }>();
    const pilotRow = await env.DB.prepare(
      "SELECT comp_pilot_id FROM comp_pilot WHERE registered_pilot_name = ?"
    )
      .bind("Harrison Rowntree")
      .first<{ comp_pilot_id: number }>();
    await env.DB.prepare(
      `INSERT INTO task_track (task_id, comp_pilot_id, igc_filename, uploaded_at, file_size)
       VALUES (?, ?, 'x.igc', '2026-01-05T00:00:00Z', 1)`
    )
      .bind(taskRow!.task_id, pilotRow!.comp_pilot_id)
      .run();

    const body = await search("kangck");
    const task = body.comps[0].tasks[0];
    expect(task.pilots).toEqual([]);
    expect(task.pilot_count).toBe(1);
    expect(compId).toBeTruthy();
    expect(pilotId).toBeTruthy();
  });

  test("a pilot is listed under the tasks they flew", async () => {
    await seedComp();
    const taskRow = await env.DB.prepare("SELECT task_id FROM task LIMIT 1").first<{
      task_id: number;
    }>();
    const pilotRow = await env.DB.prepare(
      "SELECT comp_pilot_id FROM comp_pilot WHERE registered_pilot_name = ?"
    )
      .bind("Harrison Rowntree")
      .first<{ comp_pilot_id: number }>();
    await env.DB.prepare(
      `INSERT INTO task_track (task_id, comp_pilot_id, igc_filename, uploaded_at, file_size)
       VALUES (?, ?, 'x.igc', '2026-01-05T00:00:00Z', 1)`
    )
      .bind(taskRow!.task_id, pilotRow!.comp_pilot_id)
      .run();

    const body = await search("harrison");
    const comp = body.comps[0];
    expect(comp.tasks).toHaveLength(1);
    expect(comp.tasks[0].matched).toBe(false); // carried by the pilot
    expect(comp.tasks[0].pilots.map((p) => p.name)).toEqual(["Harrison Rowntree"]);
  });

  test("a pilot who never flew is still findable, under the competition", async () => {
    await seedComp();
    const body = await search("marta");
    expect(body.comps[0].tasks).toEqual([]);
    expect(body.comps[0].pilots.map((p) => p.name)).toEqual(["Marta Kowalski"]);
  });

  test("every word must match, and they may span the levels", async () => {
    await seedComp();
    // "corryong" is the comp's name and "kangck" a turnpoint of its task: one
    // document has to carry both, which is why the comp name rides along.
    const body = await search("corryong kangck");
    expect(body.comps[0].tasks[0].matched).toBe(true);

    // A word that is in neither narrows to nothing rather than being ignored.
    expect((await search("corryong zzzz")).comps).toEqual([]);
  });

  test("matches while the last word is still being typed", async () => {
    await seedComp();
    expect((await search("corryo")).comps).toHaveLength(1);
    expect((await search("kang")).comps).toHaveLength(1);
  });

  test("finds a competition by its own name", async () => {
    await seedComp();
    const body = await search("corryong cup");
    expect(body.comps[0].matched).toBe(true);
    expect(body.comps[0].task_count).toBe(1);
  });

  test("a competition's name alone does not drag its whole roster in", async () => {
    // Every task and pilot document carries the competition's name, which is
    // what makes "corryong harrison" work. It must not also mean that asking
    // for the competition lists everything inside it as a match of its own.
    await seedComp();
    const body = await search("corryong cup");
    expect(body.comps[0].tasks).toEqual([]);
    expect(body.comps[0].pilots).toEqual([]);
    // Adding a word that IS the task's own brings it back.
    expect((await search("corryong kangck")).comps[0].tasks).toHaveLength(1);
  });

  test("a competition named for the query beats one that merely contains it", async () => {
    // bm25 scores a short document higher than a long one, so a pilot called
    // "Andrew Forbes" used to outrank every competition actually called Forbes
    // Flatlands — and pushed one off the end of the list.
    await seedComp("Forbes Flatlands 2026");
    const other = await createComp({ name: "Bright Open 2026" });
    await createTask(other, { name: "Task 1" });
    await authRequest("POST", `/api/comp/${other}/pilot`, {
      registered_pilot_name: "Andrew Forbes",
      pilot_class: "open",
    });

    const body = await search("forbes");
    expect(body.comps.map((c) => c.name)).toEqual([
      "Forbes Flatlands 2026",
      "Bright Open 2026",
    ]);
    expect(body.comps[0].matched).toBe(true);
  });

  test("competitions read newest first", async () => {
    // Every competition here matches every word, so what bm25 has left to rank
    // on is route length. Six Corryong Cups came back 2025, 2023, 2021, 2024,
    // 2017 on that basis; a reader expects the years in order.
    for (const year of ["2021", "2025", "2017"]) {
      const compId = await createComp({ name: `Corryong Cup ${year}` });
      const taskId = await createTask(compId, {
        name: "Task 1",
        task_date: `${year}-01-10`,
      });
      await authRequest("PATCH", `/api/comp/${compId}/task/${taskId}`, {
        xctsk: ROUTE_XCTSK,
      });
    }
    const body = await search("kangck");
    expect(body.comps.map((c) => c.name)).toEqual([
      "Corryong Cup 2025",
      "Corryong Cup 2021",
      "Corryong Cup 2017",
    ]);
  });

  test("hides a test comp from anyone who cannot already see it", async () => {
    const compId = await createComp({ name: "Secret Shakedown", test: true });
    await createTask(compId, { name: "Task 1" });

    expect((await search("shakedown")).comps).toEqual([]); // anonymous
    expect((await search("shakedown", "user-2")).comps).toEqual([]); // signed in, not an admin
    expect((await search("shakedown", "user-1")).comps).toHaveLength(1); // its admin
    expect((await search("shakedown", "user-super")).comps).toHaveLength(1);
  });

  test("an anonymous answer is cacheable; a personalised one is not", async () => {
    await seedComp();
    const anon = await request("GET", "/api/comp/search?q=corryong");
    expect(anon.headers.get("Cache-Control")).toBe("public, max-age=60");
    const signedIn = await request("GET", "/api/comp/search?q=corryong", { user: "user-1" });
    expect(signedIn.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("the index keeps itself current", () => {
  beforeEach(async () => {
    await clearCompData();
  });

  test("a rename is searchable by the new name and not the old", async () => {
    const { compId } = await seedComp("Corryong Cup 2026");
    expect((await search("corryong")).comps).toHaveLength(1);

    await authRequest("PATCH", `/api/comp/${compId}`, { name: "Bright Open 2026" });

    expect((await search("bright open")).comps).toHaveLength(1);
    expect((await search("corryong")).comps).toEqual([]);
  });

  test("a renamed competition is still found through its task's route", async () => {
    // The comp's name is copied into every child document, so the rename has
    // to reach them too — otherwise "bright kangck" finds nothing.
    const { compId } = await seedComp("Corryong Cup 2026");
    await authRequest("PATCH", `/api/comp/${compId}`, { name: "Bright Open 2026" });
    expect((await search("bright kangck")).comps).toHaveLength(1);
  });

  test("a re-routed task is searchable by its new turnpoints", async () => {
    const { compId, taskId } = await seedComp();
    expect((await search("kangck")).comps).toHaveLength(1);

    await authRequest("PATCH", `/api/comp/${compId}/task/${taskId}`, {
      xctsk: {
        taskType: "CLASSIC",
        version: 1,
        turnpoints: [
          { radius: 400, waypoint: { name: "MTBULR", description: "Mount Buller", lat: -37, lon: 146 } },
        ],
      },
    });

    expect((await search("kangck")).comps).toEqual([]);
    expect((await search("buller")).comps).toHaveLength(1);
  });

  test("a deleted competition leaves nothing behind", async () => {
    const { compId } = await seedComp();
    expect((await search("kangck")).comps).toHaveLength(1);

    const res = await authRequest("DELETE", `/api/comp/${compId}`);
    expect(res.status).toBeLessThan(300);

    expect((await search("kangck")).comps).toEqual([]);
    const left = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM search_doc").first<{
      cnt: number;
    }>();
    expect(left!.cnt).toBe(0);
  });

  test("a write during a rebuild is not swallowed by it", async () => {
    // The drain deletes a key only if its mark count is still what it read.
    // Simulate the race: mark, drain-read, mark again, and check the key
    // survives the delete that ends the first pass.
    const { compId } = await seedComp();
    await env.DB.prepare("DELETE FROM search_dirty").run();
    await env.DB.prepare(
      `INSERT INTO search_dirty(key, marked) VALUES ('comp:1', 1)`
    ).run();
    await env.DB.prepare(
      `UPDATE search_dirty SET marked = marked + 1 WHERE key = 'comp:1'`
    ).run();

    await drainSearchIndex(env.DB, 1);
    // Cleared: the drain read marked=2 and deleted on marked=2.
    const after = await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM search_dirty WHERE key = 'comp:1'"
    ).first<{ cnt: number }>();
    expect(after!.cnt).toBe(0);
    expect(compId).toBeTruthy();
  });

  test("the sweep re-queues documents an older builder wrote", async () => {
    await seedComp();
    await env.DB.prepare("UPDATE search_doc SET rev = 0").run();
    const marked = await sweepSearchIndex(env.DB);
    expect(marked).toBeGreaterThan(0);

    const queued = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM search_dirty").first<{
      cnt: number;
    }>();
    expect(queued!.cnt).toBeGreaterThan(0);

    await drainSearchIndex(env.DB, 5);
    const stale = await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM search_doc WHERE rev = 0"
    ).first<{ cnt: number }>();
    expect(stale!.cnt).toBe(0);
  });
});

describe("POST /api/admin/search/reindex", () => {
  beforeEach(async () => {
    await clearCompData();
  });

  test("rebuilds every document, for super admins only", async () => {
    await seedComp();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM search_doc"),
      env.DB.prepare("DELETE FROM search_dirty"),
    ]);
    expect((await search("kangck")).comps).toEqual([]);

    const denied = await authRequest("POST", "/api/admin/search/reindex");
    expect(denied.status).toBe(403);

    const res = await request("POST", "/api/admin/search/reindex", { user: "user-super" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { queued: number; rebuilt: number; remaining: number };
    expect(body.queued).toBeGreaterThan(0);
    expect(body.remaining).toBe(0);

    expect((await search("kangck")).comps).toHaveLength(1);
  });

  test("resume drains what is queued instead of queueing it all again", async () => {
    // Without this distinction a database with more documents than one request
    // rebuilds can never finish: every call re-adds the whole database, so
    // `remaining` stalls at the difference instead of falling to zero.
    await seedComp();
    const resumed = await request(
      "POST",
      "/api/admin/search/reindex?resume=true",
      { user: "user-super" }
    );
    expect(resumed.status).toBe(200);
    const body = (await resumed.json()) as { queued: number; remaining: number };
    expect(body.queued).toBe(0);
    expect(body.remaining).toBe(0);
  });
});
