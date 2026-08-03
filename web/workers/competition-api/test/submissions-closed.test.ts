/**
 * Closing ONE task for submissions (migration 0028).
 *
 * The rule has to hold at four call sites in three files, and each of those
 * files is edited for unrelated reasons — so the point of this suite is that
 * forgetting one of them is red, not silent. It also pins the two deliberate
 * NON-enforcements, so a future author cannot "helpfully" gate them without a
 * failing test to argue with.
 */
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import {
  AS_NEW_PILOT,
  authRequest,
  anonUploadRequest,
  clearCompData,
  createComp,
  createTask,
  request,
  uploadRequest,
} from "./helpers";

/** A minimal gzip IGC — enough to pass the upload's shape checks. */
function fakeIgcPayload(): Uint8Array {
  return new Uint8Array([
    0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x73, 0x8c,
    0x70, 0x0e, 0x31, 0x30, 0x30, 0x0c, 0x49, 0x2d, 0x2e, 0xe1, 0xe5, 0xf2,
    0x70, 0x73, 0x09, 0x71, 0x35, 0x30, 0x34, 0x30, 0x34, 0x32, 0xe3, 0xe5,
    0x02, 0x00, 0x19, 0xac, 0x90, 0xbb, 0x1a, 0x00, 0x00, 0x00,
  ]);
}

/** A route, because a manual flight needs geometry to measure against. */
const TASK_XCTSK = {
  taskType: "CLASSIC",
  version: 1,
  earthModel: "WGS84",
  turnpoints: [
    { type: "SSS", radius: 1000, waypoint: { name: "SSS", lat: 0, lon: 0.0 } },
    { radius: 400, waypoint: { name: "TP1", lat: 0, lon: 0.1 } },
    { radius: 400, waypoint: { name: "GOAL", lat: 0, lon: 0.2 } },
  ],
  sss: { type: "RACE", direction: "EXIT" },
  goal: { type: "CYLINDER" },
};

const PILOT_EMAIL = "bystander@test.local";

interface Fixture {
  compId: string;
  taskId: string;
  /** A roster row for user-2, who is NOT a comp admin. */
  compPilotId: string;
}

/**
 * A comp owned by user-1 (its admin) with user-2 on the roster as a plain
 * pilot, so both sides of the admin bypass can be exercised.
 */
async function fixture(): Promise<Fixture> {
  const compId = await createComp();
  const taskId = await createTask(compId, { xctsk: TASK_XCTSK });

  const res = await authRequest("POST", `/api/comp/${compId}/pilot`, {
    registered_pilot_name: "Bystander",
    pilot_class: "open",
    registered_pilot_email: PILOT_EMAIL,
  });
  const { comp_pilot_id: compPilotId } = (await res.json()) as {
    comp_pilot_id: string;
  };

  // user-2 uploads once while the task is OPEN, which puts a roster row of
  // their own in place. Without this they are not "a registered pilot in this
  // comp" and the on-behalf route would 403 for the wrong reason.
  //
  // AS_NEW_PILOT because Bystander above is an unclaimed registration, and the
  // route now refuses to guess whether user-2 is them.
  const warmUp = await uploadRequest(
    `/api/comp/${compId}/task/${taskId}/igc`,
    fakeIgcPayload(),
    { user: "user-2", headers: AS_NEW_PILOT }
  );
  expect(warmUp.status, "user-2 joins while the task is open").toBe(201);

  return { compId, taskId, compPilotId };
}

async function close(f: Fixture, closed = true): Promise<void> {
  const res = await authRequest(
    "PATCH",
    `/api/comp/${f.compId}/task/${f.taskId}`,
    { submissions_closed: closed }
  );
  expect(res.status).toBe(200);
}

beforeEach(async () => {
  await clearCompData();
});

