/**
 * Short TOC labels for the metrics that earn a deep "On this page" entry.
 *
 * The rail is an index, not a second copy of the page: a metric's full label
 * ("The day's wind, hour by hour and leg by leg") wraps to three lines in a
 * 12rem column and the eye has to read it, where an index entry should be one
 * fixation. The full label stays on the heading the entry scrolls to, so
 * nothing is lost — the two are deliberately different registers of the same
 * name.
 *
 * `shortLabel` is NOT reused here: it is a column header capped at ~10
 * characters ("Kept%", "LeaveRate"), which is the wrong register for
 * navigation. Metrics without an entry fall back to their full label, so a
 * new block-emitting metric degrades to today's behaviour rather than
 * vanishing from the rail.
 */
import type { MetricReport } from "./types";

const TOC_LABELS: Record<string, string> = {
  "day.wind": "Wind",
  "day.climb_by_hour": "Climb strength",
  "day.airtime_quality": "Airtime quality",
  "climb.selectivity": "Lift kept",
  "race.start_delay": "Start timing",
  "race.leg_time_lost": "Time lost by leg",
  "race.time_behind": "Time behind leader",
};

export function metricTocLabel(metric: Pick<MetricReport, "id" | "label">): string {
  return TOC_LABELS[metric.id] ?? metric.label;
}
