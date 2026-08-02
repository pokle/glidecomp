import { env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";
import {
  anonUploadRequest,
  authRequest,
  clearCompData,
  createComp,
  createTask,
  uploadRequest,
} from "./helpers";

/** Minimal gzip-compressed IGC (manufacturer record + HFDTE), as in igc-routes. */
function fakeIgcPayload(): Uint8Array {
  return new Uint8Array([
    0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x73, 0x8c,
    0x70, 0x0e, 0x31, 0x30, 0x30, 0x0c, 0x49, 0x2d, 0x2e, 0xe1, 0xe5, 0xf2,
    0x70, 0x73, 0x09, 0x71, 0x35, 0x30, 0x34, 0x30, 0x34, 0x32, 0xe3, 0xe5,
    0x02, 0x00, 0x19, 0xac, 0x90, 0xbb, 0x1a, 0x00, 0x00, 0x00,
  ]);
}

/**
 * A comp that accepts anonymous submissions, with one registered pilot.
 *
 * `open_igc_upload` is not settable at creation (migration 0005 defaults it to
 * 1), so turning it OFF needs a PATCH.
 */
async function openCompWithPilot(
  pilot: Record<string, unknown> = {},
  compOverrides: Record<string, unknown> = {},
  openIgcUpload = true
) {
  const compId = await createComp(compOverrides);
  if (!openIgcUpload) {
    await authRequest("PATCH", `/api/comp/${compId}`, {
      open_igc_upload: false,
    });
  }
  const taskId = await createTask(compId);
  const res = await authRequest("POST", `/api/comp/${compId}/pilot`, {
    registered_pilot_name: "Jane Smith",
    pilot_class: "open",
    registered_pilot_civl_id: "12345",
    ...pilot,
  });
  const created = (await res.json()) as { comp_pilot_id: string };
  return { compId, taskId, compPilotId: created.comp_pilot_id };
}

function submit(
  compId: string,
  taskId: string,
  identifier: { kind: string; value: string }
) {
  return anonUploadRequest(compId, taskId, fakeIgcPayload(), identifier);
}

beforeEach(async () => {
  await clearCompData();
  const listed = await env.R2.list();
  if (listed.objects.length > 0) {
    await Promise.all(listed.objects.map((o) => env.R2.delete(o.key)));
  }
});

describe("POST .../igc/open-submit — the happy path", () => {
  test("files a track against the roster pilot the identifier names", async () => {
    const { compId, taskId, compPilotId } = await openCompWithPilot();

    const res = await submit(compId, taskId, { kind: "civl_id", value: "12345" });
    expect(res.status).toBe(201);

    const data = (await res.json()) as Record<string, any>;
    expect(data.replaced).toBe(false);
    expect(data.comp_pilot_id).toBe(compPilotId);
    // Echoed so the dialog can ask "submitting for Jane Smith — is that you?"
    expect(data.pilot_name).toBe("Jane Smith");
    expect(data.pilot_class).toBe("open");
    expect(data.matched_on).toBe("civl_id");

    const row = await env.DB.prepare(
      "SELECT uploaded_by_user_id, uploaded_by_name FROM task_track WHERE task_track_id = (SELECT MAX(task_track_id) FROM task_track)"
    ).first<{ uploaded_by_user_id: string | null; uploaded_by_name: string }>();
    // No account to point at, so the row says so rather than naming someone.
    expect(row?.uploaded_by_user_id).toBeNull();
    expect(row?.uploaded_by_name).toBe("anonymous submission");
  });

  test("returns a flight summary so the pilot can spot the wrong file", async () => {
    const { compId, taskId } = await openCompWithPilot();
    const res = await submit(compId, taskId, { kind: "civl_id", value: "12345" });
    const data = (await res.json()) as Record<string, any>;

    expect(data.flight_summary).not.toBeNull();
    // The stub file has a date header and no fixes — the summary reports what
    // is there and nulls the rest rather than inventing a zero.
    expect(data.flight_summary.flight_date).toBe("2026-01-01");
    expect(data.flight_summary.fix_count).toBe(0);
    expect(data.flight_summary.duration_seconds).toBeNull();
  });

  test("matches on email, case-insensitively", async () => {
    const { compId, taskId } = await openCompWithPilot({
      registered_pilot_email: "Jane@Example.com",
      registered_pilot_civl_id: null,
    });
    // A pilot typing their own address at the end of a flying day gets the
    // case wrong; a match that fails on capitalisation reads as "the
    // organiser never registered me".
    const res = await submit(compId, taskId, {
      kind: "email",
      value: "jane@example.com",
    });
    expect(res.status).toBe(201);
  });

  // Each kind interpolates its OWN column name into the SQL
  // (`cp.registered_pilot_${kind}` / `p.${kind}`), so a typo in any one is a
  // 500 that only that kind's pilots would ever hit.
  const KINDS = [
    ["civl_id", "registered_pilot_civl_id"],
    ["safa_id", "registered_pilot_safa_id"],
    ["ushpa_id", "registered_pilot_ushpa_id"],
    ["bhpa_id", "registered_pilot_bhpa_id"],
    ["dhv_id", "registered_pilot_dhv_id"],
    ["ffvl_id", "registered_pilot_ffvl_id"],
    ["fai_id", "registered_pilot_fai_id"],
  ] as const;

  for (const [kind, column] of KINDS) {
    test(`matches a pilot registered by ${kind}`, async () => {
      const { compId, taskId } = await openCompWithPilot({
        registered_pilot_civl_id: null,
        [column]: "ID-" + kind,
      });
      const res = await submit(compId, taskId, { kind, value: "ID-" + kind });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { matched_on: string }).matched_on).toBe(kind);
    });
  }

  test("matches a pilot whose ids live on their claimed account, not the registration", async () => {
    // The stated reason findCompPilotsByIdentifier exists: once a pilot has
    // claimed their row, the ids may be on `pilot`/`user` rather than on the
    // registration the organiser typed. A pilot at launch with no session
    // still has to be findable.
    const compId = await createComp({ open_igc_upload: true });
    const taskId = await createTask(compId);

    // user-1 joins by uploading (open registration), which links their account.
    await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      fakeIgcPayload(),
      { user: "user-1" }
    );
    // Their identity lives on `pilot`, with nothing on the comp_pilot row.
    await env.DB.prepare("UPDATE pilot SET civl_id = ? WHERE user_id = ?")
      .bind("account-side-99", "user-1")
      .run();

    const res = await submit(compId, taskId, {
      kind: "civl_id",
      value: "account-side-99",
    });
    expect(res.status).toBe(200); // replaces their own track
    expect(((await res.json()) as { pilot_name: string }).pilot_name).toBe(
      "Test Pilot"
    );
  });

  test("matches on the account's email as well as the registered one", async () => {
    const compId = await createComp({ open_igc_upload: true });
    const taskId = await createTask(compId);
    await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      fakeIgcPayload(),
      { user: "user-1" }
    );
    // pilot@test.com is user-1's account address, never typed into the roster.
    const res = await submit(compId, taskId, {
      kind: "email",
      value: "PILOT@test.com",
    });
    expect(res.status).toBe(200);
  });

  test("writes an audit line that says it was anonymous and how", async () => {
    const { compId, taskId } = await openCompWithPilot();
    await submit(compId, taskId, { kind: "civl_id", value: "12345" });

    const rows = await env.DB.prepare(
      "SELECT description FROM audit_log WHERE subject_type = 'track'"
    ).all<{ description: string }>();
    const line = rows.results.map((r) => r.description).join("\n");
    expect(line).toContain("Jane Smith");
    expect(line).toContain("anonymous submission");
    expect(line).toContain("CIVL ID");
    // The label, never the value — the log is public.
    expect(line).not.toContain("12345");
  });
});

