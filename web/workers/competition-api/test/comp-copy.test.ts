import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { authRequest, clearCompData, createComp, createTask, request } from "./helpers";

const WP = [
  { code: "ELLIOT", name: "Mt Elliot", latitude: -36.186, longitude: 147.976, altitude: 1100, radius: 400 },
  { code: "CORRYG", name: "Corryong", latitude: -36.197, longitude: 147.902, altitude: 290, radius: 400 },
];

/** Seed a roster through the bulk save, as an organiser would. */
async function seedRoster(compId: string, pilots: Array<Record<string, unknown>>) {
  const res = await authRequest("POST", `/api/comp/${compId}/pilot/bulk`, { pilots, remove: [] });
  expect(res.status).toBe(200);
}

async function roster(compId: string) {
  const res = await authRequest("GET", `/api/comp/${compId}/pilot`);
  return ((await res.json()) as { pilots: Array<Record<string, unknown>> }).pilots;
}

async function auditLines(compId: string): Promise<string[]> {
  const res = await authRequest("GET", `/api/comp/${compId}/audit`);
  const body = (await res.json()) as { entries: Array<{ description: string }> };
  return body.entries.map((e) => e.description);
}

async function clone(compId: string, body: Record<string, unknown>, user = "user-1") {
  return request("POST", `/api/comp/${compId}/clone`, { body, user });
}

