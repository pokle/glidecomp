// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
import { describe, expect, test } from "bun:test";
import { currentMonthStart, hasNewer, needsCheck } from "./ranking-schedule";

describe("currentMonthStart", () => {
  test("is the first of the month, in UTC", () => {
    expect(currentMonthStart(new Date("2026-07-29T10:31:51Z"))).toBe("2026-07-01");
    expect(currentMonthStart(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01");
    expect(currentMonthStart(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12-01");
  });

  test("uses UTC, not the runner's zone", () => {
    // A CI runner in UTC+11 would call this Jan 1 local. The stored dates come
    // from CIVL's own sheet, so the comparison has to be in one fixed zone or
    // the rollover happens on different days for different runners.
    expect(currentMonthStart(new Date("2025-12-31T20:00:00Z"))).toBe("2025-12-01");
  });
});

describe("needsCheck — the no-network gate", () => {
  const JULY = "2026-07-01";

  test("a list we have never fetched always gets checked", () => {
    expect(needsCheck(undefined, JULY)).toBe(true);
  });

  test("holding this month's list means no request at all", () => {
    // The steady state: ~30 days a month cost civlcomps.org nothing.
    expect(needsCheck("2026-07-01", JULY)).toBe(false);
  });

  test("holding last month's list means look", () => {
    expect(needsCheck("2026-06-01", JULY)).toBe(true);
  });

  test("keeps looking every day of a month CIVL has not published", () => {
    // CIVL published in June, it is now late July and nothing new has
    // appeared. Every daily run must still check.
    for (const day of ["2026-07-02", "2026-07-15", "2026-07-31"]) {
      expect(needsCheck("2026-06-01", currentMonthStart(new Date(`${day}T04:00:00Z`)))).toBe(true);
    }
  });

  test("a skipped month does not wedge it", () => {
    // CIVL never published August. In September the stored date is still July,
    // which is behind September's start, so it looks — and will find September.
    expect(needsCheck("2026-07-01", "2026-09-01")).toBe(true);
  });

  test("--force checks regardless", () => {
    expect(needsCheck("2026-07-01", JULY, true)).toBe(true);
  });

  test("a stored date ahead of the month start still counts as current", () => {
    // Not expected from CIVL (they publish on the 1st), but a mid-month
    // ranking_date must not read as 'behind'.
    expect(needsCheck("2026-07-15", JULY)).toBe(false);
  });
});

describe("hasNewer — the gate after one page load", () => {
  test("exports when the page advertises something newer", () => {
    expect(hasNewer("2026-06-01", "2026-07-01")).toBe(true);
  });

  test("does not re-export what we already hold", () => {
    // The month has rolled over but CIVL has not published yet. We looked,
    // there is nothing new, and we stop before the expensive export job.
    expect(hasNewer("2026-06-01", "2026-06-01")).toBe(false);
  });

  test("does not go backwards if the page somehow advertises an older period", () => {
    expect(hasNewer("2026-07-01", "2026-06-01")).toBe(false);
  });

  test("a list we have never fetched always exports", () => {
    expect(hasNewer(undefined, "2026-07-01")).toBe(true);
  });

  test("--force re-exports the month already stored", () => {
    expect(hasNewer("2026-07-01", "2026-07-01", true)).toBe(true);
  });

  test("orders by string, which is correct for ISO dates across a year boundary", () => {
    expect(hasNewer("2025-12-01", "2026-01-01")).toBe(true);
    expect(hasNewer("2026-01-01", "2025-12-01")).toBe(false);
  });
});
