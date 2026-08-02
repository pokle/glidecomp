/**
 * What the altitude cleaning pass did to THIS pilot's track, drawn.
 *
 * The report card already lists every repaired stretch as text (time, fix
 * count, how far off) — exact, complete, and impossible to picture. A pilot
 * reading "14:12:41–14:12:44 · 3 fixes · up to 538 m off" cannot tell whether
 * that was a spike out of a climb or a hole in a glide, nor whether the
 * repaired line is the one they remember flying. The same three lines the
 * public explainer draws (/scoring/data-cleaning) answer both at a glance, so
 * this chart deliberately mirrors that figure's conventions: raw GPS, raw
 * barometer, and the cleaned line the analysis actually used, over time.
 *
 * Differences from the explainer's static figures, which are single-incident
 * zooms built by a generator:
 *
 *  1. **A real flight has many incidents** — Olav's Corryong 2023 track has
 *     48 of them. So the default frame is the WHOLE flight with every repair
 *     shaded, and the text list doubles as the chart's controls: pick a
 *     stretch and the frame zooms to it. One chart, not forty-eight.
 *
 *  2. **It draws from the tracklog the page already downloaded** for the map,
 *     so it costs no extra request and nothing had to be added to the score
 *     payload. That also makes it client-only: on the server there are no
 *     fixes, the section renders its prose and list exactly as before, and
 *     the chart appears when the track lands. Nothing SEO-relevant is in the
 *     picture — the numbers are in the list either way.
 *
 *  3. **A dead channel is not drawn.** Scoring-server exports carry no
 *     barometer (the whole column reads 0); a flat line at zero would drag
 *     the altitude axis down to it and squash the flight into the top of the
 *     frame. The explainer draws it to make a point about cross-checking; a
 *     pilot's own report card just says the channel wasn't there.
 *
 * The y domain covers the RAW excursions, not just the cleaned line: a
 * repair's whole point is how far off the fix was, and clipping it off-frame
 * would hide exactly what the reader came to see.
 *
 * Accessibility (docs/accessibility-standard.md): series identity is carried
 * by line style as well as hue (solid / dotted / dashed, echoed in the
 * legend swatches), the figcaption states the reading in words and doubles
 * as the accessible name, and the section's own list remains the exact,
 * complete, keyboard-reachable data — the shaded bands here are a
 * click-to-zoom shortcut for a mouse, never the only way to reach an
 * incident.
 */
import { useMemo } from "react";
import { fixAltitude, type IGCFix } from "@glidecomp/engine";
import type { AltitudeCleaningData } from "../comp/types";
import { formatTimeInZone } from "../lib/time";
import { extent, linearScale, niceTicks } from "./scale";
import { AxisUnit } from "./AxisTitle";

export type CleaningRange = AltitudeCleaningData["ranges"][number];

const W = 560;
const H = 210;
const MARGIN = { top: 12, right: 10, bottom: 26, left: 48 };

/** Half-width of the shading around a repaired stretch, so a single repaired
 *  fix is still a visible mark rather than a zero-width rectangle. */
const BAND_PAD_MS = 1500;
/** ...and a floor in viewBox units, for the whole-flight frame where 3 s is
 *  a fraction of a pixel. */
const MIN_BAND_UNITS = 2.5;
/** Floor for the invisible click target behind a band — a 2-unit hairline is
 *  not something anyone can hit with a mouse. */
const MIN_HIT_UNITS = 10;

/** Context either side of a zoomed repair: enough to see the altitude the
 *  fixes departed from and returned to, scaled to longer excursions. */
const ZOOM_MIN_CONTEXT_MS = 30_000;
const ZOOM_MAX_CONTEXT_MS = 120_000;

/** Mirrors altitude-cleaning.ts: a channel with more zeros than this fraction
 *  of fixes is not present in the file. */
const DEAD_CHANNEL_ZERO_FRACTION = 0.5;

/** Roughly one bucket per horizontal viewBox unit of plot — finer than the
 *  rendered pixel grid on any phone, so decimation is invisible. */
const PLOT_UNITS = W - MARGIN.left - MARGIN.right;

