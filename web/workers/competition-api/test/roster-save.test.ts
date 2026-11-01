/**
 * Saving the roster must not lose a pilot, or a pilot's own link, that the
 * organiser saving it never touched.
 *
 * Two ways it did, both through POST /pilot/bulk, which the roster editor
 * sends the whole roster to:
 *
 *   - Every row the payload did not mention was deleted, tracks and all. A
 *     pilot who joined through open registration while an organiser had the
 *     editor open was not in that organiser's payload, and so was deleted by
 *     their next Save. A caller now names what to remove (`remove`); the
 *     older whole-roster contract stays for a tab loaded before the change.
 *
 *   - Every row's account link was re-decided from the organiser's identity
 *     columns. A self-registered row has none (no email, no IDs), so every
 *     Save unlinked every self-registered pilot. See nextPilotLink in
 *     routes/pilot.ts — PATCH now shares it.
 *
 * Also here: PATCH can clear a field, the public audit log never carries an
 * email or a driver's contact details, and the roster says how many tracks
 * each pilot holds (what Remove would delete).
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import {
  AS_NEW_PILOT,
  authRequest,
  clearCompData,
  createComp,
  createTask,
  request,
  uploadRequest,
} from "./helpers";

interface Pilot {
  comp_pilot_id: string;
  name: string;
  linked: boolean;
  email: string | null;
  team_name: string | null;
  driver_contact: string | null;
  civl_id: string | null;
  track_count: number;
}

/** A minimal gzip IGC payload (same as igc-routes.test.ts). */
function fakeIgcPayload(): Uint8Array {
  return new Uint8Array([
    0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x73, 0x8c,
    0x70, 0x0e, 0x31, 0x30, 0x30, 0x0c, 0x49, 0x2d, 0x2e, 0xe1, 0xe5, 0xf2,
    0x70, 0x73, 0x09, 0x71, 0x35, 0x30, 0x34, 0x30, 0x34, 0x32, 0xe3, 0xe5,
    0x02, 0x00, 0x19, 0xac, 0x90, 0xbb, 0x1a, 0x00, 0x00, 0x00,
  ]);
}

/**
 * user-1 uploads a track and joins the roster through open registration: a
 * row with a name, a class and a link, and no email or ID for the resolver to
 * find them by. "None of these" (AS_NEW_PILOT) answers the which-registration
 * question an unclaimed row on the roster would otherwise ask.
 */
async function selfRegister(compId: string): Promise<void> {
  const taskId = await createTask(compId);
  const res = await uploadRequest(`/api/comp/${compId}/task/${taskId}/igc`, fakeIgcPayload(), {
    user: "user-1",
    headers: AS_NEW_PILOT,
  });
  expect(res.status).toBeLessThan(300);
}

async function roster(compId: string): Promise<Pilot[]> {
  const res = await authRequest("GET", `/api/comp/${compId}/pilot`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { pilots: Pilot[] }).pilots;
}

async function bulk(compId: string, body: unknown): Promise<Response> {
  return authRequest("POST", `/api/comp/${compId}/pilot/bulk`, body);
}

/** The bulk row an editor would send back for a pilot it was shown. */
function unchanged(p: Pilot) {
  return {
    comp_pilot_id: p.comp_pilot_id,
    registered_pilot_name: p.name,
    registered_pilot_email: p.email,
    registered_pilot_civl_id: p.civl_id,
    pilot_class: "open",
  };
}

async function auditDescriptions(compId: string): Promise<string[]> {
  const res = await request("GET", `/api/comp/${compId}/audit`);
  const { entries } = (await res.json()) as { entries: Array<{ description: string }> };
  return entries.map((e) => e.description);
}

beforeEach(async () => {
  await clearCompData();
  const listed = await env.R2.list();
  await Promise.all(listed.objects.map((o) => env.R2.delete(o.key)));
});

