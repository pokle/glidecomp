/**
 * Cloud cover by hour — three lanes stacked as the sky is (high at the top,
 * low at the bottom), each hour a cell whose shading is that layer's cover.
 *
 * Lanes rather than a stacked area, because the three figures do not sum:
 * they are three independent covers of the same sky, and stacking them would
 * invent a 240 % overcast. Shading rather than three more lines, because
 * what a pilot wants from this row is a pattern read at a glance — the hour
 * the low cloud filled in, the afternoon the high cirrus arrived and the
 * climbs died — not three values to a decimal place.
 *
 * Each layer is what it costs a free-flying pilot:
 *   low  (to ~2 km)  the cumulus you fly under, and the overdevelopment that
 *                    shuts the day down
 *   mid  (2–6 km)    spreading altocumulus shading the ground
 *   high (6 km+)     cirrus taking the edge off the heating
 *
 * Rain gets a mark of its own, because "the sky filled in" and "it rained on
 * the course line" are different days and the cover percentages alone cannot
 * tell them apart.
 */
import type { WeatherHour, WeatherSource } from "@/react/weather/types";
import { formatTimeRange } from "@/react/lib/time";
import type { TimeAxis } from "./time-axis";
import { TimeTickLabels } from "./TimeAxisParts";
import { MetSourceTag, sourceSentence } from "./MetSourceTag";
import { PLOT_LEFT, PLOT_RIGHT, W } from "./shared";
import { coverOpacity } from "./met-shared";

const HOUR_MS = 3_600_000;
const H = 104;
const LANE_TOP = 22;
const LANE_H = 17;
const LANE_GAP = 2;
const TICK_LABEL_Y = H - 8;

/** Layers in the pilot's order — low first — which is how the readout reads
 * them out. */
const LAYERS = [
  { key: "lowPct", label: "low", description: "low cloud, below about 2 km" },
  { key: "midPct", label: "mid", description: "mid cloud, 2 to 6 km" },
  { key: "highPct", label: "high", description: "high cloud, above 6 km" },
] as const;

/** The same layers in DRAWING order: high at the top, low at the bottom, so
 * the lanes are stacked the way the sky is — and so this chart sitting above
 * the ceiling chart reads as one continuous column of air. */
const LANES = [...LAYERS].reverse();

export function MetSkyChart({
  hours,
  source,
  axis,
  timeZone,
  setReadout,
}: {
  hours: WeatherHour[];
  source: WeatherSource;
  axis: TimeAxis;
  timeZone: string | undefined;
  setReadout: (text: string | null) => void;
}) {
  const cells = hours.map((h) => ({
    tMs: new Date(h.t).getTime(),
    cloud: h.cloud,
    rainMm: h.precipitationMm,
  }));
  if (cells.length === 0) return null;
  // Nothing to draw if the dataset carried no cloud at all.
  if (!cells.some((c) => LAYERS.some(({ key }) => c.cloud[key] !== null))) return null;

  const laneY = (i: number) => LANE_TOP + i * (LANE_H + LANE_GAP);

  const readout = (c: (typeof cells)[number]): string => {
    const when = formatTimeRange(
      new Date(c.tMs).toISOString(),
      new Date(c.tMs + HOUR_MS).toISOString(),
      timeZone
    );
    const parts = LAYERS.filter(({ key }) => c.cloud[key] !== null).map(
      ({ key, label }) => `${label} ${Math.round(c.cloud[key]!)}%`
    );
    const rain = c.rainMm && c.rainMm > 0 ? `, rain ${c.rainMm.toFixed(1)} mm` : "";
    return `${when} — cloud cover ${parts.join(", ")}${rain}`;
  };

  const peakLow = Math.max(0, ...cells.map((c) => c.cloud.lowPct ?? 0));

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label={
        `Cloud cover by hour in three layers — high, mid and low, top to bottom — across ` +
        `${cells.length} hour${cells.length === 1 ? "" : "s"}; darker means more cover. ` +
        `Low cloud peaks at ${Math.round(peakLow)} percent. ` +
        sourceSentence(source)
      }
      onMouseLeave={() => setReadout(null)}
    >
      <text
        aria-hidden
        x={PLOT_LEFT - 38}
        y={12}
        className="fill-current text-[10px] font-medium text-muted-foreground"
      >
        Weather: cloud
      </text>
      <MetSourceTag source={source} y={12} />

      {LANES.map(({ key, label }, i) => (
        <g key={key}>
          <text
            aria-hidden
            x={PLOT_LEFT - 6}
            y={laneY(i) + LANE_H / 2 + 3}
            textAnchor="end"
            className="fill-current text-[9px] text-muted-foreground"
          >
            {label}
          </text>
          {/* Lane bed, so an hour with 0% still reads as "measured and clear"
              rather than as a hole in the data. */}
          <rect
            x={PLOT_LEFT}
            y={laneY(i)}
            width={PLOT_RIGHT - PLOT_LEFT}
            height={LANE_H}
            className="fill-muted"
            opacity={0.5}
          />
          {cells.map((c) => {
            const pct = c.cloud[key];
            if (pct === null) return null;
            const x0 = axis.x(c.tMs);
            const x1 = axis.x(c.tMs + HOUR_MS);
            return (
              <rect
                key={`${key}${c.tMs}`}
                x={x0}
                y={laneY(i)}
                width={Math.max(0, x1 - x0)}
                height={LANE_H}
                style={{ fill: "var(--chart-1)" }}
                opacity={coverOpacity(pct)}
              />
            );
          })}
        </g>
      ))}

      {/* Rain: a mark under the lanes, not a fourth lane — it is an event,
          and on most competition days there are none at all. */}
      {cells.map((c) =>
        c.rainMm && c.rainMm > 0 ? (
          <text
            key={`r${c.tMs}`}
            aria-hidden
            x={axis.x(c.tMs + HOUR_MS / 2)}
            y={laneY(LAYERS.length) + 8}
            textAnchor="middle"
            className="fill-current text-[9px] text-muted-foreground"
          >
            ▾
          </text>
        ) : null
      )}

      {cells.map((c) => (
        <rect
          key={`h${c.tMs}`}
          x={axis.x(c.tMs)}
          width={Math.max(0, axis.x(c.tMs + HOUR_MS) - axis.x(c.tMs))}
          y={LANE_TOP}
          height={LANE_H * 3 + LANE_GAP * 2 + 10}
          fill="transparent"
          onMouseEnter={() => setReadout(readout(c))}
        />
      ))}

      <TimeTickLabels axis={axis} y={TICK_LABEL_Y} />
    </svg>
  );
}
