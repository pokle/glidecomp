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
import { unitDisplay } from "@glidecomp/client/units";
import type {
  CorrelationVerdict,
  TaskAnalysisReport,
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

// Shared with the app's weather charts.
export { unitDisplay, type UnitDisplay } from "@glidecomp/client/units";


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
  report: TaskAnalysisReport,
  units: UnitPreferences
): TaskAnalysisReport {
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
