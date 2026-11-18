/**
 * Climb by hour, drawn as a quantile fan: median line, p25–p75 band, p10–p90
 * band — never literal min/max, whose single-sample extremes would set the
 * axis and bury the signal. A small column strip underneath shows how many
 * climbs each hour produced (the shape of the day's activity, and the
 * confidence caveat for thin edge buckets).
 *
 * The day-timing overlays live here because this is where they derive from:
 * the best-conditions hour is a shaded band sitting on the hump of the
 * median line it was computed from, every pilot's takeoff is a dot on the
 * takeoff lane, and the task's own clock (launch window, start gates, goal
 * deadline) is drawn as labelled rules — so "the field launched an hour
 * before the best climbs" is visible as a gap.
 *
 * An hour is selected by touch, mouse or keyboard (HourColumns.tsx) and its
 * figures print in the legend row, which also names the marks that have no
 * room for a label in the plot and states the takeoff spread. The Climb by
 * hour and Day timing tables below remain the exact, screen-reader-navigable
 * reading.
 *
 * Geometry comes from the stack's `ChartFrame`, and every height here is a
 * multiple of its type size — see frame.ts.
 */
import type { ClimbHourlySeries, DayTimingSeries } from "../../types";
import { formatTimeRange, hhmmInZone } from "@/react/lib/time";
import { useUnits } from "@/react/lib/units";
import { formatMetricValue } from "../../types";
import { unitDisplay } from "../../units";
import { linearScale, niceTicks, quantileSorted } from "../chart-utils";
import type { TimeAxis } from "./time-axis";
import type { ChartFrame } from "./frame";
import { TimeGridColumns, TimeTickLabels } from "./TimeAxisParts";
import { ChartHeader } from "./MetSourceTag";
import { MetLegend, type LegendEntry } from "./MetLegend";
import { HourColumns, columnAt, hourRange, useHourPointer, type HourColumn } from "./HourColumns";
import { approxTextWidth } from "./met-shared";

const HOUR_MS = 3_600_000;

const MEDIAN_STROKE = { stroke: "var(--chart-1)", strokeWidth: 2 };

/** A labelled vertical rule (gate / window / deadline). */
interface RuleMark {
  ms: number;
  label: string;
}

