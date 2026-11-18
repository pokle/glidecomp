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
import type { ChartFrame } from "./frame";
import { TimeTickLabels } from "./TimeAxisParts";
import { ChartHeader, sourceSentence } from "./MetSourceTag";
import { MetLegend, type LegendEntry } from "./MetLegend";
import { HourColumns, columnAt, hourRange, useHourPointer, type HourColumn } from "./HourColumns";
import { cloudReading } from "./met-readout";
import { coverOpacity } from "./met-shared";

const HOUR_MS = 3_600_000;

/** The layers in DRAWING order: high at the top, low at the bottom, so the
 * lanes are stacked the way the sky is — and so this chart sitting above the
 * ceiling chart reads as one continuous column of air. */
const LANES = [
  { key: "highPct", label: "high" },
  { key: "midPct", label: "mid" },
  { key: "lowPct", label: "low" },
] as const;

export function MetSkyChart({
  hours,
  source,
  axis,
  frame,
  timeZone,
  selectedMs,
  onSelect,
}: {
  hours: WeatherHour[];
  source: WeatherSource;
  axis: TimeAxis;
  frame: ChartFrame;
  timeZone: string | undefined;
  selectedMs: number | null;
  onSelect: (tMs: number | null) => void;
}) {
  const cells = hours.map((h) => ({
    tMs: new Date(h.t).getTime(),
    cloud: h.cloud,
    rainMm: h.precipitationMm,
  }));
  const columns: HourColumn[] = hours.map((h) => {
    const tMs = new Date(h.t).getTime();
    const when = formatTimeRange(h.t, new Date(tMs + HOUR_MS).toISOString(), timeZone);
    const reading = cloudReading(h);
    return {
      tMs,
      label: reading ? `${when} — cloud cover ${reading}` : `${when} — no cloud figures`,
    };
  });
  const pointer = useHourPointer(frame, axis, columns, onSelect);

  if (cells.length === 0) return null;
  // Nothing to draw if the dataset carried no cloud at all.
  if (!cells.some((c) => LANES.some(({ key }) => c.cloud[key] !== null))) return null;

  // Heights in ems of the label size: three lanes, a strip for the rain
  // marks, and a row for the time labels.
  const em = frame.fontSize;
  const laneTop = em * 0.3;
  const laneH = em * 1.7;
  const laneGap = em * 0.2;
  const laneY = (i: number) => laneTop + i * (laneH + laneGap);
  const lanesBottom = laneY(LANES.length - 1) + laneH;
  const H = lanesBottom + em * 2.8;

  const peakLow = Math.max(0, ...cells.map((c) => c.cloud.lowPct ?? 0));

  // The lanes are named beside themselves, so this legend is empty until an
  // hour is chosen: then it is that hour's cover, layer by layer.
  const sel = columnAt(cells, selectedMs);
  const legend: LegendEntry[] = sel
    ? LANES.filter(({ key }) => sel.cloud[key] !== null).map(({ key, label }) => ({
        key,
        kind: "note" as const,
        text: label,
        value: `${Math.round(sel.cloud[key]!)}%`,
      }))
    : [];
  if (sel && sel.rainMm && sel.rainMm > 0) {
    legend.push({ key: "rain", kind: "note", text: "rain", value: `${sel.rainMm.toFixed(1)} mm` });
  }

  return (
    <div className="space-y-0.5" data-met-chart="cloud">
      <ChartHeader
        title="Weather: cloud"
        when={sel ? hourRange(sel.tMs, timeZone) : null}
        source={source}
      />
      <MetLegend entries={legend} />
      <svg
        viewBox={`0 0 ${frame.width} ${H}`}
        className="h-auto w-full select-none"
        role="group"
        aria-label={
          `Cloud cover by hour in three layers — high, mid and low, top to bottom — across ` +
          `${cells.length} hour${cells.length === 1 ? "" : "s"}; darker means more cover. ` +
          `Low cloud peaks at ${Math.round(peakLow)} percent. ` +
          sourceSentence(source)
        }
        {...pointer}
      >
        {LANES.map(({ key, label }, i) => (
          <g key={key}>
            <text
              aria-hidden
              x={frame.plotLeft - em * 0.6}
              y={laneY(i) + laneH / 2 + em * 0.35}
              textAnchor="end"
              fontSize={em}
              className="fill-current text-muted-foreground"
            >
              {label}
            </text>
            {/* Lane bed, so an hour with 0% still reads as "measured and clear"
                rather than as a hole in the data. */}
            <rect
              x={frame.plotLeft}
              y={laneY(i)}
              width={frame.plotRight - frame.plotLeft}
              height={laneH}
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
                  height={laneH}
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
              y={lanesBottom + em * 0.8}
              textAnchor="middle"
              fontSize={em * 0.9}
              className="fill-current text-muted-foreground"
            >
              ▾
            </text>
          ) : null
        )}

        <TimeTickLabels axis={axis} y={lanesBottom + em * 2.2} frame={frame} />
        <HourColumns
          columns={columns}
          axis={axis}
          top={0}
          bottom={lanesBottom + em * 0.9}
          selectedMs={selectedMs}
          onSelect={onSelect}
        />
      </svg>
    </div>
  );
}
