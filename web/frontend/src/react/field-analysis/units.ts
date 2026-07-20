/**
 * Unit names as words, for accessible names — "km/h" reads badly in a screen
 * reader; "kilometres per hour" doesn't.
 *
 * Its own module (rather than living in PerPilotMetricTable, where it
 * started) because both the table and the charts need it, and the charts are
 * also imported by MetricExplanation — which the table imports, so leaving
 * it in the table would close an import cycle.
 */
import type { MetricDirection } from "./types";

export function unitWords(unit: string): string {
  switch (unit) {
    case "pct":
      return "percent";
    case "m":
      return "metres";
    case "m/s":
      return "metres per second";
    case "km/h":
      return "kilometres per hour";
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
