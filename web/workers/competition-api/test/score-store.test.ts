/**
 * Stale-first score store semantics (docs/score-caching-stale-first-plan.md):
 * reads serve the materialized task_scores row instantly; mutations mark it
 * stale transactionally; revalidation is lock-deduped and its guarded write
 * can never record a result computed from superseded inputs as fresh.
 *
 * The store-level describes seed comp/task/tracks with direct D1 + R2 writes
 * (not the routes) so no route-scheduled background revalidation races the
 * assertions — every compute here is an explicitly awaited call. The
 * "mutation hooks" describe exercises the real routes and asserts on the
 * converged result (polling out the background re-score).
 */
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import {
  request,
  authRequest,
  uploadRequest,
  createComp,
  createTask,
  clearCompData,
} from "./helpers";
import { decodeId, encodeId } from "../src/sqids";
import {
  bumpScoreInputs,
  computeAndStoreTaskScore,
  readTaskScoreRow,
  revalidateTaskScores,
  REVALIDATION_LEASE_MS,
  type TaskScoreRow,
} from "../src/score-store";

/** Compress a string to gzip for upload / R2 storage. */
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

interface ServedScore {
  task_id: string;
  computed_at: string;
  stale: boolean;
  classes: Array<{ pilots: Array<{ pilot_name: string; total_score: number }> }>;
}

interface ServedCompScores {
  comp_id: string;
  computed_at: string | null;
  stale: boolean;
  tasks: Array<{ task_id: string }>;
  standings: Array<{ pilot_class: string; pilots: Array<{ pilot_name: string }> }>;
}

beforeEach(async () => {
  await clearCompData();
  const listed = await env.R2.list();
  if (listed.objects.length > 0) {
    await Promise.all(listed.objects.map((o) => env.R2.delete(o.key)));
  }
});

/**
 * Seed a comp + task (+ n gzip'd tracks in R2) with direct writes, then
 * materialize the scores with one awaited compute. Nothing here schedules
 * background work.
 */
