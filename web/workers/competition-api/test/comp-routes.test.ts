import { env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";
import { defaultsFor } from "@glidecomp/engine";
import {
  request,
  authRequest,
  createComp,
  createTask,
  clearCompData,
} from "./helpers";
import { decodeId, encodeId } from "../src/sqids";

const ALPHABET = env.SQIDS_ALPHABET;

/**
 * Comp-level audit sentences, oldest first. Pass the id from {@link lastAuditId}
 * to read only what a particular request wrote — creating the comp and its
 * first task both log lines of their own.
 */
async function compAuditLines(afterId = 0): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT description FROM audit_log
     WHERE subject_type = 'comp' AND audit_id > ? ORDER BY audit_id`
  )
    .bind(afterId)
    .all();
  return rows.results.map((r) => r.description as string);
}

/** The high-water mark of the audit log — the "before" of an audit assertion. */
async function lastAuditId(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT MAX(audit_id) AS id FROM audit_log"
  ).first<{ id: number | null }>();
  return row?.id ?? 0;
}

/** A task's score-input revision — the counter a scoring mutation bumps. */
async function inputsRev(taskId: number): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT inputs_rev FROM task_scores WHERE task_id = ?"
  )
    .bind(taskId)
    .first<{ inputs_rev: number }>();
  return row?.inputs_rev ?? null;
}

beforeEach(async () => {
  await clearCompData();
});

// ── POST /api/comp ──────────────────────────────────────────────────────────

describe("POST /api/comp", () => {
  test("creates a competition and returns encoded ID", async () => {
    const res = await authRequest("POST", "/api/comp", {
      name: "Bells 2026",
      category: "hg",
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.name).toBe("Bells 2026");
    expect(data.category).toBe("hg");
    expect(typeof data.comp_id).toBe("string");
    expect((data.comp_id as string).length).toBeGreaterThanOrEqual(4);
    expect(data.pilot_classes).toEqual(["open"]);
    expect(data.default_pilot_class).toBe("open");

    // Verify in D1 directly
    const row = await env.DB.prepare("SELECT * FROM comp").first();
    expect(row!.name).toBe("Bells 2026");
  });

  test("creates with custom pilot classes", async () => {
    const res = await authRequest("POST", "/api/comp", {
      name: "PG Open",
      category: "pg",
      pilot_classes: ["open", "sport", "floater"],
      default_pilot_class: "sport",
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.pilot_classes).toEqual(["open", "sport", "floater"]);
    expect(data.default_pilot_class).toBe("sport");
  });

  test("creates with GAP parameters, stripping legacy pre-2026 keys", async () => {
    const gapParams = {
      // Legacy keys from pre-2026 editions — accepted but stripped, since
      // the S7F 2026 edition fixes their values.
      nominalLaunch: 0.96,
      nominalGoal: 0.2,
      // Live 2026-surface keys.
      nominalDistance: 70000,
      nominalTime: 5400,
      minimumDistance: 5000,
      scoring: "HG",
      useLeading: true,
      useArrival: true,
    };
    const res = await authRequest("POST", "/api/comp", {
      name: "GAP Comp",
      category: "hg",
      gap_params: gapParams,
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    const { nominalLaunch: _nl, nominalGoal: _ng, ...kept } = gapParams;
    expect(data.gap_params).toEqual(kept);
  });

  test("caller becomes first admin", async () => {
    const compId = await createComp();

    const row = await env.DB.prepare(
      "SELECT user_id FROM comp_admin"
    ).first();
    expect(row!.user_id).toBe("user-1");
  });

  test("rejects if default_pilot_class not in pilot_classes", async () => {
    const res = await authRequest("POST", "/api/comp", {
      name: "Bad Comp",
      category: "hg",
      pilot_classes: ["open"],
      default_pilot_class: "novice",
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("default_pilot_class");
  });

  test("rejects unauthenticated requests", async () => {
    const res = await request("POST", "/api/comp", {
      body: { name: "No Auth", category: "hg" },
    });
    expect(res.status).toBe(401);
  });

  test("validates name is required", async () => {
    const res = await authRequest("POST", "/api/comp", { category: "hg" });
    expect(res.status).toBe(400);
  });

  test("validates category enum", async () => {
    const res = await authRequest("POST", "/api/comp", {
      name: "Bad Cat",
      category: "invalid",
    });
    expect(res.status).toBe(400);
  });

  test("rejects name exceeding 128 chars", async () => {
    const res = await authRequest("POST", "/api/comp", {
      name: "x".repeat(200),
      category: "hg",
    });
    expect(res.status).toBe(400);
  });

  test("rejects duplicate pilot classes", async () => {
    const res = await authRequest("POST", "/api/comp", {
      name: "Dup Classes",
      category: "hg",
      pilot_classes: ["open", "open"],
    });
    expect(res.status).toBe(400);
  });

  test("validation failures return a readable string error, not a ZodError object", async () => {
    const res = await authRequest("POST", "/api/comp", {
      name: "Bad Zone",
      category: "hg",
      timezone: "Mars/OlympusMons",
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: unknown };
    expect(typeof data.error).toBe("string");
    expect(data.error).toContain("timezone");
    expect(data.error).toContain("valid timezone");
  });

  test("string error names the offending field on nested paths", async () => {
    const comp = await authRequest("POST", "/api/comp", {
      name: "Email Comp",
      category: "hg",
    });
    const { comp_id } = (await comp.json()) as { comp_id: string };
    const res = await authRequest("PATCH", `/api/comp/${comp_id}`, {
      admin_emails: ["admin@example.com", "not-an-email"],
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: unknown };
    expect(typeof data.error).toBe("string");
    expect(data.error).toBe("admin_emails.1: Invalid email");
  });
});

// ── GET /api/comp ───────────────────────────────────────────────────────────

describe("GET /api/comp", () => {
  test("returns empty list when no comps exist", async () => {
    const res = await authRequest("GET", "/api/comp");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { comps: unknown[] };
    expect(data.comps).toEqual([]);
  });

  test("returns admin comps for authenticated user", async () => {
    await createComp({ name: "My Comp" });

    const res = await authRequest("GET", "/api/comp");
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      comps: Array<{ name: string; is_admin: boolean }>;
    };
    expect(data.comps.length).toBe(1);
    expect(data.comps[0].name).toBe("My Comp");
    expect(data.comps[0].is_admin).toBe(true);
  });

  test("returns public (non-test) comps for anonymous users", async () => {
    await createComp({ name: "Public Comp" });

    const res = await request("GET", "/api/comp");
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      comps: Array<{ name: string; is_admin: boolean }>;
    };
    expect(data.comps.length).toBe(1);
    expect(data.comps[0].name).toBe("Public Comp");
    expect(data.comps[0].is_admin).toBe(false);
  });

  test("hides test comps from anonymous users", async () => {
    await createComp({ name: "Secret", test: true });

    const res = await request("GET", "/api/comp");
    const data = (await res.json()) as { comps: unknown[] };
    expect(data.comps.length).toBe(0);
  });

  test("shows test comps to their admin", async () => {
    await createComp({ name: "Secret", test: true });

    const res = await authRequest("GET", "/api/comp");
    const data = (await res.json()) as {
      comps: Array<{ name: string; test: boolean }>;
    };
    expect(data.comps.length).toBe(1);
    expect(data.comps[0].test).toBe(true);
  });

  test("sorts by most recent event first, creation date for task-less comps", async () => {
    // Created oldest-event-last so creation order and event order disagree.
    const recentId = await createComp({ name: "Recent Event" });
    await createTask(recentId, { task_date: "2026-06-01" });
    const noTasksId = await createComp({ name: "No Tasks" });
    const oldId = await createComp({ name: "Old Event" });
    await createTask(oldId, { task_date: "2020-05-10" });

    const res = await authRequest("GET", "/api/comp");
    const data = (await res.json()) as { comps: Array<{ name: string }> };
    // "No Tasks" falls back to its creation timestamp (today), which
    // outranks both events' task dates.
    expect(data.comps.map((c) => c.name)).toEqual([
      "No Tasks",
      "Recent Event",
      "Old Event",
    ]);
  });
});

// ── GET /api/comp/:comp_id ──────────────────────────────────────────────────

describe("GET /api/comp/:comp_id", () => {
  test("returns comp details with tasks, admins, pilot count", async () => {
    const compId = await createComp({ name: "Detail Comp", category: "pg" });

    const res = await authRequest("GET", `/api/comp/${compId}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.name).toBe("Detail Comp");
    expect(data.comp_id).toBe(compId);
    expect(Array.isArray(data.admins)).toBe(true);
    expect(
      (data.admins as Array<{ email: string }>)[0].email
    ).toBe("pilot@test.com");
    expect(Array.isArray(data.tasks)).toBe(true);
    expect(data.pilot_count).toBe(0);
    expect(Array.isArray(data.class_coverage_warnings)).toBe(true);
  });

  test("returns 404 for non-existent comp", async () => {
    const fakeId = encodeId(ALPHABET, 99999);
    const res = await authRequest("GET", `/api/comp/${fakeId}`);
    expect(res.status).toBe(404);
  });

  test("returns 400 for invalid sqid", async () => {
    const res = await authRequest("GET", "/api/comp/!!!!");
    expect(res.status).toBe(400);
  });

  test("hides test comp from non-admin", async () => {
    const compId = await createComp({ name: "Secret", test: true });

    // user-2 is not an admin
    const res = await request("GET", `/api/comp/${compId}`, {
      user: "user-2",
    });
    expect(res.status).toBe(404);
  });

  test("shows test comp to its admin", async () => {
    const compId = await createComp({ name: "Secret", test: true });

    const res = await authRequest("GET", `/api/comp/${compId}`);
    expect(res.status).toBe(200);
  });

  test("allows anonymous access to non-test comp", async () => {
    const compId = await createComp({ name: "Public" });

    const res = await request("GET", `/api/comp/${compId}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { name: string };
    expect(data.name).toBe("Public");
  });

  test("flags GAP tasks defined without SSS/ESS turnpoint types", async () => {
    const compId = await createComp({ name: "Fallback Comp" });
    const taskId = await createTask(compId);

    // A realistic mis-set task: turnpoints exist but nobody marked SSS/ESS
    await authRequest("PATCH", `/api/comp/${compId}/task/${taskId}`, {
      xctsk: {
        taskType: "CLASSIC",
        version: 1,
        turnpoints: [
          { type: "TAKEOFF", radius: 400, waypoint: { name: "Launch", lat: -37.0, lon: 144.0 } },
          { radius: 400, waypoint: { name: "TP1", lat: -37.1, lon: 144.1 } },
          { radius: 400, waypoint: { name: "Goal", lat: -37.2, lon: 144.2 } },
        ],
      },
    });

    const res = await authRequest("GET", `/api/comp/${compId}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      tasks: Array<{ missing_sss: boolean; missing_ess: boolean }>;
    };
    expect(data.tasks[0].missing_sss).toBe(true);
    expect(data.tasks[0].missing_ess).toBe(true);
  });

  test("no speed-section flags when SSS/ESS are typed or no task is defined", async () => {
    const compId = await createComp({ name: "Well Set Comp" });
    const typedTaskId = await createTask(compId, { name: "Typed" });
    await createTask(compId, { name: "Empty" });

    await authRequest("PATCH", `/api/comp/${compId}/task/${typedTaskId}`, {
      xctsk: {
        taskType: "CLASSIC",
        version: 1,
        turnpoints: [
          { type: "SSS", radius: 1000, waypoint: { name: "Start", lat: -37.0, lon: 144.0 } },
          { type: "ESS", radius: 400, waypoint: { name: "Goal", lat: -37.1, lon: 144.1 } },
        ],
      },
    });

    const res = await authRequest("GET", `/api/comp/${compId}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      tasks: Array<{ name: string; missing_sss: boolean; missing_ess: boolean; line_goal: boolean }>;
    };
    for (const task of data.tasks) {
      expect(task.missing_sss).toBe(false);
      expect(task.missing_ess).toBe(false);
      expect(task.line_goal).toBe(false);
    }
  });

  test("returns setup-guide signals: waypoint_count and settings_reviewed", async () => {
    const compId = await createComp();

    // Fresh comp: no waypoints, settings never saved.
    let res = await authRequest("GET", `/api/comp/${compId}`);
    let data = (await res.json()) as {
      waypoint_count: number;
      settings_reviewed: boolean;
    };
    expect(data.waypoint_count).toBe(0);
    expect(data.settings_reviewed).toBe(false);

    await authRequest("PUT", `/api/comp/${compId}/waypoints`, {
      waypoints: [
        { code: "A01", name: "Launch", latitude: -36.5, longitude: 147.0, altitude: 500, radius: 400 },
        { code: "A02", name: "Goal", latitude: -36.6, longitude: 147.1, altitude: 200, radius: 1000 },
      ],
    });

    res = await authRequest("GET", `/api/comp/${compId}`);
    data = (await res.json()) as typeof data;
    expect(data.waypoint_count).toBe(2);
  });

  test("flags a task with a LINE goal (informational badge)", async () => {
    const compId = await createComp({ name: "Line Goal Comp" });
    const taskId = await createTask(compId);

    await authRequest("PATCH", `/api/comp/${compId}/task/${taskId}`, {
      xctsk: {
        taskType: "CLASSIC",
        version: 1,
        turnpoints: [
          { type: "SSS", radius: 1000, waypoint: { name: "Start", lat: -37.0, lon: 144.0 } },
          { type: "ESS", radius: 400, waypoint: { name: "Goal", lat: -37.1, lon: 144.1 } },
        ],
        goal: { type: "LINE" },
      },
    });

    const res = await authRequest("GET", `/api/comp/${compId}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      tasks: Array<{ line_goal: boolean }>;
    };
    expect(data.tasks[0].line_goal).toBe(true);
  });
});

