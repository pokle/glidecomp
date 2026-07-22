/**
 * Unit names as words, for accessible names — "km/h" reads badly in a screen
 * reader; "kilometres per hour" doesn't.
 *
 * Its own module (rather than living in PerPilotMetricTable, where it
 * started) because both the table and the charts need it, and the charts are
 * also imported by MetricExplanation — which the table imports, so leaving
 * it in the table would close an import cycle.
 */
import type { UnitPreferences } from "@glidecomp/engine";
import type {
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
 * ('m') the altitude preference; everything else ('pct', 's', 'min', …) is
 * dimensionless or time and passes through.
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
      if (units.speed === "mph") return { unit: "mph", factor: 0.621371 };
      if (units.speed === "knots") return { unit: "kts", factor: 0.539957 };
      return { unit: "km/h", factor: 1 };
    case "m/s":
      if (units.climbRate === "ft/min") return { unit: "fpm", factor: 196.85 };
      if (units.climbRate === "knots") return { unit: "kts", factor: 1.944 };
      return { unit: "m/s", factor: 1 };
    case "m":
      if (units.altitude === "ft") return { unit: "ft", factor: 3.281 };
      return { unit: "m", factor: 1 };
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
