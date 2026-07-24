/**
 * Stale-first field-analysis store + endpoints (migration 0019).
 *
 * Same contract as the score store, with two deliberate departures this file
 * pins down: the cold read path NEVER computes synchronously (it returns
 * `pending` and schedules), and revalidation is triggered by reads rather
 * than by mutations.
 *
 * Like score-store.test.ts, the store-level describes seed with direct D1 +
 * R2 writes so no route-scheduled background work races the assertions.
 */
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { request, uploadRequest, clearCompData } from "./helpers";
import { encodeId } from "../src/sqids";
import {
  computeAndStoreFieldAnalysis,
  readFieldAnalysisRow,
  revalidateFieldAnalysis,
  FIELD_REVALIDATION_LEASE_MS,
  fieldRowHasResult,
  isFieldRowStale,
  type TaskFieldAnalysisRow,
} from "../src/field-analysis-store";

/** How many sample tracks each seeded task gets. Enough pilots that the
 * metrics have a field to compare against, few enough to stay quick. */
const TRACK_COUNT = 6;

async function compressText(text: string): Promise<Uint8Array> {
  const stream = new Response(text).body!.pipeThrough(
    new CompressionStream("gzip")
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function sampleIgcEntries(): Array<[string, string]> {
  const files = JSON.parse(env.SAMPLE_IGC_FILES) as Record<string, string>;
  return Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
}

interface ServedAnalysis {
  task_id: string;
  computed_at: string | null;
  stale: boolean;
  pending: boolean;
  error: string | null;
  classes: Array<{
    pilot_class: string;
    report: {
      basis: { pilotCount: number };
      pilots: Array<{ trackFile: string; pilotName: string; rank: number }>;
      metrics: Array<{
        id: string;
        family: string;
        correlation: { rho: number; n: number } | null;
      }>;
    };
    pilot_key_by_track_file: Record<string, string>;
    totals: Array<{ trackFile: string; totalScore: number }>;
    excluded: Array<{ pilot_name: string; reason: string }>;
  }>;
}

beforeEach(async () => {
  await clearCompData();
  const listed = await env.R2.list();
  if (listed.objects.length > 0) {
    await Promise.all(listed.objects.map((o) => env.R2.delete(o.key)));
  }
});

interface SeededTask {
  compIdNum: number;
  taskIdNum: number;
  compId: string;
  taskId: string;
  path: string;
  compPath: string;
  refreshPath: string;
  trackKeys: string[];
  pilotIdNums: number[];
}

/**
 * Seed a comp (admin: user-1) + task + n gzip'd tracks with direct writes.
 * Does NOT compute the analysis — each test decides when that happens.
 */
async function seedTask(
  opts: { scoringFormat?: string; nTracks?: number } = {}
): Promise<SeededTask> {
  const nTracks = opts.nTracks ?? TRACK_COUNT;
  const now = "2026-01-01T00:00:00Z";
  const comp = await env.DB.prepare(
    `INSERT INTO comp (name, creation_date, category, scoring_format)
     VALUES ('Field Analysis Comp', ?, 'hg', ?)`
  )
    .bind(now, opts.scoringFormat ?? "gap")
    .run();
  const compIdNum = comp.meta.last_row_id;
  await env.DB.prepare(
    `INSERT INTO comp_admin (comp_id, user_id) VALUES (?, 'user-1')`
  )
    .bind(compIdNum)
    .run();

  const task = await env.DB.prepare(
    `INSERT INTO task (comp_id, name, task_date, creation_date, xctsk)
     VALUES (?, 'Task 1', '2026-01-15', ?, ?)`
  )
    .bind(compIdNum, now, env.SAMPLE_TASK_XCTSK)
    .run();
  const taskIdNum = task.meta.last_row_id;
  await env.DB.prepare(
    `INSERT INTO task_class (task_id, pilot_class) VALUES (?, 'open')`
  )
    .bind(taskIdNum)
    .run();

  const entries = sampleIgcEntries();
  const trackKeys: string[] = [];
  const pilotIdNums: number[] = [];
  for (let i = 0; i < nTracks; i++) {
    const cp = await env.DB.prepare(
      `INSERT INTO comp_pilot (comp_id, registered_pilot_name, pilot_class)
       VALUES (?, ?, 'open')`
    )
      .bind(compIdNum, `FA Pilot ${i + 1}`)
      .run();
    const r2Key = `c/${compIdNum}/t/${taskIdNum}/${cp.meta.last_row_id}.igc`;
    const gz = await compressText(entries[i][1]);
    await env.R2.put(r2Key, gz);
    await env.DB.prepare(
      `INSERT INTO task_track (task_id, comp_pilot_id, igc_filename, uploaded_at, file_size)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(taskIdNum, cp.meta.last_row_id, r2Key, now, gz.byteLength)
      .run();
    trackKeys.push(r2Key);
    pilotIdNums.push(cp.meta.last_row_id);
  }

  const compId = encodeId(env.SQIDS_ALPHABET, compIdNum);
  const taskId = encodeId(env.SQIDS_ALPHABET, taskIdNum);
  return {
    compIdNum,
    taskIdNum,
    compId,
    taskId,
    path: `/api/comp/${compId}/task/${taskId}/field-analysis`,
    compPath: `/api/comp/${compId}/field-analysis`,
    refreshPath: `/api/comp/${compId}/task/${taskId}/field-analysis/refresh`,
    trackKeys,
    pilotIdNums,
  };
}

async function getRow(taskId: number): Promise<TaskFieldAnalysisRow> {
  const row = await readFieldAnalysisRow(env.DB, taskId);
  expect(row).not.toBeNull();
  return row!;
}

/** GET as the comp admin. */
function adminGet(path: string): Promise<Response> {
  return request("GET", path, { user: "user-1" });
}

function conditionalAdminGet(path: string, etag: string): Promise<Response> {
  return SELF.fetch(`https://test${path}`, {
    headers: { "If-None-Match": etag, Cookie: "test-user=user-1" },
  });
}

// ---------------------------------------------------------------------------

describe("field analysis read path", () => {
  test("a cold task returns pending WITHOUT computing on the request path", async () => {
    const t = await seedTask();
    const res = await adminGet(t.path);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("MISS");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const data = (await res.json()) as ServedAnalysis;
    expect(data.pending).toBe(true);
    expect(data.stale).toBe(true);
    expect(data.computed_at).toBeNull();
    expect(data.classes).toEqual([]);
  });

  test("a materialized row serves the report as a HIT with an fa:-prefixed ETag", async () => {
    const t = await seedTask();
    await computeAndStoreFieldAnalysis(env, t.taskIdNum, 0);

    const res = await adminGet(t.path);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("HIT");
    // The fa: prefix keeps this body from ever matching a score ETag — the
    // two share the same state_key because they share the same inputs.
    expect(res.headers.get("ETag")).toMatch(/^"fa:/);

    const data = (await res.json()) as ServedAnalysis;
    expect(data.stale).toBe(false);
    expect(data.pending).toBe(false);
    expect(data.classes).toHaveLength(1);

    const cls = data.classes[0];
    expect(cls.pilot_class).toBe("open");
    expect(cls.report.pilots.length).toBeGreaterThan(0);
    expect(cls.report.basis.pilotCount).toBe(cls.report.pilots.length);
    // Every registered metric family reports, and the separation ranking has
    // something to rank.
    expect(new Set(cls.report.metrics.map((m) => m.family))).toEqual(
      new Set(["day", "climbing", "gliding", "decision", "gaggle", "racecraft"])
    );
    // Cross-task pairing keys are exact comp_pilot ids, not filename guesses.
    for (const key of Object.values(cls.pilot_key_by_track_file)) {
      expect(key).toMatch(/^cp:\d+$/);
    }
  });

  test("ranks come from the official standings, and totals match them", async () => {
    const t = await seedTask();
    await computeAndStoreFieldAnalysis(env, t.taskIdNum, 0);

    const faRes = await adminGet(t.path);
    const fa = (await faRes.json()) as ServedAnalysis;
    const scoreRes = await adminGet(
      `/api/comp/${t.compId}/task/${t.taskId}/score`
    );
    const scores = (await scoreRes.json()) as {
      classes: Array<{
        pilots: Array<{ comp_pilot_id: string; rank: number; total_score: number }>;
      }>;
    };

    const cls = fa.classes[0];
    const totalByTrackFile = new Map(
      cls.totals.map((x) => [x.trackFile, x.totalScore])
    );
    for (const official of scores.classes[0].pilots) {
      // Pair by comp_pilot_id → trackFile, never by array index.
      const idx = t.pilotIdNums.findIndex(
        (n) => encodeId(env.SQIDS_ALPHABET, n) === official.comp_pilot_id
      );
      expect(idx).toBeGreaterThanOrEqual(0);
      const trackFile = t.trackKeys[idx];
      const analysed = cls.report.pilots.find((p) => p.trackFile === trackFile);
      if (!analysed) continue; // unreadable track — reported in `excluded`
      expect(analysed.rank).toBe(official.rank);
      expect(totalByTrackFile.get(trackFile)).toBe(official.total_score);
    }
  });

  test("a repeat GET with the served ETag is a 304", async () => {
    const t = await seedTask();
    await computeAndStoreFieldAnalysis(env, t.taskIdNum, 0);
    const first = await adminGet(t.path);
    const etag = first.headers.get("ETag")!;
    const second = await conditionalAdminGet(t.path, etag);
    expect(second.status).toBe(304);
  });

  test("a stale body's ETag differs from the fresh one for the same state key", async () => {
    const t = await seedTask();
    await computeAndStoreFieldAnalysis(env, t.taskIdNum, 0);
    const fresh = (await adminGet(t.path)).headers.get("ETag")!;

    await env.DB.prepare(
      `UPDATE task_field_analysis SET inputs_rev = inputs_rev + 1 WHERE task_id = ?`
    )
      .bind(t.taskIdNum)
      .run();

    const staleRes = await adminGet(t.path);
    const stale = staleRes.headers.get("ETag")!;
    expect(staleRes.headers.get("X-Cache")).toBe("HIT-STALE");
    expect(stale).not.toBe(fresh);
    expect(stale).toContain(":stale");
    const data = (await staleRes.json()) as ServedAnalysis;
    // Stale is still SERVED, not withheld — the whole point of stale-first.
    expect(data.stale).toBe(true);
    expect(data.classes).toHaveLength(1);
  });

  test("an unsupported task stores its reason and serves it instead of retrying forever", async () => {
    const t = await seedTask({ scoringFormat: "open_distance" });
    const stored = await computeAndStoreFieldAnalysis(env, t.taskIdNum, 0);
    expect(stored.report).toBeNull();
    expect(stored.error).toMatch(/open-distance/i);

    const res = await adminGet(t.path);
    expect(res.status).toBe(200);
    const data = (await res.json()) as ServedAnalysis;
    expect(data.pending).toBe(false);
    expect(data.error).toMatch(/open-distance/i);
    expect(data.classes).toEqual([]);
  });

  test("a task with no route is 422", async () => {
    const t = await seedTask({ nTracks: 0 });
    await env.DB.prepare(`UPDATE task SET xctsk = NULL WHERE task_id = ?`)
      .bind(t.taskIdNum)
      .run();
    const res = await adminGet(t.path);
    expect(res.status).toBe(422);
  });
});

describe("field analysis visibility (public; test comps admin-only)", () => {
  test("anyone can read a public (non-test) comp's field analysis", async () => {
    const t = await seedTask();
    await computeAndStoreFieldAnalysis(env, t.taskIdNum, 0);

    // Anonymous and a signed-in non-admin both get the report now.
    expect((await request("GET", t.path)).status).toBe(200);
    expect((await request("GET", t.path, { user: "user-3" })).status).toBe(200);
    expect((await request("GET", t.compPath)).status).toBe(200);
  });

  test("a hidden `test` comp stays admin-only — 404 for others, not 403", async () => {
    const t = await seedTask();
    await computeAndStoreFieldAnalysis(env, t.taskIdNum, 0);
    await env.DB.prepare(`UPDATE comp SET test = 1 WHERE comp_id = ?`)
      .bind(t.compIdNum)
      .run();

    expect((await request("GET", t.path)).status).toBe(404);
    expect((await request("GET", t.path, { user: "user-3" })).status).toBe(404);
    expect((await request("GET", t.compPath)).status).toBe(404);

    // The comp admin and a super-admin still get it.
    expect((await adminGet(t.path)).status).toBe(200);
    expect(
      (await request("GET", t.path, { user: "user-super" })).status
    ).toBe(200);
  });

  test("the comp admin and a super-admin both get the report", async () => {
    const t = await seedTask();
    await computeAndStoreFieldAnalysis(env, t.taskIdNum, 0);

    expect((await adminGet(t.path)).status).toBe(200);
    expect(
      (await request("GET", t.path, { user: "user-super" })).status
    ).toBe(200);
  });
});

describe("field analysis cache headers", () => {
  test("an anonymous reader gets a public, age-based Cache-Control", async () => {
    const t = await seedTask();
    await computeAndStoreFieldAnalysis(env, t.taskIdNum, 0);

    const res = await request("GET", t.path);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toMatch(
      /^public, max-age=\d+, must-revalidate$/
    );

    // A signed-in viewer is never shared-cached (names every pilot).
    expect((await adminGet(t.path)).headers.get("Cache-Control")).toBe(
      "private, no-store"
    );
  });

  test("a long-stable report gets a long max-age, capped at three months", async () => {
    const t = await seedTask();
    await computeAndStoreFieldAnalysis(env, t.taskIdNum, 0);
    // Backdate the compute 40 days: a stable report should be cacheable for
    // roughly that long (well under the 90-day cap).
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
    await env.DB.prepare(
      `UPDATE task_field_analysis SET computed_at = ? WHERE task_id = ?`
    )
      .bind(old, t.taskIdNum)
      .run();

    const res = await request("GET", t.path);
    const maxAge = Number(
      res.headers.get("Cache-Control")!.match(/max-age=(\d+)/)![1]
    );
    expect(maxAge).toBeGreaterThan(30 * 24 * 3600);
    expect(maxAge).toBeLessThan(90 * 24 * 3600);
  });
});

describe("field analysis revalidation", () => {
  /**
   * REGRESSION: revalidation takes its lease with an UPDATE, which changes
   * nothing when the task has no row — and nothing else creates one, because
   * field analysis never computes on the request path. Without
   * ensureFieldAnalysisRow every never-mutated task stayed "pending" forever.
   * Caught by driving the real app, not by the tests that pre-seed a row.
   */
  test("a task that has never had a row still gets one computed", async () => {
    const t = await seedTask();
    expect(await readFieldAnalysisRow(env.DB, t.taskIdNum)).toBeNull();

    await revalidateFieldAnalysis(env, t.taskIdNum);

    const row = await getRow(t.taskIdNum);
    expect(fieldRowHasResult(row)).toBe(true);
    expect(isFieldRowStale(row)).toBe(false);
  });

  test("a cold GET schedules work that actually converges to a report", async () => {
    const t = await seedTask();
    const first = await adminGet(t.path);
    expect(((await first.json()) as ServedAnalysis).pending).toBe(true);

    // Drain the scheduled revalidation, then the next read must be a HIT.
    for (let i = 0; i < 30; i++) {
      const row = await readFieldAnalysisRow(env.DB, t.taskIdNum);
      if (row && fieldRowHasResult(row)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const res = await adminGet(t.path);
    const data = (await res.json()) as ServedAnalysis;
    expect(data.pending).toBe(false);
    expect(data.classes.length).toBeGreaterThan(0);
  });

  test("revalidation recomputes a stale row and clears its lock", async () => {
    const t = await seedTask();
    await computeAndStoreFieldAnalysis(env, t.taskIdNum, 0);
    await env.DB.prepare(
      `UPDATE task_field_analysis SET inputs_rev = inputs_rev + 1 WHERE task_id = ?`
    )
      .bind(t.taskIdNum)
      .run();
    expect(isFieldRowStale(await getRow(t.taskIdNum))).toBe(true);

    await revalidateFieldAnalysis(env, t.taskIdNum);

    const row = await getRow(t.taskIdNum);
    expect(isFieldRowStale(row)).toBe(false);
    expect(row.revalidating_until).toBe("");
    expect(row.compute_ms).toBeGreaterThan(0);
  });

  test("a live lease makes a concurrent revalidation a no-op", async () => {
    const t = await seedTask();
    await computeAndStoreFieldAnalysis(env, t.taskIdNum, 0);
    const before = await getRow(t.taskIdNum);

    await env.DB.prepare(
      `UPDATE task_field_analysis
       SET inputs_rev = inputs_rev + 1, revalidating_until = ?
       WHERE task_id = ?`
    )
      .bind(
        new Date(Date.now() + FIELD_REVALIDATION_LEASE_MS).toISOString(),
        t.taskIdNum
      )
      .run();

    await revalidateFieldAnalysis(env, t.taskIdNum);

    // Locked out: the blob is untouched and the row is still stale.
    const after = await getRow(t.taskIdNum);
    expect(after.computed_at).toBe(before.computed_at);
    expect(isFieldRowStale(after)).toBe(true);
  });

  test("a stale writer cannot regress a newer report", async () => {
    const t = await seedTask();
    await computeAndStoreFieldAnalysis(env, t.taskIdNum, 5);
    const newer = await getRow(t.taskIdNum);

    // A slow writer that lost the lease race finishing with an older rev.
    await computeAndStoreFieldAnalysis(env, t.taskIdNum, 2);

    const after = await getRow(t.taskIdNum);
    expect(after.computed_rev).toBe(newer.computed_rev);
    expect(after.computed_at).toBe(newer.computed_at);
  });

  test("a metric-version roll makes every stored row stale with no migration", async () => {
    const t = await seedTask();
    await computeAndStoreFieldAnalysis(env, t.taskIdNum, 0);
    expect(isFieldRowStale(await getRow(t.taskIdNum))).toBe(false);

    await env.DB.prepare(
      `UPDATE task_field_analysis SET analysis_version = analysis_version + 1
       WHERE task_id = ?`
    )
      .bind(t.taskIdNum)
      .run();

    expect(isFieldRowStale(await getRow(t.taskIdNum))).toBe(true);
  });
});

describe("field analysis invalidation is shared with scores", () => {
  /**
   * THE INVARIANT BEHIND THE SINGLE-BUMP DESIGN. bumpScoreInputs() bumps both
   * derived tables in one batch, which is what keeps the 28 score-affecting
   * mutation sites from ever having to know this table exists. If someone
   * re-splits that bump, this test fails.
   */
  test("an IGC upload through the real route marks the field analysis stale", async () => {
    const t = await seedTask();
    await computeAndStoreFieldAnalysis(env, t.taskIdNum, 0);
    const before = await getRow(t.taskIdNum);
    expect(isFieldRowStale(before)).toBe(false);

    // The upload route takes gzipped IGC and auto-registers the pilot it
    // finds in the file's own header.
    const entries = sampleIgcEntries();
    const res = await uploadRequest(
      `/api/comp/${t.compId}/task/${t.taskId}/igc`,
      await compressText(entries[TRACK_COUNT][1]),
      { user: "user-1" }
    );
    expect(res.status).toBeLessThan(300);

    const after = await getRow(t.taskIdNum);
    expect(after.inputs_rev).toBeGreaterThan(before.inputs_rev);
    expect(isFieldRowStale(after)).toBe(true);
  });

  test("the explicit refresh action bumps only the analysis, not the scores", async () => {
    const t = await seedTask();
    await computeAndStoreFieldAnalysis(env, t.taskIdNum, 0);
    const faBefore = await getRow(t.taskIdNum);
    const scoreBefore = await env.DB.prepare(
      `SELECT inputs_rev FROM task_scores WHERE task_id = ?`
    )
      .bind(t.taskIdNum)
      .first<{ inputs_rev: number }>();

    const res = await request("POST", t.refreshPath, { user: "user-1" });
    expect(res.status).toBe(200);

    const faAfter = await getRow(t.taskIdNum);
    expect(faAfter.inputs_rev).toBeGreaterThan(faBefore.inputs_rev);

    const scoreAfter = await env.DB.prepare(
      `SELECT inputs_rev FROM task_scores WHERE task_id = ?`
    )
      .bind(t.taskIdNum)
      .first<{ inputs_rev: number }>();
    expect(scoreAfter?.inputs_rev ?? 0).toBe(scoreBefore?.inputs_rev ?? 0);
  });

  test("a non-admin cannot trigger a refresh", async () => {
    const t = await seedTask();
    const res = await request("POST", t.refreshPath, { user: "user-3" });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("comp-level aggregate", () => {
  test("a stale-but-served task is NOT counted pending, and a stale refusal IS", async () => {
    const t = await seedTask();
    await computeAndStoreFieldAnalysis(env, t.taskIdNum, 0);

    // Second task: a refusal row (no tracks), then its inputs move — the
    // "tracks arrived after the refusal" shape that must be rescheduled and
    // reported pending, not silently dropped from the comp page forever.
    const second = await env.DB.prepare(
      `INSERT INTO task (comp_id, name, task_date, creation_date, xctsk)
       VALUES (?, 'Task 2', '2026-01-16', '2026-01-01T00:00:00Z', ?)`
    )
      .bind(t.compIdNum, env.SAMPLE_TASK_XCTSK)
      .run();
    const secondId = second.meta.last_row_id;
    await env.DB.prepare(
      `INSERT INTO task_class (task_id, pilot_class) VALUES (?, 'open')`
    )
      .bind(secondId)
      .run();
    const refusal = await computeAndStoreFieldAnalysis(env, secondId, 0);
    expect(refusal.error).toMatch(/needs tracks/i);

    // Mark BOTH stale (as any scoring-input mutation would).
    await env.DB.prepare(
      `UPDATE task_field_analysis SET inputs_rev = inputs_rev + 1`
    ).run();

    const res = await adminGet(t.compPath);
    const data = (await res.json()) as {
      stale: boolean;
      pending_task_count: number;
      task_labels: string[];
    };
    // The served-but-stale first task is in the aggregate — pending would
    // falsely tell the admin it was "left out of the figures below".
    expect(data.task_labels).toEqual(["T1"]);
    expect(data.stale).toBe(true);
    // The stale REFUSAL is genuinely absent, so it IS pending (and got
    // rescheduled — pre-fix it was skipped entirely and vanished forever).
    expect(data.pending_task_count).toBe(1);
  });

  test("a real compute failure lands in the error column instead of pending forever", async () => {
    const t = await seedTask();
    // Delete every track object from R2 but keep the D1 rows: fetchIgcFixes
    // returns null for all of them, which surfaces as an Unsupported "no
    // analysable tracks" refusal — stored, not thrown, so the row is fresh
    // with an explanation rather than an invisible retry loop.
    const listed = await env.R2.list();
    await Promise.all(listed.objects.map((o) => env.R2.delete(o.key)));

    const stored = await computeAndStoreFieldAnalysis(env, t.taskIdNum, 0);
    expect(stored.report).toBeNull();
    expect(stored.error).not.toBe("");

    const res = await adminGet(t.path);
    const data = (await res.json()) as ServedAnalysis;
    expect(data.pending).toBe(false);
    expect(data.error).not.toBeNull();
  });

  test("aggregates the stored task reports and reports pending tasks", async () => {
    const t = await seedTask();

    // A second task in the same comp, left cold on purpose.
    const second = await env.DB.prepare(
      `INSERT INTO task (comp_id, name, task_date, creation_date, xctsk)
       VALUES (?, 'Task 2', '2026-01-16', '2026-01-01T00:00:00Z', ?)`
    )
      .bind(t.compIdNum, env.SAMPLE_TASK_XCTSK)
      .run();
    await env.DB.prepare(
      `INSERT INTO task_class (task_id, pilot_class) VALUES (?, 'open')`
    )
      .bind(second.meta.last_row_id)
      .run();

    await computeAndStoreFieldAnalysis(env, t.taskIdNum, 0);

    const res = await adminGet(t.compPath);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      task_labels: string[];
      classes: Array<{
        pilot_class: string;
        aggregate: {
          taskLabels: string[];
          pilots: Array<{ key: string; rank: number }>;
          metrics: Array<{ id: string; perTaskRho: (number | null)[] }>;
        };
      }>;
      pending_task_count: number;
      total_task_count: number;
    };

    expect(data.task_labels).toEqual(["T1"]);
    expect(data.total_task_count).toBe(2);
    expect(data.pending_task_count).toBe(1);
    expect(data.classes).toHaveLength(1);

    const agg = data.classes[0].aggregate;
    expect(agg.taskLabels).toEqual(["T1"]);
    expect(agg.pilots.length).toBeGreaterThan(0);
    expect(agg.pilots[0].key).toMatch(/^cp:\d+$/);
    expect(agg.metrics.length).toBeGreaterThan(0);
    for (const m of agg.metrics) {
      expect(m.perTaskRho).toHaveLength(1);
    }
  });
});
