import { describe, expect, it } from "vitest";
import { TO_SI, type UnitPreferences } from "@glidecomp/engine";
import type { TaskAnalysisReport } from "./types";
import { displayReport, unitDisplay, unitWords, verdictWords } from "./units";

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
    // Factors derive from the engine's exact TO_SI table, not hand-typed
    // truncations, so this display can never drift from the engine's own
    // formatting. The closeTo pins catch a wrong derivation (inverted,
    // wrong unit) without re-pinning truncated constants.
    const mph = unitDisplay("km/h", IMPERIAL);
    expect(mph).toEqual({ unit: "mph", factor: TO_SI["km/h"] / TO_SI.mph });
    expect(mph.factor).toBeCloseTo(0.621371, 6);
    expect(unitDisplay("km/h", { ...METRIC, speed: "knots" }).unit).toBe("kts");
  });
  it("maps m/s by the climb preference", () => {
    const fpm = unitDisplay("m/s", IMPERIAL);
    expect(fpm).toEqual({ unit: "fpm", factor: 1 / TO_SI["ft/min"] });
    expect(fpm.factor).toBeCloseTo(196.8504, 4);
    expect(unitDisplay("m/s", { ...METRIC, climbRate: "knots" }).unit).toBe("kts");
  });
  it("maps m by the altitude preference", () => {
    const ft = unitDisplay("m", IMPERIAL);
    expect(ft).toEqual({ unit: "ft", factor: 1 / TO_SI.ft });
    expect(ft.factor).toBeCloseTo(3.28084, 5);
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
  } as unknown as TaskAnalysisReport;

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

describe("verdictWords", () => {
  it("says what each verdict means rather than how it was reached", () => {
    expect(verdictWords("strong")).toBe("clear pattern");
    expect(verdictWords("moderate")).toBe("some pattern");
    expect(verdictWords("weak")).toBe("faint pattern");
    expect(verdictWords("n too small")).toBe("too few pilots");
  });
  it("turns the statistical 'within noise' into a conclusion", () => {
    // The one that sent a reader to a glossary: it named the test, not the
    // finding.
    expect(verdictWords("within noise")).toBe("could be chance");
  });
});
