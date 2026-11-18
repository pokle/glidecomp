/**
 * The leg waterfall, drawn: one pilot's time gained or lost against the task
 * winner, leg by leg. Time LOST hangs below the zero line (down = worse,
 * matching "up is better" everywhere else on the page); time gained pokes
 * above it. The bar labels carry the signed m:ss the table prints.
 *
 * One pilot at a time, chosen with a select (default: the highest-ranked
 * pilot who actually differs from the winner) — 30 pilots × 6 legs of bars
 * at once is a wall, and "where did THIS pilot lose the race" is the
 * question a debrief actually asks. The waterfall table below remains the
 * whole-field, screen-reader-navigable reading.
 *
 * **Drawn in CSS pixels** (`charts/use-chart-box.ts`, issue #860). It was a
 * 560-unit drawing scaled to the page, so a phone painted its labels at
 * 5.3px. At a readable size a leg's own name ("HALFWY→CUDGWE") is more than
 * twice as wide as its bar on a phone. A leg is the stretch between two
 * turnpoints, so the axis names the TURNPOINTS, at the edges of the bars,
 * and each name is said once: the same axis the horserace above this chart
 * has. See {@link legBoundaries}.
 */
import { useMemo, useState } from "react";
import { SimpleSelect } from "@/react/rac/select";
import type { CategoricalReportSeries, TaskAnalysisReport } from "../types";
import { linearScale, staggerRows } from "./chart-utils";
import { XAxisTitle, YAxisTitle } from "@/react/charts/AxisTitle";
import { useChartBox } from "@/react/charts/use-chart-box";
import { approxTextWidth } from "@/react/charts/text-width";

const Y_TITLE = "time against the winner (m:ss)";