async function seedScoredTask(nTracks = 1): Promise<{
  compIdNum: number;
  taskIdNum: number;
  compId: string;
  taskId: string;
  scorePath: string;
  compScoresPath: string;
}> {
  const now = "2026-01-01T00:00:00Z";
  const comp = await env.DB.prepare(
    `INSERT INTO comp (name, creation_date, category) VALUES ('Store Test Comp', ?, 'hg')`
  )
    .bind(now)
    .run();
  const compIdNum = comp.meta.last_row_id;
  const task = await env.DB.prepare(
    `INSERT INTO task (comp_id, name, task_date, creation_date, xctsk)
     VALUES (?, 'Store Test Task', '2026-01-15', ?, ?)`
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
  for (let i = 0; i < nTracks; i++) {
    const cp = await env.DB.prepare(
      `INSERT INTO comp_pilot (comp_id, registered_pilot_name, pilot_class)
       VALUES (?, ?, 'open')`
    )
      .bind(compIdNum, `Store Pilot ${i + 1}`)
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
  }

  await computeAndStoreTaskScore(env, taskIdNum, 0);

  const compId = encodeId(env.SQIDS_ALPHABET, compIdNum);
  const taskId = encodeId(env.SQIDS_ALPHABET, taskIdNum);
  return {
    compIdNum,
    taskIdNum,
    compId,
    taskId,
    scorePath: `/api/comp/${compId}/task/${taskId}/score`,
    compScoresPath: `/api/comp/${compId}/scores`,
  };
}

/** Poll a score endpoint until the served body reports stale: false —
 * converging (and thereby draining) any in-flight background re-score. */
async function getFresh(path: string): Promise<{ res: Response; data: ServedScore }> {
  for (let attempt = 0; ; attempt++) {
    const res = await request("GET", path);
    expect(res.status).toBe(200);
    const data = (await res.json()) as ServedScore;
    if (data.stale === false) return { res, data };
    if (attempt >= 50) throw new Error("scores never became fresh");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function getRow(taskId: number): Promise<TaskScoreRow> {
  const row = await readTaskScoreRow(env.DB, taskId);
  expect(row).not.toBeNull();
  return row!;
}

function conditionalGet(path: string, etag: string): Promise<Response> {
  return SELF.fetch(`https://test${path}`, {
    headers: { "If-None-Match": etag },
  });
}

describe("task score read path", () => {
  test("a materialized row serves as a HIT with ETag and anonymous cache headers", async () => {
    const t = await seedScoredTask();
    const res = await request("GET", t.scorePath);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("HIT");
    expect(res.headers.get("ETag")).toMatch(/^".+"$/);
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=0, must-revalidate"
    );
    const data = (await res.json()) as ServedScore;
    expect(data.stale).toBe(false);
    expect(data.classes[0].pilots).toHaveLength(1);
    expect(new Date(data.computed_at).getTime()).not.toBeNaN();
  });

  test("signed-in readers get private, no-store", async () => {
    const t = await seedScoredTask();
    const res = await request("GET", t.scorePath, { user: "user-1" });
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  test("304 on matching If-None-Match; 200 with a new ETag once inputs change", async () => {
    const t = await seedScoredTask();
    const res = await request("GET", t.scorePath);
    const etag = res.headers.get("ETag")!;

    const conditional = await conditionalGet(t.scorePath, etag);
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe("");
    expect(conditional.headers.get("ETag")).toBe(etag);

    // A real input change (a penalty) + recompute rolls the stored
    // state_key, so the same conditional request now gets a full 200.
    await env.DB.prepare(
      "UPDATE task_track SET penalty_points = 25 WHERE task_id = ?"
    )
      .bind(t.taskIdNum)
      .run();
    await bumpScoreInputs(env.DB, [t.taskIdNum]);
    await revalidateTaskScores(env, t.taskIdNum);

    const after = await conditionalGet(t.scorePath, etag);
    expect(after.status).toBe(200);
    expect(after.headers.get("ETag")).not.toBe(etag);
    expect(after.headers.get("X-Cache")).toBe("HIT");
  });

  test("a stale row serves the OLD body instantly, labelled stale, then heals in the background", async () => {
    const t = await seedScoredTask();
    const { data: before } = await getFresh(t.scorePath);

    await bumpScoreInputs(env.DB, [t.taskIdNum]);

    const res = await request("GET", t.scorePath);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("HIT-STALE");
    const stale = (await res.json()) as ServedScore;
    expect(stale.stale).toBe(true);
    // The body (bar the label) is exactly the pre-bump result — readers are
    // never made to wait for a recompute.
    expect({ ...stale, stale: false }).toEqual(before);

    // That stale read scheduled revalidation; the row converges to fresh.
    const { res: healed } = await getFresh(t.scorePath);
    expect(healed.headers.get("X-Cache")).toBe("HIT");
    const row = await getRow(t.taskIdNum);
    expect(row.computed_rev).toBe(row.inputs_rev);
  });

  test("an engine-version bump reads as stale with no migration step", async () => {
    const t = await seedScoredTask();
    // A blob computed by a previous engine generation.
    await env.DB.prepare(
      "UPDATE task_scores SET engine_version = engine_version - 1 WHERE task_id = ?"
    )
      .bind(t.taskIdNum)
      .run();

    const res = await request("GET", t.scorePath);
    expect(res.headers.get("X-Cache")).toBe("HIT-STALE");
    const data = (await res.json()) as ServedScore;
    expect(data.stale).toBe(true);

    // The scheduled revalidation recomputes under the running engine.
    await getFresh(t.scorePath);
    const row = await getRow(t.taskIdNum);
    expect(row.computed_rev).toBe(row.inputs_rev);
  });

  test("a task with no row (pre-feature) computes synchronously exactly once: MISS then HIT", async () => {
    const t = await seedScoredTask();
    // Simulate a task that predates the feature (or slipped the hooks).
    await env.DB.prepare("DELETE FROM task_scores WHERE task_id = ?")
      .bind(t.taskIdNum)
      .run();

    const cold = await request("GET", t.scorePath);
    expect(cold.status).toBe(200);
    expect(cold.headers.get("X-Cache")).toBe("MISS");
    const coldData = (await cold.json()) as ServedScore;
    expect(coldData.stale).toBe(false);
    expect(coldData.classes[0].pilots).toHaveLength(1);

    const warm = await request("GET", t.scorePath);
    expect(warm.headers.get("X-Cache")).toBe("HIT");
  });

  test("bumpScoreInputs upserts a placeholder for never-scored tasks; reads treat it as cold", async () => {
    const t = await seedScoredTask();
    await env.DB.prepare("DELETE FROM task_scores WHERE task_id = ?")
      .bind(t.taskIdNum)
      .run();
    await bumpScoreInputs(env.DB, [t.taskIdNum]);

    const placeholder = await getRow(t.taskIdNum);
    expect(placeholder.computed_rev).toBe(-1);
    expect(placeholder.response_json).toBe("");

    // No servable blob yet — the endpoint computes synchronously rather
    // than serving the placeholder.
    const res = await request("GET", t.scorePath);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("MISS");
    const data = (await res.json()) as ServedScore;
    expect(data.stale).toBe(false);
  });
});

describe("revalidation lock and CAS", () => {
  test("a live lease blocks a second revalidation; an expired lease is stolen", async () => {
    const t = await seedScoredTask();

    // Make the row stale and pretend another worker holds a live lease.
    await bumpScoreInputs(env.DB, [t.taskIdNum]);
    const liveLease = new Date(Date.now() + REVALIDATION_LEASE_MS).toISOString();
    await env.DB.prepare(
      "UPDATE task_scores SET revalidating_until = ? WHERE task_id = ?"
    )
      .bind(liveLease, t.taskIdNum)
      .run();

    await revalidateTaskScores(env, t.taskIdNum);
    let row = await getRow(t.taskIdNum);
    // Locked out: nothing recomputed, lease untouched.
    expect(row.computed_rev).toBeLessThan(row.inputs_rev);
    expect(row.revalidating_until).toBe(liveLease);

    // An expired lease (crashed worker) is stolen and the recompute runs.
    const deadLease = new Date(Date.now() - 1000).toISOString();
    await env.DB.prepare(
      "UPDATE task_scores SET revalidating_until = ? WHERE task_id = ?"
    )
      .bind(deadLease, t.taskIdNum)
      .run();

    await revalidateTaskScores(env, t.taskIdNum);
    row = await getRow(t.taskIdNum);
    expect(row.computed_rev).toBe(row.inputs_rev);
    expect(row.revalidating_until).toBe("");
  });

  test("a redundant revalidation of a fresh row neither recomputes nor holds the lease", async () => {
    const t = await seedScoredTask();
    const before = await getRow(t.taskIdNum);

    await revalidateTaskScores(env, t.taskIdNum);

    const after = await getRow(t.taskIdNum);
    expect(after.computed_at).toBe(before.computed_at);
    expect(after.response_json).toBe(before.response_json);
    expect(after.revalidating_until).toBe("");
  });

  test("a result computed from superseded inputs is stored but never recorded as fresh", async () => {
    const t = await seedScoredTask();
    const before = await getRow(t.taskIdNum);

    // A mutation lands while our compute is in flight: the writer captured
    // rev = inputs_rev, then inputs moved on by two.
    const capturedRev = before.inputs_rev;
    await bumpScoreInputs(env.DB, [t.taskIdNum]);
    await bumpScoreInputs(env.DB, [t.taskIdNum]);

    await computeAndStoreTaskScore(env, t.taskIdNum, capturedRev);
    const row = await getRow(t.taskIdNum);
    // The (newer than before) blob landed, but the row stays stale — the
    // next trigger converges it. Freshness is derived from the two revs, so
    // there is no flag a racing writer could set wrongly.
    expect(row.computed_rev).toBe(capturedRev);
    expect(row.computed_rev).toBeLessThan(row.inputs_rev);

    const res = await request("GET", t.scorePath);
    expect(res.headers.get("X-Cache")).toBe("HIT-STALE");
    await getFresh(t.scorePath); // drain the revalidation that read scheduled
  });

  test("an out-of-order older writer cannot regress a newer stored result", async () => {
    const t = await seedScoredTask();
    // Move the row forward a few revisions, fresh at rev 3.
    await bumpScoreInputs(env.DB, [t.taskIdNum]);
    await bumpScoreInputs(env.DB, [t.taskIdNum]);
    await bumpScoreInputs(env.DB, [t.taskIdNum]);
    await revalidateTaskScores(env, t.taskIdNum);
    const fresh = await getRow(t.taskIdNum);
    expect(fresh.computed_rev).toBe(3);

    // A zombie writer that captured rev 0 (its lease expired mid-compute and
    // someone else already finished) must not overwrite the newer blob.
    await computeAndStoreTaskScore(env, t.taskIdNum, 0);

    const row = await getRow(t.taskIdNum);
    expect(row.computed_rev).toBe(fresh.computed_rev);
    expect(row.response_json).toBe(fresh.response_json);
    expect(row.computed_at).toBe(fresh.computed_at);
  });
});

describe("comp scores aggregation", () => {
  test("aggregates stored rows; reports oldest computed_at and any-stale; 304s on the comp ETag", async () => {
    const t = await seedScoredTask(2);

    const res1 = await request("GET", t.compScoresPath);
    expect(res1.status).toBe(200);
    expect(res1.headers.get("X-Cache")).toBe("HIT");
    const comp1 = (await res1.json()) as ServedCompScores;
    expect(comp1.stale).toBe(false);
    expect(comp1.computed_at).toBe((await getRow(t.taskIdNum)).computed_at);
    expect(comp1.standings[0].pilots).toHaveLength(2);
    const etag = res1.headers.get("ETag")!;

    // Unchanged comp: conditional request transfers nothing.
    const conditional = await conditionalGet(t.compScoresPath, etag);
    expect(conditional.status).toBe(304);

    // Mark the task stale — the comp response reports it transactionally
    // while still serving the stored standings. The ETag folds the staleness
    // label in, so the stale-labelled body has its own identity; a poll
    // carrying it keeps 304ing until the re-score lands.
    await bumpScoreInputs(env.DB, [t.taskIdNum]);
    const res2 = await request("GET", t.compScoresPath);
    expect(res2.headers.get("X-Cache")).toBe("HIT-STALE");
    const comp2 = (await res2.json()) as ServedCompScores;
    expect(comp2.stale).toBe(true);
    const staleEtag = res2.headers.get("ETag")!;
    expect(staleEtag).not.toBe(etag);
    expect(staleEtag).toContain(":stale");

    // Still re-scoring → the stale ETag matches → 304.
    const midPoll = await conditionalGet(t.compScoresPath, staleEtag);
    expect([304, 200]).toContain(midPoll.status); // 200 if the re-score won the race

    // Once fresh again (no-op bump → identical scores), the identity returns
    // to the original fresh ETag: the stale poll now 200s, the fresh one 304s.
    await getFresh(t.scorePath);
    const afterHeal = await conditionalGet(t.compScoresPath, staleEtag);
    expect(afterHeal.status).toBe(200);
    expect(afterHeal.headers.get("ETag")).toBe(etag);
  });

  test("a comp with no scoreable tasks reports computed_at: null", async () => {
    const now = "2026-01-01T00:00:00Z";
    const comp = await env.DB.prepare(
      `INSERT INTO comp (name, creation_date, category) VALUES ('Empty Comp', ?, 'hg')`
    )
      .bind(now)
      .run();
    const compId = encodeId(env.SQIDS_ALPHABET, comp.meta.last_row_id);

    const res = await request("GET", `/api/comp/${compId}/scores`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as ServedCompScores;
    expect(data.computed_at).toBeNull();
    expect(data.stale).toBe(false);
    expect(data.standings).toEqual([]);
  });

  test("a team edit changes the comp ETag and the served teams without any recompute", async () => {
    const t = await seedScoredTask();

    const res1 = await request("GET", t.compScoresPath);
    const etag1 = res1.headers.get("ETag")!;
    const rowBefore = await getRow(t.taskIdNum);

    // Assign a team directly (roster metadata — not a scoring input; the
    // PATCH route for it deliberately doesn't bump).
    await env.DB.prepare(
      "UPDATE comp_pilot SET team_name = 'Team Thermal' WHERE comp_id = ?"
    )
      .bind(t.compIdNum)
      .run();

    const res2 = await request("GET", t.compScoresPath);
    expect(res2.headers.get("ETag")).not.toBe(etag1);
    expect(res2.headers.get("X-Cache")).toBe("HIT");
    const comp2 = (await res2.json()) as ServedCompScores & {
      standings: Array<{ pilots: Array<{ team_name: string | null }> }>;
    };
    expect(comp2.standings[0].pilots[0].team_name).toBe("Team Thermal");
    expect(comp2.stale).toBe(false);

    // No recompute happened: the task's stored blob is untouched.
    const rowAfter = await getRow(t.taskIdNum);
    expect(rowAfter.computed_at).toBe(rowBefore.computed_at);
  });
});

describe("mutation hooks mark scores stale (via routes)", () => {
  test("a pilot rename re-scores the tasks holding their tracks", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId, {
      xctsk: JSON.parse(env.SAMPLE_TASK_XCTSK),
      pilot_classes: ["open"],
    });
    const upload = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      await compressText(sampleIgcEntries()[0][1]),
      { user: "user-1" }
    );
    expect(upload.status).toBe(201);
    const scorePath = `/api/comp/${compId}/task/${taskId}/score`;
    const { data: before } = await getFresh(scorePath);
    const originalName = before.classes[0].pilots[0].pilot_name;

    const pilots = await request("GET", `/api/comp/${compId}/pilot`);
    const pilotList = (await pilots.json()) as {
      pilots: Array<{ comp_pilot_id: string }>;
    };
    const patch = await authRequest(
      "PATCH",
      `/api/comp/${compId}/pilot/${pilotList.pilots[0].comp_pilot_id}`,
      { registered_pilot_name: "Renamed Pilot" }
    );
    expect(patch.status).toBe(200);

    const { data: after } = await getFresh(scorePath);
    expect(after.classes[0].pilots[0].pilot_name).toBe("Renamed Pilot");
    expect(after.classes[0].pilots[0].pilot_name).not.toBe(originalName);
  });

  test("deleting a track re-scores the task", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId, {
      xctsk: JSON.parse(env.SAMPLE_TASK_XCTSK),
      pilot_classes: ["open"],
    });
    const entries = sampleIgcEntries();
    for (const [i, user] of ["user-1", "user-2"].entries()) {
      const res = await uploadRequest(
        `/api/comp/${compId}/task/${taskId}/igc`,
        await compressText(entries[i][1]),
        { user }
      );
      expect(res.status).toBe(201);
    }
    const scorePath = `/api/comp/${compId}/task/${taskId}/score`;
    const { data: before } = await getFresh(scorePath);
    expect(before.classes[0].pilots).toHaveLength(2);

    const tracks = await request("GET", `/api/comp/${compId}/task/${taskId}/igc`);
    const trackList = (await tracks.json()) as {
      tracks: Array<{ comp_pilot_id: string }>;
    };
    const del = await authRequest(
      "DELETE",
      `/api/comp/${compId}/task/${taskId}/igc/${trackList.tracks[0].comp_pilot_id}`
    );
    expect(del.status).toBe(200);

    const { data: after } = await getFresh(scorePath);
    expect(after.classes[0].pilots).toHaveLength(1);
  });
});

