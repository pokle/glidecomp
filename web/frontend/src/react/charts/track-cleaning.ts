/**
 * The pure half of the report card's "Track data cleaning" chart — which
 * altimeters a file carries, the frame for one repair, decimation that keeps
 * the glitches, and band geometry — for `charts/TrackCleaningChart.tsx`,
 * and unit-testable without rendering it. Report-card rule (d): the
 * frame always covers the RAW excursion, never only the cleaned line.
 */
import type { IGCFix } from "@glidecomp/engine";
import type { AltitudeCleaningData } from "../comp/types";

export type CleaningRange = AltitudeCleaningData["ranges"][number];

/** Context either side of a zoomed repair: enough to see the altitude the
 *  fixes departed from and returned to, scaled to longer excursions. */
const ZOOM_MIN_CONTEXT_MS = 30_000;
const ZOOM_MAX_CONTEXT_MS = 120_000;

/** Mirrors altitude-cleaning.ts: a channel with more zeros than this fraction
 *  of fixes is not present in the file. */
const DEAD_CHANNEL_ZERO_FRACTION = 0.5;

export type Point = [timeMs: number, metres: number];

/**
 * Which altimeters this file actually has. A GPS-only logger writes pressure
 * 0 on every B record and a pressure-only logger writes GNSS 0, so "mostly
 * zeros" is the test — the same one the cleaning pass itself makes.
 */
export function channelHealth(fixes: IGCFix[]): {
  gnssAlive: boolean;
  baroAlive: boolean;
} {
  let zeroGnss = 0;
  let zeroBaro = 0;
  for (const f of fixes) {
    if (f.gnssAltitude === 0) zeroGnss++;
    if (f.pressureAltitude === 0) zeroBaro++;
  }
  const limit = fixes.length * DEAD_CHANNEL_ZERO_FRACTION;
  return { gnssAlive: zeroGnss < limit, baroAlive: zeroBaro < limit };
}

/**
 * The frame for one repaired stretch: the stretch plus context either side,
 * clamped to the flight. Long excursions get proportionally more room, so a
 * 30-fix repair isn't drawn edge to edge with nothing to compare it against.
 */
export function zoomWindow(
  range: Pick<CleaningRange, "startTimeMs" | "endTimeMs">,
  flight: [number, number],
): [number, number] {
  const span = Math.max(0, range.endTimeMs - range.startTimeMs);
  const context = Math.min(
    ZOOM_MAX_CONTEXT_MS,
    Math.max(ZOOM_MIN_CONTEXT_MS, span * 2),
  );
  return [
    Math.max(flight[0], range.startTimeMs - context),
    Math.min(flight[1], range.endTimeMs + context),
  ];
}

/**
 * Thin a series to about `buckets` buckets, keeping each bucket's first,
 * minimum, maximum and last sample in time order.
 *
 * Plain every-Nth sampling would drop the glitches — a one-fix spike 9 km
 * below the flight is exactly the sample an even stride is most likely to
 * skip, and this chart exists to show it. Buckets are counted in samples
 * rather than time, which spends fewer of them across a logging gap; that
 * costs nothing, because a gap has no detail to lose.
 */
export function decimateSeries(points: Point[], buckets: number): Point[] {
  if (buckets < 1 || points.length <= buckets * 2) return points;
  const out: Point[] = [];
  const size = points.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * size);
    const end = Math.min(points.length, Math.floor((b + 1) * size));
    if (end <= start) continue;
    let minIndex = start;
    let maxIndex = start;
    for (let i = start + 1; i < end; i++) {
      if (points[i][1] < points[minIndex][1]) minIndex = i;
      if (points[i][1] > points[maxIndex][1]) maxIndex = i;
    }
    let previous = -1;
    for (const i of [start, minIndex, maxIndex, end - 1].sort((a, b2) => a - b2)) {
      if (i === previous) continue;
      out.push(points[i]);
      previous = i;
    }
  }
  return out;
}

/** First index whose fix time is >= t (fix times ascend). */
export function lowerBound(fixes: IGCFix[], t: number): number {
  let lo = 0;
  let hi = fixes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (fixes[mid].time.getTime() < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * A rectangle spanning [x0, x1] with a minimum width, kept inside the plot —
 * so a repair at either end of the frame is drawn at the edge rather than
 * hanging over the axis labels, and a widened hairline shifts inwards instead
 * of overflowing.
 */
export function bandRect(
  x0: number,
  x1: number,
  minWidth: number,
  plot: { left: number; right: number },
): { x: number; width: number } {
  const width = Math.min(plot.right - plot.left, Math.max(minWidth, x1 - x0));
  const clamped = Math.min(
    plot.right - width,
    Math.max(plot.left, x0 - Math.max(0, width - (x1 - x0)) / 2),
  );
  return { x: clamped, width };
}

