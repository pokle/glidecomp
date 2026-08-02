import { describe, expect, it } from "vitest";
import {
  buildLanes,
  defaultProfileTrack,
  laneEndWords,
  laneSentence,
  lanesCaption,
} from "./metric-lanes";
import type {
  FieldAnalysisReport,
  MetricCorrelation,
  MetricDirection,
  MetricReport,
} from "../types";

/** Four pilots in rank order — the report side of the trackFile join. */
const PILOTS: FieldAnalysisReport["pilots"] = [
  { trackFile: "a.igc", pilotName: "Ana", rank: 1 },
  { trackFile: "b.igc", pilotName: "Bo", rank: 2 },
  { trackFile: "c.igc", pilotName: "Cy", rank: 3 },
  { trackFile: "d.igc", pilotName: "Di", rank: 4 },
];

function metric(
  id: string,
  direction: MetricDirection,
  rho: number | null,
  values: Array<[string, number | null]> = [
    ["a.igc", 1],
    ["b.igc", 2],
    ["c.igc", 3],
    ["d.igc", 4],
  ],
  extra: Partial<MetricReport> = {}
): MetricReport {
  const correlation: MetricCorrelation | null =
    rho === null
      ? null
      : { metricId: id, rho, absRho: Math.abs(rho), n: 4, verdict: "strong" };
  return {
    id,
    label: id,
    unit: "ratio",
    family: "climbing",
    direction,
    explanation: "test",
    perPilot: values.map(([trackFile, value]) => ({ trackFile, value })),
    correlation,
    ...extra,
  };
}

const ids = (lanes: ReturnType<typeof buildLanes>) => lanes.map((l) => l.metricId);

describe("buildLanes ordering", () => {
  it("stacks the strongest separator first and the counter-intuitive last", () => {
    const lanes = buildLanes(
      [
        metric("noise", "higher", 0.02),
        metric("against", "higher", 0.7),
        metric("agrees", "higher", -0.8),
        metric("agrees-a-bit", "lower", 0.4),
      ],
      PILOTS
    );
    expect(ids(lanes)).toEqual(["agrees", "agrees-a-bit", "noise", "against"]);
  });

  it("puts a metric with no coefficient in the middle, with the noise", () => {
    const lanes = buildLanes(
      [
        metric("against", "higher", 0.5),
        metric("nocorr", "higher", null),
        metric("agrees", "higher", -0.5),
      ],
      PILOTS
    );
    expect(ids(lanes)).toEqual(["agrees", "nocorr", "against"]);
  });

  it("breaks ties on id, so SSR and the client agree", () => {
    const input = [metric("b", "higher", -0.5), metric("a", "higher", -0.5)];
    expect(ids(buildLanes(input, PILOTS))).toEqual(["a", "b"]);
    expect(ids(buildLanes([...input].reverse(), PILOTS))).toEqual(["a", "b"]);
  });

  it("does not mutate the caller's array", () => {
    const input = [metric("b", "higher", 0.5), metric("a", "higher", -0.5)];
    buildLanes(input, PILOTS);
    expect(input.map((m) => m.id)).toEqual(["b", "a"]);
  });
});

describe("buildLanes filtering", () => {
  it("drops outcome-derived metrics, which track rank by construction", () => {
    const lanes = buildLanes(
      [
        metric("race.time_behind", "lower", 0.95, undefined, { outcome: true }),
        metric("behaviour", "higher", -0.4),
      ],
      PILOTS
    );
    expect(ids(lanes)).toEqual(["behaviour"]);
  });

  it("drops metrics with no usable value anywhere", () => {
    const lanes = buildLanes(
      [
        metric("day.wind", "neutral", -0.9, [
          ["a.igc", null],
          ["b.igc", null],
          ["c.igc", null],
          ["d.igc", null],
        ]),
        metric("kept", "higher", -0.4),
      ],
      PILOTS
    );
    expect(ids(lanes)).toEqual(["kept"]);
  });
});