describe("bulk save with a remove list", () => {
  test("removes the pilots it names and keeps the ones it does not mention", async () => {
    const compId = await createComp();
    await bulk(compId, {
      pilots: ["Alice", "Bob", "Carol"].map((n) => ({
        registered_pilot_name: n,
        pilot_class: "open",
      })),
    });
    const [alice, bob, carol] = await roster(compId);

    const res = await bulk(compId, { pilots: [unchanged(alice)], remove: [bob.comp_pilot_id] });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { deleted: number; total: number };
    expect(data.deleted).toBe(1);
    expect((await roster(compId)).map((p) => p.name)).toEqual(["Alice", "Carol"]);
    expect(carol.name).toBe("Carol");
  });

  test("a pilot who joined while the editor was open survives the save", async () => {
    const compId = await createComp();
    await bulk(compId, { pilots: [{ registered_pilot_name: "Alice", pilot_class: "open" }] });
    // The editor opens on this roster...
    const shown = await roster(compId);
    // ...a pilot joins by uploading a track...
    await selfRegister(compId);
    // ...and the organiser saves what they were shown.
    const res = await bulk(compId, { pilots: shown.map(unchanged), remove: [] });
    expect(res.status).toBe(200);

    const after = await roster(compId);
    expect(after).toHaveLength(2);
    const joined = after.find((p) => p.name !== "Alice")!;
    expect(joined.linked).toBe(true);
    expect(joined.track_count).toBe(1);
    expect(await env.R2.list().then((l) => l.objects.length)).toBe(1);
  });

  test("a pilot somebody else already removed is not an error", async () => {
    const compId = await createComp();
    await bulk(compId, {
      pilots: ["Alice", "Bob"].map((n) => ({ registered_pilot_name: n, pilot_class: "open" })),
    });
    const [alice, bob] = await roster(compId);
    await authRequest("DELETE", `/api/comp/${compId}/pilot/${bob.comp_pilot_id}`);

    const res = await bulk(compId, { pilots: [unchanged(alice)], remove: [bob.comp_pilot_id] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { deleted: number }).deleted).toBe(0);
  });

  test("refuses a pilot that is both updated and removed", async () => {
    const compId = await createComp();
    await bulk(compId, { pilots: [{ registered_pilot_name: "Alice", pilot_class: "open" }] });
    const [alice] = await roster(compId);

    const res = await bulk(compId, {
      pilots: [unchanged(alice)],
      remove: [alice.comp_pilot_id],
    });
    expect(res.status).toBe(400);
    expect(await roster(compId)).toHaveLength(1);
  });

  test("refuses an id it cannot read", async () => {
    const compId = await createComp();
    const res = await bulk(compId, { pilots: [], remove: ["not-a-sqid!"] });
    expect(res.status).toBe(400);
  });

  test("a new row matching a pilot already registered is refused, not a 500", async () => {
    const compId = await createComp();
    // user-1 joins by uploading; their profile carries a CIVL ID.
    await selfRegister(compId);
    await env.DB.prepare("UPDATE pilot SET civl_id = ? WHERE user_id = ?")
      .bind("C-77", "user-1")
      .run();

    // An organiser adds them again by ID, leaving the existing row alone.
    const res = await bulk(compId, {
      pilots: [{ registered_pilot_name: "Typed Again", registered_pilot_civl_id: "C-77", pilot_class: "open" }],
      remove: [],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Array<{ error: string }> };
    expect(body.errors[0].error).toMatch(/already registered/);
    expect(await roster(compId)).toHaveLength(1);
  });
});

describe("bulk save without a remove list (a tab loaded before the change)", () => {
  test("still deletes every pilot the payload does not mention", async () => {
    const compId = await createComp();
    await bulk(compId, {
      pilots: ["Alice", "Bob"].map((n) => ({ registered_pilot_name: n, pilot_class: "open" })),
    });
    const [alice] = await roster(compId);

    const res = await bulk(compId, { pilots: [unchanged(alice)] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { deleted: number }).deleted).toBe(1);
    expect((await roster(compId)).map((p) => p.name)).toEqual(["Alice"]);
  });
});

describe("a roster save keeps a pilot's own link", () => {
  test("a bulk save of an unchanged roster keeps a self-registered pilot linked", async () => {
    const compId = await createComp();
    await selfRegister(compId);
    const shown = await roster(compId);
    expect(shown[0].linked).toBe(true);

    // Exactly what today's grid sends: the whole roster, no remove list.
    const res = await bulk(compId, { pilots: shown.map(unchanged) });
    expect(res.status).toBe(200);
    expect((await roster(compId))[0].linked).toBe(true);
  });

  test("an organiser adding an ID that matches nobody keeps the pilot's own link", async () => {
    const compId = await createComp();
    await selfRegister(compId);
    const [p] = await roster(compId);

    const res = await authRequest("PATCH", `/api/comp/${compId}/pilot/${p.comp_pilot_id}`, {
      registered_pilot_safa_id: "S-123",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Pilot).linked).toBe(true);
  });

  test("changing the email that made a link drops it", async () => {
    await env.DB.prepare("INSERT INTO pilot (user_id, name) VALUES (?, ?)")
      .bind("user-3", "Pilot Three")
      .run();
    const compId = await createComp();
    const create = await authRequest("POST", `/api/comp/${compId}/pilot`, {
      registered_pilot_name: "Pilot Three",
      registered_pilot_email: "pilot3@test.com",
      pilot_class: "open",
    });
    const created = (await create.json()) as Pilot;
    expect(created.linked).toBe(true);

    // The email linked them, so correcting it is how a wrong link is undone.
    const res = await authRequest("PATCH", `/api/comp/${compId}/pilot/${created.comp_pilot_id}`, {
      registered_pilot_email: "someone.else@example.com",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Pilot).linked).toBe(false);
  });
});

describe("PATCH clears a field sent as null", () => {
  test("null clears; a field left out is kept", async () => {
    const compId = await createComp();
    const create = await authRequest("POST", `/api/comp/${compId}/pilot`, {
      registered_pilot_name: "Alice",
      pilot_class: "open",
      team_name: "Alpha",
      driver_contact: "Sam 0400 000 000",
      registered_pilot_civl_id: "C-1",
    });
    const { comp_pilot_id } = (await create.json()) as Pilot;

    const res = await authRequest("PATCH", `/api/comp/${compId}/pilot/${comp_pilot_id}`, {
      team_name: null,
      driver_contact: null,
    });
    expect(res.status).toBe(200);
    const after = (await res.json()) as Pilot;
    expect(after.team_name).toBeNull();
    expect(after.driver_contact).toBeNull();
    expect(after.civl_id).toBe("C-1");
  });
});

describe("the public audit log never carries contact details", () => {
  test("email and driver changes are logged without their values", async () => {
    const compId = await createComp();
    const create = await authRequest("POST", `/api/comp/${compId}/pilot`, {
      registered_pilot_name: "Alice",
      pilot_class: "open",
      driver_contact: "Sam 0400 111 222",
    });
    const { comp_pilot_id } = (await create.json()) as Pilot;

    await authRequest("PATCH", `/api/comp/${compId}/pilot/${comp_pilot_id}`, {
      registered_pilot_email: "alice@example.com",
      driver_contact: "Jo 0400 333 444",
      team_name: "Alpha",
    });
    await authRequest("PATCH", `/api/comp/${compId}/pilot/${comp_pilot_id}`, {
      driver_contact: null,
    });

    const log = await auditDescriptions(compId);
    expect(log).toContain("Alice: Set email");
    expect(log).toContain("Alice: Changed driver");
    expect(log).toContain("Alice: Cleared driver");
    // Other fields still show their values.
    expect(log).toContain('Alice: Set team to "Alpha"');
    const all = log.join("\n");
    expect(all).not.toContain("alice@example.com");
    expect(all).not.toContain("0400");
  });
});

describe("the roster says how many tracks each pilot holds", () => {
  test("track_count is 0 for a pilot with no tracks and counts an upload", async () => {
    const compId = await createComp();
    await bulk(compId, { pilots: [{ registered_pilot_name: "Alice", pilot_class: "open" }] });
    await selfRegister(compId);

    const counts = Object.fromEntries((await roster(compId)).map((p) => [p.linked, p.track_count]));
    expect(counts).toEqual({ false: 0, true: 1 });
  });

  test("an anonymous reader gets it too", async () => {
    const compId = await createComp();
    await selfRegister(compId);
    const res = await request("GET", `/api/comp/${compId}/pilot`);
    const { pilots } = (await res.json()) as { pilots: Pilot[] };
    expect(pilots[0].track_count).toBe(1);
  });
});
