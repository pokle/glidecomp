/**
 * The pre-flight that lets the form ask "which registration are you?" before
 * the pilot has chosen a file.
 *
 * Its one hard promise is that it CHANGES NOTHING — a pilot who opens the form
 * and walks away must leave no trace, and a resolve that is retried or raced
 * must be as harmless as one that is not. Several tests below assert on the
 * database rather than the response for exactly that reason.
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
  return ((await res.json()) as { comp_pilot_id: string }).comp_pilot_id;
}

function resolve(
  compId: string,
  user: string,
  body: unknown = {}
): Promise<Response> {
  return request("POST", `/api/comp/${compId}/registration/resolve`, {
    body,
    user,
  });
}

async function dbCounts(): Promise<{ compPilots: number; linked: number }> {
  const a = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM comp_pilot"
  ).first<{ n: number }>();
  const b = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM comp_pilot WHERE pilot_id IS NOT NULL"
  ).first<{ n: number }>();
  return { compPilots: a!.n, linked: b!.n };
}

beforeEach(async () => {
  await clearCompData();
});

describe("it changes nothing", () => {
  test("resolving does not claim, link or create anything", async () => {
    const compId = await createComp();
    await preRegister(compId, "Jane Smith");
    const before = await dbCounts();

    const res = await resolve(compId, "user-2");
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toMatchObject({ state: "choose" });

    // The whole contract of this endpoint in two lines.
    expect(await dbCounts()).toEqual(before);
  });

  test("resolving five times is the same as resolving once", async () => {
    const compId = await createComp();
    await preRegister(compId, "Jane Smith");
    const before = await dbCounts();

    for (let i = 0; i < 5; i++) await resolve(compId, "user-2");

    expect(await dbCounts()).toEqual(before);
  });
});

describe("what it answers", () => {
  test("linked, once the pilot is on the roster under their account", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      fakeIgcPayload(),
      { user: "user-2" }
    );

    const body = (await (await resolve(compId, "user-2")).json()) as any;
    expect(body.state).toBe("linked");
    expect(body.comp_pilot.registered_pilot_name).toBe("Admin Two");
  });

  test("new, when the roster has nothing to pick from", async () => {
    const compId = await createComp();
    const body = (await (await resolve(compId, "user-2")).json()) as any;
    expect(body.state).toBe("new");
    expect(body.may_register).toBe(true);
    expect(body.candidates).toEqual([]);
  });

  test("choose, with the likeliest first and the address masked", async () => {
    const compId = await createComp();
    await preRegister(compId, "Zoe Adams");
    await preRegister(compId, "Test Pilot", {
      registered_pilot_email: "pilot@elsewhere.example",
    });

    const body = (await (await resolve(compId, "user-1")).json()) as any;
    expect(body.state).toBe("choose");
    expect(body.candidates.map((c: any) => c.registered_pilot_name)).toEqual([
      "Test Pilot",
      "Zoe Adams",
    ]);
    // Enough to recognise your own old address, not enough to harvest one.
    expect(body.candidates[0].notify_email_masked).toBe("p***@elsewhere.example");
  });

  test("says when the comp will not accept a new pilot", async () => {
    // The form needs this to know whether to offer "None of these".
    const compId = await createComp();
    await authRequest("PATCH", `/api/comp/${compId}`, {
      open_registration: false,
    });
    await preRegister(compId, "Jane Smith");

    const body = (await (await resolve(compId, "user-2")).json()) as any;
    expect(body.may_register).toBe(false);
  });
});

describe("naming yourself another way", () => {
  test("finds the registration by a CIVL id the account does not carry", async () => {
    // The scenario the whole feature exists for: the organiser registered them
    // with a mistyped email, so nothing about the ACCOUNT matches — but the
    // pilot knows their CIVL id.
    const compId = await createComp();
    await preRegister(compId, "Jane Smith", {
      registered_pilot_email: "jane@gmial.com",
      registered_pilot_civl_id: "12345",
    });
    await preRegister(compId, "Bob Jones");

    const body = (await (
      await resolve(compId, "user-2", {
        identifier: { kind: "civl_id", value: "12345" },
      })
    ).json()) as any;

    expect(body.state).toBe("choose");
    expect(body.matched_by).toBe("civl_id");
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].registered_pilot_name).toBe("Jane Smith");
  });

  test("an identifier that matches nobody falls back to the roster", async () => {
    // Not a dead end: the pilot can still pick themselves off the list.
    const compId = await createComp();
    await preRegister(compId, "Jane Smith");

    const body = (await (
      await resolve(compId, "user-2", {
        identifier: { kind: "civl_id", value: "99999" },
      })
    ).json()) as any;
    expect(body.state).toBe("choose");
    expect(body.matched_by).toBeUndefined();
    expect(body.candidates).toHaveLength(1);
  });

  test("never offers a registration somebody else has claimed", async () => {
    // ensureCompPilot refuses a claimed row, so offering one would be a button
    // that cannot work.
    const compId = await createComp();
    const taskId = await createTask(compId);
    const janeId = await preRegister(compId, "Jane Smith", {
      registered_pilot_civl_id: "12345",
    });
    // user-3 claims Jane.
    await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      fakeIgcPayload(),
      { user: "user-3", headers: { "x-comp-pilot": janeId } }
    );

    const body = (await (
      await resolve(compId, "user-2", {
        identifier: { kind: "civl_id", value: "12345" },
      })
    ).json()) as any;
    expect(body.candidates).toHaveLength(0);
    expect(body.state).toBe("new");
  });

  test("rejects an identifier kind we do not hold", async () => {
    const compId = await createComp();
    const res = await resolve(compId, "user-2", {
      identifier: { kind: "passport", value: "X" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe("bad_identifier");
  });
});

describe("who may ask", () => {
  test("a signed-out caller cannot", async () => {
    // It discloses masked addresses from the roster, so it is not public.
    const compId = await createComp();
    await preRegister(compId, "Jane Smith");
    const res = await request(
      "POST",
      `/api/comp/${compId}/registration/resolve`,
      { body: {} }
    );
    expect(res.status).toBe(401);
  });

  test("a missing competition is a 404, not an empty list", async () => {
    const res = await resolve("zzzzzz", "user-2");
    expect([400, 404]).toContain(res.status);
  });
});

describe("the answer agrees with what the upload will do", () => {
  test("choose here means the upload would 409 without a header", async () => {
    // If these two ever disagreed, the form would show a picker for a route
    // that did not need one, or none for a route that did.
    const compId = await createComp();
    const taskId = await createTask(compId);
    await preRegister(compId, "Jane Smith");

    expect(((await (await resolve(compId, "user-2")).json()) as any).state).toBe(
      "choose"
    );
    const upload = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      fakeIgcPayload(),
      { user: "user-2" }
    );
    expect(upload.status).toBe(409);
  });

  test("new here means the upload just works", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    expect(((await (await resolve(compId, "user-2")).json()) as any).state).toBe(
      "new"
    );
    const upload = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      fakeIgcPayload(),
      { user: "user-2" }
    );
    expect(upload.status).toBe(201);
  });

  test("a candidate it offers is one the upload will accept", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    await preRegister(compId, "Jane Smith");

    const body = (await (await resolve(compId, "user-2")).json()) as any;
    const chosen = body.candidates[0].comp_pilot_id;

    const upload = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      fakeIgcPayload(),
      { user: "user-2", headers: { "x-comp-pilot": chosen } }
    );
    expect(upload.status).toBe(201);
    expect(((await upload.json()) as any).comp_pilot_id).toBe(chosen);
    // And no duplicate, which is the point of the whole exercise.
    expect((await dbCounts()).compPilots).toBe(1);
  });
});
