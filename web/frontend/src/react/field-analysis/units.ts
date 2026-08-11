/**
 * Unit names as words, for accessible names — "km/h" reads badly in a screen
 * reader; "kilometres per hour" doesn't.
 *
 * Its own module (rather than living in PerPilotMetricTable, where it
 * started) because both the table and the charts need it, and the charts are
 * also imported by MetricExplanation — which the table imports, so leaving
 * it in the table would close an import cycle.
 */
import { TO_SI, type UnitPreferences } from "@glidecomp/engine";
import type {
  CorrelationVerdict,
  FieldAnalysisReport,
  MetricDirection,
  MetricReport,
} from "./types";

export function unitWords(unit: string): string {
  switch (unit) {
    case "pct":
      return "percent";
    case "m":
      return "metres";
    case "ft":
      return "feet";
    case "m/s":
      return "metres per second";
    case "fpm":
      return "feet per minute";
    case "km/h":
      return "kilometres per hour";
    case "km":
      return "kilometres";
    case "mi":
      return "miles";
    case "nmi":
      return "nautical miles";
    case "mph":
      return "miles per hour";
    case "kts":
      return "knots";
    case "s":
      return "seconds";
    case "min":
      return "minutes";
    case "count":
      return "count";
    case "ratio":
      return "ratio";
    default:
      return unit;
  }
}

/**
 * Display conversion for one engine metric unit under the viewer's preferred
 * units. The engine always computes and stores metric units; the UI converts
 * numbers at the display boundary. Horizontal speeds ('km/h') follow the
 * speed preference, vertical rates ('m/s') the climb preference, heights
 * ('m') the altitude preference, ground distances ('km') the distance
 * preference; everything else ('pct', 's', 'min', …) is dimensionless or time
 * and passes through.
 *
 * Every factor is derived from the engine's canonical TO_SI table, so a value
 * displayed here can never disagree with the same value formatted by the
 * engine's own formatUnit.
 */
export interface UnitDisplay {
  /** Display token in the metric-unit vocabulary ('mph', 'kts', 'fpm', 'ft',
   * or the engine unit itself when no conversion applies). */
  unit: string;
  /** Multiply an engine-unit value by this to get the display value. */
  factor: number;
}

export function unitDisplay(engineUnit: string, units: UnitPreferences): UnitDisplay {
  switch (engineUnit) {
    case "km/h":
      if (units.speed === "mph") return { unit: "mph", factor: TO_SI["km/h"] / TO_SI.mph };
      if (units.speed === "knots") return { unit: "kts", factor: TO_SI["km/h"] / TO_SI.knots };
      return { unit: "km/h", factor: 1 };
    case "m/s":
      if (units.climbRate === "ft/min") return { unit: "fpm", factor: 1 / TO_SI["ft/min"] };
      if (units.climbRate === "knots") return { unit: "kts", factor: 1 / TO_SI.knots };
      return { unit: "m/s", factor: 1 };
    case "m":
      if (units.altitude === "ft") return { unit: "ft", factor: 1 / TO_SI.ft };
      return { unit: "m", factor: 1 };
    case "km":
      if (units.distance === "mi") return { unit: "mi", factor: 1000 / TO_SI.mi };
      if (units.distance === "nmi") return { unit: "nmi", factor: 1000 / TO_SI.nmi };
      return { unit: "km", factor: 1 };
    default:
      return { unit: engineUnit, factor: 1 };
  }
}

/**
 * A copy of the report with every metric's per-pilot values and unit token
 * converted for display. Correlations, percentiles and ranks are invariant
 * under this linear scaling, so everything derived downstream (ρ badges,
 * heatmap percentiles, scatter shapes) is unchanged — only the numbers and
 * unit labels read differently. Engine-authored prose (fieldSummary lines,
 * extraTables cells) is pre-rendered text and stays in metric units.
 *
 * Metrics that need no conversion are returned by reference, so an all-metric
 * viewer gets the original report object back (and memo identities hold).
 */
export function displayReport(
  report: FieldAnalysisReport,
  units: UnitPreferences
): FieldAnalysisReport {
  let changed = false;
  const metrics = report.metrics.map((m) => {
    const conv = unitDisplay(m.unit, units);
    if (conv.factor === 1 && conv.unit === m.unit) return m;
    changed = true;
    return {
      ...m,
      unit: conv.unit,
      perPilot: m.perPilot.map((p) =>
        p.value === null ? p : { ...p, value: p.value * conv.factor }
      ),
    } satisfies MetricReport;
  });
  return changed ? { ...report, metrics } : report;
}

/**
 * How a correlation's verdict reads to a pilot rather than to a statistician.
 *
 * The engine's `CorrelationVerdict` tokens are stored in every report blob and
 * printed by the CLI, so they stay as they are; these are their display forms
 * on the public pages. Note they collapse two axes on purpose — how clear the
 * pattern is (strong/moderate/weak) and whether there is one to read at all
 * (within noise, n too small) — because that is the one question the reader
 * has: how seriously to take this row.
 *
 * "within noise" was the worst offender: it names a statistical procedure
 * rather than a conclusion. "could be chance" says the conclusion. Every
 * threshold behind these words is still spelled out in VerdictLegend.
 */
export function verdictWords(verdict: CorrelationVerdict): string {
  switch (verdict) {
    case "strong":
      return "clear pattern";
    case "moderate":
      return "some pattern";
    case "weak":
      return "faint pattern";
    case "within noise":
      return "could be chance";
    case "n too small":
      return "too few pilots";
    default:
      return verdict;
  }
}

/**
 * How a metric's expected relationship to rank reads in prose. Lives here
 * (not in MetricExplanation, where it started) for the same cycle-breaking
 * reason as unitWords: both the popover and the glossary need it, and the
 * popover links into the glossary.
 */
export function directionWords(direction: MetricDirection): string {
  switch (direction) {
    case "higher":
      return "higher is better";
    case "lower":
      return "lower is better";
    default:
      return "no expected direction";
  }
}
