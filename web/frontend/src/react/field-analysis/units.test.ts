import { describe, expect, it } from "vitest";
import type { UnitPreferences } from "@glidecomp/engine";
import type { FieldAnalysisReport } from "./types";
import { displayReport, unitDisplay, unitWords } from "./units";

const METRIC: UnitPreferences = {
  speed: "km/h",
  altitude: "m",
  distance: "km",
  climbRate: "m/s",
};
const IMPERIAL: UnitPreferences = {
  speed: "mph",
  altitude: "ft",
  distance: "mi",
  climbRate: "ft/min",
};

describe("unitDisplay", () => {
  it("is the identity under metric preferences", () => {
    for (const u of ["km/h", "m/s", "m", "pct", "min", "ratio"]) {
      expect(unitDisplay(u, METRIC)).toEqual({ unit: u, factor: 1 });
    }
  });
  it("maps km/h by the speed preference", () => {
    expect(unitDisplay("km/h", IMPERIAL)).toEqual({ unit: "mph", factor: 0.621371 });
    expect(unitDisplay("km/h", { ...METRIC, speed: "knots" }).unit).toBe("kts");
  });
  it("maps m/s by the climb preference", () => {
    expect(unitDisplay("m/s", IMPERIAL)).toEqual({ unit: "fpm", factor: 196.85 });
    expect(unitDisplay("m/s", { ...METRIC, climbRate: "knots" }).unit).toBe("kts");
  });
  it("maps m by the altitude preference", () => {
    expect(unitDisplay("m", IMPERIAL)).toEqual({ unit: "ft", factor: 3.281 });
  });
  it("passes dimensionless and time units through untouched", () => {
    for (const u of ["pct", "s", "min", "count", "ratio"]) {
      expect(unitDisplay(u, IMPERIAL)).toEqual({ unit: u, factor: 1 });
    }
  });
});

describe("displayReport", () => {
  const report = {
    metrics: [
      {
        id: "glide.speed",
        unit: "km/h",
        perPilot: [
          { trackFile: "a.igc", value: 60 },
          { trackFile: "b.igc", value: null },
        ],
      },
      {
        id: "race.start_delay",
        unit: "min",
        perPilot: [{ trackFile: "a.igc", value: 12 }],
      },
    ],
  } as unknown as FieldAnalysisReport;

  it("returns the same object when nothing converts", () => {
    expect(displayReport(report, METRIC)).toBe(report);
  });
  it("converts values and unit tokens, leaving nulls and other units alone", () => {
    const out = displayReport(report, IMPERIAL);
    expect(out).not.toBe(report);
    expect(out.metrics[0].unit).toBe("mph");
    expect(out.metrics[0].perPilot[0].value).toBeCloseTo(37.28, 2);
    expect(out.metrics[0].perPilot[1].value).toBeNull();
    // Non-physical metrics keep their identity (memo-friendly).
    expect(out.metrics[1]).toBe(report.metrics[1]);
  });
});

describe("unitWords", () => {
  it("spells out the display tokens for screen readers", () => {
    expect(unitWords("mph")).toBe("miles per hour");
    expect(unitWords("kts")).toBe("knots");
    expect(unitWords("fpm")).toBe("feet per minute");
    expect(unitWords("ft")).toBe("feet");
  });
});
