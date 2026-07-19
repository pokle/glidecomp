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
 */
import { useMemo, useState } from "react";
import { SimpleSelect } from "@/react/rac/select";
import type { FieldAnalysisReport, ReportSeries } from "../types";
import { linearScale } from "./chart-utils";

const W = 560;
const H = 252;
// bottom fits two staggered rows of leg labels.
const MARGIN = { top: 22, right: 12, bottom: 40, left: 12 };
const PLOT = {
  left: MARGIN.left,
  right: W - MARGIN.right,
  top: MARGIN.top,
  bottom: H - MARGIN.bottom,
};

/** Signed "m:ss", the same reading as the engine's table cells. */
function fmtSignedMinSec(seconds: number): string {
  const sign = seconds < 0 ? "-" : "+";
  const abs = Math.round(Math.abs(seconds));
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`;
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
  series: ReportSeries;
  report: FieldAnalysisReport;
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
  const selected =
    pilots.find((p) => p.trackFile === (selectedTrack ?? defaultTrack)) ?? pilots[0];

  if (!selected || series.xLabels.length === 0) return null;

  const maxAbs = Math.max(
    30, // floor: a ±30 s scale keeps near-zero bars from filling the plot
    ...selected.points.flatMap((v) => (v === null ? [] : [Math.abs(v)]))
  );
  // Symmetric diverging scale; losses (positive) extend DOWN from zero.
  const y = linearScale([-maxAbs, maxAbs], [PLOT.bottom, PLOT.top]);
  const zeroY = y(0);
  const slot = (PLOT.right - PLOT.left) / series.xLabels.length;
  const barWidth = Math.min(48, slot * 0.6);

  const total = selected.points.reduce<number>((acc, v) => acc + (v ?? 0), 0);
  const comparedLegs = selected.points.filter((v) => v !== null).length;

  const chartLabel = `${series.title}, bar chart for ${selected.name}: ${series.xLabels
    .map((label, i) => {
      const v = selected.points[i];
      return `${label} ${v === null ? "not compared" : fmtSignedMinSec(v)}`;
    })
    .join(", ")}. Positive is time lost to the winner.`;

  return (
    <figure className="space-y-2">
      <SimpleSelect
        ariaLabel="Pilot for the leg waterfall"
        value={selected.trackFile}
        onChange={setSelectedTrack}
        options={pilots.map((p) => ({
          value: p.trackFile,
          label: `${p.rank}. ${p.name}`,
        }))}
      />

      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={chartLabel}>
        {/* The zero line: level with the winner. */}
        <line
          x1={PLOT.left}
          x2={PLOT.right}
          y1={zeroY}
          y2={zeroY}
          className="stroke-border"
          strokeWidth={1}
        />
        {series.xLabels.map((label, i) => {
          const cx = PLOT.left + slot * i + slot / 2;
          const v = selected.points[i];
          return (
            <g key={i}>
              {v === null ? (
                <text
                  x={cx}
                  y={zeroY - 5}
                  textAnchor="middle"
                  className="fill-current text-[10px] text-muted-foreground"
                >
                  —
                </text>
              ) : (
                <>
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
                    // Just past the bar's end, clamped inside the plot so a
                    // full-scale bar's label sits over it (the halo keeps it
                    // readable) instead of colliding with the leg labels.
                    y={
                      v >= 0
                        ? Math.min(y(-v) + 12, PLOT.bottom - 4)
                        : Math.max(y(-v) - 4, PLOT.top + 10)
                    }
                    textAnchor="middle"
                    className="fill-current stroke-background text-[10px] font-medium text-foreground [paint-order:stroke] [stroke-width:3px]"
                  >
                    {fmtSignedMinSec(v)}
                  </text>
                </>
              )}
              <text
                x={cx}
                // Staggered rows: adjacent leg labels are wider than a slot.
                y={PLOT.bottom + 14 + (i % 2) * 12}
                textAnchor="middle"
                className="fill-current text-[10px] text-muted-foreground"
              >
                {label}
              </text>
            </g>
          );
        })}
      </svg>

      <figcaption className="text-xs text-muted-foreground">
        {selected.name} against the winner, leg by leg: bars hanging below the
        line are time lost, bars above are time gained
        {comparedLegs > 0
          ? `; over the ${comparedLegs} compared leg${comparedLegs === 1 ? "" : "s"}, ${
              total === 0 ? "dead level" : `${fmtSignedMinSec(total)} overall`
            }`
          : ""}
        . — marks a leg the pilot or the winner did not complete; the table
        below has every pilot.
      </figcaption>
    </figure>
  );
}
