/**
 * The day-profile panel's shared time axis: one epoch-ms domain spanning
 * every instant any of the panel's series mentions, with tick marks on the
 * COMPETITION zone's whole wall-clock hours — a +10:30 zone ticks at :30
 * past the UTC hour, because the wall clock is what the reader thinks in.
 *
 * Pure math (no DOM, no React) so tick placement is unit-testable,
 * including the half-hour-offset zones.
 */
import { hhmmInZone, zoneOffsetMinutes } from "@/react/lib/time";
import { linearScale } from "../chart-utils";

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;

export interface TimeAxisTick {
  ms: number;
  /** Wall-clock label in the axis zone, e.g. "14:00". */
  label: string;
}

export interface TimeAxis {
  /** Domain in epoch ms (already padded). */
  domainStart: number;
  domainEnd: number;
  /** Epoch ms → x pixel inside the plot range the axis was built for. */
  x: (ms: number) => number;
  /** Wall-hour ticks, ascending, inside the domain. */
  ticks: TimeAxisTick[];
}

/** Offset ms of `timeZone` at `atMs`; 0 when the zone is unknown/undefined. */
function offsetMsAt(atMs: number, timeZone: string | undefined): number {
  if (!timeZone) return 0;
  try {
    return zoneOffsetMinutes(new Date(atMs), timeZone) * MIN_MS;
  } catch {
    return 0;
  }
}

/**
 * Build the axis from every instant the panel's series mention. Returns null
 * when there are no finite instants. A near-degenerate span (everything in
 * one moment) is widened to half an hour so the charts keep a readable
 * scale. Tick step adapts to the span: 30 min under 2.5 h, hourly to 9.5 h,
 * else 2-hourly.
 */
export function buildTimeAxis(
  instantsMs: number[],
  timeZone: string | undefined,
  [x0, x1]: [number, number]
): TimeAxis | null {
  const finite = instantsMs.filter((t) => Number.isFinite(t));
  if (finite.length === 0) return null;
  let min = Math.min(...finite);
  let max = Math.max(...finite);
  if (max - min < 30 * MIN_MS) {
    const mid = (min + max) / 2;
    min = mid - 15 * MIN_MS;
    max = mid + 15 * MIN_MS;
  }
  const pad = Math.max(3 * MIN_MS, (max - min) * 0.02);
  const domainStart = min - pad;
  const domainEnd = max + pad;

  const span = domainEnd - domainStart;
  const stepMs =
    span < 2.5 * HOUR_MS ? 30 * MIN_MS : span <= 9.5 * HOUR_MS ? HOUR_MS : 2 * HOUR_MS;

  // Tick on whole wall-clock steps: shift into wall time, snap, shift back.
  // The offset at the domain start serves the whole axis — a DST transition
  // mid-flight would shift later labels, but competition flights don't cross
  // 2–3 am.
  const offset = offsetMsAt(domainStart, timeZone);
  const ticks: TimeAxisTick[] = [];
  const firstWall = Math.ceil((domainStart + offset) / stepMs) * stepMs;
  for (let wall = firstWall; wall - offset <= domainEnd; wall += stepMs) {
    const ms = wall - offset;
    ticks.push({ ms, label: hhmmInZone(new Date(ms), timeZone) });
  }

  return { domainStart, domainEnd, x: linearScale([domainStart, domainEnd], [x0, x1]), ticks };
}
