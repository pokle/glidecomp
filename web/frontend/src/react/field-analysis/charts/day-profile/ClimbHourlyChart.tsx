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
 * Hover names the hour (or the takeoff spread) in the panel's shared
 * readout; the Climb by hour and Day timing tables below remain the exact,
 * screen-reader-navigable reading.
 */
import type { ClimbHourlySeries, DayTimingSeries } from "../../types";
import { formatTimeOfDay, formatTimeRange } from "@/react/lib/time";
import { formatTickValue, linearScale, niceTicks, quantileSorted } from "../chart-utils";
import type { TimeAxis } from "./time-axis";
import { TimeGridColumns, TimeTickLabels } from "./TimeAxisParts";
import { PLOT_LEFT, PLOT_RIGHT, W } from "./shared";

const HOUR_MS = 3_600_000;
const H = 216;
const PLOT = { top: 26, bottom: 140 };
const TAKEOFF_LANE = { top: 146, cy: 153, bottom: 160 };
const N_STRIP = { top: 166, bottom: 192 };
const TICK_LABEL_Y = H - 8;

/** A labelled vertical rule (gate / window / deadline). */
interface RuleMark {
  ms: number;
  label: string | null;
}

export function ClimbHourlyChart({
  series,
  timing,
  axis,
  timeZone,
  setReadout,
}: {
  series: ClimbHourlySeries;
  timing: DayTimingSeries | null;
  axis: TimeAxis;
  timeZone: string | undefined;
  setReadout: (text: string | null) => void;
}) {
  if (series.hours.length === 0) return null;

  const hours = series.hours.map((h) => {
    const tMs = new Date(h.t).getTime();
    return { ...h, tMs, cx: axis.x(tMs + HOUR_MS / 2) };
  });
  const maxN = Math.max(...hours.map((h) => h.n));
  const yMin = Math.min(0, ...hours.map((h) => h.p10));
  const yMax = Math.max(...hours.map((h) => h.p90)) * 1.08;
  const y = linearScale([yMin, yMax], [PLOT.bottom, PLOT.top]);
  const yTicks = niceTicks([yMin, yMax], 3);

  /** Closed area path between an upper and a lower quantile. */
  const bandPath = (upper: (h: (typeof hours)[number]) => number, lower: (h: (typeof hours)[number]) => number) =>
    hours.map((h, i) => `${i === 0 ? "M" : "L"}${h.cx.toFixed(1)},${y(upper(h)).toFixed(1)}`).join("") +
    [...hours].reverse().map((h) => `L${h.cx.toFixed(1)},${y(lower(h)).toFixed(1)}`).join("") +
    "Z";
  const medianPath = hours
    .map((h, i) => `${i === 0 ? "M" : "L"}${h.cx.toFixed(1)},${y(h.median).toFixed(1)}`)
    .join("");

  // The task's clock: labelled rules, sorted by time with staggered label
  // rows so adjacent labels don't overprint. Only the FIRST gate gets a
  // full rule — a 15-minute gate sequence is 18 rules, which buries the
  // fan — the rest become short ticks at the top of the plot.
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
  const labelledRules = rules.filter((r) => r.label !== null);

  const bestHour = timing?.bestHour
    ? { fromMs: new Date(timing.bestHour.from).getTime(), toMs: new Date(timing.bestHour.to).getTime() }
    : null;
  const takeoffs = (timing?.takeoffs ?? []).map((t) => new Date(t).getTime()).sort((a, b) => a - b);

  const hourReadout = (h: (typeof hours)[number]): string =>
    `${formatTimeRange(h.t, new Date(h.tMs + HOUR_MS).toISOString(), timeZone)} — ` +
    `median ${h.median.toFixed(1)} m/s (p25–p75 ${h.p25.toFixed(1)}–${h.p75.toFixed(1)}, ` +
    `p10–p90 ${h.p10.toFixed(1)}–${h.p90.toFixed(1)}), ${h.n} climb${h.n === 1 ? "" : "s"}`;

  const takeoffReadout = (): string => {
    if (takeoffs.length === 0) return "";
    const first = new Date(takeoffs[0]).toISOString();
    const last = new Date(takeoffs[takeoffs.length - 1]).toISOString();
    const med = new Date(quantileSorted(takeoffs, 0.5)).toISOString();
    return (
      `${takeoffs.length} takeoffs, ${formatTimeRange(first, last, timeZone)} ` +
      `(median ${formatTimeOfDay(med, timeZone)})`
    );
  };

  const medians = hours.map((h) => h.median);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label={
        `Climb by hour: median climb rate with p25 to p75 and p10 to p90 bands across ` +
        `${hours.length} hour${hours.length === 1 ? "" : "s"}, medians ${Math.min(...medians).toFixed(1)} ` +
        `to ${Math.max(...medians).toFixed(1)} m/s, plus takeoff times and the task clock. ` +
        `The Climb by hour and Day timing tables below carry the exact numbers.`
      }
      onMouseLeave={() => setReadout(null)}
    >
      {/* Best-conditions hour: shaded band behind everything — it derives
          from these very buckets, so it sits on the median line's hump. */}
      {bestHour ? (
        <g aria-hidden>
          <rect
            x={axis.x(bestHour.fromMs)}
            width={Math.max(0, axis.x(bestHour.toMs) - axis.x(bestHour.fromMs))}
            y={PLOT.top - 4}
            height={PLOT.bottom - PLOT.top + 4}
            className="fill-foreground/5"
          />
          <text
            x={(axis.x(bestHour.fromMs) + axis.x(bestHour.toMs)) / 2}
            y={PLOT.top - 8}
            textAnchor="middle"
            className="fill-current text-[9px] text-muted-foreground"
          >
            best climbs
          </text>
        </g>
      ) : null}

      <TimeGridColumns axis={axis} top={PLOT.top} bottom={PLOT.bottom} />
      {yTicks.map((t) => (
        <line
          key={`gy${t}`}
          x1={PLOT_LEFT}
          x2={PLOT_RIGHT}
          y1={y(t)}
          y2={y(t)}
          className={t === 0 ? "stroke-muted-foreground/50" : "stroke-border"}
          strokeWidth={1}
        />
      ))}
      <g aria-hidden className="text-[10px] text-muted-foreground">
        {yTicks.map((t) => (
          <text key={`ty${t}`} x={PLOT_LEFT - 6} y={y(t) + 3} textAnchor="end" className="fill-current">
            {formatTickValue("m/s", t)}
          </text>
        ))}
        <text x={PLOT_LEFT - 6} y={TAKEOFF_LANE.cy + 2} textAnchor="end" className="fill-current text-[9px]">
          takeoffs
        </text>
        <text x={PLOT_LEFT - 6} y={N_STRIP.bottom - 2} textAnchor="end" className="fill-current text-[9px]">
          climbs
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
            style={{ stroke: "var(--chart-1)" }}
            strokeWidth={2}
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

      {/* The task clock: labelled dashed rules through the plot and lanes;
          later gates are quiet ticks along the top. */}
      <g aria-hidden>
        {rules.map((r, i) => (
          <line
            key={`r${r.ms}-${i}`}
            x1={axis.x(r.ms)}
            x2={axis.x(r.ms)}
            y1={PLOT.top - 4}
            y2={N_STRIP.bottom}
            className="stroke-muted-foreground/70"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        ))}
        {gateTicks.map((ms) => (
          <line
            key={`gt${ms}`}
            x1={axis.x(ms)}
            x2={axis.x(ms)}
            y1={PLOT.top - 4}
            y2={PLOT.top + 4}
            className="stroke-muted-foreground/70"
            strokeWidth={1}
          />
        ))}
        {labelledRules.map((r, i) => (
          <text
            key={`rl${r.ms}`}
            x={axis.x(r.ms)}
            y={i % 2 === 0 ? 10 : 20}
            textAnchor="middle"
            className="fill-current text-[9px] text-muted-foreground"
          >
            {r.label}
          </text>
        ))}
      </g>

      {/* Takeoff lane: every pilot's launch as a dot; overlap = density. */}
      {takeoffs.length > 0 ? (
        <g>
          <g aria-hidden>
            {takeoffs.map((t, i) => (
              <circle
                key={`${t}-${i}`}
                cx={axis.x(t)}
                cy={TAKEOFF_LANE.cy}
                r={2.5}
                className="fill-foreground/35"
              />
            ))}
          </g>
          <rect
            x={PLOT_LEFT}
            width={PLOT_RIGHT - PLOT_LEFT}
            y={TAKEOFF_LANE.top}
            height={TAKEOFF_LANE.bottom - TAKEOFF_LANE.top}
            fill="transparent"
            onMouseEnter={() => setReadout(takeoffReadout())}
          />
        </g>
      ) : null}

      {/* Climb-count strip: the day's activity, hour by hour. */}
      <g aria-hidden>
        {hours.map((h) => {
          const barW = Math.min(26, Math.max(6, (axis.x(h.tMs + HOUR_MS) - axis.x(h.tMs)) * 0.6));
          const barH = Math.max(1, (h.n / maxN) * (N_STRIP.bottom - N_STRIP.top));
          return (
            <rect
              key={`n${h.t}`}
              x={h.cx - barW / 2}
              width={barW}
              y={N_STRIP.bottom - barH}
              height={barH}
              className="fill-muted-foreground/30"
            />
          );
        })}
      </g>

      {/* Hover targets: one column per hour bucket, over plot + strip. */}
      {hours.map((h) => (
        <rect
          key={`h${h.t}`}
          x={axis.x(h.tMs)}
          width={Math.max(0, axis.x(h.tMs + HOUR_MS) - axis.x(h.tMs))}
          y={PLOT.top - 4}
          height={PLOT.bottom - PLOT.top + 4}
          fill="transparent"
          onMouseEnter={() => setReadout(hourReadout(h))}
        />
      ))}

      <TimeTickLabels axis={axis} y={TICK_LABEL_Y} />
    </svg>
  );
}
