import { describe, it, expect } from "vitest";
import type { TaskAnalysisBasis } from "@glidecomp/engine";
import { fieldFact, thermalsFact, windFact } from "./basis-facts";
import type { MetricReport } from "./types";

/** A basis with neither airtime field — what a stored v12-or-earlier report gives us. */
const OLD_BASIS: TaskAnalysisBasis = {
  pilotCount: 37,
  gridStepSeconds: 10,
  sharedThermalCount: 182,
  multiPilotThermalCount: 51,
  workingBandFloor: 894,
  workingBandCeiling: 2575,
  workingBandFallback: false,
};

const WINDOW = { from: "2026-01-07T02:05:00Z", to: "2026-01-07T07:40:00Z" };
const SPLIT = { climbPct: 37.6, glidePct: 23.4, searchPct: 39.0, airborneSeconds: 294_840 };
const ZONE = "Australia/Sydney";

const METRIC: UnitPrefsShape = { altitude: "m", speed: "km/h", climbRate: "m/s", distance: "km" };
const IMPERIAL: UnitPrefsShape = { altitude: "ft", speed: "mph", climbRate: "ft/min", distance: "mi" };
type UnitPrefsShape = Parameters<typeof thermalsFact>[1];

describe("fieldFact", () => {
  it("pairs the airtime total with the window it was flown in", () => {
    // 294840 s = 81.9 h, rendered whole above 10 h; window in COMP time
    // (13:05–18:40 AEDT), never the runtime's zone.
    expect(fieldFact({ ...OLD_BASIS, airtimeSplit: SPLIT, analysisWindow: WINDOW }, ZONE)).toBe(
      "37 pilots · 82h (13:05–18:40 AEDT)"
    );
  });

  /**
   * A thin day is exactly when a reader should distrust the correlations the
   * box is sitting under, and "6h" hides that where "5.6h" does not.
   */
  it("keeps a decimal on a thin day, where the total is the warning", () => {
    const out = fieldFact(
      {
        ...OLD_BASIS,
        pilotCount: 7,
        airtimeSplit: { ...SPLIT, airborneSeconds: 20_160 },
        analysisWindow: WINDOW,
      },
      ZONE
    );
    expect(out).toContain("7 pilots");
    expect(out).toContain("5.6h");
  });

  /**
   * The version bump makes stored reports stale, but a stale row is SERVED
   * while it revalidates — so these meet bases without the field and must drop
   * the half they cannot say rather than render "undefined".
   */
  it("falls back to the window alone when a stale row has no split", () => {
    expect(fieldFact({ ...OLD_BASIS, analysisWindow: WINDOW }, ZONE)).toBe(
      "37 pilots · 13:05–18:40 AEDT"
    );
  });

  it("is the pilot count alone when a stale row has neither", () => {
    expect(fieldFact(OLD_BASIS, ZONE)).toBe("37 pilots");
  });
});

describe("thermalsFact", () => {
  /** "51 of 182 multi-pilot" read as though 51 pilots were meant: the count of
   *  thermals is the fact, and how many had company is the qualifier. */
  it("counts the thermals, qualifies how many were shared, and states the band", () => {
    const out = thermalsFact(OLD_BASIS, METRIC);
    // The unit is joined to its number with a non-breaking space (formatAltitude),
    // so match on the parts rather than pasting an invisible character in here.
    expect(out).toContain("182 thermals, 51 shared by 2+");
    expect(out).toMatch(/894–2575\s?m$/);
  });

  it("converts the band to the reader's altitude unit", () => {
    const out = thermalsFact(OLD_BASIS, IMPERIAL);
    expect(out).toContain("ft");
    expect(out).not.toContain(" m");
  });

  /** An estimated band is a weaker reading than a measured one, and the box
   *  must not present the two as the same fact. */
  it("says when the band was estimated", () => {
    expect(thermalsFact({ ...OLD_BASIS, workingBandFallback: true }, METRIC)).toContain(
      "(estimated)"
    );
  });
});

describe("windFact", () => {
  const withWind = (wholeTask: unknown): MetricReport[] =>
    [
      {
        extraSeries: [{ kind: "wind-hourly", hours: [], wholeTask }],
      } as unknown as MetricReport,
    ];

  it("reads the whole-task wind in the charts' own words", () => {
    expect(
      windFact(withWind({ speedKmh: 15.4, directionDeg: 312, n: 88 }), METRIC)
    ).toBe("15 km/h NW");
  });

  it("converts the speed to the reader's unit", () => {
    expect(
      windFact(withWind({ speedKmh: 16.1, directionDeg: 90, n: 12 }), IMPERIAL)
    ).toBe("10 mph E");
  });

  /**
   * On a task nobody thermalled there is no circle to estimate wind from.
   * Reporting the absence of a measurement as a calm day would be a lie the
   * reader cannot see through.
   */
  it("is null when no circle produced an estimate", () => {
    expect(windFact(withWind(null), METRIC)).toBeNull();
  });

  it("is null when the report carries no wind series at all", () => {
    expect(windFact([], METRIC)).toBeNull();
    expect(windFact([{ extraSeries: [] } as unknown as MetricReport], METRIC)).toBeNull();
  });
});
