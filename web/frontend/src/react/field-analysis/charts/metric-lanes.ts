/**
 * Lane building for {@link MetricLanes} — which lanes, in what order, with
 * which pilot sitting where, and the prose that describes the result.
 *
 * Pure and separate from the component for the reason `chart-utils.test.ts`
 * and `PercentileHeatmap.test.ts` already establish here: the decisions worth
 * testing are the filtering, the ordering and the sentences, none of which
 * need a rendering harness.
 */
import {
  formatMetricValue,
  type FieldAnalysisReport,
  type MetricReport,
} from "../types";
import { unitWords } from "../units";
import { notableExcludedRanks, notableRanksPhrase } from "../exclusions";
import {
  directionAdjustedPercentile,
  orientedRho,
  quantileSorted,
} from "./chart-utils";

/** One pilot's dot on one lane. */
export interface LanePoint {
  trackFile: string;
  pilotName: string;
  rank: number;
  /** The metric's own value, in whatever units the display report carries. */
  value: number;
  /** Direction-adjusted percentile within THIS lane's measured pilots, 0–100. */
  pct: number;
}

/** One metric's lane. */
export interface Lane {
  metricId: string;
  label: string;
  /** The compact form the gutter renders — the same vocabulary as the tables. */
  shortLabel: string;
  unit: string;
  direction: MetricReport["direction"];
  /** No good/bad direction: the lane is NOT oriented, and is marked with †. */
  neutral: boolean;
  points: LanePoint[];
  /** Pilots with a usable value — this lane's percentile population. */
  n: number;
  /** Pilots in the report with no usable value here. */
  missing: number;
  /** Top-3 ranks among the missing, so a lane without the winner says so. */
  notableMissingRanks: number[];
  /** Values at the low end, the middle and the high end of the lane, in the
   * lane's own left-to-right order (so `low` is the leftmost dot's value). */
  low: number;
  median: number;
  high: number;
  /** Every pilot produced the same value — every dot lands on P50. */
  degenerate: boolean;
}

/** Metrics that can't be a lane, and why, as a filter. */
function laneable(m: MetricReport): boolean {
  // Outcome-derived metrics ("race time behind the leader") track rank by
  // construction, so their lane would run cleanly best-to-worst and read as a
  // finding about flying. `rankMetrics()` and `heatmapColumns()` both exclude
  // them for that reason; the per-pilot tables still carry their values.
  if (m.outcome) return false;
  // A lane of nothing (the field-level day metrics carry no per-pilot values
  // at all) is not a lane.
  return m.perPilot.some((p) => p.value !== null && Number.isFinite(p.value));
}

/**
 * The lanes for a set of metrics, in the order they should stack.
 *
 * Ordered by {@link orientedRho} descending — the behaviours whose better end
 * went with better placings first, the ones that said nothing last. Same key
 * and same direction as the percentile heatmap's columns, so the two read the
 * same way round; note the per-pilot table below a lane stack keeps its own
 * registry order, which is why the caption says what orders the lanes.
 *
 * Ties break on a plain codepoint compare of the id, never `localeCompare`:
 * these pages are server-rendered, and collation differing between workerd's
 * ICU and the browser's would be a hydration mismatch.
 *
 * Percentiles are midrank (`directionAdjustedPercentile` → `percentileRank`),
 * matching every other percentile on the page — the heatmap cell, the ⓘ
 * popover strip, the cluster medians. A consequence worth stating in the
 * caption rather than leaving to be noticed: no dot ever reaches 0 or 100.
 *
 * Each lane's percentile is over ITS OWN measured pilots, not the whole
 * report — P50 of 31 and P50 of 38 are not the same statistic, hence `n` on
 * every lane.
 */
export function buildLanes(
  metrics: MetricReport[],
  pilots: FieldAnalysisReport["pilots"]
): Lane[] {
  const byTrack = new Map(pilots.map((p) => [p.trackFile, p]));

  return metrics
    .filter(laneable)
    .slice()
    .sort(
      (a, b) =>
        orientedRho(b) - orientedRho(a) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    )
    .map((m) => {
      // Pair by trackFile, never by array index — the project's standing rule,
      // and `perPilot` is only aligned to `pilots` by construction upstream.
      const usable = m.perPilot.flatMap((p) => {
        const pilot = byTrack.get(p.trackFile);
        if (!pilot || p.value === null || !Number.isFinite(p.value)) return [];
        return [{ pilot, value: p.value }];
      });
      const values = usable.map((u) => u.value);
      const sorted = [...values].sort((x, y) => x - y);
      const neutral = m.direction === "neutral";

      const points: LanePoint[] = usable.map(({ pilot, value }) => ({
        trackFile: pilot.trackFile,
        pilotName: pilot.pilotName,
        rank: pilot.rank,
        value,
        pct: directionAdjustedPercentile(m.direction, values, value),
      }));

      const min = sorted[0];
      const max = sorted[sorted.length - 1];
      // The lane's ends, not the value extremes: on a 'lower'-is-better lane
      // the left end holds the LARGEST value, because the axis is oriented.
      const flipped = m.direction === "lower";

      return {
        metricId: m.id,
        label: m.label,
        shortLabel: m.shortLabel ?? m.label,
        unit: m.unit,
        direction: m.direction,
        neutral,
        points,
        n: usable.length,
        missing: m.perPilot.length - usable.length,
        notableMissingRanks: notableExcludedRanks(pilots, m.perPilot),
        low: flipped ? max : min,
        median: quantileSorted(sorted, 0.5),
        high: flipped ? min : max,
        degenerate: sorted.length > 0 && min === max,
      } satisfies Lane;
    })
    // Two dots minimum, for two different reasons.
    //
    // `laneable` reads perPilot before the trackFile join, so a metric whose
    // only values belong to pilots this report doesn't list arrives here with
    // no dots at all — nothing to label, nothing to say.
    //
    // And a single dot cannot be a percentile: there is no field for it to sit
    // within, so midrank puts it at exactly 50 and the lane states "this pilot
    // was dead average" when the truth is "only one pilot could be measured".
    // The coverage count discloses the n, but position is what a reader reads
    // first, and at n = 1 it is false. Auditing the archive found 136 such
    // lanes across 3,401 — too many to leave asserting it. The value is still
    // in the per-pilot table below, which is where a single reading belongs.
    .filter((lane) => lane.n >= 2);
}

