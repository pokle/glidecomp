import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MetricDistribution,
  captionText,
  fieldStats,
  type CaptionArgs,
} from "./MetricDistribution";
import type { MetricReport, PilotMetricValue } from "../types";

function metric(values: (number | null)[], unit = "km/h"): MetricReport {
  return {
    id: "glide.speed",
    label: "Glide speed",
    shortLabel: "Glide",
    unit,
    family: "gliding",
    direction: "higher",
    explanation: "test metric",
    perPilot: values.map(
      (value, i): PilotMetricValue => ({ trackFile: `t${i}.igc`, value })
    ),
    correlation: null,
  };
}

const pilots = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    trackFile: `t${i}.igc`,
    pilotName: `Pilot ${i}`,
  }));

function caption(over: Partial<CaptionArgs> = {}): string {
  return captionText({
    metricLabel: "Glide ratio",
    unit: "ratio",
    n: 37,
    subjectName: "Katie Muir",
    subjectValue: 8.4,
    mean: 7.1,
    sd: 1.0833333,
    ringed: 3,
    missing: 0,
    ...over,
  });
}

describe("fieldStats", () => {
  // The POPULATION standard deviation, matching the engine's zScoreColumns:
  // this is the whole field, not a sample drawn from a larger one. Divided by
  // n − 1 the same input would give 2.5820, and every SD label on the chart
  // would sit slightly wider than the z-scores the table prints.
  it("takes the population standard deviation, not the sample one", () => {
    const s = fieldStats([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(s?.mean).toBeCloseTo(5, 10);
    expect(s?.sd).toBeCloseTo(2, 10);
  });

  it("ignores non-finite values rather than poisoning the mean", () => {
    const s = fieldStats([1, NaN, 3, Infinity]);
    expect(s?.mean).toBeCloseTo(2, 10);
    expect(s?.sd).toBeCloseTo(1, 10);
  });

  it("is null when nothing is finite", () => {
    expect(fieldStats([])).toBeNull();
    expect(fieldStats([NaN, Infinity])).toBeNull();
  });

  it("reports zero spread for an identical field rather than dividing by it", () => {
    expect(fieldStats([3, 3, 3])).toEqual({ mean: 3, sd: 0 });
  });
});

describe("captionText", () => {
  it("states the field size, the pilot's value and the gap in SD", () => {
    expect(caption()).toBe(
      "Glide ratio for 37 pilots. Katie Muir sat at 8.40, 1.2 SD above the field average of 7.10. " +
        "The shaded band is one standard deviation either side of that average, and the ringed dots " +
        "are the three pilots closest to Katie Muir overall."
    );
  });

  it("says below for a pilot under the average", () => {
    expect(caption({ subjectValue: 6.0 })).toContain(
      "sat at 6.00, 1.0 SD below the field average of 7.10"
    );
  });

  // A pilot a twentieth of a standard deviation off the mean prints as
  // "0.0 SD above", which dresses a rounding artefact up as a finding.
  it("calls a pilot at the mean level with it, and names no direction", () => {
    const text = caption({ subjectValue: 7.13 });
    expect(text).toContain("Katie Muir sat at 7.13, level with the field average.");
    expect(text).not.toContain("above");
    expect(text).not.toContain("below");
  });

  it("treats a zero-spread field as level rather than dividing by zero", () => {
    expect(caption({ subjectValue: 7.1, sd: 0 })).toContain("level with the field average");
  });

  it("puts the ringed clause in the singular for one neighbour", () => {
    expect(caption({ ringed: 1 })).toContain(
      "the ringed dot is the pilot closest to Katie Muir overall."
    );
  });

  it("drops the ringed clause when nothing is ringed", () => {
    const text = caption({ ringed: 0 });
    expect(text).toContain("The shaded band is one standard deviation either side of that average.");
    expect(text).not.toContain("ringed");
  });

  // Drop-don't-fill is the convention everywhere in task analysis, so the
  // chart must say who it left out rather than quietly shrinking the field.
  it("names the pilots with no reading, singular and plural", () => {
    expect(caption({ missing: 1 })).toContain(
      "1 pilot had no reading for this behaviour and is not shown."
    );
    expect(caption({ missing: 3 })).toContain(
      "3 pilots had no reading for this behaviour and are not shown."
    );
  });

  it("says nothing about missing pilots when everyone had a reading", () => {
    expect(caption({ missing: 0 })).not.toContain("no reading");
  });

  it("counts a one-pilot field in the singular", () => {
    expect(caption({ n: 1 })).toContain("Glide ratio for 1 pilot.");
  });
});

describe("MetricDistribution", () => {
  function render(props: Parameters<typeof MetricDistribution>[0]) {
    return renderToStaticMarkup(createElement(MetricDistribution, props));
  }

  const full = {
    metric: metric([30, 32, 34, 36, 38]),
    pilots: pilots(5),
    subjectTrackFile: "t2.igc",
    ringed: [{ trackFile: "t1.igc" }, { trackFile: "t3.igc" }],
  };

  it("draws one dot per pilot, the lane, the SD band and the axis", () => {
    const html = render(full);
    expect((html.match(/<circle/g) ?? []).length).toBe(5 + 2);
    expect(html).toContain("<rect");
    expect(html).toContain("Glide speed (kilometres per hour)");
    expect(html).toContain("Field average");
    expect(html).toContain("−1 SD");
    expect(html).toContain("+1 SD");
  });

  it("names the subject on the chart and in the accessible name", () => {
    const html = render(full);
    expect(html).toContain('role="img"');
    expect(html).toContain("Pilot 2 sat at 34.0, level with the field average.");
  });

  it("gives every dot a tooltip carrying the pilot and the value with its unit", () => {
    expect(render(full)).toContain("<title>Pilot 0 — 30.0 km/h</title>");
  });

  // A missing value is dropped, never imputed — and the caption owns saying so.
  it("drops pilots with no reading and counts them in the caption", () => {
    const html = render({ ...full, metric: metric([30, 32, 34, 36, null]) });
    expect((html.match(/<circle/g) ?? []).length).toBe(4 + 2);
    expect(html).toContain("1 pilot had no reading for this behaviour and is not shown.");
  });

  it("renders nothing when the subject has no reading for the behaviour", () => {
    expect(render({ ...full, metric: metric([30, 32, null, 36, 38]) })).toBe("");
  });

  // One dot is not a spread; the sheet's table still lists everybody.
  it("renders nothing for a field of one", () => {
    expect(
      render({
        ...full,
        metric: metric([34]),
        pilots: pilots(1),
        subjectTrackFile: "t0.igc",
      })
    ).toBe("");
  });

  it("renders nothing when the behaviour is absent altogether", () => {
    expect(render({ ...full, metric: metric([null, null, null, null, null]) })).toBe("");
  });

  // Every pilot identical: there is no band to shade and no ±1 SD to label,
  // and dividing by that spread must not reach the reader as NaN.
  it("survives a field with no spread at all", () => {
    const html = render({ ...full, metric: metric([34, 34, 34, 34, 34]) });
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("−1 SD");
    expect(html).toContain("level with the field average");
  });

  // perPilot carries its own key: pairing by array position is the bug class
  // that has bitten scoring here before.
  it("pairs names by trackFile rather than by position", () => {
    const shuffled = pilots(5).reverse();
    expect(render({ ...full, pilots: shuffled })).toContain(
      "<title>Pilot 0 — 30.0 km/h</title>"
    );
  });

  // Axis title and ticks both come from the shared task-analysis helpers, so
  // this strip and the rank scatter can never name the same unit two ways.
  it("leaves the unit off the axis title when the behaviour has none to name", () => {
    const html = render({ ...full, metric: metric([30, 32, 34, 36, 38], "ratio") });
    expect(html).toContain(">Glide speed</text>");
    expect(html).not.toContain("Glide speed (");
  });

  it("labels percentage ticks with a percent sign", () => {
    const html = render({ ...full, metric: metric([30, 40, 50, 60, 70], "pct") });
    expect(html).toContain(">40%</text>");
  });
});
