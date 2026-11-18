/**
 * Wind by leg, drawn as a Gantt over the day: one row per speed-section leg
 * in course order.
 *
 * TWO nested bars per row, because one bar told a lie. The pale outer bar is
 * the leg's FLOWN window — first pilot on it to last pilot off it. The solid
 * inner band is the narrower window the wind was actually measured in: the
 * circles behind that leg's estimate. Glides produce no estimate at all, so
 * on a leg the field mostly glided the inner band can be a two-minute sliver
 * of a two-hour bar — and drawn alone (as it was until TASK_ANALYSIS_VERSION
 * 17) it read as the course being flown out of order, a final leg "finishing"
 * before the leg preceding it began. The outer bar restores the nesting a
 * Gantt promises; the inner band's offset inside it is itself the finding.
 *
 * Bars overlap between rows — fast pilots are on leg 3 while slow pilots
 * still circle leg 1 — and on the panel's shared axis that overlap sits
 * directly under the wind and climb charts.
 *
 * Speed is NOT bar colour (a thin bar shows too little colour area to read a
 * ramp): it is the arrow's length plus a text label, with the arrow angle
 * carrying direction — same convention as the hourly chart above. Arrow and
 * band opacity track the leg's sample count, so a leg measured from one
 * pilot's four circles cannot read as confidently as one measured from 800;
 * below the thin thresholds the label says the counts outright.
 *
 * Each leg is a ROW of the page, not a row of one drawing (issue #860): its
 * name and its wind are a line of real text, and its bar is a strip beneath
 * on the stack's shared time axis. As one SVG the names and the wind labels
 * were `<text>` that could not wrap or be cut short, and at a readable size
 * they did not fit beside their bars. A row is a button: choosing it prints
 * the leg's full sentence under it — what a hover over the row used to say.
 * The Wind by leg table below remains the exact reading.
 */
import { useRef, useState } from "react";
import type { DayTimingSeries, WindLegsSeries } from "../../types";
import { formatTimeRange } from "@/react/lib/time";
import { useUnits } from "@/react/lib/units";
import { formatMetricValue } from "../../types";
import { unitDisplay } from "../../units";
import type { TimeAxis } from "./time-axis";
import type { ChartFrame } from "./frame";
import { TimeTickLabels } from "./TimeAxisParts";
import { ChartHeader } from "./MetSourceTag";
import { MetLegend, type LegendEntry } from "./MetLegend";
import { degToCompass, windArrowPath, windArrowTransform, windLabel } from "./shared";

const HOUR_MS = 3_600_000;
/** Below either of these, a leg's wind is one or two pilots' few minutes and
 * the row prints the counts rather than leaving the reader to ask. */
const THIN_ESTIMATES = 20;
const THIN_PILOTS = 3;

const FLOWN_FILL = { fill: "var(--chart-2)", opacity: 0.16 };

type Leg = WindLegsSeries["legs"][number];

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
};

/**
 * The leg's two windows as epoch ms. Reports stored before version 17 carry
 * no flown window, so it falls back to the circling window — the old drawing,
 * rather than a missing bar, until the row revalidates.
 */
function windows(l: Leg): { flown: [number, number] | null; circling: [number, number] | null } {
  const cFrom = ms(l.from);
  const cTo = ms(l.to);
  const circling = cFrom !== null && cTo !== null ? ([cFrom, cTo] as [number, number]) : null;
  const fFrom = ms(l.flownFrom);
  const fTo = ms(l.flownTo);
  const flown = fFrom !== null && fTo !== null ? ([fFrom, fTo] as [number, number]) : circling;
  return { flown, circling };
}