describe("buildLanes placement", () => {
  it("orients 'lower' so the best value sits at the high end", () => {
    const [lane] = buildLanes([metric("m", "lower", -0.1)], PILOTS);
    const byPilot = new Map(lane.points.map((p) => [p.pilotName, p]));
    // 1 is the best value on a lower-is-better metric, so it must have the
    // HIGHER percentile of the two.
    expect(byPilot.get("Ana")!.pct).toBeGreaterThan(byPilot.get("Di")!.pct);
    expect(lane.low).toBe(4);
    expect(lane.high).toBe(1);
  });

  it("leaves 'neutral' on raw value order, claiming no direction", () => {
    const [lane] = buildLanes([metric("m", "neutral", -0.1)], PILOTS);
    const byPilot = new Map(lane.points.map((p) => [p.pilotName, p]));
    expect(byPilot.get("Di")!.pct).toBeGreaterThan(byPilot.get("Ana")!.pct);
    expect(lane.low).toBe(1);
    expect(lane.high).toBe(4);
    expect(lane.neutral).toBe(true);
  });

  it("never places a dot at 0 or 100 — midrank, like every other percentile here", () => {
    const [lane] = buildLanes([metric("m", "higher", -0.1)], PILOTS);
    for (const p of lane.points) {
      expect(p.pct).toBeGreaterThan(0);
      expect(p.pct).toBeLessThan(100);
    }
  });

  it("pairs by trackFile, not array position", () => {
    // perPilot deliberately in a different order from PILOTS, with Ana last.
    const [lane] = buildLanes(
      [
        metric("m", "higher", -0.1, [
          ["d.igc", 40],
          ["c.igc", 30],
          ["b.igc", 20],
          ["a.igc", 10],
        ]),
      ],
      PILOTS
    );
    const ana = lane.points.find((p) => p.pilotName === "Ana")!;
    expect(ana.value).toBe(10);
    expect(ana.rank).toBe(1);
  });

  it("drops a null rather than reading it as zero", () => {
    const [lane] = buildLanes(
      [
        metric("m", "higher", -0.1, [
          ["a.igc", null],
          ["b.igc", 2],
          ["c.igc", 3],
          ["d.igc", 4],
        ]),
      ],
      PILOTS
    );
    expect(lane.n).toBe(3);
    expect(lane.missing).toBe(1);
    expect(lane.points.map((p) => p.value)).not.toContain(0);
    // The absent pilot is rank 1, which the caption has to be able to name.
    expect(lane.notableMissingRanks).toEqual([1]);
  });

  it("flags a zero-variance lane instead of drawing a tie cluster", () => {
    const [lane] = buildLanes(
      [
        metric("m", "higher", null, [
          ["a.igc", 7],
          ["b.igc", 7],
          ["c.igc", 7],
          ["d.igc", 7],
        ]),
      ],
      PILOTS
    );
    expect(lane.degenerate).toBe(true);
    expect(lane.points.every((p) => p.pct === 50)).toBe(true);
  });

  it("drops a lane with one measured pilot rather than calling them average", () => {
    // Midrank puts a lone value at exactly 50, so the lane would state "dead
    // average" when it means "only one pilot could be measured". There is no
    // field for a percentile to be within.
    const lanes = buildLanes(
      [
        metric("lonely", "higher", null, [
          ["a.igc", 5],
          ["b.igc", null],
          ["c.igc", null],
          ["d.igc", null],
        ]),
        metric("kept", "higher", -0.4),
      ],
      PILOTS
    );
    expect(ids(lanes)).toEqual(["kept"]);
  });

  it("keeps a two-pilot lane, where position does mean something", () => {
    const [lane] = buildLanes(
      [
        metric("m", "higher", null, [
          ["a.igc", 5],
          ["b.igc", 9],
          ["c.igc", null],
          ["d.igc", null],
        ]),
      ],
      PILOTS
    );
    expect(lane.n).toBe(2);
    expect(lane.points.map((p) => p.pct).sort((x, y) => x - y)).toEqual([25, 75]);
  });

  it("drops a lane whose every value belongs to a pilot the report omits", () => {
    // The blank-column filter reads perPilot before the trackFile join, so
    // this survives it and would otherwise arrive with no dots to label.
    const lanes = buildLanes(
      [
        metric("ghosts-only", "higher", -0.5, [["ghost.igc", 9]]),
        metric("kept", "higher", -0.4),
      ],
      PILOTS
    );
    expect(ids(lanes)).toEqual(["kept"]);
  });

  it("ignores a perPilot entry for a pilot the report doesn't list", () => {
    const [lane] = buildLanes(
      [
        metric("m", "higher", null, [
          ["a.igc", 1],
          ["b.igc", 2],
          ["ghost.igc", 99],
        ]),
      ],
      PILOTS
    );
    expect(lane.n).toBe(2);
    expect(lane.points.map((p) => p.pilotName)).toEqual(["Ana", "Bo"]);
    // The ghost's 99 must not stretch the lane's ends either.
    expect(lane.high).toBe(2);
  });
});