// ── PATCH /api/comp/:comp_id ────────────────────────────────────────────────

describe("PATCH /api/comp/:comp_id", () => {
  test("updates comp name", async () => {
    const compId = await createComp({ name: "Original" });

    const res = await authRequest("PATCH", `/api/comp/${compId}`, {
      name: "Updated",
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { name: string };
    expect(data.name).toBe("Updated");

    // Verify in D1
    const row = await env.DB.prepare("SELECT name FROM comp").first();
    expect(row!.name).toBe("Updated");
  });

  test("any settings save flips settings_reviewed (setup guide)", async () => {
    const compId = await createComp();

    // Even a PATCH that changes nothing counts as a review.
    const res = await authRequest("PATCH", `/api/comp/${compId}`, {});
    expect(res.status).toBe(200);

    const detail = (await (
      await authRequest("GET", `/api/comp/${compId}`)
    ).json()) as { settings_reviewed: boolean };
    expect(detail.settings_reviewed).toBe(true);
  });

  test("updates category", async () => {
    const compId = await createComp({ category: "hg" });

    const res = await authRequest("PATCH", `/api/comp/${compId}`, {
      category: "pg",
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { category: string };
    expect(data.category).toBe("pg");
  });

  test("updates pilot classes", async () => {
    const compId = await createComp();

    const res = await authRequest("PATCH", `/api/comp/${compId}`, {
      pilot_classes: ["open", "sport"],
      default_pilot_class: "sport",
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      pilot_classes: string[];
      default_pilot_class: string;
    };
    expect(data.pilot_classes).toEqual(["open", "sport"]);
    expect(data.default_pilot_class).toBe("sport");
  });

  test("rejects non-admin updates", async () => {
    const compId = await createComp();

    const res = await request("PATCH", `/api/comp/${compId}`, {
      body: { name: "Hacked" },
      user: "user-2",
    });
    expect(res.status).toBe(403);
  });

  test("rejects unauthenticated updates", async () => {
    const compId = await createComp();

    const res = await request("PATCH", `/api/comp/${compId}`, {
      body: { name: "Hacked" },
    });
    expect(res.status).toBe(401);
  });

  test("updates admin list via emails", async () => {
    const compId = await createComp();

    const res = await authRequest("PATCH", `/api/comp/${compId}`, {
      admin_emails: ["pilot@test.com", "admin2@test.com"],
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      admins: Array<{ email: string }>;
    };
    expect(data.admins.length).toBe(2);
    const emails = data.admins.map((a) => a.email).sort();
    expect(emails).toEqual(["admin2@test.com", "pilot@test.com"]);

    // Verify in D1
    const rows = await env.DB.prepare(
      "SELECT user_id FROM comp_admin ORDER BY user_id"
    ).all();
    expect(rows.results.length).toBe(2);
  });

  test("rejects admin_emails with no registered users", async () => {
    const compId = await createComp();

    const res = await authRequest("PATCH", `/api/comp/${compId}`, {
      admin_emails: ["nobody@test.com"],
    });
    expect(res.status).toBe(500); // updateAdmins throws
  });

  test("rejects inconsistent default_pilot_class", async () => {
    const compId = await createComp({
      pilot_classes: ["open", "sport"],
      default_pilot_class: "open",
    });

    const res = await authRequest("PATCH", `/api/comp/${compId}`, {
      default_pilot_class: "floater",
    });
    expect(res.status).toBe(400);
  });

  test("updates GAP parameters, allowing omitted nominalDistance", async () => {
    const compId = await createComp({ category: "pg" });

    const gapParams = {
      // nominalDistance omitted → scorer auto-computes per task
      nominalTime: 5400,
      minimumDistance: 4000,
      scoring: "PG",
      useLeading: true,
      useArrival: false,
    };
    const res = await authRequest("PATCH", `/api/comp/${compId}`, {
      gap_params: gapParams,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { gap_params: Record<string, unknown> };
    expect(data.gap_params).toEqual(gapParams);
    expect(data.gap_params.nominalDistance).toBeUndefined();
  });

  test("writes specific audit lines for GAP parameter changes", async () => {
    const compId = await createComp({ category: "hg" });
    const before = await lastAuditId();

    const res = await authRequest("PATCH", `/api/comp/${compId}`, {
      gap_params: {
        nominalLaunch: 0.96,
        nominalGoal: 0.2,
        nominalTime: 6000,
        minimumDistance: 5000,
        scoring: "HG",
        useLeading: true,
        useArrival: true,
        distanceOrigin: "start",
        useDistanceDifficulty: false,
      },
    });
    expect(res.status).toBe(200);

    const descriptions = await compAuditLines(before);
    expect(descriptions).toContain("Disabled HG distance difficulty (pure linear distance points)");
    expect(descriptions).toContain("Changed nominal time from 90 min to 100 min");
    expect(descriptions).toContain('Changed distance origin from "takeoff" to "start"');
    // Leading and arrival were ALREADY on — they are the official HG defaults
    // this comp was being scored with, even though its gap_params was null.
    // Saying otherwise is issue #633.
    expect(descriptions).not.toContain("Enabled leading (departure) points");
    expect(descriptions).not.toContain("Enabled arrival points");
    // No generic catch-all line
    expect(descriptions).not.toContain("Updated GAP scoring parameters");
  });

  // ── The first settings save on an untouched comp (issue #633) ────────────
  //
  // Until somebody saves settings once, a comp's gap_params is null and the
  // scorer resolves it through the official per-category defaults. The audit
  // description used to resolve it through the raw engine baseline instead,
  // where leading/arrival/difficulty are OFF — so the first save announced
  // changes nobody made and rescored every task to identical numbers.

  /**
   * What the Settings dialog sends for a comp that has never saved: the
   * effective values it displays, which are the defaults the scorer is
   * already using. Nominal distance stays "auto" (null).
   */
  function untouchedSettings(category: "hg" | "pg") {
    const d = defaultsFor(category);
    return {
      scoring: d.scoring,
      nominalDistance: null,
      nominalTime: d.nominalTime,
      minimumDistance: d.minimumDistance,
      useLeading: d.useLeading,
      useArrival: d.useArrival,
      leadingTimeRatio: d.leadingTimeRatio,
      distanceOrigin: d.distanceOrigin,
      useDistanceDifficulty: d.useDistanceDifficulty,
      jumpTheGunFactor: d.jumpTheGunFactor,
      jumpTheGunMaxSeconds: d.jumpTheGunMaxSeconds,
      essNotGoalFactor: d.essNotGoalFactor,
    };
  }

  for (const category of ["hg", "pg"] as const) {
    test(`a first ${category.toUpperCase()} save that keeps the defaults writes no GAP audit lines and no score bump`, async () => {
      const compId = await createComp({ category });
      const taskId = decodeId(
        ALPHABET,
        await createTask(compId, { xctsk: JSON.parse(env.SAMPLE_TASK_XCTSK) })
      )!;
      const revBefore = await inputsRev(taskId);
      const before = await lastAuditId();

      const res = await authRequest("PATCH", `/api/comp/${compId}`, {
        gap_params: untouchedSettings(category),
      });
      expect(res.status).toBe(200);

      // The row is written (Save stays idempotent) but nothing moved.
      expect(await compAuditLines(before)).toEqual([]);
      expect(await inputsRev(taskId)).toBe(revBefore);
    });
  }

  test("an open-distance comp's first save is silent too", async () => {
    // The Settings dialog HIDES the Advanced section for an open-distance
    // comp but still submits gap_params, so an organiser who never sees a
    // GAP knob used to get the same phantom leading/arrival lines — on a
    // competition whose scores those parameters do not touch at all.
    const compId = await createComp({
      category: "hg",
      scoring_format: "open_distance",
    });
    // An open-distance task is one TAKEOFF turnpoint — the full sample route
    // is rejected by the format's own validation.
    const sample = JSON.parse(env.SAMPLE_TASK_XCTSK) as {
      turnpoints: Array<{ radius: number; waypoint: unknown }>;
    };
    const taskId = decodeId(
      ALPHABET,
      await createTask(compId, {
        xctsk: {
          taskType: "OPEN-DISTANCE",
          version: 1,
          earthModel: "WGS84",
          turnpoints: [
            { type: "TAKEOFF", radius: 400, waypoint: sample.turnpoints[0].waypoint },
          ],
        },
      })
    )!;
    const revBefore = await inputsRev(taskId);
    const before = await lastAuditId();

    const res = await authRequest("PATCH", `/api/comp/${compId}`, {
      scoring_format: "open_distance",
      gap_params: untouchedSettings("hg"),
    });
    expect(res.status).toBe(200);

    expect(await compAuditLines(before)).toEqual([]);
    expect(await inputsRev(taskId)).toBe(revBefore);
  });

  test("a save that changes only the nominal distance logs only that", async () => {
    const compId = await createComp({ category: "hg" });
    const before = await lastAuditId();

    const res = await authRequest("PATCH", `/api/comp/${compId}`, {
      gap_params: { ...untouchedSettings("hg"), nominalDistance: 60000 },
    });
    expect(res.status).toBe(200);

    expect(await compAuditLines(before)).toEqual([
      "Changed nominal distance from auto (per task) to 60 km",
    ]);
  });

  test("switching category describes the parameters that really moved", async () => {
    // A PG comp that never saved: leading on, arrival off, pure-linear
    // distance, 26% leading-time ratio. Switching to HG turns arrival and
    // difficulty on and moves the ratio — and says so, once each.
    const compId = await createComp({ category: "pg" });
    const before = await lastAuditId();

    const res = await authRequest("PATCH", `/api/comp/${compId}`, {
      category: "hg",
      gap_params: untouchedSettings("hg"),
    });
    expect(res.status).toBe(200);

    const descriptions = await compAuditLines(before);
    expect(descriptions).toContain('Changed category from "pg" to "hg"');
    expect(descriptions).toContain('Changed scoring class from "PG" to "HG"');
    expect(descriptions).toContain("Enabled arrival points");
    expect(descriptions).toContain("Enabled HG distance difficulty");
    expect(descriptions).toContain(
      'Changed leading-time ratio from "26%" to "17.5%"'
    );
    // Leading is on for both disciplines, so the switch does not touch it.
    expect(descriptions).not.toContain("Enabled leading (departure) points");
  });

  test("clearing gap_params that already held the defaults is a no-op", async () => {
    const compId = await createComp({
      category: "hg",
      gap_params: untouchedSettings("hg"),
    });
    const taskId = decodeId(
      ALPHABET,
      await createTask(compId, { xctsk: JSON.parse(env.SAMPLE_TASK_XCTSK) })
    )!;
    const revBefore = await inputsRev(taskId);
    const before = await lastAuditId();

    const res = await authRequest("PATCH", `/api/comp/${compId}`, {
      gap_params: null,
    });
    expect(res.status).toBe(200);

    expect(await compAuditLines(before)).toEqual([]);
    expect(await inputsRev(taskId)).toBe(revBefore);
  });

  test("clearing gap_params that held an override is one reset line", async () => {
    const compId = await createComp({
      category: "hg",
      gap_params: { ...untouchedSettings("hg"), useArrival: false },
    });
    const before = await lastAuditId();

    const res = await authRequest("PATCH", `/api/comp/${compId}`, {
      gap_params: null,
    });
    expect(res.status).toBe(200);

    expect(await compAuditLines(before)).toEqual([
      "Reset GAP scoring parameters to defaults",
    ]);
  });
});

// ── DELETE /api/comp/:comp_id ───────────────────────────────────────────────

describe("DELETE /api/comp/:comp_id", () => {
  test("deletes a comp and cascades", async () => {
    const compId = await createComp({ name: "Doomed" });

    const res = await authRequest("DELETE", `/api/comp/${compId}`);
    expect(res.status).toBe(200);

    // Verify comp is gone
    const getRes = await authRequest("GET", `/api/comp/${compId}`);
    expect(getRes.status).toBe(404);

    // Verify in D1 directly
    const row = await env.DB.prepare("SELECT COUNT(*) as cnt FROM comp").first<{ cnt: number }>();
    expect(row!.cnt).toBe(0);

    // Verify admin rows cascaded
    const adminRow = await env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM comp_admin"
    ).first<{ cnt: number }>();
    expect(adminRow!.cnt).toBe(0);
  });

  test("rejects unauthenticated delete", async () => {
    const compId = await createComp();

    const res = await request("DELETE", `/api/comp/${compId}`);
    expect(res.status).toBe(401);
  });

  test("rejects non-admin delete", async () => {
    const compId = await createComp();

    const res = await request("DELETE", `/api/comp/${compId}`, {
      user: "user-2",
    });
    expect(res.status).toBe(403);

    // Comp still exists
    const row = await env.DB.prepare("SELECT COUNT(*) as cnt FROM comp").first<{ cnt: number }>();
    expect(row!.cnt).toBe(1);
  });
});

// ── Comp timezone setting (#269 / #274) ─────────────────────────────────────

describe("Comp timezone setting", () => {
  const corryongTask = {
    taskType: "CLASSIC",
    version: 1,
    turnpoints: [
      {
        type: "TAKEOFF",
        radius: 400,
        waypoint: { name: "Launch", lat: -36.195, lon: 147.9 },
      },
    ],
  };

  test("defaults to null on create and round-trips an explicit value", async () => {
    const res = await authRequest("POST", "/api/comp", {
      name: "TZ Comp",
      category: "hg",
    });
    const data = (await res.json()) as { timezone: unknown };
    expect(data.timezone).toBeNull();

    const res2 = await authRequest("POST", "/api/comp", {
      name: "TZ Comp 2",
      category: "hg",
      timezone: "Australia/Melbourne",
    });
    const data2 = (await res2.json()) as { timezone: unknown };
    expect(data2.timezone).toBe("Australia/Melbourne");
  });

  test("rejects a garbage timezone", async () => {
    const res = await authRequest("POST", "/api/comp", {
      name: "Bad TZ",
      category: "hg",
      timezone: "Not/AZone",
    });
    expect(res.status).toBe(400);

    const compId = await createComp();
    const patch = await authRequest("PATCH", `/api/comp/${compId}`, {
      timezone: "gibberish",
    });
    expect(patch.status).toBe(400);
  });

  test("PATCH sets the timezone and audit-logs the change", async () => {
    const compId = await createComp();

    const res = await authRequest("PATCH", `/api/comp/${compId}`, {
      timezone: "Europe/Paris",
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { timezone: unknown };
    expect(data.timezone).toBe("Europe/Paris");

    const auditRes = await request("GET", `/api/comp/${compId}/audit`, {
      user: "user-1",
    });
    const auditData = (await auditRes.json()) as {
      entries: Array<{ description: string }>;
    };
    expect(
      auditData.entries.some((e) =>
        e.description.includes('Set timezone to "Europe/Paris"')
      )
    ).toBe(true);
  });

  test("PATCH with null re-derives from the task location", async () => {
    const compId = await createComp({ timezone: "Europe/Paris" });
    await createTask(compId, { xctsk: corryongTask });

    const res = await authRequest("PATCH", `/api/comp/${compId}`, {
      timezone: null,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { timezone: unknown };
    expect(data.timezone).toBe("Australia/Melbourne");

    const auditRes = await request("GET", `/api/comp/${compId}/audit`, {
      user: "user-1",
    });
    const auditData = (await auditRes.json()) as {
      entries: Array<{ description: string }>;
    };
    expect(
      auditData.entries.some((e) =>
        e.description.includes("Reset timezone to automatic")
      )
    ).toBe(true);
  });

  test("PATCH with null clears the timezone when no task has a route", async () => {
    const compId = await createComp({ timezone: "Europe/Paris" });

    const res = await authRequest("PATCH", `/api/comp/${compId}`, {
      timezone: null,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { timezone: unknown };
    expect(data.timezone).toBeNull();
  });
});