describe("FTV series scoring (S7F §15)", () => {
  interface ServedFtvScores extends ServedCompScores {
    series_scoring: "total" | "ftv";
    ftv_factor?: number;
    standings: Array<{
      pilot_class: string;
      pilots: Array<{
        pilot_name: string;
        total_score: number;
        calculated_ftv?: number;
        tasks: Array<{
          task_id: string;
          score: number;
          ftv_status?: "full" | "partial" | "discarded";
          ftv_counted_score?: number;
          validity?: number;
        }>;
      }>;
    }>;
  }

  /** Seed a 2-task GAP comp with 3 pilots flying both tasks (rotated tracks so
   *  each pilot's two day scores differ). Direct writes; scores cold-compute on
   *  read. Returns the comp handle. */
  async function seedTwoTaskComp(): Promise<{
    compIdNum: number;
    compScoresPath: string;
  }> {
    const now = "2026-01-01T00:00:00Z";
    const comp = await env.DB.prepare(
      `INSERT INTO comp (name, creation_date, category, scoring_format)
       VALUES ('FTV Comp', ?, 'pg', 'gap')`
    )
      .bind(now)
      .run();
    const compIdNum = comp.meta.last_row_id;
    const entries = sampleIgcEntries().slice(0, 3);

    // Three pilots, registered once for the comp.
    const pilotIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const cp = await env.DB.prepare(
        `INSERT INTO comp_pilot (comp_id, registered_pilot_name, pilot_class)
         VALUES (?, ?, 'open')`
      )
        .bind(compIdNum, `FTV Pilot ${i + 1}`)
        .run();
      pilotIds.push(cp.meta.last_row_id);
    }

    for (let taskNo = 0; taskNo < 2; taskNo++) {
      const task = await env.DB.prepare(
        `INSERT INTO task (comp_id, name, task_date, creation_date, xctsk)
         VALUES (?, ?, ?, ?, ?)`
      )
        .bind(compIdNum, `Task ${taskNo + 1}`, `2026-01-1${taskNo + 5}`, now, env.SAMPLE_TASK_XCTSK)
        .run();
      const taskIdNum = task.meta.last_row_id;
      await env.DB.prepare(
        `INSERT INTO task_class (task_id, pilot_class) VALUES (?, 'open')`
      )
        .bind(taskIdNum)
        .run();
      for (let i = 0; i < 3; i++) {
        // Rotate which track each pilot flies per task so day scores differ.
        const [, content] = entries[(i + taskNo) % 3];
        const r2Key = `c/${compIdNum}/t/${taskIdNum}/${pilotIds[i]}.igc`;
        const gz = await compressText(content);
        await env.R2.put(r2Key, gz);
        await env.DB.prepare(
          `INSERT INTO task_track (task_id, comp_pilot_id, igc_filename, uploaded_at, file_size)
           VALUES (?, ?, ?, ?, ?)`
        )
          .bind(taskIdNum, pilotIds[i], r2Key, now, gz.byteLength)
          .run();
      }
    }

    return {
      compIdNum,
      compScoresPath: `/api/comp/${encodeId(env.SQIDS_ALPHABET, compIdNum)}/scores`,
    };
  }

  test("FTV discards weakest results; total ≤ sum; setting folds into the ETag", async () => {
    const t = await seedTwoTaskComp();

    // Baseline: sum-of-tasks.
    const sumRes = await request("GET", t.compScoresPath);
    expect(sumRes.status).toBe(200);
    const sum = (await sumRes.json()) as ServedFtvScores;
    expect(sum.series_scoring).toBe("total");
    const sumByPilot = new Map(
      sum.standings[0].pilots.map((p) => [p.pilot_name, p.total_score])
    );
    const etagTotal = sumRes.headers.get("ETag")!;

    // Switch to FTV — a pure aggregation change, no per-task recompute.
    await env.DB.prepare("UPDATE comp SET series_scoring='ftv' WHERE comp_id=?")
      .bind(t.compIdNum)
      .run();

    const ftvRes = await request("GET", t.compScoresPath);
    const ftv = (await ftvRes.json()) as ServedFtvScores;
    expect(ftv.series_scoring).toBe("ftv");
    expect(ftv.ftv_factor).toBe(0.2); // 2 tasks → ≤6 → 0.2
    // The series-scoring setting is folded into the comp ETag.
    expect(ftvRes.headers.get("ETag")).not.toBe(etagTotal);

    for (const p of ftv.standings[0].pilots) {
      // FTV can only drop points, never add them.
      expect(p.total_score).toBeLessThanOrEqual(sumByPilot.get(p.pilot_name)! + 1e-6);
      expect(typeof p.calculated_ftv).toBe("number");
      // Every task carries an FTV status; at least one counted.
      for (const task of p.tasks) {
        expect(["full", "partial", "discarded"]).toContain(task.ftv_status);
      }
      expect(
        p.tasks.some((task) => task.ftv_status !== "discarded")
      ).toBe(true);
    }
  });

  test("a single-task FTV comp falls back to the plain total", async () => {
    const t = await seedScoredTask(2);
    await env.DB.prepare("UPDATE comp SET scoring_format='gap', series_scoring='ftv' WHERE comp_id=?")
      .bind(t.compIdNum)
      .run();
    const res = await request("GET", t.compScoresPath);
    const data = (await res.json()) as ServedFtvScores;
    // One task can't discard anything → reported as plain total.
    expect(data.series_scoring).toBe("total");
    expect(data.standings[0].pilots[0].tasks[0].ftv_status).toBeUndefined();
  });
});