export function ClimbHourlyChart({
  series,
  timing,
  axis,
  frame,
  timeZone,
  selectedMs,
  onSelect,
}: {
  series: ClimbHourlySeries;
  timing: DayTimingSeries | null;
  axis: TimeAxis;
  frame: ChartFrame;
  timeZone: string | undefined;
  selectedMs: number | null;
  onSelect: (tMs: number | null) => void;
}) {
  // Climb rates follow the climb preference; series quantiles are m/s and
  // convert here at the display boundary.
  const climb = unitDisplay("m/s", useUnits());
  const fmtClimb = (v: number) => formatMetricValue(climb.unit, v);

  const hours = series.hours.map((h) => {
    const tMs = new Date(h.t).getTime();
    return {
      ...h,
      median: h.median * climb.factor,
      p10: h.p10 * climb.factor,
      p25: h.p25 * climb.factor,
      p75: h.p75 * climb.factor,
      p90: h.p90 * climb.factor,
      tMs,
      cx: axis.x(tMs + HOUR_MS / 2),
    };
  });
  const columns: HourColumn[] = hours.map((h) => ({
    tMs: h.tMs,
    label:
      `${hourRange(h.tMs, timeZone)} — median ${fmtClimb(h.median)} ${climb.unit} ` +
      `(p25–p75 ${fmtClimb(h.p25)}–${fmtClimb(h.p75)}, p10–p90 ${fmtClimb(h.p10)}–${fmtClimb(h.p90)}), ` +
      `${h.n} climb${h.n === 1 ? "" : "s"}`,
  }));
  const pointer = useHourPointer(frame, axis, columns, onSelect);

  if (hours.length === 0) return null;

  const maxN = Math.max(...hours.map((h) => h.n));
  const yMin = Math.min(0, ...hours.map((h) => h.p10));
  const yMax = Math.max(...hours.map((h) => h.p90)) * 1.08;

  // The task's clock: labelled rules, sorted by time. Only the FIRST gate
  // gets a full rule — a 15-minute gate sequence is 18 rules, which buries
  // the fan — the rest become short ticks at the top of the plot.
  // The axis window is framed by the field's own flying (±2 h), so a clock
  // marker can legitimately fall outside it — an early launch window, a
  // deadline hours after the last landing. Drop those rather than draw into
  // the chart's margin.
  const inDomain = (ms: number) => ms >= axis.domainStart && ms <= axis.domainEnd;
  const rules: RuleMark[] = [];
  const gateTicks: number[] = [];
  if (timing) {
    if (timing.launchOpen) rules.push({ ms: new Date(timing.launchOpen).getTime(), label: "window opens" });
    timing.startGates.forEach((g, i) => {
      if (i === 0) {
        rules.push({
          ms: new Date(g).getTime(),
          label: timing.startGates.length > 1 ? "start gates" : "start gate",
        });
      } else {
        gateTicks.push(new Date(g).getTime());
      }
    });
    if (timing.deadline) rules.push({ ms: new Date(timing.deadline).getTime(), label: "deadline" });
    rules.sort((a, b) => a.ms - b.ms);
  }
  const shownRules = rules.filter((r) => inDomain(r.ms));
  const shownGateTicks = gateTicks.filter(inDomain);

  // Heights in ems of the label size. Each rule's label gets a line of its
  // own above the plot: two rules half an hour apart are 20px apart on a
  // phone, and no stagger of two rows keeps three labels off each other.
  const em = frame.fontSize;
  const labelRows = shownRules.length;
  const plot = { top: em * (1.5 + labelRows * 1.25), bottom: em * (10 + labelRows * 1.25) };
  const takeoffLane = { top: plot.bottom + em * 0.4, bottom: plot.bottom + em * 1.6 };
  const takeoffCy = (takeoffLane.top + takeoffLane.bottom) / 2;
  const nStrip = { top: takeoffLane.bottom + em * 0.3, bottom: takeoffLane.bottom + em * 2.3 };
  const H = nStrip.bottom + em * 2;

  const y = linearScale([yMin, yMax], [plot.bottom, plot.top]);
  const yTicks = niceTicks([yMin, yMax], 3);

  /** Closed area path between an upper and a lower quantile. */
  const bandPath = (upper: (h: (typeof hours)[number]) => number, lower: (h: (typeof hours)[number]) => number) =>
    hours.map((h, i) => `${i === 0 ? "M" : "L"}${h.cx.toFixed(1)},${y(upper(h)).toFixed(1)}`).join("") +
    [...hours].reverse().map((h) => `L${h.cx.toFixed(1)},${y(lower(h)).toFixed(1)}`).join("") +
    "Z";
  const medianPath = hours
    .map((h, i) => `${i === 0 ? "M" : "L"}${h.cx.toFixed(1)},${y(h.median).toFixed(1)}`)
    .join("");

  const bestHour = timing?.bestHour
    ? { fromMs: new Date(timing.bestHour.from).getTime(), toMs: new Date(timing.bestHour.to).getTime() }
    : null;
  const takeoffs = (timing?.takeoffs ?? []).map((t) => new Date(t).getTime()).sort((a, b) => a - b);

  /** "57, 13:40–15:52 AEDT (median 14:21)" — one fact about the day, so it is
   * printed in the legend, where it used to answer a hover over the lane. */
  const takeoffSummary = (): string => {
    const first = new Date(takeoffs[0]).toISOString();
    const last = new Date(takeoffs[takeoffs.length - 1]).toISOString();
    const med = new Date(quantileSorted(takeoffs, 0.5));
    return `${takeoffs.length}, ${formatTimeRange(first, last, timeZone)} (median ${hhmmInZone(med, timeZone)})`;
  };

  const sel = columnAt(hours, selectedMs);
  const legend: LegendEntry[] = [
    {
      key: "median",
      text: "median climb",
      value: sel ? `${fmtClimb(sel.median)} ${climb.unit}` : null,
      ...MEDIAN_STROKE,
    },
  ];
  if (sel) {
    legend.push(
      { key: "p25", kind: "note", text: "p25–p75", value: `${fmtClimb(sel.p25)}–${fmtClimb(sel.p75)}` },
      { key: "p10", kind: "note", text: "p10–p90", value: `${fmtClimb(sel.p10)}–${fmtClimb(sel.p90)}` }
    );
  }
  if (bestHour) {
    legend.push({ key: "best", kind: "box", text: "best climbs", fillClass: "bg-foreground/10" });
  }
  if (takeoffs.length > 0) {
    legend.push({
      key: "takeoffs",
      kind: "dot",
      text: `takeoffs: ${takeoffSummary()}`,
      fillClass: "bg-foreground/50",
    });
  }
  legend.push({
    key: "n",
    kind: "box",
    text: "climbs each hour",
    value: sel ? String(sel.n) : null,
    fillClass: "bg-muted-foreground/30",
  });

  /** Keep a rule's label inside the plot: centred on its rule where there is
   * room, pushed in from an edge where there is not. */
  const ruleLabelX = (r: RuleMark): number => {
    const half = approxTextWidth(r.label, em) / 2;
    return Math.min(frame.plotRight - half, Math.max(frame.plotLeft + half, axis.x(r.ms)));
  };

  const medians = hours.map((h) => h.median);
  return (
    <div className="space-y-0.5" data-day-chart="climb">
      <ChartHeader title="From tracks: climb" when={sel ? hourRange(sel.tMs, timeZone) : null} />
      <MetLegend entries={legend} lines={4} />
      <svg
        viewBox={`0 0 ${frame.width} ${H}`}
        className="h-auto w-full select-none"
        role="group"
        aria-label={
          `Climb by hour: median climb rate with p25 to p75 and p10 to p90 bands across ` +
          `${hours.length} hour${hours.length === 1 ? "" : "s"}, medians ${fmtClimb(Math.min(...medians))} ` +
          `to ${fmtClimb(Math.max(...medians))} ${climb.unit}, plus takeoff times and the task clock. ` +
          `The Climb by hour and Day timing tables below carry the exact numbers.`
        }
        {...pointer}
      >
        {/* Best-conditions hour: shaded band behind everything — it derives
            from these very buckets, so it sits on the median line's hump. */}
        {bestHour ? (
          <rect
            aria-hidden
            x={axis.x(bestHour.fromMs)}
            width={Math.max(0, axis.x(bestHour.toMs) - axis.x(bestHour.fromMs))}
            y={plot.top}
            height={plot.bottom - plot.top}
            className="fill-foreground/10"
          />
        ) : null}

        <TimeGridColumns axis={axis} top={plot.top} bottom={plot.bottom} />
        {yTicks.map((t) => (
          <line
            key={`gy${t}`}
            x1={frame.plotLeft}
            x2={frame.plotRight}
            y1={y(t)}
            y2={y(t)}
            className={t === 0 ? "stroke-muted-foreground/50" : "stroke-border"}
            strokeWidth={1}
          />
        ))}
        <g aria-hidden fontSize={em} className="text-muted-foreground">
          {yTicks.map((t) => (
            <text
              key={`ty${t}`}
              x={frame.plotLeft - em * 0.6}
              y={y(t) + em * 0.35}
              textAnchor="end"
              className="fill-current"
            >
              {fmtClimb(t).replace(/\.0+$/, "")}
            </text>
          ))}
          <text x={0} y={plot.top - em * 0.3} className="fill-current">
            {climb.unit}
          </text>
        </g>

        {/* The quantile fan. A single bucket degenerates to a candle. */}
        {hours.length >= 2 ? (
          <g aria-hidden>
            <path d={bandPath((h) => h.p90, (h) => h.p10)} style={{ fill: "var(--chart-1)" }} opacity={0.12} />
            <path d={bandPath((h) => h.p75, (h) => h.p25)} style={{ fill: "var(--chart-1)" }} opacity={0.2} />
            <path
              d={medianPath}
              fill="none"
              style={{ stroke: MEDIAN_STROKE.stroke }}
              strokeWidth={MEDIAN_STROKE.strokeWidth}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </g>
        ) : (
          <g aria-hidden>
            {hours.map((h) => (
              <g key={h.t}>
                <line
                  x1={h.cx}
                  x2={h.cx}
                  y1={y(h.p10)}
                  y2={y(h.p90)}
                  style={{ stroke: "var(--chart-1)" }}
                  strokeWidth={2}
                  opacity={0.4}
                />
                <rect
                  x={h.cx - 4}
                  width={8}
                  y={y(h.p75)}
                  height={Math.max(1, y(h.p25) - y(h.p75))}
                  style={{ fill: "var(--chart-1)" }}
                  opacity={0.3}
                />
                <line
                  x1={h.cx - 7}
                  x2={h.cx + 7}
                  y1={y(h.median)}
                  y2={y(h.median)}
                  style={{ stroke: "var(--chart-1)" }}
                  strokeWidth={2}
                />
              </g>
            ))}
          </g>
        )}

        {/* The task clock: dashed rules through the plot and lanes, each
            named on a line of its own above the plot; later gates are quiet
            ticks along the top. */}
        <g aria-hidden>
          {shownRules.map((r, i) => (
            <line
              key={`r${r.ms}-${i}`}
              x1={axis.x(r.ms)}
              x2={axis.x(r.ms)}
              y1={em * (0.4 + (i + 1) * 1.25)}
              y2={nStrip.bottom}
              className="stroke-muted-foreground/70"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
          ))}
          {shownGateTicks.map((ms) => (
            <line
              key={`gt${ms}`}
              x1={axis.x(ms)}
              x2={axis.x(ms)}
              y1={plot.top - em * 0.4}
              y2={plot.top + em * 0.4}
              className="stroke-muted-foreground/70"
              strokeWidth={1}
            />
          ))}
          <g fontSize={em} className="text-muted-foreground">
            {shownRules.map((r, i) => (
              <text
                key={`rl${r.ms}-${i}`}
                x={ruleLabelX(r)}
                y={em * (1 + i * 1.25)}
                textAnchor="middle"
                className="fill-current"
              >
                {r.label}
              </text>
            ))}
          </g>
        </g>

        {/* Takeoff lane: every pilot's launch as a dot; overlap = density. */}
        <g aria-hidden>
          {takeoffs.map((t, i) => (
            <circle key={`${t}-${i}`} cx={axis.x(t)} cy={takeoffCy} r={2.5} className="fill-foreground/35" />
          ))}
        </g>

        {/* Climb-count strip: the day's activity, hour by hour. */}
        <g aria-hidden>
          {hours.map((h) => {
            const barW = Math.min(26, Math.max(6, (axis.x(h.tMs + HOUR_MS) - axis.x(h.tMs)) * 0.6));
            const barH = Math.max(1, (h.n / maxN) * (nStrip.bottom - nStrip.top));
            return (
              <rect
                key={`n${h.t}`}
                x={h.cx - barW / 2}
                width={barW}
                y={nStrip.bottom - barH}
                height={barH}
                className="fill-muted-foreground/30"
              />
            );
          })}
        </g>

        <TimeTickLabels axis={axis} y={nStrip.bottom + em * 1.4} frame={frame} />
        <HourColumns
          columns={columns}
          axis={axis}
          top={plot.top}
          bottom={nStrip.bottom}
          selectedMs={selectedMs}
          onSelect={onSelect}
        />
      </svg>
    </div>
  );
}
