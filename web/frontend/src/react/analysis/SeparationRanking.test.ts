/**
 * The ranking's URL parameter, which is the whole of the section's selection
 * state. Absent, empty and junk must all mean "nothing chosen": stacked, that
 * is the ranking as the view, and "All behaviours" — which deletes the
 * parameter — must not put the reader straight back into a chart.
 */
import { describe, it, expect } from "vitest";
import { metricFromParam } from "./SeparationRanking";

const ids = ["climb.shared_percentile", "glide.speed", "gaggle.affinity"];

describe("metricFromParam", () => {
  it("chooses nothing when the parameter is absent", () => {
    expect(metricFromParam(null, ids)).toBeNull();
  });

  it("chooses nothing for an empty or unrecognised value", () => {
    expect(metricFromParam("", ids)).toBeNull();
    expect(metricFromParam("not-a-metric", ids)).toBeNull();
    expect(metricFromParam("climb", ids)).toBeNull();
  });

  it("chooses nothing for an id this ranking does not carry", () => {
    expect(metricFromParam("race.time_behind", ids)).toBeNull();
  });

  it("chooses the metric the value names, dotted ids included", () => {
    expect(metricFromParam("climb.shared_percentile", ids)).toBe(
      "climb.shared_percentile"
    );
    expect(metricFromParam("gaggle.affinity", ids)).toBe("gaggle.affinity");
  });
});