/** Signed "m:ss", the same reading as the engine's table cells. */
function fmtSignedMinSec(seconds: number): string {
  const sign = seconds < 0 ? "-" : "+";
  const abs = Math.round(Math.abs(seconds));
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`;
}

/**
 * The turnpoints at the edges of the legs, when the legs join end to end:
 * `["SSS→HALFWY", "HALFWY→CUDG", "CUDG→ESS"]` gives
 * `["SSS", "HALFWY", "CUDG", "ESS"]`, one more name than there are legs.
 *
 * Read from the leg labels because that is all a stored report carries
 * (`CategoricalReportSeries.xLabels`), and a report stored before this chart
 * changed has to draw too. Null when the labels are not that shape — a name
 * with an arrow in it, or legs that do not join — and the caller then names
 * each leg whole, under its own bar.
 */
export function legBoundaries(legLabels: readonly string[]): string[] | null {
  if (legLabels.length === 0) return null;
  const legs = legLabels.map((label) => label.split("→"));
  if (legs.some((ends) => ends.length !== 2 || ends[0] === "" || ends[1] === "")) return null;
  for (let i = 1; i < legs.length; i++) {
    if (legs[i][0] !== legs[i - 1][1]) return null;
  }
  return [legs[0][0], ...legs.map((ends) => ends[1])];
}

interface WaterfallPilot {
  trackFile: string;
  name: string;
  rank: number;
  points: (number | null)[];
}

export function LegWaterfall({
  series,
  report,
}: {
  series: CategoricalReportSeries;
  report: TaskAnalysisReport;
}) {
  const pilots = useMemo<WaterfallPilot[]>(() => {
    const byTrack = new Map(report.pilots.map((p) => [p.trackFile, p]));
    return series.perPilot
      .flatMap((s) => {
        const pilot = byTrack.get(s.trackFile);
        return pilot && s.points.some((v) => v !== null)
          ? [{ trackFile: s.trackFile, name: pilot.pilotName, rank: pilot.rank, points: s.points }]
          : [];
      })
      .sort((a, b) => a.rank - b.rank);
  }, [series, report]);

  // Default to the best-ranked pilot with something to show — the winner
  // compared with themselves is a row of zeros.
  const defaultTrack =
    pilots.find((p) => p.points.some((v) => v !== null && v !== 0))?.trackFile ??
    pilots[0]?.trackFile ??
    null;
  const [selectedTrack, setSelectedTrack] = useState<string | null>(null);
  const { ref: svgRef, box } = useChartBox();
  const selected =
    pilots.find((p) => p.trackFile === (selectedTrack ?? defaultTrack)) ?? pilots[0];

  if (!selected || series.xLabels.length === 0) return null;

  const W = box.width;
  const em = box.fontSize;
  const legCount = series.xLabels.length;

  // The names under the axis: turnpoints at the bars' edges where the legs
  // join end to end, else each leg's own name under its bar.
  const boundaries = legBoundaries(series.xLabels);
  const axisLabels = boundaries ?? series.xLabels;
  const labelWidths = axisLabels.map((label) => approxTextWidth(label, em));

  // Margins hold type, so each is measured in it.
  // - left: the rotated axis title's line, and the half of the first
  //   turnpoint name that overhangs the plot's edge.
  // - right: the half of the last name that overhangs.
  const overhang = (width: number) => (boundaries ? width / 2 + 2 : 0);
  const plotLeft = Math.round(Math.max(em * 2, overhang(labelWidths[0])));
  const plotRight = W - Math.ceil(Math.max(em * 0.5, overhang(labelWidths[labelWidths.length - 1])));
  const slot = (plotRight - plotLeft) / legCount;
  const rows = staggerRows(labelWidths, slot, em * 0.6);
  const plotTop = Math.round(em * 0.5);
  // Tall enough for the rotated title, whatever the width.
  const plotHeight = Math.round(
    Math.max(Math.min(em * 20, Math.max(em * 13, W * 0.45)), approxTextWidth(Y_TITLE, em) + em)
  );
  const plotBottom = plotTop + plotHeight;
  const rowHeight = em * 1.25;
  const xTitleY = plotBottom + em * 1.4 + rowHeight * rows;
  const H = Math.round(xTitleY + em * 0.5);

  const maxAbs = Math.max(
    30, // floor: a ±30 s scale keeps near-zero bars from filling the plot
    ...selected.points.flatMap((v) => (v === null ? [] : [Math.abs(v)]))
  );
  // Symmetric diverging scale; losses (positive) extend DOWN from zero.
  const y = linearScale([-maxAbs, maxAbs], [plotBottom, plotTop]);
  const zeroY = y(0);
  const barWidth = Math.min(em * 3.7, slot * 0.6);

  // A bar's value is printed just past the bar's end. Where a slot is
  // narrower than the value, neighbours would run into each other, so every
  // second value goes to the far side of the zero line instead, where its
  // neighbours' values are not.
  const valueWidth = Math.max(
    ...selected.points.map((v) => (v === null ? 0 : approxTextWidth(fmtSignedMinSec(v), em)))
  );
  const tight = slot < valueWidth + 2;
  function valueY(v: number, i: number): number {
    const below = v >= 0; // a loss hangs below the zero line
    if (tight && i % 2 === 1) return below ? zeroY - em * 0.35 : zeroY + em * 1.05;
    // Clamped inside the plot, so a full-scale bar's value sits over the bar
    // (the halo keeps it readable) and not on the names under the axis.
    return below
      ? Math.min(y(-v) + em * 1.05, plotBottom - em * 0.3)
      : Math.max(y(-v) - em * 0.35, plotTop + em * 0.9);
  }

  const total = selected.points.reduce<number>((acc, v) => acc + (v ?? 0), 0);
  const comparedLegs = selected.points.filter((v) => v !== null).length;

  const chartLabel = `${series.title}, bar chart for ${selected.name}: ${series.xLabels
    .map((label, i) => {
      const v = selected.points[i];
      return `${label} ${v === null ? "not compared" : fmtSignedMinSec(v)}`;
    })
    .join(", ")}. Positive is time lost to the winner.`;

  return (
    <figure className="space-y-2" data-chart="waterfall">
      <SimpleSelect
        ariaLabel="Pilot for the leg waterfall"
        value={selected.trackFile}
        onChange={setSelectedTrack}
        options={pilots.map((p) => ({
          value: p.trackFile,
          label: `${p.rank}. ${p.name}`,
        }))}
      />

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={chartLabel}
      >
        {/* Where one leg ends and the next begins. The line runs down to its
            turnpoint's name, which may be on a lower row. */}
        {boundaries
          ? boundaries.map((_, i) => (
              <line
                key={`edge${i}`}
                x1={plotLeft + slot * i}
                x2={plotLeft + slot * i}
                y1={plotTop}
                y2={plotBottom + rowHeight * (i % rows)}
                className="stroke-border"
                strokeWidth={1}
              />
            ))
          : null}

        {/* The zero line: level with the winner. */}
        <line
          x1={plotLeft}
          x2={plotRight}
          y1={zeroY}
          y2={zeroY}
          className="stroke-muted-foreground/50"
          strokeWidth={1}
        />

        {/* The axes, named. This chart had no y ticks at all — only a zero
            line and the signed bar labels — so nothing said what the height
            of a bar meant, nor which side of the line was the bad one. */}
        <YAxisTitle x={em * 1.05} top={plotTop} bottom={plotBottom} fontSize={em}>
          {Y_TITLE}
        </YAxisTitle>
        <XAxisTitle left={plotLeft} right={plotRight} y={xTitleY} fontSize={em}>
          speed-section legs, in order
        </XAxisTitle>

        <g aria-hidden fontSize={em} className="text-muted-foreground">
          {axisLabels.map((label, i) => (
            <text
              key={`tx${i}`}
              // A turnpoint sits on the edge between two bars; a whole leg's
              // name sits under the middle of its own.
              x={plotLeft + slot * (boundaries ? i : i + 0.5)}
              y={plotBottom + em * 1.05 + rowHeight * (i % rows)}
              textAnchor="middle"
              className="fill-current"
            >
              {label}
            </text>
          ))}
        </g>

        {selected.points.map((v, i) => {
          const cx = plotLeft + slot * i + slot / 2;
          return v === null ? (
            <text
              key={i}
              x={cx}
              y={zeroY - em * 0.4}
              textAnchor="middle"
              fontSize={em}
              className="fill-current text-muted-foreground"
            >
              —
            </text>
          ) : (
            <g key={i}>
              <rect
                x={cx - barWidth / 2}
                // Loss (positive) hangs below zero; gain rises above it.
                y={v >= 0 ? zeroY : y(-v)}
                width={barWidth}
                height={Math.max(1, Math.abs(y(Math.abs(v)) - zeroY))}
                rx={2}
                style={{
                  // Diverging pair off the fixed palette: losses warm
                  // (--chart-3), gains cool (--chart-1). Which side of
                  // the zero line carries the sign; colour reinforces.
                  fill: v >= 0 ? "var(--chart-3)" : "var(--chart-1)",
                }}
              />
              <text
                x={cx}
                y={valueY(v, i)}
                textAnchor="middle"
                fontSize={em}
                className="fill-current stroke-background font-medium text-foreground [paint-order:stroke] [stroke-width:3px]"
              >
                {fmtSignedMinSec(v)}
              </text>
            </g>
          );
        })}
      </svg>

      {/* The y axis says "time against the winner" and the x says the legs are
          in order, so the caption drops both. The running total is the reading
          the chart cannot state in a label, so it stays. */}
      <figcaption className="text-xs text-muted-foreground">
        {selected.name}
        {comparedLegs > 0
          ? `, over ${comparedLegs} compared leg${comparedLegs === 1 ? "" : "s"}: ${
              total === 0 ? "dead level" : `${fmtSignedMinSec(total)} overall`
            }`
          : ""}
        . — marks a leg the pilot or the winner did not complete; the table
        below has every pilot.
      </figcaption>
    </figure>
  );
}