describe("a task closed for submissions", () => {
  test("refuses a pilot's own upload, with a code and someone to ask", async () => {
    const f = await fixture();
    await close(f);

    const res = await uploadRequest(
      `/api/comp/${f.compId}/task/${f.taskId}/igc`,
      fakeIgcPayload(),
      { user: "user-2" }
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, any>;
    expect(body.code).toBe("submissions_closed");
    // Naming the task matters: a pilot at a six-day comp has to know WHICH one
    // was refused.
    expect(body.task.name).toBe("Test Task");
    // The only repair available to them is asking an organiser, so the
    // organiser has to be in the answer.
    expect(Array.isArray(body.organisers)).toBe(true);
  });

  test("refuses an upload on behalf of another pilot", async () => {
    const f = await fixture();
    await close(f);

    const res = await uploadRequest(
      `/api/comp/${f.compId}/task/${f.taskId}/igc/${f.compPilotId}`,
      fakeIgcPayload(),
      { user: "user-2" }
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as Record<string, any>).code).toBe(
      "submissions_closed"
    );
  });

  test("refuses an anonymous submission — no admin to bypass with", async () => {
    const f = await fixture();
    await close(f);

    const res = await anonUploadRequest(
      f.compId,
      f.taskId,
      fakeIgcPayload(),
      { kind: "email", value: PILOT_EMAIL }
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as Record<string, any>).code).toBe(
      "submissions_closed"
    );
  });

  test("refuses a manual flight, because that is evidence too", async () => {
    // The one most likely to be forgotten: it lives in a different file from
    // the upload routes, and leaving it open makes "closed" simply false.
    const f = await fixture();
    await close(f);

    const res = await request(
      "PUT",
      `/api/comp/${f.compId}/task/${f.taskId}/manual-flight/${f.compPilotId}`,
      {
        body: { last_reached_tp_index: 1, landing_lat: 0, landing_lon: 0.15 },
        user: "user-2",
      }
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as Record<string, any>).code).toBe(
      "submissions_closed"
    );
  });

  test("still lets the organiser upload, on both routes", async () => {
    // The stop tells pilots to stop sending files. It must not lock the
    // scorekeeper out of the recovered SD card, or it stops being used.
    const f = await fixture();
    await close(f);

    // AS_NEW_PILOT for the same reason as the fixture: the organiser is not on
    // their own roster, and Bystander is unclaimed, so the route asks rather
    // than guesses. Being an admin bypasses the CLOSED task, not the identity
    // question — those are deliberately separate.
    const own = await uploadRequest(
      `/api/comp/${f.compId}/task/${f.taskId}/igc`,
      fakeIgcPayload(),
      { user: "user-1", headers: AS_NEW_PILOT }
    );
    expect(own.status).toBe(201);

    const onBehalf = await uploadRequest(
      `/api/comp/${f.compId}/task/${f.taskId}/igc/${f.compPilotId}`,
      fakeIgcPayload(),
      { user: "user-1" }
    );
    expect([200, 201]).toContain(onBehalf.status);
  });

  test("still lets the organiser record a manual flight", async () => {
    const f = await fixture();
    await close(f);

    const res = await authRequest(
      "PUT",
      `/api/comp/${f.compId}/task/${f.taskId}/manual-flight/${f.compPilotId}`,
      { last_reached_tp_index: 1, landing_lat: 0, landing_lon: 0.15 }
    );
    expect(res.status).toBe(200);
  });

  test("does NOT stop a pilot status being set", async () => {
    // Deliberate non-enforcement, asserted so nobody gates it later without
    // this test to argue with: marking the day's DNFs and absentees is exactly
    // what an organiser does AFTER closing the task.
    const f = await fixture();
    await close(f);

    const res = await authRequest(
      "PUT",
      `/api/comp/${f.compId}/task/${f.taskId}/pilot-status/${f.compPilotId}`,
      { status_key: "dnf", note: null }
    );
    expect(res.status).toBe(200);
  });

  test("reopening lets the pilot back in", async () => {
    const f = await fixture();
    await close(f);
    await close(f, false);

    const res = await uploadRequest(
      `/api/comp/${f.compId}/task/${f.taskId}/igc`,
      fakeIgcPayload(),
      { user: "user-2" }
    );
    expect([200, 201]).toContain(res.status);
  });
});