type Point = [timeMs: number, metres: number];

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
function lowerBound(fixes: IGCFix[], t: number): number {
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

function svgPath(points: Point[], x: (v: number) => number, y: (v: number) => number): string {
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`)
    .join("");
}

/** Whole metres with thousands separators, in a fixed locale (the rest of
 *  the app's chart text is en-AU and never the viewer's). */
function metres(v: number): string {
  return Math.round(v).toLocaleString("en-AU");
}

export function TrackCleaningChart({
  fixes,
  ranges,
  selected,
  timezone,
  onSelectRange,
}: {
  /** The pilot's parsed tracklog — the same fixes the map draws. */
  fixes: IGCFix[];
  /** The repaired stretches the analysis published, in flight order. */
  ranges: CleaningRange[];
  /** Index into `ranges` to zoom to, or null for the whole flight. */
  selected: number | null;
  /** Comp zone for the time axis (falls back to the viewer's). */
  timezone: string | null;
  /** Click-to-zoom on a shaded band; the list is the keyboard equivalent. */
  onSelectRange: (index: number | null) => void;
}) {
  const { gnssAlive, baroAlive } = useMemo(() => channelHealth(fixes), [fixes]);

  const view = useMemo(() => {
    if (fixes.length < 2) return null;
    const flight: [number, number] = [
      fixes[0].time.getTime(),
      fixes[fixes.length - 1].time.getTime(),
    ];
    const range = selected != null ? ranges[selected] : undefined;
    const [t0, t1] = range ? zoomWindow(range, flight) : flight;
    if (t1 <= t0) return null;

    // One fix of overhang each side, so a zoomed frame's lines reach its
    // edges instead of stopping short of them.
    const from = Math.max(0, lowerBound(fixes, t0) - 1);
    const to = Math.min(fixes.length, lowerBound(fixes, t1) + 1);
    const slice = fixes.slice(from, to);
    if (slice.length < 2) return null;

    const at = (f: IGCFix, v: number): Point => [f.time.getTime(), v];
    const raw = gnssAlive ? slice.map((f) => at(f, f.gnssAltitude)) : [];
    const baro = baroAlive ? slice.map((f) => at(f, f.pressureAltitude)) : [];
    const cleaned = slice.map((f) => at(f, fixAltitude(f)));
    if (!gnssAlive && !baroAlive) return null;

    const yDomain = extent([...raw, ...baro, ...cleaned].map((p) => p[1]));
    if (!yDomain) return null;
    const pad = Math.max(20, (yDomain[1] - yDomain[0]) * 0.06);

    const buckets = Math.round(PLOT_UNITS);
    return {
      t0,
      t1,
      raw: decimateSeries(raw, buckets),
      baro: decimateSeries(baro, buckets),
      cleaned: decimateSeries(cleaned, buckets),
      yDomain: [yDomain[0] - pad, yDomain[1] + pad] as [number, number],
      // Bands for every repair the frame can show — zoomed in, a neighbouring
      // incident a few seconds away is part of the story.
      bands: ranges
        .map((r, index) => ({ r, index }))
        .filter(({ r }) => r.endTimeMs >= t0 && r.startTimeMs <= t1),
    };
  }, [fixes, ranges, selected, gnssAlive, baroAlive]);

  if (!view) return null;

  const plot = {
    left: MARGIN.left,
    right: W - MARGIN.right,
    top: MARGIN.top,
    bottom: H - MARGIN.bottom,
  };
  const x = linearScale([view.t0, view.t1], [plot.left, plot.right]);
  const y = linearScale(view.yDomain, [plot.bottom, plot.top]);
  const yTicks = niceTicks(view.yDomain, 4);
  const xTicks = [view.t0, (view.t0 + view.t1) / 2, view.t1];
  const time = (ms: number) => formatTimeInZone(new Date(ms), timezone ?? undefined);

  const range = selected != null ? ranges[selected] : null;
  const caption = range
    ? `The repair at ${time(range.startTimeMs)}: ${range.fixCount} fix${
        range.fixCount === 1 ? "" : "es"
      }, up to ${metres(range.maxCorrectionMeters)} m off, with ${
        Math.round((view.t1 - view.t0) / 1000)
      } seconds of the flight around it.`
    : `The whole flight: ${ranges.length} repaired stretch${
        ranges.length === 1 ? "" : "es"
      } shaded, between ${time(view.t0)} and ${time(view.t1)}.`;
  const channels = baroAlive
    ? "Raw GPS altitude, raw barometric altitude and the cleaned line the analysis used."
    : "Raw GPS altitude and the cleaned line the analysis used — this file carries no barometric channel.";

  return (
    <figure className="mt-3">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Altitude against time. ${channels} ${caption}`}
      >
        {yTicks.map((t) => (
          <line
            key={`gy${t}`}
            x1={plot.left}
            x2={plot.right}
            y1={y(t)}
            y2={y(t)}
            className="stroke-border"
            strokeWidth={1}
          />
        ))}

        {/* Repaired stretches. Clickable to zoom — a shortcut for a mouse,
            with the list below as the keyboard path, so these are aria-hidden
            rather than a duplicate set of controls. The visible band shows
            the true extent (down to a hairline for one repaired fix); an
            invisible wider rectangle behind it makes that hairline hittable. */}
        {view.bands.map(({ r, index }) => {
          const isSelected = index === selected;
          const band = bandRect(
            x(r.startTimeMs - BAND_PAD_MS),
            x(r.endTimeMs + BAND_PAD_MS),
            MIN_BAND_UNITS,
            plot,
          );
          const hit = bandRect(band.x, band.x + band.width, MIN_HIT_UNITS, plot);
          return (
            <g key={r.startIndex} aria-hidden onClick={() => onSelectRange(isSelected ? null : index)}>
              <rect
                x={hit.x}
                y={plot.top}
                width={hit.width}
                height={plot.bottom - plot.top}
                className="cursor-pointer fill-transparent"
              />
              <rect
                x={band.x}
                y={plot.top}
                width={band.width}
                height={plot.bottom - plot.top}
                className={
                  isSelected
                    ? "pointer-events-none fill-chart-2/25 stroke-chart-2/60"
                    : "pointer-events-none fill-chart-2/10"
                }
              />
            </g>
          );
        })}

        {/* aria-hidden: the caption carries the reading, and loose axis
            numbers only add noise to a screen reader. */}
        <g aria-hidden className="text-[10px] text-muted-foreground">
          {yTicks.map((t) => (
            <text
              key={`ty${t}`}
              x={plot.left - 6}
              y={y(t) + 3}
              textAnchor="end"
              className="fill-current"
            >
              {metres(t)}
            </text>
          ))}
          {/* A unit stamp, not an axis title: the y axis is altitude and the
              three lines' legend already says whose. See AxisTitle.tsx. */}
          <AxisUnit left={plot.left} top={plot.top}>
            m
          </AxisUnit>
          {xTicks.map((t, i) => (
            <text
              key={`tx${t}`}
              x={x(t)}
              y={plot.bottom + 15}
              textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
              className="fill-current"
            >
              {time(t)}
            </text>
          ))}
        </g>

        {/* Barometer under the GPS trace, cleaned on top: the cleaned line is
            what the analysis used, so it must never be the hidden one. */}
        {view.baro.length > 0 ? (
          <path
            aria-hidden
            d={svgPath(view.baro, x, y)}
            fill="none"
            strokeWidth={1.5}
            strokeDasharray="1 3"
            strokeLinecap="round"
            className="stroke-chart-3"
          />
        ) : null}
        {view.raw.length > 0 ? (
          <path
            aria-hidden
            d={svgPath(view.raw, x, y)}
            fill="none"
            strokeWidth={1.5}
            className="stroke-chart-1"
          />
        ) : null}
        <path
          aria-hidden
          d={svgPath(view.cleaned, x, y)}
          fill="none"
          strokeWidth={2.5}
          strokeDasharray="6 3"
          className="stroke-chart-2"
        />
      </svg>

      {/* Legend: swatches repeat the line styles, so the series are told
          apart without relying on hue. */}
      <div
        aria-hidden
        className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
      >
        {gnssAlive ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 bg-chart-1" />
            raw GPS
          </span>
        ) : null}
        {baroAlive ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-4 border-t-2 border-dotted border-chart-3" />
            raw barometer
          </span>
        ) : (
          <span>no barometric channel in this file</span>
        )}
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-4 border-t-2 border-dashed border-chart-2" />
          cleaned
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block size-3 border border-border bg-chart-2/20" />
          repaired
        </span>
      </div>

      <figcaption className="mt-1 text-xs text-muted-foreground">{caption}</figcaption>
    </figure>
  );
}