/**
 * Whose profile the chart draws when nobody is hovered.
 *
 * The best-ranked pilot who actually appears in at least two of these lanes —
 * NOT simply rank 1. A percentile axis spreads the field near-evenly by
 * construction, so a chart with no connector is rows of dots and nothing else,
 * which is what print and a reader who never hovers would be left with. Rank 1
 * having no measured value in a family is rare but real: auditing the archive
 * found 5 charts across 861 where it happens (a winner who never shared a
 * thermal has no gaggle metrics at all), and each of those drew nothing.
 *
 * Two lanes, not one: a single dot is not a profile, and the connector needs
 * two points to exist.
 */
export function defaultProfileTrack(
  lanes: Lane[],
  pilots: FieldAnalysisReport["pilots"]
): string | null {
  const laneCount = new Map<string, number>();
  for (const lane of lanes) {
    for (const p of lane.points) {
      laneCount.set(p.trackFile, (laneCount.get(p.trackFile) ?? 0) + 1);
    }
  }
  const ranked = [...pilots].sort((a, b) => a.rank - b.rank);
  return (
    ranked.find((p) => (laneCount.get(p.trackFile) ?? 0) >= 2)?.trackFile ??
    // Nobody appears twice (a one-lane-each field): fall back to anyone with a
    // dot, so at least their position is marked, then to nothing.
    ranked.find((p) => laneCount.has(p.trackFile))?.trackFile ??
    null
  );
}

/**
 * What the two ends of a lane are called. A directional lane has a better end
 * and a worse one; a neutral lane only has a bigger end and a smaller one, and
 * calling either "best" would assert the direction the metric refuses to have.
 */
export function laneEndWords(lane: Pick<Lane, "neutral">): {
  low: string;
  high: string;
} {
  return lane.neutral
    ? { low: "lowest", high: "highest" }
    : { low: "worst", high: "best" };
}

/** One lane, read as a sentence — the per-lane part of the accessible name. */
export function laneSentence(lane: Lane): string {
  const words = laneEndWords(lane);
  const fmt = (v: number) => `${formatMetricValue(lane.unit, v)} ${unitWords(lane.unit)}`;
  if (lane.n === 0) return `${lane.label}: no pilot has a usable value.`;
  if (lane.degenerate) {
    return `${lane.label}: every one of the ${lane.n} measured pilots produced ${fmt(
      lane.low
    )}.`;
  }
  const parts = [
    `${lane.label}${lane.neutral ? " (no good or bad direction)" : ""}: ` +
      `${words.low} ${fmt(lane.low)}, median ${fmt(lane.median)}, ` +
      `${words.high} ${fmt(lane.high)}, over ${lane.n} pilots.`,
  ];
  if (lane.missing > 0) {
    parts.push(
      `${lane.missing} not applicable` +
        (lane.notableMissingRanks.length > 0
          ? `, including ${notableRanksPhrase(lane.notableMissingRanks)}.`
          : ".")
    );
  }
  return parts.join(" ");
}

/**
 * The figure's accessible name: what the picture is, then every lane in words.
 *
 * The per-pilot table below carries every value and is keyboard-navigable, so
 * it is named here as the data equivalent — the same contract the percentile
 * heatmap states, and the reason the dots are not 240 tab stops.
 */
export function lanesAccessibleName(lanes: Lane[], subject: string): string {
  const head =
    `${subject}: ${lanes.length} behaviours, each a lane of one dot per pilot ` +
    `placed by percentile in this field, strongest separator at the top. ` +
    `The table below carries every value.`;
  return [head, ...lanes.map(laneSentence)].join(" ");
}

/**
 * The visible caption. Says what the position means, what orders the lanes,
 * and — deliberately — the two things a reader would otherwise infer wrongly:
 * that a percentile axis says nothing about spread, and that the right-hand
 * end is only the end the metric EXPECTS to be better, not a claim about this
 * task.
 */
export function lanesCaption(lanes: Lane[]): string {
  const parts = [
    "One lane per behaviour, one dot per pilot, placed by percentile within " +
      "the pilots that behaviour could be measured on — so a dot's position " +
      "says where a pilot sat, never how spread the field was. Hover a pilot " +
      "to light them up in every lane at once.",
    "Lanes run strongest separator first, the ones that separated nobody last; " +
      "the table below keeps its usual order.",
    "Right is the end the behaviour is expected to be better at — whether it " +
      "paid on this task is the ranking's question, not this chart's.",
  ];
  if (lanes.some((l) => l.neutral)) {
    parts.push(
      "† No good or bad direction: right is simply the larger value."
    );
  }
  if (lanes.some((l) => l.missing > 0)) {
    parts.push(
      "A lane's count is the pilots it applied to; the rest have no value for " +
        "it, which is not a score of zero."
    );
  }
  return parts.join(" ");
}
