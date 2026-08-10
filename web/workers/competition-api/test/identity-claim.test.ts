/**
 * A signed-in pilot's registration is never guessed.
 *
 * The bug: an organiser registers Jane with a mistyped email, Jane's own
 * profile has no national ids, nothing matches — and the upload route used to
 * INSERT a second roster row. Jane was then registered twice, the organiser's
 * entry sitting empty, and nobody was told. The pilot count feeds launch
 * validity (S7F §10.1), so the phantom is a scoring input too.
 *
 * Every test here is written so that the DUPLICATE is what fails, not merely
 * the status code: a route that answered 409 and still inserted would pass a
 * status-only assertion.
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

function fakeIgcPayload(): Uint8Array {
  return new Uint8Array([
    0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x73, 0x8c,
    0x70, 0x0e, 0x31, 0x30, 0x30, 0x0c, 0x49, 0x2d, 0x2e, 0xe1, 0xe5, 0xf2,
    0x70, 0x73, 0x09, 0x71, 0x35, 0x30, 0x34, 0x30, 0x34, 0x32, 0xe3, 0xe5,
    0x02, 0x00, 0x19, 0xac, 0x90, 0xbb, 0x1a, 0x00, 0x00, 0x00,
  ]);
}

interface Comp {
  compId: string;
  taskId: string;
}

async function comp(): Promise<Comp> {
  const compId = await createComp();
  const taskId = await createTask(compId);
  return { compId, taskId };
}

/** Pre-register somebody the way an organiser's spreadsheet import does. */
async function preRegister(
  compId: string,
  name: string,
  extra: Record<string, unknown> = {}
): Promise<string> {
  const res = await authRequest("POST", `/api/comp/${compId}/pilot`, {
    registered_pilot_name: name,
    pilot_class: "open",
    ...extra,
  });
  expect(res.ok).toBe(true);
  return ((await res.json()) as { comp_pilot_id: string }).comp_pilot_id;
}

function upload(
  c: Comp,
  user: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  return uploadRequest(
    `/api/comp/${c.compId}/task/${c.taskId}/igc`,
    fakeIgcPayload(),
    { user, headers }
  );
}

async function rosterSize(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM comp_pilot"
  ).first<{ n: number }>();
  return row!.n;
}

async function claimantOf(compPilotId: string): Promise<number | null> {
  // Read by name rather than decoding the sqid — the test should not have to
  // know the alphabet to check who owns a row.
  const row = await env.DB.prepare(
    "SELECT pilot_id FROM comp_pilot WHERE registered_pilot_name = ?"
  )
    .bind(compPilotId)
    .first<{ pilot_id: number | null }>();
  return row?.pilot_id ?? null;
}

beforeEach(async () => {
  await clearCompData();
});

describe("the server refuses to guess", () => {
  test("asks which registration, instead of making a second one", async () => {
    const c = await comp();
    await preRegister(c.compId, "Jane Smith", {
      // The typo that starts the whole problem.
      registered_pilot_email: "jane@gmial.com",
    });

    const res = await upload(c, "user-2");

    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, any>;
    expect(body.code).toBe("identity_ambiguous");
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].registered_pilot_name).toBe("Jane Smith");
    // The masked address is often how a pilot recognises which entry is theirs.
    expect(body.candidates[0].notify_email_masked).toBe("j***@gmial.com");

    // THE ASSERTION THIS FILE EXISTS FOR.
    expect(await rosterSize(), "no duplicate was created").toBe(1);
  });

  test("asks even when no name resembles the pilot at all", async () => {
    // Deliberate: the ask rule is "is there an unclaimed row", never a name
    // threshold. If it were a name threshold, a pilot the organiser wrote down
    // as "Mick" would never be shown "Michael" and would silently duplicate.
    const c = await comp();
    await preRegister(c.compId, "Someone Entirely Different");

    const res = await upload(c, "user-2");
    expect(res.status).toBe(409);
    expect(await rosterSize()).toBe(1);
  });

  test("offers the likeliest registration first", async () => {
    const c = await comp();
    await preRegister(c.compId, "Zoe Adams");
    await preRegister(c.compId, "Test Pilot"); // user-1's account name
    await preRegister(c.compId, "Bob Jones");

    const res = await upload(c, "user-1");
    const body = (await res.json()) as Record<string, any>;
    expect(body.candidates.map((x: any) => x.registered_pilot_name)).toEqual([
      "Test Pilot",
      "Bob Jones",
      "Zoe Adams",
    ]);
  });
});

