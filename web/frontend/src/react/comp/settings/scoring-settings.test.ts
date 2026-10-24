import { describe, expect, it } from "vitest";
import { defaultsFor } from "@glidecomp/engine";
import { accessSummary, scoringDefaults, scoringFormValues, scoringPatch, scoringSummary } from "./scoring-settings";

const comp = {
  category: "hg",
  gap_params: null,
  scoring_format: "gap" as const,
  series_scoring: "total" as const,
  ftv_factor: null,
  pilot_classes: ["open", "sport"],
};

describe("scoring settings", () => {
  it("starts from the wing's official defaults, nominal distance on auto", () => {
    const v = scoringFormValues(comp);
    const d = defaultsFor("hg");
    expect(Number.isNaN(v.nominalDistance)).toBe(true);
    expect(v.nominalTime).toBe(Math.round(d.nominalTime / 60));
    expect(v.leadingTimeRatio).toBe(17.5);
  });

  it("saves what it shows: an untouched form round-trips the defaults", () => {
    const body = scoringPatch(scoringFormValues(comp), comp) as { gap_params: Record<string, unknown>; ftv_factor: unknown };
    expect(body.gap_params.scoring).toBe("HG");
    expect(body.gap_params.nominalDistance).toBeNull();
    expect(body.gap_params.leadingTimeRatio).toBeCloseTo(0.175);
    expect(body.gap_params.hgClass2Classes).toEqual([]);
    expect(body.ftv_factor).toBeNull();
  });

  it("an open-distance comp sends no GAP parameters, and sums its tasks", () => {
    const v = { ...scoringFormValues(comp), scoringFormat: "open_distance" as const, seriesScoring: "ftv" as const };
    const body = scoringPatch(v, comp);
    expect(body.gap_params).toBeUndefined();
    expect(body.series_scoring).toBe("total");
  });

  it("Reset puts the GAP fields back and keeps the format", () => {
    const v = { ...scoringFormValues(comp), nominalTime: 1, scoringFormat: "gap" as const, class2Classes: ["sport"] };
    const r = scoringDefaults("hg", v);
    expect(r.nominalTime).toBe(Math.round(defaultsFor("hg").nominalTime / 60));
    expect(r.class2Classes).toEqual(["sport"]);
  });

  it("summarises the rows of the settings index", () => {
    expect(scoringSummary({ scoring_format: "gap", series_scoring: "ftv" })).toBe("GAP · FTV");
    expect(accessSummary({ test: true, open_registration: false })).toBe("Hidden · Admins add pilots");
  });
});