describe("POST .../igc/open-submit — never creates anything", () => {
  test("an unmatched identifier adds no pilot and no registration", async () => {
    const { compId, taskId } = await openCompWithPilot();
    const before = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM comp_pilot) AS cp, (SELECT COUNT(*) FROM pilot) AS p"
    ).first<{ cp: number; p: number }>();

    const res = await submit(compId, taskId, { kind: "civl_id", value: "99999" });
    expect(res.status).toBe(404);

    const after = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM comp_pilot) AS cp, (SELECT COUNT(*) FROM pilot) AS p"
    ).first<{ cp: number; p: number }>();
    // The load-bearing invariant: anonymous submission can never grow a
    // competition, so it can never push the per-task pilot cap either.
    expect(after).toEqual(before!);
  });
});

describe("POST .../igc/open-submit — repairable failures", () => {
  test("an unknown identifier names the comp and the organiser", async () => {
    const { compId, taskId } = await openCompWithPilot();
    const res = await submit(compId, taskId, { kind: "civl_id", value: "99999" });

    expect(res.status).toBe(404);
    const data = (await res.json()) as Record<string, any>;
    expect(data.code).toBe("no_pilot_match");
    expect(data.error).toContain("CIVL ID");
    expect(data.comp.name).toBe("Test Comp");
    // The pilot cannot fix a roster; the organiser can, so the answer has to
    // be able to reach them.
    expect(data.organisers[0].email).toBe("pilot@test.com");
  });

  test("two roster rows on one identifier refuse to guess", async () => {
    const { compId, taskId } = await openCompWithPilot();
    await authRequest("POST", `/api/comp/${compId}/pilot`, {
      registered_pilot_name: "Jane Smyth",
      pilot_class: "open",
      registered_pilot_civl_id: "12345",
    });

    const res = await submit(compId, taskId, { kind: "civl_id", value: "12345" });
    expect(res.status).toBe(409);
    const data = (await res.json()) as Record<string, any>;
    expect(data.code).toBe("ambiguous_pilot_match");
    expect(data.match_count).toBe(2);

    const tracks = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM task_track"
    ).first<{ n: number }>();
    expect(tracks?.n).toBe(0);
  });

  test("a comp that has not opened up asks for a sign-in", async () => {
    const { compId, taskId } = await openCompWithPilot({}, {}, false);
    const res = await submit(compId, taskId, { kind: "civl_id", value: "12345" });
    expect(res.status).toBe(403);
    const data = (await res.json()) as Record<string, any>;
    expect(data.code).toBe("anonymous_not_permitted");
    expect(data.organisers).toHaveLength(1);
  });

  test("a closed comp says so and names the organiser", async () => {
    const { compId, taskId } = await openCompWithPilot({}, { close_date: "2020-01-01" });
    const res = await submit(compId, taskId, { kind: "civl_id", value: "12345" });
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, any>;
    expect(data.code).toBe("comp_closed");
    expect(data.close_date).toBe("2020-01-01");
  });

  test("a name is not an identifier we accept", async () => {
    const { compId, taskId } = await openCompWithPilot();
    // Two people share a name, which is why neither the linker nor the
    // resolver will auto-link on one. An anonymous caller has less standing
    // than either, so this must stay closed.
    const res = await submit(compId, taskId, { kind: "name", value: "Jane Smith" });
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, any>;
    expect(data.code).toBe("bad_identifier");
    expect(data.accepted_kinds).not.toContain("name");
  });

  test("a missing identifier is a repairable error, not a crash", async () => {
    const { compId, taskId } = await openCompWithPilot();
    const res = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc/open-submit`,
      fakeIgcPayload()
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe("bad_identifier");
  });

  test("a file that is not an IGC says which rule it broke", async () => {
    const { compId, taskId } = await openCompWithPilot();
    const res = await anonUploadRequest(
      compId,
      taskId,
      new Uint8Array([1, 2, 3, 4]),
      { kind: "civl_id", value: "12345" }
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, any>;
    expect(data.code).toBe("invalid_file");
    expect(typeof data.reason).toBe("string");
  });
});

describe("POST .../igc/open-submit — a hidden comp stays hidden", () => {
  test("a test comp answers exactly as a missing one", async () => {
    const { compId, taskId } = await openCompWithPilot({}, { test: true });
    const res = await submit(compId, taskId, { kind: "civl_id", value: "12345" });
    expect(res.status).toBe(404);
    const data = (await res.json()) as Record<string, any>;
    expect(data.code).toBe("comp_not_found");
    // No comp name, no organisers — nothing that confirms it exists.
    expect(data.comp).toBeUndefined();
  });
});

describe("POST .../igc/open-submit — replacing a track", () => {
  test("replaces, preserves the scorekeeper's penalty, and reports the notice", async () => {
    const { compId, taskId, compPilotId } = await openCompWithPilot({
      registered_pilot_email: "jane@example.com",
    });

    const first = await submit(compId, taskId, { kind: "civl_id", value: "12345" });
    expect(first.status).toBe(201);

    await authRequest(
      "PATCH",
      `/api/comp/${compId}/task/${taskId}/igc/${compPilotId}`,
      { penalty_points: 25, penalty_reason: "Airspace" }
    );

    const second = await submit(compId, taskId, { kind: "civl_id", value: "12345" });
    expect(second.status).toBe(200);
    const data = (await second.json()) as Record<string, any>;
    expect(data.replaced).toBe(true);
    // Masked: enough to recognise, not enough to learn.
    expect(data.notified).toEqual({
      emailed: true,
      masked_to: "j***@example.com",
    });

    const row = await env.DB.prepare(
      "SELECT penalty_points, penalty_reason FROM task_track WHERE comp_pilot_id = (SELECT comp_pilot_id FROM comp_pilot LIMIT 1)"
    ).first<{ penalty_points: number; penalty_reason: string }>();
    expect(row?.penalty_points).toBe(25);
    expect(row?.penalty_reason).toBe("Airspace");
  });

  test("records in the audit log when there is nobody to advise", async () => {
    const { compId, taskId } = await openCompWithPilot();
    await submit(compId, taskId, { kind: "civl_id", value: "12345" });
    const res = await submit(compId, taskId, { kind: "civl_id", value: "12345" });

    const data = (await res.json()) as Record<string, any>;
    expect(data.notified).toEqual({
      emailed: false,
      reason: "no_registered_email",
    });

    // The replacement still stands — refusing it would punish the pilots
    // whose organiser did the least data entry — so the log is now the only
    // record and has to say so.
    const rows = await env.DB.prepare(
      "SELECT description FROM audit_log"
    ).all<{ description: string }>();
    expect(rows.results.map((r) => r.description).join("\n")).toContain(
      "Could not advise Jane Smith"
    );
  });
});

describe("POST .../igc/open-submit — the rest of the error taxonomy", () => {
  test("a task from another competition is not found", async () => {
    const { compId } = await openCompWithPilot();
    const otherComp = await createComp({ open_igc_upload: true });
    const strayTask = await createTask(otherComp);

    const res = await submit(compId, strayTask, { kind: "civl_id", value: "12345" });
    expect(res.status).toBe(404);
    const data = (await res.json()) as Record<string, any>;
    expect(data.code).toBe("task_not_found");
    expect(data.comp.name).toBe("Test Comp");
  });

  test("a malformed percent-encoded identifier is refused, not thrown", async () => {
    const { compId, taskId } = await openCompWithPilot();
    const res = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc/open-submit`,
      fakeIgcPayload(),
      { headers: { "x-pilot-ident-kind": "civl_id", "x-pilot-ident": "%E0%A4%A" } }
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("bad_identifier");
  });

  test("an identifier of only whitespace is refused", async () => {
    const { compId, taskId } = await openCompWithPilot();
    const res = await submit(compId, taskId, { kind: "civl_id", value: "   " });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("bad_identifier");
  });

  test("an absurdly long identifier is refused before any lookup", async () => {
    const { compId, taskId } = await openCompWithPilot();
    const res = await submit(compId, taskId, {
      kind: "civl_id",
      value: "x".repeat(200),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("bad_identifier");
  });

  test("a cookie does not change the answer", async () => {
    // The route deliberately has no auth middleware at all. If a session
    // could change its behaviour it would quietly be two routes.
    const { compId, taskId } = await openCompWithPilot();
    const anon = await submit(compId, taskId, { kind: "civl_id", value: "99999" });
    const signedIn = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc/open-submit`,
      fakeIgcPayload(),
      {
        user: "user-1",
        headers: {
          "x-pilot-ident-kind": "civl_id",
          "x-pilot-ident": "99999",
        },
      }
    );
    expect(signedIn.status).toBe(anon.status);
    expect(((await signedIn.json()) as { code: string }).code).toBe("no_pilot_match");
  });
});

describe("POST .../igc/open-submit — budgets", () => {
  test("stops rewriting one pilot's track after the daily allowance", async () => {
    const { compId, taskId } = await openCompWithPilot();

    // ANON_SUBMIT_PER_PILOT is 6 a day: enough for a pilot to fix a genuinely
    // wrong upload several times, not enough to sit there overwriting.
    for (let i = 0; i < 6; i++) {
      const ok = await submit(compId, taskId, { kind: "civl_id", value: "12345" });
      expect(ok.status).toBe(i === 0 ? 201 : 200);
    }

    const blocked = await submit(compId, taskId, {
      kind: "civl_id",
      value: "12345",
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    const data = (await blocked.json()) as Record<string, any>;
    expect(data.code).toBe("rate_limited");
    expect(data.scope).toBe("pilot");
  });

  test("stops a run of probes at somebody's address", async () => {
    // ANON_SUBMIT_MISSES is 20/day. Without it, the endpoint answers "is this
    // address registered for this comp?" as fast as anyone can ask — and
    // email is the one identifier NOT already on the public roster.
    const { compId, taskId } = await openCompWithPilot();
    let last: Response | undefined;
    for (let i = 0; i < 21; i++) {
      last = await submit(compId, taskId, {
        kind: "email",
        value: `guess-${i}@example.com`,
      });
    }
    expect(last!.status).toBe(429);
    const data = (await last!.json()) as Record<string, any>;
    expect(data.scope).toBe("probe");
    expect(last!.headers.get("Retry-After")).toBeTruthy();
  });

  test("charges the probe budget only when nothing matched", async () => {
    const { compId, taskId } = await openCompWithPilot();

    // Successful submissions must not consume the miss budget, or a pilot
    // re-uploading would lock themselves out of ever mistyping.
    await submit(compId, taskId, { kind: "civl_id", value: "12345" });
    const charged = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM "rateLimit" WHERE "key" LIKE 'anon-igc:miss:%'`
    ).first<{ n: number }>();
    expect(charged?.n).toBe(0);

    await submit(compId, taskId, { kind: "civl_id", value: "99999" });
    const afterMiss = await env.DB.prepare(
      `SELECT "count" FROM "rateLimit" WHERE "key" LIKE 'anon-igc:miss:%'`
    ).first<{ count: number }>();
    expect(afterMiss?.count).toBe(1);
  });
});
