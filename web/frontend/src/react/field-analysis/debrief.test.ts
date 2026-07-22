import { describe, expect, it } from "vitest";
import { debriefFindings, debriefSentence } from "./debrief";
import type { CompAggregateReport, CompMetricAggregate } from "./types";

function metric(
  id: string,
  perTask: ({ rho: number; n: number; noiseFloor: number } | null)[],
  outcome?: true,
): CompMetricAggregate {
  return {
    id,
    label: id,
    unit: "ratio",
    direction: "neutral",
    ...(outcome ? { outcome } : {}),
    perTaskRho: perTask.map((c) => c?.rho ?? null),
    perTaskCorrelation: perTask,
    meanAbsRho: null,
    meanSignedRho: null,
    signSummary: { negative: 0, positive: 0, quiet: 0 },
    consistency: "quiet",
    compRho: null,
  };
}

const informative = (rho: number, n = 20) => ({ rho, n, noiseFloor: 0.44 });
const noisy = (rho: number, n = 20) => ({ rho, n, noiseFloor: 0.9 });

function report(metrics: CompMetricAggregate[]): CompAggregateReport {
  return { taskLabels: ["T1", "T2", "T3", "T4"], pilots: [], metrics };
}

describe("debriefFindings", () => {
  it("flags an informative sign that contradicts a consistent other-task consensus", () => {
    const agg = report([
      metric("m", [informative(0.62), informative(-0.5), informative(-0.55), null]),
    ]);
    const findings = debriefFindings(agg, 0);
    expect(findings.length).toBe(1);
    expect(findings[0].higherBetterToday).toBe(false);
    expect(findings[0].otherCount).toBe(2);
    expect(debriefSentence(findings[0])).toContain("opposite of this comp's other tasks");
  });

  it("stays silent when today's coefficient is within noise", () => {
    const agg = report([
      metric("m", [noisy(0.62), informative(-0.5), informative(-0.55), null]),
    ]);
    expect(debriefFindings(agg, 0)).toEqual([]);
  });

  it("stays silent when the other tasks are split or too few", () => {
    // Others split — no consensus to contradict.
    const split = report([
      metric("m", [informative(0.62), informative(-0.5), informative(0.55), null]),
    ]);
    expect(debriefFindings(split, 0)).toEqual([]);
    // Only one informative other task — not a consensus.
    const lone = report([metric("m", [informative(0.62), informative(-0.5), null, null])]);
    expect(debriefFindings(lone, 0)).toEqual([]);
  });

  it("excludes the current task from its own consensus", () => {
    // Seen from task 1's seat, tasks 0/2 agree negative and task 1 flipped.
    const agg = report([
      metric("m", [informative(-0.5), informative(0.6), informative(-0.55), null]),
    ]);
    expect(debriefFindings(agg, 1).length).toBe(1);
    // Seen from task 0's seat the others are split — silent.
    expect(debriefFindings(agg, 0)).toEqual([]);
  });

  it("ignores outcome metrics and small-n tasks, and caps at three findings", () => {
    const flip = (id: string) =>
      metric(id, [informative(0.62), informative(-0.5), informative(-0.55), null]);
    const agg = report([
      metric("outcome", [informative(0.9), informative(-0.9), informative(-0.9), null], true),
      metric("small-n", [informative(0.9, 5), informative(-0.9), informative(-0.9), null]),
      flip("a"),
      flip("b"),
      flip("c"),
      flip("d"),
    ]);
    const findings = debriefFindings(agg, 0);
    expect(findings.length).toBe(3);
    expect(findings.every((f) => !["outcome", "small-n"].includes(f.metricId))).toBe(true);
  });
});
