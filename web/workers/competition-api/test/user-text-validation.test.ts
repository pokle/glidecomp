// Issue #232 — server-side input validation for user-entered comp text,
// defence-in-depth for the SEC-22 stored-XSS fix in #231.
//
// These are VALIDATION rules, not sanitisation: a bad value is refused with a
// 400 that names the field, and a good value is stored exactly as typed. The
// only transform is NFC normalisation, which is canonical equivalence rather
// than an edit. See docs/security-output-encoding.md — the frontend's output
// encoding is still what actually prevents the XSS, and these tests must never
// be read as licence to drop it.

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { authRequest, clearCompData, createComp } from "./helpers";
import {
  createCompPilotSchema,
  createCompSchema,
  createTaskSchema,
  updateCompSchema,
  updatePenaltySchema,
  updatePilotSchema,
  updateTaskSchema,
} from "../src/validators";

const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);
const LF = String.fromCharCode(10);
const DEL = String.fromCharCode(127);
const C1 = String.fromCharCode(0x9b); // CSI — a C1 control, category Cc

const pilot = (overrides: Record<string, unknown> = {}) => ({
  registered_pilot_name: "Alice Smith",
  pilot_class: "open",
  ...overrides,
});

/** The first zod message, which is what `validated()` shows the user. */
function firstError(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  return result.success ? null : result.error!.issues[0]!.message;
}

describe("control characters are rejected in user text", () => {
  test.each([
    ["NUL", NUL],
    ["BEL", BEL],
    ["a line break", LF],
    ["DEL", DEL],
    ["a C1 control", C1],
  ])("a registered pilot name containing %s is a 400", (_label, ch) => {
    const result = createCompPilotSchema.safeParse(
      pilot({ registered_pilot_name: `Alice${ch}Smith` })
    );
    expect(result.success).toBe(false);
    expect(firstError(result)).toBe("must not contain control characters");
  });

  test("a line break cannot be smuggled into a team name", () => {
    // The audit log and the CSV export are line-oriented; a raw LF in a name
    // is how one row becomes two.
    const result = createCompPilotSchema.safeParse(
      pilot({ team_name: `Vic Team${LF}injected,row` })
    );
    expect(result.success).toBe(false);
  });

  test("but a non-breaking space, which is not a control, is fine", () => {
    // U+00A0 sits just past the C1 block. Rejecting it would refuse a name a
    // person can legitimately paste.
    const nbsp = String.fromCharCode(0xa0);
    const result = createCompPilotSchema.safeParse(
      pilot({ registered_pilot_name: `Jean${nbsp}Marc` })
    );
    expect(result.success).toBe(true);
  });

  test("comp, task, pilot-profile and penalty text all refuse them", () => {
    expect(createCompSchema.safeParse({ name: `Comp${NUL}`, category: "pg" }).success).toBe(
      false
    );
    expect(
      createTaskSchema.safeParse({
        name: `Task${NUL}`,
        task_date: "2026-01-01",
        pilot_classes: ["open"],
      }).success
    ).toBe(false);
    expect(updatePilotSchema.safeParse({ phone: `+61 400${NUL}` }).success).toBe(false);
    expect(
      updatePenaltySchema.safeParse({ penalty_points: 10, penalty_reason: `late${NUL}` })
        .success
    ).toBe(false);
  });
});

describe("angle brackets are rejected in name-type fields", () => {
  test.each([
    ["registered_pilot_name", { registered_pilot_name: "<img src=x onerror=alert(1)>" }],
    ["team_name", { team_name: "<script>alert(1)</script>" }],
    ["pilot_class", { pilot_class: "open<" }],
  ])("%s refuses markup", (_label, overrides) => {
    const result = createCompPilotSchema.safeParse(pilot(overrides));
    expect(result.success).toBe(false);
    expect(firstError(result)).toBe("must not contain < or >");
  });

  test("a glider and an emergency contact name refuse them too", () => {
    expect(updatePilotSchema.safeParse({ glider: "Enzo <3" }).success).toBe(false);
    expect(
      updatePilotSchema.safeParse({ emergency_contact_name: "<b>Bob</b>" }).success
    ).toBe(false);
  });

  test("comp and task names refuse them", () => {
    expect(
      createCompSchema.safeParse({ name: "<svg onload=alert(1)>", category: "pg" }).success
    ).toBe(false);
    expect(updateCompSchema.safeParse({ name: "Nats <2026>" }).success).toBe(false);
    expect(updateTaskSchema.safeParse({ name: "Task <1>" }).success).toBe(false);
  });
});

