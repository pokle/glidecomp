// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

import { describe, expect, it } from "bun:test";
import { bestDaylightWindow, sunTimes } from "../src/weather/sun";

const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

/** Assert an epoch ms lands within `tolMin` minutes of an ISO instant. */
function expectNear(actualMs: number, expectedIso: string, tolMin: number) {
  const delta = Math.abs(actualMs - Date.parse(expectedIso)) / MIN_MS;
  expect(delta).toBeLessThanOrEqual(tolMin);
}

describe("sunTimes", () => {
  it("matches the Corryong summer day within a few minutes", () => {
    // Corryong Cup task area (-36.17, 147.86) on 2026-01-05: sunrise ~05:58,
    // sunset ~20:29 AEDT (UTC+11), day length ~14 h 32 m — hand-checked
    // against the sunrise equation (δ ≈ −22.6°, ω₀ ≈ 108.9°).
    const sun = sunTimes(-36.17, 147.86, Date.parse("2026-01-05T00:00:00Z"));
    expect(sun).not.toBeNull();
    expectNear(sun!.sunriseMs, "2026-01-04T18:58:00Z", 10);
    expectNear(sun!.sunsetMs, "2026-01-05T09:29:00Z", 10);
    const lengthH = (sun!.sunsetMs - sun!.sunriseMs) / HOUR_MS;
    expect(lengthH).toBeGreaterThan(14.3);
    expect(lengthH).toBeLessThan(14.8);
  });

  it("gives a ~12 h day on the equator at the equinox", () => {
    const sun = sunTimes(0, 0, Date.parse("2026-03-20T00:00:00Z"));
    expect(sun).not.toBeNull();
    const lengthH = (sun!.sunsetMs - sun!.sunriseMs) / HOUR_MS;
    // Slightly over 12 h because of the −0.833° refraction horizon.
    expect(lengthH).toBeGreaterThan(12);
    expect(lengthH).toBeLessThan(12.4);
    // Solar noon at lon 0 is near 12:00 UTC (equation of time ≈ −7.5 min).
    const noonMs = (sun!.sunriseMs + sun!.sunsetMs) / 2;
    expectNear(noonMs, "2026-03-20T12:08:00Z", 10);
  });

  it("keeps the solar day aligned to the longitude, not the UTC date", () => {
    // In eastern Australia the summer sunrise falls on the PREVIOUS UTC
    // date; the returned window must still be the local day's.
    const sun = sunTimes(-36.17, 147.86, Date.parse("2026-01-05T00:00:00Z"));
    expect(sun!.sunriseMs).toBeLessThan(Date.parse("2026-01-05T00:00:00Z"));
    expect(sun!.sunsetMs).toBeGreaterThan(Date.parse("2026-01-05T00:00:00Z"));
  });

  it("returns null in polar day and polar night", () => {
    expect(sunTimes(80, 0, Date.parse("2026-06-21T00:00:00Z"))).toBeNull();
    expect(sunTimes(80, 0, Date.parse("2026-12-21T00:00:00Z"))).toBeNull();
  });
});

describe("bestDaylightWindow", () => {
  const lat = -36.17;
  const lon = 147.86;

  it("picks ONE local flying day from a whole-UTC-day answer", () => {
    // The task-query fallback for an Australian task: the whole UTC day,
    // which locally runs from late morning through midnight into the next
    // dawn. The window must be the FIRST local day's daylight (the one
    // holding most of the answer), not the next morning's.
    const from = Date.parse("2026-02-14T00:00:00Z");
    const to = Date.parse("2026-02-15T00:00:00Z");
    const win = bestDaylightWindow(lat, lon, from, to);
    expect(win).not.toBeNull();
    // Sunrise on the local 14th falls late on the UTC 13th.
    expect(win!.sunriseMs).toBeGreaterThan(Date.parse("2026-02-13T18:00:00Z"));
    expect(win!.sunriseMs).toBeLessThan(Date.parse("2026-02-13T20:00:00Z"));
    expect(win!.sunsetMs).toBeGreaterThan(Date.parse("2026-02-14T08:30:00Z"));
    expect(win!.sunsetMs).toBeLessThan(Date.parse("2026-02-14T10:00:00Z"));
  });

  it("brackets a task-hours answer with the same day's sun window", () => {
    // Corryong's real task window, 02:00–09:00Z on Jan 5 (13:00–20:00 AEDT):
    // the day's daylight fully contains it, so a clamp keeps every hour.
    const from = Date.parse("2026-01-05T02:00:00Z");
    const to = Date.parse("2026-01-05T09:00:00Z");
    const win = bestDaylightWindow(lat, lon, from, to);
    expect(win).not.toBeNull();
    expect(win!.sunriseMs).toBeLessThan(from);
    expect(win!.sunsetMs).toBeGreaterThan(to);
  });

  it("returns null in polar day, where there is no window to pick", () => {
    const noon = Date.parse("2026-06-21T12:00:00Z");
    expect(bestDaylightWindow(80, 0, noon, noon + HOUR_MS)).toBeNull();
  });
});