describe("the record of closing it", () => {
  test("is audit-logged, saying organisers can still upload", async () => {
    const f = await fixture();
    await close(f);

    const res = await request("GET", `/api/comp/${f.compId}/audit`);
    const { entries } = (await res.json()) as {
      entries: { description: string }[];
    };
    const line = entries.find((e) => e.description.includes("closed the task"))
      ?? entries.find((e) => e.description.includes("Closed the task"));
    expect(line?.description).toBe(
      "Closed the task for track submissions — organisers can still upload"
    );
  });

  test("reopening is audit-logged too", async () => {
    const f = await fixture();
    await close(f);
    await close(f, false);

    const res = await request("GET", `/api/comp/${f.compId}/audit`);
    const { entries } = (await res.json()) as {
      entries: { description: string }[];
    };
    expect(
      entries.some(
        (e) => e.description === "Reopened the task for track submissions"
      )
    ).toBe(true);
  });

  test("does NOT mark the scores stale", async () => {
    // Whether FURTHER evidence may arrive changes no score that exists, so
    // this must not trigger a rescore. Asserted because the standing rule is
    // "every mutation bumps", and this is a documented exception.
    const f = await fixture();
    const before = await env.DB.prepare(
      "SELECT inputs_rev FROM task_scores WHERE task_id = (SELECT task_id FROM task LIMIT 1)"
    ).first<{ inputs_rev: number }>();

    await close(f);

    const after = await env.DB.prepare(
      "SELECT inputs_rev FROM task_scores WHERE task_id = (SELECT task_id FROM task LIMIT 1)"
    ).first<{ inputs_rev: number }>();
    expect(after?.inputs_rev).toBe(before?.inputs_rev);
  });
});

describe("what the rest of the API says about it", () => {
  test("the task GET reports it, so a pilot sees it before trying", async () => {
    const f = await fixture();
    await close(f);

    const res = await request(
      "GET",
      `/api/comp/${f.compId}/task/${f.taskId}`
    );
    expect(((await res.json()) as Record<string, any>).submissions_closed).toBe(
      true
    );
  });

  test("open-now stops offering the task", async () => {
    // The endpoint's contract is "what could somebody submit to right now".
    // Left in, suggested_task_id would steer every pilot into a 403.
    const compId = await createComp({ name: "Flying Now" });
    const open = await createTask(compId, {
      name: "Open Task",
      task_date: new Date().toISOString().slice(0, 10),
    });
    const shut = await createTask(compId, {
      name: "Shut Task",
      task_date: new Date().toISOString().slice(0, 10),
    });
    await authRequest("PATCH", `/api/comp/${compId}/task/${shut}`, {
      submissions_closed: true,
    });

    const res = await SELF.fetch("https://test/api/comp/open-now");
    const body = (await res.json()) as {
      comps: { tasks: { task_id: string }[]; suggested_task_id: string }[];
    };
    const ids = body.comps[0].tasks.map((t) => t.task_id);
    expect(ids).toContain(open);
    expect(ids).not.toContain(shut);
    expect(body.comps[0].suggested_task_id).toBe(open);
  });

  test("a comp whose only task is closed drops off open-now entirely", async () => {
    const compId = await createComp({ name: "All Done" });
    const only = await createTask(compId, {
      task_date: new Date().toISOString().slice(0, 10),
    });
    await authRequest("PATCH", `/api/comp/${compId}/task/${only}`, {
      submissions_closed: true,
    });

    const res = await SELF.fetch("https://test/api/comp/open-now");
    const body = (await res.json()) as { comps: { name: string }[] };
    expect(body.comps.map((c) => c.name)).not.toContain("All Done");
  });
});