describe("legitimate values still pass through untouched", () => {
  // Quotes, apostrophes and ampersands are real; only output encoding may
  // touch them, and only at the sink. Storing them mangled would corrupt the
  // CSV export, the audit log and name matching.
  test.each([
    "O'Brien",
    'Sean "Birdman" O\'Brien',
    "Fly & Co",
    "Müller",
    "Nguyen Thi Bich",
    "Jose Maria de la Cruz-Sanchez",
  ])("%s is accepted verbatim", (name) => {
    const result = createCompPilotSchema.safeParse(pilot({ registered_pilot_name: name }));
    expect(result.success).toBe(true);
    expect(result.success && result.data.registered_pilot_name).toBe(name.normalize("NFC"));
  });

  test("a driver contact may use angle brackets — it is not a name field", () => {
    const result = createCompPilotSchema.safeParse(
      pilot({ driver_contact: "Jo <jo@example.com>" })
    );
    expect(result.success).toBe(true);
    expect(result.success && result.data.driver_contact).toBe("Jo <jo@example.com>");
  });

  test("weather notes keep their paragraph breaks", () => {
    const notes = `Overdeveloped by 2pm.${LF}${LF}Glass off at 3.`;
    const result = updateTaskSchema.safeParse({ weather_notes: notes });
    expect(result.success).toBe(true);
    expect(result.success && result.data.weather_notes).toBe(notes);
  });

  test("weather notes still refuse the rest of C0", () => {
    expect(updateTaskSchema.safeParse({ weather_notes: `blown out${NUL}` }).success).toBe(
      false
    );
  });
});

describe("Unicode is normalised to NFC on write", () => {
  // The same name typed two ways must land on the same bytes, or it sorts
  // twice, dedupes never, and fails to link to its own account.
  const composed = "M" + String.fromCharCode(0xfc) + "ller"; // U+00FC
  const decomposed = "Mu" + String.fromCharCode(0x308) + "ller"; // u + combining diaeresis

  test("the two spellings differ before validation", () => {
    expect(composed).not.toBe(decomposed);
  });

  test("and are identical after it", () => {
    const a = createCompPilotSchema.safeParse(pilot({ registered_pilot_name: composed }));
    const b = createCompPilotSchema.safeParse(pilot({ registered_pilot_name: decomposed }));
    expect(a.success && b.success).toBe(true);
    expect(a.success && a.data.registered_pilot_name).toBe(
      b.success ? b.data.registered_pilot_name : null
    );
    expect(a.success && a.data.registered_pilot_name).toBe(composed);
  });

  test("pilot classes dedupe across spellings", () => {
    // Two visually identical classes are now caught by the array's duplicate
    // check, which runs after each element is normalised.
    const result = createCompSchema.safeParse({
      name: "Comp",
      category: "pg",
      pilot_classes: ["Sport-" + composed, "Sport-" + decomposed],
    });
    expect(result.success).toBe(false);
    expect(firstError(result)).toBe("Duplicate pilot classes");
  });
});

describe("the existing bounds are untouched", () => {
  test("length caps still apply", () => {
    expect(
      createCompPilotSchema.safeParse(pilot({ registered_pilot_name: "a".repeat(129) }))
        .success
    ).toBe(false);
  });

  test("an empty required name is still refused", () => {
    expect(createCompPilotSchema.safeParse(pilot({ registered_pilot_name: "" })).success).toBe(
      false
    );
  });

  test("nulls still clear an optional field", () => {
    const result = createCompPilotSchema.safeParse(pilot({ team_name: null }));
    expect(result.success).toBe(true);
    expect(result.success && result.data.team_name).toBeNull();
  });
});

describe("the rejection reaches the user as a named validation error", () => {
  // The constraint from issue #232: a refusal must be a clear error the
  // organiser can act on, not a silent edit of their data. `validated()`
  // prefixes the field path, so the roster grid can point at the row.
  beforeEach(async () => {
    await clearCompData();
  });
  afterEach(async () => {
    await clearCompData();
  });

  test("a single create answers 400 naming the field", async () => {
    const compId = await createComp({ pilot_classes: ["open"] });
    const res = await authRequest("POST", `/api/comp/${compId}/pilot`, {
      registered_pilot_name: "<script>alert(1)</script>",
      pilot_class: "open",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("registered_pilot_name: must not contain < or >");
  });

  test("a bulk save names the offending ROW as well as the field", async () => {
    const compId = await createComp({ pilot_classes: ["open"] });
    const res = await authRequest("POST", `/api/comp/${compId}/pilot/bulk`, {
      pilots: [
        { registered_pilot_name: "Alice Smith", pilot_class: "open" },
        { registered_pilot_name: "Bob <b>", pilot_class: "open" },
      ],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("pilots.1.registered_pilot_name: must not contain < or >");
  });

  test("nothing is written when a row is refused", async () => {
    const compId = await createComp({ pilot_classes: ["open"] });
    await authRequest("POST", `/api/comp/${compId}/pilot`, {
      registered_pilot_name: "Mallory <img src=x>",
      pilot_class: "open",
    });
    const list = await authRequest("GET", `/api/comp/${compId}/pilot`);
    const { pilots } = (await list.json()) as { pilots: unknown[] };
    expect(pilots).toHaveLength(0);
  });

  test("an accepted name is stored exactly as typed, entities and all", async () => {
    const compId = await createComp({ pilot_classes: ["open"] });
    const res = await authRequest("POST", `/api/comp/${compId}/pilot`, {
      registered_pilot_name: `Se\u00e1n "Birdman" O'Brien & Co`,
      pilot_class: "open",
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { name: string };
    // Not HTML-encoded on write — docs/security-output-encoding.md. If this
    // ever reads `O&#39;Brien`, the CSV export and the audit log are corrupt.
    expect(data.name).toBe(`Se\u00e1n "Birdman" O'Brien & Co`);
  });
});