describe("what still works exactly as before", () => {
  test("an empty roster self-registers silently", async () => {
    // The legitimate open-registration path. If this regressed, every first
    // upload in every new comp would 409.
    const c = await comp();

    const res = await upload(c, "user-2");
    expect(res.status).toBe(201);
    expect(await rosterSize()).toBe(1);

    const audit = await request("GET", `/api/comp/${c.compId}/audit`);
    const { entries } = (await audit.json()) as { entries: { description: string }[] };
    expect(
      entries.some((e) => e.description.startsWith("Registered pilot"))
    ).toBe(true);
  });

  test("an exact email match still claims the organiser's row by itself", async () => {
    // Nothing about the happy path changed: a pilot whose registered email IS
    // their account email is linked with no question asked.
    const c = await comp();
    await preRegister(c.compId, "Test Pilot", {
      registered_pilot_email: "pilot@test.com", // user-1's account address
    });

    const res = await upload(c, "user-1");
    expect(res.status).toBe(201);
    expect(await rosterSize(), "claimed, not duplicated").toBe(1);
    expect(await claimantOf("Test Pilot")).not.toBeNull();
  });

  test("a pilot already on the roster is never asked again", async () => {
    const c = await comp();
    await preRegister(c.compId, "Jane Smith");

    const first = await upload(c, "user-2", AS_NEW_PILOT);
    expect(first.status).toBe(201);
    // Second upload: they are linked now, so the question must not come back.
    const second = await upload(c, "user-2");
    expect([200, 201]).toContain(second.status);
    expect(await rosterSize()).toBe(2);
  });
});

describe("claiming a registration", () => {
  test("puts the track on the organiser's row and links the account", async () => {
    const c = await comp();
    const janeId = await preRegister(c.compId, "Jane Smith", {
      registered_pilot_email: "jane@gmial.com",
    });

    const res = await upload(c, "user-2", { "x-comp-pilot": janeId });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, any>;
    expect(body.comp_pilot_id).toBe(janeId);

    expect(await rosterSize(), "still one pilot").toBe(1);
    expect(await claimantOf("Jane Smith"), "now linked to the account").not.toBeNull();
  });

  test("says in the audit log that the PILOT claimed it, not that we matched", async () => {
    // The permissive model rests on this: nothing was verified, so the record
    // has to show it was an assertion rather than a match.
    const c = await comp();
    const janeId = await preRegister(c.compId, "Jane Smith");
    await upload(c, "user-2", { "x-comp-pilot": janeId });

    const audit = await request("GET", `/api/comp/${c.compId}/audit`);
    const { entries } = (await audit.json()) as { entries: { description: string }[] };
    expect(
      entries.some((e) => /claimed the registration for "Jane Smith"/.test(e.description))
    ).toBe(true);
  });

  test("a second account cannot take a registration already claimed", async () => {
    const c = await comp();
    const janeId = await preRegister(c.compId, "Jane Smith");
    expect((await upload(c, "user-2", { "x-comp-pilot": janeId })).status).toBe(201);

    const before = await claimantOf("Jane Smith");
    const res = await upload(c, "user-3", { "x-comp-pilot": janeId });

    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, any>;
    expect(body.code).toBe("claim_rejected");
    expect(body.reason).toBe("already_claimed");
    // The loser must not have moved the winner's link, nor grown the roster.
    expect(await claimantOf("Jane Smith")).toBe(before);
    expect(await rosterSize()).toBe(1);
  });

  test("a pilot already registered here cannot move to another row", async () => {
    const c = await comp();
    const janeId = await preRegister(c.compId, "Jane Smith");
    await preRegister(c.compId, "Bob Jones");
    // user-2 joins as themselves.
    expect((await upload(c, "user-2", AS_NEW_PILOT)).status).toBe(201);

    const res = await upload(c, "user-2", { "x-comp-pilot": janeId });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, any>).reason).toBe(
      "already_registered"
    );
    expect(await claimantOf("Jane Smith"), "Jane is untouched").toBeNull();
  });

  test("a registration from another competition is not claimable", async () => {
    const a = await comp();
    const b = await comp();
    const strangerId = await preRegister(b.compId, "Someone Else");

    const res = await upload(a, "user-2", { "x-comp-pilot": strangerId });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, any>).reason).toBe("not_found");
  });

  test("a malformed header is refused, not ignored", async () => {
    // Ignoring it would silently fall back to guessing, which is the behaviour
    // this whole change removes.
    const c = await comp();
    await preRegister(c.compId, "Jane Smith");

    const res = await upload(c, "user-2", { "x-comp-pilot": "!!!not-an-id" });
    expect(res.status).toBe(400);
    expect(await rosterSize()).toBe(1);
  });
});