describe("POST /api/comp/:comp_id/clone", () => {
  beforeEach(clearCompData);
  afterEach(clearCompData);

  test("makes a hidden comp with the settings, waypoints and pilots", async () => {
    const from = await createComp({
      name: "Corryong Cup 2026",
      category: "pg",
      pilot_classes: ["open", "sport"],
      default_pilot_class: "sport",
      scoring_format: "gap",
      series_scoring: "ftv",
      ftv_factor: 0.25,
      timezone: "Australia/Melbourne",
    });
    await authRequest("PATCH", `/api/comp/${from}`, {
      open_registration: false,
      organiser_notes: "Briefing 9:30 at the launch shelter",
    });
    await authRequest("PUT", `/api/comp/${from}/waypoints`, { waypoints: WP });
    await seedRoster(from, [
      {
        registered_pilot_name: "Jane Doe",
        registered_pilot_email: "jane@example.com",
        registered_pilot_civl_id: "12345",
        registered_pilot_glider: "Enzo 3",
        pilot_class: "open",
        team_name: "Alpha Gliders",
        driver_contact: "Sam 0400 000 000",
        wprs_points: 261.5,
        first_start_order: 3,
      },
      { registered_pilot_name: "Bob Roe", pilot_class: "sport" },
    ]);
    await createTask(from, { name: "Task 1" });

    const res = await clone(from, { name: "Corryong Cup 2027" });
    expect(res.status).toBe(201);
    const made = (await res.json()) as {
      comp_id: string;
      share_key: string;
      test: boolean;
      copied: { waypoints: number; pilots: number; admins: number };
    };
    expect(made.test).toBe(true);
    expect(made.share_key).toMatch(/^[a-z0-9]+$/);
    expect(made.copied).toEqual({ waypoints: 2, pilots: 2, admins: 0 });

    const comp = (await (await authRequest("GET", `/api/comp/${made.comp_id}`)).json()) as Record<
      string,
      unknown
    >;
    expect(comp).toMatchObject({
      name: "Corryong Cup 2027",
      category: "pg",
      test: true,
      pilot_classes: ["open", "sport"],
      default_pilot_class: "sport",
      series_scoring: "ftv",
      ftv_factor: 0.25,
      timezone: "Australia/Melbourne",
      open_registration: false,
      waypoint_count: 2,
      pilot_count: 2,
    });
    // Year-specific things stay behind.
    expect(comp.organiser_notes).toBe("");
    expect(comp.tasks).toEqual([]);
    // Hidden: nobody but its organisers can see it by its id alone.
    expect((await request("GET", `/api/comp/${made.comp_id}`)).status).toBe(404);

    const wps = (await (await authRequest("GET", `/api/comp/${made.comp_id}/waypoints`)).json()) as {
      waypoints: unknown[];
    };
    expect(wps.waypoints).toEqual(WP);

    const pilots = await roster(made.comp_id);
    const jane = pilots.find((p) => p.name === "Jane Doe")!;
    expect(jane).toMatchObject({
      email: "jane@example.com",
      civl_id: "12345",
      glider: "Enzo 3",
      pilot_class: "open",
      team_name: "Alpha Gliders",
      driver_contact: "Sam 0400 000 000",
      // A ranking and a launch order belong to one competition.
      wprs_points: null,
      first_start_order: null,
    });
  });

  test("leaves out what the organiser unticks", async () => {
    const from = await createComp();
    await authRequest("PUT", `/api/comp/${from}/waypoints`, { waypoints: WP });
    await seedRoster(from, [{ registered_pilot_name: "Jane Doe", pilot_class: "open" }]);

    const res = await clone(from, { name: "Copy", waypoints: false, pilots: false });
    expect(res.status).toBe(201);
    const made = (await res.json()) as { comp_id: string; copied: Record<string, number> };
    expect(made.copied).toEqual({ waypoints: 0, pilots: 0, admins: 0 });
    expect(await roster(made.comp_id)).toEqual([]);
  });

  test("brings the other organisers along when asked", async () => {
    const from = await createComp();
    await authRequest("PATCH", `/api/comp/${from}`, {
      admin_emails: ["pilot@test.com", "admin2@test.com"],
    });

    const withThem = (await (await clone(from, { name: "With" })).json()) as {
      comp_id: string;
      copied: { admins: number };
    };
    expect(withThem.copied.admins).toBe(1);
    expect((await request("GET", `/api/comp/${withThem.comp_id}`, { user: "user-2" })).status).toBe(
      200
    );

    const without = (await (await clone(from, { name: "Without", admins: false })).json()) as {
      comp_id: string;
    };
    expect((await request("GET", `/api/comp/${without.comp_id}`, { user: "user-2" })).status).toBe(
      404
    );
  });

  test("keeps a pilot's link to their account", async () => {
    await env.DB.prepare("INSERT INTO pilot (user_id, name) VALUES (?, ?)")
      .bind("user-3", "Pilot Three")
      .run();
    const from = await createComp();
    // Linked by the email the account signs in with.
    await seedRoster(from, [
      { registered_pilot_name: "Pilot Three", registered_pilot_email: "pilot3@test.com", pilot_class: "open" },
    ]);
    expect((await roster(from))[0].linked).toBe(true);

    const made = (await (await clone(from, { name: "Next" })).json()) as { comp_id: string };
    expect((await roster(made.comp_id))[0].linked).toBe(true);
  });

  test("writes what it copied into the new comp's audit log", async () => {
    const from = await createComp({ name: "Corryong Cup 2026" });
    await authRequest("PUT", `/api/comp/${from}/waypoints`, { waypoints: WP });
    await seedRoster(from, [{ registered_pilot_name: "Jane Doe", pilot_class: "open" }]);

    const made = (await (await clone(from, { name: "Corryong Cup 2027" })).json()) as {
      comp_id: string;
    };
    const lines = await auditLines(made.comp_id);
    expect(lines.some((l) =>
      /^Created competition "Corryong Cup 2027" as a copy of "Corryong Cup 2026", with its settings, 2 waypoints and 1 pilot/.test(l)
    )).toBe(true);
    expect(lines).toContain('Copied pilot "Jane Doe" from "Corryong Cup 2026" (class: open)');
    // The source comp's log is untouched.
    expect((await auditLines(from)).some((l) => /copy/i.test(l))).toBe(false);
  });

  test("only an organiser of the comp may copy it", async () => {
    const from = await createComp();
    expect((await clone(from, { name: "Mine now" }, "user-2")).status).toBe(403);
    expect((await request("POST", `/api/comp/${from}/clone`, { body: { name: "x" } })).status).toBe(401);
  });

  test("needs a name", async () => {
    const from = await createComp();
    const res = await clone(from, { name: "" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { field?: string }).field).toBe("name");
  });
});

