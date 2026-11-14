import { describe, expect, test } from "vitest";
import { isCompClosed } from "../src/submission-gate";
import { createCompSchema, updateCompSchema } from "../src/validators";

/**
 * A date-only close date ends with that day in the COMP'S zone. It used to
 * end with the day in UTC, which closed a competition in the Americas in the
 * middle of its last afternoon.
 */
describe("isCompClosed", () => {
  test("no close date never closes", () => {
    expect(isCompClosed(null, "Australia/Melbourne")).toBe(false);
    expect(isCompClosed("", "Australia/Melbourne")).toBe(false);
  });

  test("west of Greenwich, the last evening is still open", () => {
    // 18:30 on 31 December in Los Angeles is 02:30 UTC on 1 January.
    const lastEvening = new Date("2027-01-01T02:30:00Z");
    expect(isCompClosed("2026-12-31", "America/Los_Angeles", lastEvening)).toBe(false);
    // Past local midnight it has closed.
    const afterMidnight = new Date("2027-01-01T08:30:00Z");
    expect(isCompClosed("2026-12-31", "America/Los_Angeles", afterMidnight)).toBe(true);
  });

  test("east of Greenwich, it closes at local midnight, not hours later", () => {
    // 09:00 on 1 January in Melbourne is 22:00 UTC on 31 December.
    const nextMorning = new Date("2026-12-31T22:00:00Z");
    expect(isCompClosed("2026-12-31", "Australia/Melbourne", nextMorning)).toBe(true);
    // 20:00 on the last day is still open.
    const lastEvening = new Date("2026-12-31T09:00:00Z");
    expect(isCompClosed("2026-12-31", "Australia/Melbourne", lastEvening)).toBe(false);
  });

  test("a comp with no zone yet, or an unknown one, reads the day in UTC", () => {
    const at = new Date("2026-12-31T23:30:00Z");
    expect(isCompClosed("2026-12-31", null, at)).toBe(false);
    expect(isCompClosed("2026-12-31", "Not/AZone", at)).toBe(false);
    const next = new Date("2027-01-01T00:30:00Z");
    expect(isCompClosed("2026-12-31", null, next)).toBe(true);
    expect(isCompClosed("2026-12-31", "Not/AZone", next)).toBe(true);
  });

  test("a close date with a time is an instant", () => {
    const close = "2026-12-31T12:00:00Z";
    expect(isCompClosed(close, "America/Los_Angeles", new Date("2026-12-31T11:59:00Z"))).toBe(false);
    expect(isCompClosed(close, "America/Los_Angeles", new Date("2026-12-31T12:01:00Z"))).toBe(true);
  });

  test("text that cannot be read as a date never closes a comp", () => {
    expect(isCompClosed("soon", "Australia/Melbourne")).toBe(false);
  });
});

/** What a close date may be on the way in. */
describe("close_date validation", () => {
  const create = (close_date: unknown) =>
    createCompSchema.safeParse({ name: "Cup", category: "hg", close_date }).success;

  test("a calendar day, a date and time, or nothing", () => {
    for (const ok of ["2026-12-31", "2026-12-31T12:00:00Z", "", null, undefined]) {
      expect(create(ok), String(ok)).toBe(true);
    }
    expect(updateCompSchema.safeParse({ close_date: null }).success).toBe(true);
  });

  test("text that is not a date is refused, and names the field", () => {
    for (const bad of ["31/12/2026", "1 Jan", "soon", "2026-12-31Tnoon"]) {
      expect(create(bad), bad).toBe(false);
    }
    const refused = updateCompSchema.safeParse({ close_date: "31/12/2026" });
    expect(refused.success).toBe(false);
    if (!refused.success) expect(refused.error.issues[0].path).toEqual(["close_date"]);
  });
});