describe("declining every candidate", () => {
  test("registers the pilot and records what they turned down", async () => {
    const c = await comp();
    await preRegister(c.compId, "Jane Smith");
    await preRegister(c.compId, "Bob Jones");

    const res = await upload(c, "user-2", AS_NEW_PILOT);
    expect(res.status).toBe(201);
    expect(await rosterSize(), "a third, deliberately").toBe(3);

    const audit = await request("GET", `/api/comp/${c.compId}/audit`);
    const { entries } = (await audit.json()) as { entries: { description: string }[] };
    expect(
      entries.some((e) =>
        e.description.includes("declining 2 unclaimed registrations")
      ),
      "the audit log says the duplicate was a deliberate choice"
    ).toBe(true);
  });

  test("still refuses when the comp does not accept self-registration", async () => {
    // "None of these" is not a way around a closed roster.
    const c = await comp();
    await authRequest("PATCH", `/api/comp/${c.compId}`, {
      open_registration: false,
    });
    await preRegister(c.compId, "Jane Smith");

    const res = await upload(c, "user-2", AS_NEW_PILOT);
    expect(res.status).toBe(403);
    expect(((await res.json()) as Record<string, any>).code).toBe(
      "registration_closed"
    );
    expect(await rosterSize()).toBe(1);
  });
});

describe("telling the registered pilot", () => {
  // The submit form promises this UNCONDITIONALLY ("we email the registered
  // pilot to tell them about it"), so a route that quietly skipped it would
  // make that copy a lie with nothing in the UI to show it.

  test("claiming somebody's registration emails the address on it", async () => {
    const c = await comp();
    const janeId = await preRegister(c.compId, "Jane Smith", {
      registered_pilot_email: "jane@gmial.com",
    });

    const res = await upload(c, "user-2", { "x-comp-pilot": janeId });
    const body = (await res.json()) as any;
    expect(body.notified.emailed).toBe(true);
    expect(body.notified.masked_to).toBe("j***@gmial.com");
  });

  test("filing your own track to your own address is not a notice", async () => {
    // Writing to somebody about a thing they just did, at the address they are
    // signed in with, on the screen that already says it.
    const c = await comp();
    await preRegister(c.compId, "Test Pilot", {
      registered_pilot_email: "pilot@test.com", // user-1's account address
    });

    const res = await upload(c, "user-1");
    const body = (await res.json()) as any;
    expect(body.notified.emailed).toBe(false);
    expect(body.notified.reason).toBe("submitter_is_recipient");
  });

  test("a pilot with no address at all is audited, not silently skipped", async () => {
    // The log becomes the only record that the notice never went out, so it
    // has to say so.
    const c = await comp();
    const janeId = await preRegister(c.compId, "Jane Smith"); // no email

    const res = await upload(c, "user-2", { "x-comp-pilot": janeId });
    expect(((await res.json()) as any).notified.emailed).toBe(false);

    const audit = await request("GET", `/api/comp/${c.compId}/audit`);
    const { entries } = (await audit.json()) as { entries: { description: string }[] };
    expect(
      entries.some((e) =>
        /Could not advise Jane Smith about this submission/.test(e.description)
      )
    ).toBe(true);
  });

  test("an upload on behalf tells the pilot it was filed for", async () => {
    // The gap this closes: a STRANGER'S anonymous replacement emailed you, but
    // a fellow registered pilot overwriting your track did not.
    const c = await comp();
    const janeId = await preRegister(c.compId, "Jane Smith", {
      registered_pilot_email: "jane@gmial.com",
    });
    // user-1 is the comp admin, so may upload on behalf.
    const res = await uploadRequest(
      `/api/comp/${c.compId}/task/${c.taskId}/igc/${janeId}`,
      fakeIgcPayload(),
      { user: "user-1" }
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.notified.emailed).toBe(true);
    expect(body.notified.masked_to).toBe("j***@gmial.com");
  });
});
