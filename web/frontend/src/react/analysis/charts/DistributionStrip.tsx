/**
 * A one-dimensional strip of the field's values for one metric — where the
 * field sits, how spread it is, and (optionally) where one pilot lands in it.
 *
 * Non-interactive by design: it is a `role="img"` whose accessible name reads
 * the min / median / max in words, and those three numbers are also printed
 * as visible labels, so the strip degrades to text. Density shows through
 * dot overlap at partial opacity.
 *
 * **Drawn in CSS pixels** (`charts/use-chart-box.ts`, issue #860). It was a
 * 560-unit drawing scaled to the page, so a phone painted its labels at
 * 5.7px and its dots a little over 2px across.
 */
import { useMemo } from "react";
import { cn } from "@/react/lib/utils";
import { formatMetricValue, type MetricReport } from "../types";
import { unitWords } from "../units";
import { extent, formatTickValue, linearScale, quantileSorted } from "./chart-utils";
import { useChartBox } from "@/react/charts/use-chart-box";
import { approxTextWidth } from "@/react/charts/text-width";

export function DistributionStrip({
  metric,
  emphasizeTrackFile,
  compact = false,
}: {
  metric: Pick<MetricReport, "label" | "unit" | "perPilot">;
  /** Draw this pilot's dot ringed and name their position in the label. */
  emphasizeTrackFile?: string;
  /** Popover-sized rendering. */
  compact?: boolean;
}) {
  const { ref: svgRef, box } = useChartBox();
  const { values, sorted, emphasized } = useMemo(() => {
    const usable = metric.perPilot.filter(
      (p): p is { trackFile: string; value: number } =>
        p.value !== null && Number.isFinite(p.value)
    );
    return {
      values: usable,
      sorted: usable.map((p) => p.value).sort((a, b) => a - b),
      emphasized: emphasizeTrackFile
        ? (usable.find((p) => p.trackFile === emphasizeTrackFile) ?? null)
        : null,
    };
  }, [metric, emphasizeTrackFile]);

  if (sorted.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No pilot has a usable value for this metric.
      </p>
    );
  }

  const W = box.width;
  const em = box.fontSize;
  const PAD = 14;
  const CY = 16;
  const r = compact ? 3 : 4;
  // Two label lines under the axis: the statistic's name, then its value.
  const nameY = CY + r + 8 + em * 1.05;
  const valueY = nameY + em * 1.2;
  const H = Math.round(valueY + em * 0.45);

  const min = sorted[0];
  const median = quantileSorted(sorted, 0.5);
  const max = sorted[sorted.length - 1];
  const x = linearScale(extent(sorted)!, [PAD, W - PAD]);

  const fmt = (v: number) => formatMetricValue(metric.unit, v);
  const notApplicable = metric.perPilot.length - values.length;

  // Midrank percentile: position of the emphasized pilot within the field.
  const emphasizedPercentile = emphasized
    ? Math.round(
        ((sorted.filter((v) => v < emphasized.value).length +
          sorted.filter((v) => v === emphasized.value).length / 2) /
          sorted.length) *
          100
      )
    : null;

  const label = [
    `Field distribution of ${metric.label}: minimum ${fmt(min)}, median ${fmt(
      median
    )}, maximum ${fmt(max)} ${unitWords(metric.unit)}, over ${sorted.length} pilots.`,
    notApplicable > 0 ? `${notApplicable} not applicable.` : null,
    emphasized
      ? `This pilot at ${fmt(emphasized.value)}, ${emphasizedPercentile}th percentile of the field.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  // De-duplicate colliding min/median/max labels (e.g. a tight field where
  // median ≈ min) — a garbled overlap is worse than fewer labels.
  // Min and max first, so that where the median's label has no room between
  // them it is the median that is left out: the ends are what frame the strip.
  const widthOf = (m: { word: string; value: number }) =>
    Math.max(approxTextWidth(m.word, em), approxTextWidth(formatTickValue(metric.unit, m.value), em));
  const spanOf = (m: { word: string; value: number; anchor: "start" | "middle" | "end" }) => {
    const w = widthOf(m);
    const at = x(m.value);
    const x0 = m.anchor === "start" ? at : m.anchor === "end" ? at - w : at - w / 2;
    return { x0, x1: x0 + w };
  };
  const marks: { word: string; value: number; anchor: "start" | "middle" | "end" }[] = [];
  for (const m of [
    { word: "min", value: min, anchor: "start" as const },
    { word: "max", value: max, anchor: "end" as const },
    { word: "median", value: median, anchor: "middle" as const },
  ]) {
    const span = spanOf(m);
    const clear = marks.every((o) => {
      const taken = spanOf(o);
      return span.x1 + em * 0.6 < taken.x0 || span.x0 - em * 0.6 > taken.x1;
    });
    if (clear) marks.push(m);
  }

  return (
    <svg
      ref={svgRef}
      data-chart="distribution-strip"
      viewBox={`0 0 ${W} ${H}`}
      className={cn("h-auto", compact ? "w-full max-w-70" : "w-full")}
      role="img"
      aria-label={label}
    >
      <line
        x1={PAD}
        x2={W - PAD}
        y1={CY}
        y2={CY}
        className="stroke-border"
        strokeWidth={1}
      />
      {values.map((p) => (
        <circle
          key={p.trackFile}
          cx={x(p.value)}
          cy={CY}
          r={r}
          className="fill-chart-1/50"
        />
      ))}
      {emphasized ? (
        <circle
          cx={x(emphasized.value)}
          cy={CY}
          r={r + 1}
          className="fill-chart-1 stroke-foreground stroke-2"
        />
      ) : null}
      <g aria-hidden fontSize={em} className="text-muted-foreground">
        {marks.map((m) => (
          <g key={m.word}>
            <line
              x1={x(m.value)}
              x2={x(m.value)}
              y1={CY + r + 3}
              y2={CY + r + 8}
              className="stroke-border"
              strokeWidth={1}
            />
            <text
              x={x(m.value)}
              y={nameY}
              textAnchor={m.anchor}
              className="fill-current"
            >
              {m.word}
            </text>
            <text
              x={x(m.value)}
              y={valueY}
              textAnchor={m.anchor}
              className="fill-current"
            >
              {formatTickValue(metric.unit, m.value)}
            </text>
          </g>
        ))}
      </g>
    </svg>
  );
}
