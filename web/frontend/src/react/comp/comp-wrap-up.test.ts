import { describe, expect, test } from "vitest";
import { deriveWrapUpSteps, isCompClosedForWrapUp } from "./CompWrapUp";

describe("isCompClosedForWrapUp", () => {
  const comp = { close_date: "2020-12-20", timezone: "Australia/Melbourne" };

  test("the close date is the END of that day, in the comp's zone", () => {
    // 23:00 on the 20th in Melbourne: still open.
    expect(isCompClosedForWrapUp(comp, new Date("2020-12-20T12:00:00Z"))).toBe(false);
    // 00:30 on the 21st in Melbourne: closed.
    expect(isCompClosedForWrapUp(comp, new Date("2020-12-20T13:30:00Z"))).toBe(true);
  });

  test("a comp with no close date never prompts", () => {
    expect(isCompClosedForWrapUp({ close_date: null, timezone: null }, new Date("2030-01-01"))).toBe(false);
  });

  test("a comp with no zone reads the date in UTC", () => {
    const utc = { close_date: "2020-12-20", timezone: null };
    expect(isCompClosedForWrapUp(utc, new Date("2020-12-20T23:59:00Z"))).toBe(false);
    expect(isCompClosedForWrapUp(utc, new Date("2020-12-21T00:01:00Z"))).toBe(true);
  });
});

describe("deriveWrapUpSteps", () => {
  test("closing is already done; keeping the record is what is left", () => {
    const steps = deriveWrapUpSteps({ close_date: "2020-12-20" }, false);
    expect(steps.map((s) => [s.key, s.complete])).toEqual([
      ["closed", true],
      ["record", false],
    ]);
    expect(steps[0].label).toBe("Submissions closed on Sun, 20 Dec 2020");
  });

  test("downloading the record completes it", () => {
    expect(deriveWrapUpSteps({ close_date: "2020-12-20" }, true).every((s) => s.complete)).toBe(true);
  });
});