export function WindLegsGantt({
  series,
  timing,
  axis,
  frame,
  timeZone,
  selectedMs,
}: {
  series: WindLegsSeries;
  timing: DayTimingSeries | null;
  axis: TimeAxis;
  frame: ChartFrame;
  timeZone: string | undefined;
  /** The stack's selected hour, drawn as a band through every leg's strip. */
  selectedMs: number | null;
}) {
  // Wind follows the speed preference; series values are km/h and convert
  // here at the display boundary. Arrow lengths use the km/h ratio directly
  // (a linear factor cancels out of speed/maxSpeed).
  const wind = unitDisplay("km/h", useUnits());
  const [openLeg, setOpenLeg] = useState<number | null>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  if (series.legs.length === 0) return null;

  const em = frame.fontSize;
  const stripH = em * 1.5;
  const barH = em * 0.75;
  const barY = (stripH - barH) / 2;
  const arrowMin = em * 0.8;
  const arrowMax = em * 1.4;

  const maxSpeed = Math.max(1, ...series.legs.map((l) => l.speedKmh ?? 0));
  // Confidence is relative to the best-sampled leg, the same ramp the hourly
  // chart uses for its buckets.
  const maxN = Math.max(1, ...series.legs.map((l) => l.n));

  // Just the race's bookends here — the first gate and the deadline. The
  // full gate sequence is labelled on the climb chart above; repeating all
  // of it would bury the bars. Dropped when they fall outside the axis
  // window (which is framed by the field's own flying, ±2 h).
  const rules = (
    timing
      ? [
          ...timing.startGates.slice(0, 1).map((g) => new Date(g).getTime()),
          ...(timing.deadline ? [new Date(timing.deadline).getTime()] : []),
        ]
      : []
  ).filter((t) => t >= axis.domainStart && t <= axis.domainEnd);

  /** "4 circles, 1 pilot" — the sample behind a leg's figure, in words. */
  const sampleText = (l: Leg): string => {
    const circles = `${l.n} circle${l.n === 1 ? "" : "s"}`;
    return l.pilotsWithEstimates === undefined
      ? circles
      : `${circles}, ${l.pilotsWithEstimates} pilot${l.pilotsWithEstimates === 1 ? "" : "s"}`;
  };
  const isThin = (l: Leg): boolean =>
    l.n < THIN_ESTIMATES || (l.pilotsWithEstimates !== undefined && l.pilotsWithEstimates < THIN_PILOTS);

  /** The leg in full: when it was flown and by how many, and what its wind
   * was measured from. */
  const legDetail = (l: Leg): string => {
    const { flown, circling } = windows(l);
    const flownPart =
      flown === null
        ? "no pilot flew the whole leg"
        : `flown ${formatTimeRange(new Date(flown[0]).toISOString(), new Date(flown[1]).toISOString(), timeZone)}` +
          (l.pilotsOnLeg ? ` by ${l.pilotsOnLeg} pilot${l.pilotsOnLeg === 1 ? "" : "s"}` : "");
    if (circling === null || l.speedKmh === null || l.directionDeg === null)
      return `${l.label} — ${flownPart}; no circling on it, so no wind estimate`;
    return (
      `${l.label} — ${flownPart}. Wind ${formatMetricValue(wind.unit, l.speedKmh * wind.factor)} ${wind.unit} ` +
      `from ${Math.round(l.directionDeg)}° (${degToCompass(l.directionDeg)}), measured from ${sampleText(l)} ` +
      `while circling ${formatTimeRange(new Date(circling[0]).toISOString(), new Date(circling[1]).toISOString(), timeZone)}`
    );
  };

  function onKeyDown(e: React.KeyboardEvent, i: number) {
    let next: number;
    if (e.key === "ArrowDown") next = Math.min(i + 1, series.legs.length - 1);
    else if (e.key === "ArrowUp") next = Math.max(i - 1, 0);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = series.legs.length - 1;
    else return;
    e.preventDefault();
    rowRefs.current[next]?.focus();
  }

  const legend: LegendEntry[] = [
    { key: "flown", kind: "box", text: "leg flown", fillClass: "bg-chart-2/15" },
    { key: "measured", kind: "box", text: "wind measured", fillClass: "bg-chart-2/60" },
    { key: "direction", kind: "arrow", text: "direction", stroke: "var(--chart-2)", strokeWidth: 1.6 },
  ];

  const measured = series.legs.filter((l) => l.n > 0).length;
  const bandX =
    selectedMs === null ? null : ([axis.x(selectedMs), axis.x(selectedMs + HOUR_MS)] as const);

  return (
    <div
      className="space-y-0.5"
      data-day-chart="legs"
      role="group"
      aria-label={
        `Wind by leg: ${series.legs.length} speed-section legs as time bars. Each pale bar spans when the ` +
        `field flew that leg; the solid band inside it spans only the circles the leg's wind was measured ` +
        `from, with an arrow and speed per leg (${measured} of ${series.legs.length} legs have estimates). ` +
        `The Wind by leg table below carries the exact numbers and sample counts.`
      }
    >
      <ChartHeader title="From tracks: wind by leg" />
      <MetLegend entries={legend} />
      <div className="divide-y divide-border border-y border-border">
        {series.legs.map((l, i) => {
          const { flown: flownWin, circling } = windows(l);
          const hasWind = circling !== null && l.speedKmh !== null && l.directionDeg !== null;
          const span = (w: [number, number]): [number, number] => {
            const a = axis.x(w[0]);
            return [a, Math.max(axis.x(w[1]), a + 3)];
          };
          const [fx0, fx1] = flownWin ? span(flownWin) : [0, 0];
          const [cx0, cx1] = circling ? span(circling) : [0, 0];
          const arrowLen = hasWind ? arrowMin + (arrowMax - arrowMin) * (l.speedKmh! / maxSpeed) : 0;
          // Opacity says "how much evidence"; the same 0.4→1.0 ramp as the
          // hourly chart's direction arrows.
          const confidence = 0.4 + 0.6 * (l.n / maxN);
          const open = openLeg === i;
          return (
            // Key by row index: concentric tasks (e.g. Kosciuszko Loop) repeat
            // the same waypoint name in every leg label.
            <div key={i}>
              <button
                type="button"
                ref={(el) => {
                  rowRefs.current[i] = el;
                }}
                aria-expanded={open}
                data-leg={i}
                onClick={() => setOpenLeg(open ? null : i)}
                onKeyDown={(e) => onKeyDown(e, i)}
                className="block w-full cursor-pointer py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="min-w-0 truncate">{l.label}</span>
                  <span
                    className={
                      hasWind
                        ? "shrink-0 text-muted-foreground"
                        : "shrink-0 text-muted-foreground italic"
                    }
                  >
                    {hasWind
                      ? windLabel(l.speedKmh! * wind.factor, wind.unit, l.directionDeg!)
                      : "no circling on this leg"}
                  </span>
                </span>
                <svg
                  aria-hidden
                  viewBox={`0 0 ${frame.width} ${stripH}`}
                  className="block h-auto w-full"
                >
                  {bandX ? (
                    <rect
                      x={bandX[0]}
                      width={Math.max(0, bandX[1] - bandX[0])}
                      y={0}
                      height={stripH}
                      className="fill-foreground/10"
                    />
                  ) : null}
                  {axis.ticks.map((t) => (
                    <line
                      key={t.ms}
                      x1={axis.x(t.ms)}
                      x2={axis.x(t.ms)}
                      y1={0}
                      y2={stripH}
                      className="stroke-border"
                      strokeWidth={1}
                    />
                  ))}
                  {/* Task-clock rules (labelled on the climb chart above). */}
                  {rules.map((t, r) => (
                    <line
                      key={`r${t}-${r}`}
                      x1={axis.x(t)}
                      x2={axis.x(t)}
                      y1={0}
                      y2={stripH}
                      className="stroke-muted-foreground/70"
                      strokeWidth={1}
                      strokeDasharray="3 3"
                    />
                  ))}
                  {/* Outer bar: when the field was on the leg. */}
                  {flownWin ? (
                    <rect
                      x={fx0}
                      width={fx1 - fx0}
                      y={barY}
                      height={barH}
                      rx={2}
                      style={{ fill: FLOWN_FILL.fill }}
                      opacity={FLOWN_FILL.opacity}
                    />
                  ) : null}
                  {/* Inner band: when its wind was measured. */}
                  {hasWind ? (
                    <>
                      <rect
                        x={cx0}
                        width={cx1 - cx0}
                        y={barY}
                        height={barH}
                        rx={2}
                        style={{ fill: "var(--chart-2)" }}
                        // Floored well clear of the outer bar's 0.16: a thin
                        // leg should read as tentative, not vanish — the
                        // reader still has to find WHERE in the leg the wind
                        // was measured.
                        opacity={0.38 + 0.32 * (l.n / maxN)}
                      />
                      <path
                        d={windArrowPath(arrowLen)}
                        transform={windArrowTransform((cx0 + cx1) / 2, stripH / 2, l.directionDeg!)}
                        fill="none"
                        style={{ stroke: "var(--chart-2)" }}
                        strokeWidth={1.6}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        opacity={confidence}
                      />
                    </>
                  ) : null}
                </svg>
                {hasWind && isThin(l) ? (
                  <span className="block text-xs text-muted-foreground">
                    Measured from {sampleText(l)} only.
                  </span>
                ) : null}
              </button>
              {open ? (
                <p data-leg-detail className="pb-1 text-xs text-muted-foreground">
                  {legDetail(l)}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      <svg
        aria-hidden
        viewBox={`0 0 ${frame.width} ${em * 1.6}`}
        className="h-auto w-full"
      >
        <TimeTickLabels axis={axis} y={em * 1.1} frame={frame} />
      </svg>
    </div>
  );
}