describe("defaultProfileTrack", () => {
  // Auditing the archive found 5 charts of 861 where the winner has no
  // measured value in the whole family (a winner who never shared a thermal
  // has no gaggle metrics), and each drew no connector at all — the exact
  // rows-of-dots state the default profile exists to prevent.
  it("picks the winner when the winner is measured", () => {
    const lanes = buildLanes([metric("a", "higher", -0.5), metric("b", "higher", -0.4)], PILOTS);
    expect(defaultProfileTrack(lanes, PILOTS)).toBe("a.igc");
  });

  it("falls past a leader who has no values to the best pilot who does", () => {
    const absent: Array<[string, number | null]> = [
      ["a.igc", null],
      ["b.igc", 2],
      ["c.igc", 3],
      ["d.igc", 4],
    ];
    const lanes = buildLanes(
      [metric("a", "higher", -0.5, absent), metric("b", "higher", -0.4, absent)],
      PILOTS
    );
    expect(defaultProfileTrack(lanes, PILOTS)).toBe("b.igc");
  });

  it("requires two lanes to call it a profile, not one", () => {
    // Ana appears in one lane only; Bo in both. A single dot is not a profile
    // and the connector needs two points to exist at all.
    const lanes = buildLanes(
      [
        metric("a", "higher", -0.5, [
          ["a.igc", 1],
          ["b.igc", 2],
        ]),
        metric("b", "higher", -0.4, [
          ["a.igc", null],
          ["b.igc", 2],
          ["c.igc", 3],
        ]),
      ],
      PILOTS
    );
    expect(defaultProfileTrack(lanes, PILOTS)).toBe("b.igc");
  });

  it("still marks a lone dot when nobody appears twice", () => {
    const lanes = buildLanes(
      [
        metric("a", "higher", -0.5, [
          ["a.igc", 1],
          ["b.igc", 2],
        ]),
        metric("b", "higher", -0.4, [
          ["c.igc", 3],
          ["d.igc", 4],
        ]),
      ],
      PILOTS
    );
    expect(defaultProfileTrack(lanes, PILOTS)).toBe("a.igc");
  });

  it("returns null when no lane has a dot for anyone in the report", () => {
    expect(defaultProfileTrack([], PILOTS)).toBeNull();
  });
});

describe("lane prose", () => {
  it("names a directional lane's ends best and worst", () => {
    expect(laneEndWords({ neutral: false })).toEqual({ low: "worst", high: "best" });
  });

  it("refuses best/worst on a neutral lane", () => {
    // Calling either end "best" would assert the direction the metric declines
    // to have — the same refusal directionAdjustedPercentile makes.
    expect(laneEndWords({ neutral: true })).toEqual({
      low: "lowest",
      high: "highest",
    });
  });

  it("reads a lane as a sentence, naming a missing leader", () => {
    const [lane] = buildLanes(
      [
        metric("Out-climb", "higher", -0.5, [
          ["a.igc", null],
          ["b.igc", 2],
          ["c.igc", 3],
          ["d.igc", 4],
        ]),
      ],
      PILOTS
    );
    const text = laneSentence(lane);
    expect(text).toContain("worst 2");
    expect(text).toContain("best 4");
    expect(text).toContain("1 not applicable");
    expect(text).toContain("the #1 ranked pilot");
  });

  it("says a degenerate lane is degenerate instead of quoting a median", () => {
    const [lane] = buildLanes(
      [
        metric("m", "higher", null, [
          ["a.igc", 7],
          ["b.igc", 7],
          ["c.igc", 7],
          ["d.igc", 7],
        ]),
      ],
      PILOTS
    );
    expect(laneSentence(lane)).toContain("every one of the 4 measured pilots");
  });
});

describe("lanesCaption", () => {
  const lanes = (metrics: MetricReport[]) => buildLanes(metrics, PILOTS);

  it("says what orders the lanes, since the table below is ordered differently", () => {
    expect(lanesCaption(lanes([metric("m", "higher", -0.5)]))).toContain(
      "strongest separator first"
    );
  });

  it("refuses to claim the right end was better on this task", () => {
    const text = lanesCaption(lanes([metric("m", "higher", -0.5)]));
    expect(text).toContain("expected to be better");
    expect(text).toContain("the ranking's question");
  });

  it("warns that a percentile axis says nothing about spread", () => {
    expect(lanesCaption(lanes([metric("m", "higher", -0.5)]))).toContain(
      "never how spread the field was"
    );
  });

  it("explains † only when a neutral lane is present", () => {
    expect(lanesCaption(lanes([metric("m", "neutral", -0.5)]))).toContain("†");
    expect(lanesCaption(lanes([metric("m", "higher", -0.5)]))).not.toContain("†");
  });

  it("explains the per-lane count only when some lane is short", () => {
    const short = lanes([
      metric("m", "higher", -0.5, [
        ["a.igc", null],
        ["b.igc", 2],
        ["c.igc", 3],
        ["d.igc", 4],
      ]),
    ]);
    expect(lanesCaption(short)).toContain("not a score of zero");
    expect(lanesCaption(lanes([metric("m", "higher", -0.5)]))).not.toContain(
      "not a score of zero"
    );
  });
});