describe("copying pilots from another comp", () => {
  beforeEach(clearCompData);
  afterEach(clearCompData);

  test("lists the caller's other comps that have pilots", async () => {
    const here = await createComp({ name: "Here" });
    const full = await createComp({ name: "Full" });
    await createComp({ name: "Empty" });
    await seedRoster(full, [{ registered_pilot_name: "Jane Doe", pilot_class: "open" }]);

    const res = await authRequest("GET", `/api/comp/${here}/pilot/copy-sources`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { comps: Array<{ name: string; pilot_count: number }> };
    expect(body.comps).toEqual([expect.objectContaining({ name: "Full", pilot_count: 1 })]);
  });

  test("previews, then adds only the pilots who are not already there", async () => {
    const from = await createComp({ name: "Last year", pilot_classes: ["open", "sport"] });
    await seedRoster(from, [
      { registered_pilot_name: "Jane Doe", registered_pilot_civl_id: "111", pilot_class: "open" },
      { registered_pilot_name: "Bob Roe", registered_pilot_email: "bob@example.com", pilot_class: "open" },
      { registered_pilot_name: "Cara Lee", pilot_class: "sport", team_name: "alpha  gliders" },
      { registered_pilot_name: "Dan Poe", pilot_class: "open" },
    ]);
    const to = await createComp({ name: "This year", pilot_classes: ["open"] });
    await seedRoster(to, [
      { registered_pilot_name: "J. Doe", registered_pilot_civl_id: "111", pilot_class: "open" },
      { registered_pilot_name: "Robert Roe", registered_pilot_email: "BOB@example.com", pilot_class: "open" },
      { registered_pilot_name: "Dan Poe", pilot_class: "open" },
      { registered_pilot_name: "Eve Sky", pilot_class: "open", team_name: "Alpha Gliders" },
    ]);

    const preview = await authRequest("GET", `/api/comp/${to}/pilot/copy?from=${from}`);
    expect(preview.status).toBe(200);
    const plan = (await preview.json()) as {
      from: { name: string };
      copy: Array<{ name: string; pilot_class: string; team_name: string | null; same_name_as: string | null }>;
      skip: Array<{ name: string; reason: string }>;
      remapped: Array<{ from: string; to: string; count: number }>;
      error: string | null;
    };
    expect(plan.from.name).toBe("Last year");
    expect(plan.skip).toEqual([
      { name: "Bob Roe", reason: "Already on this roster as Robert Roe (same email)" },
      { name: "Jane Doe", reason: "Already on this roster as J. Doe (same CIVL ID)" },
    ]);
    // A name alone never decides: Dan Poe is copied, and the plan says why
    // the organiser may want to look.
    expect(plan.copy).toEqual([
      // A class this comp lacks becomes its default; the team snaps to the
      // roster's spelling.
      { name: "Cara Lee", pilot_class: "open", team_name: "Alpha Gliders", linked: false, same_name_as: null },
      { name: "Dan Poe", pilot_class: "open", team_name: null, linked: false, same_name_as: "Dan Poe" },
    ]);
    expect(plan.remapped).toEqual([{ from: "sport", to: "open", count: 1 }]);
    expect(plan.error).toBeNull();
    // A preview writes nothing.
    expect(await roster(to)).toHaveLength(4);

    const apply = await authRequest("POST", `/api/comp/${to}/pilot/copy`, { from_comp_id: from });
    expect(apply.status).toBe(200);
    expect(await apply.json()).toMatchObject({ copied: 2, skipped: 2 });
    const names = (await roster(to)).map((p) => p.name).sort();
    expect(names).toEqual(["Cara Lee", "Dan Poe", "Dan Poe", "Eve Sky", "J. Doe", "Robert Roe"]);

    const lines = await auditLines(to);
    expect(lines).toContain('Copied pilot "Cara Lee" from "Last year" (class: open, was sport)');
    expect(lines).toContain('Copied pilot "Dan Poe" from "Last year" (class: open)');
  });

  test("summarises a big copy in one audit line", async () => {
    const from = await createComp({ name: "Big" });
    await seedRoster(
      from,
      Array.from({ length: 6 }, (_, i) => ({ registered_pilot_name: `Pilot ${i}`, pilot_class: "open" }))
    );
    const to = await createComp();
    await authRequest("POST", `/api/comp/${to}/pilot/copy`, { from_comp_id: from });
    expect(await auditLines(to)).toContain('Copied 6 pilots from "Big"');
  });

  test("refuses a comp the caller does not organise, hidden or public", async () => {
    const to = await createComp();
    const theirs = (await (
      await request("POST", "/api/comp", { body: { name: "Theirs", category: "hg", test: false }, user: "user-2" })
    ).json()) as { comp_id: string };
    const res = await authRequest("GET", `/api/comp/${to}/pilot/copy?from=${theirs.comp_id}`);
    expect(res.status).toBe(404);
    const post = await authRequest("POST", `/api/comp/${to}/pilot/copy`, {
      from_comp_id: theirs.comp_id,
    });
    expect(post.status).toBe(404);
  });

  test("refuses to copy a comp into itself", async () => {
    const to = await createComp();
    const res = await authRequest("POST", `/api/comp/${to}/pilot/copy`, { from_comp_id: to });
    expect(res.status).toBe(400);
  });

  test("only the target comp's organisers may copy into it", async () => {
    const from = await createComp();
    const to = await createComp();
    const res = await request("POST", `/api/comp/${to}/pilot/copy`, {
      body: { from_comp_id: from },
      user: "user-2",
    });
    expect(res.status).toBe(403);
  });
});
