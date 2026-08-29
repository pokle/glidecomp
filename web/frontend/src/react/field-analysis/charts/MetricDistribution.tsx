/**
 * Where the whole field sat on ONE behaviour — a dot per pilot on a single
 * lane, with the field's average and its ±1 SD band drawn over them.
 *
 * Built for the "Who flew like me?" sheet, which ranks the field by a
 * similarity computed out of z-scores the reader never sees. This is those
 * z-scores' raw material: the spread the mean and standard deviation are taken
 * from, on whichever behaviour the reader picks. Seeing your own dot sitting
 * just outside a tight clump is the whole reason a 0.3 SD gap ranked someone
 * near you, in one glance.
 *
 * Dots rather than bins or a fitted curve, following charts/DistributionStrip
 * and the day profile's takeoff lane. A histogram must choose a bucket width,
 * which at a few dozen values reads as an arbitrary grid laid over the data;
 * a fitted normal curve goes further and asserts a shape flying metrics do not
 * reliably have — they are heavy-tailed, which is the KNOWN LIMITATION the
 * engine's similarity module names explicitly. The mean and the SD band drawn
 * here are not a fit: they are the exact two numbers zScoreColumns() computes,
 * so the picture and the arithmetic behind the table cannot disagree.
 *
 * Presentation-only and free of DOM access, so it is safe wherever the rest of
 * field-analysis renders. Non-interactive by design, matching the strip it is
 * modelled on: `role="img"` whose accessible name is the caption, with the
 * sheet's own table below carrying the exact figures.
 */
import { formatMetricValue, type MetricReport } from "../types";
import { cn } from "@/react/lib/utils";
import { extent, linearScale, niceTicks } from "@/react/charts/scale";
import { axisTitleFor, formatTickValue } from "./chart-utils";
import { XAxisTitle } from "@/react/charts/AxisTitle";

const W = 520;
const H = 128;
const MARGIN = { left: 14, right: 14 };
/** The lane the dots sit on. */
const LANE_Y = 72;
/** Dot radius, matching charts/DistributionStrip and the takeoff lane. */
const DOT_R = 3;
/** Half-height of the shaded ±1 SD band. */
const BAND_HALF = 13;
/**
 * Baselines for marker labels, nearest the lane first. Two rows because these
 * markers genuinely collide: on a behaviour where the field bunched, "−1 SD",
 * "Field average" and the reader's own name all land within a few pixels of
 * each other — and a tightly bunched field is exactly when a reader most wants
 * to know where they sat.
 */
const LABEL_ROWS = [34, 18];
/** Rough label width for collision testing, at the 10px label size. */
const labelWidth = (t: string) => t.length * 5.4;
const TICK_LABEL_Y = 90;
const AXIS_TITLE_Y = 108;
/** How many round ticks to aim for across the axis. */
const TICK_TARGET = 5;
/** |z| below which a pilot is called level with the average rather than above
 *  or below it — a tenth of a standard deviation rounds to "0.0 SD above",
 *  which is a distinction without a difference dressed up as a finding. */
const LEVEL_Z = 0.05;

/** Population mean and standard deviation of the finite values — the same two
 * numbers the engine's zScoreColumns() takes, over the pilots that HAVE the
 * behaviour. This is the whole field, not a sample drawn from a larger one, so
 * the divisor is n. */
export function fieldStats(values: number[]): { mean: number; sd: number } | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  const mean = finite.reduce((s, v) => s + v, 0) / finite.length;
  const sd = Math.sqrt(
    finite.reduce((s, v) => s + (v - mean) ** 2, 0) / finite.length
  );
  return { mean, sd };
}

/** Small counts as words, so the caption reads as a sentence rather than as a
 * form field. Beyond three the sheet never rings more than it lists. */
function numberWord(n: number): string {
  return ["zero", "one", "two", "three", "four", "five"][n] ?? String(n);
}

export interface CaptionArgs {
  metricLabel: string;
  unit: string;
  /** Pilots with a reading — the dots actually drawn. */
  n: number;
  subjectName: string;
  subjectValue: number;
  mean: number;
  sd: number;
  /** How many neighbours are ringed. */
  ringed: number;
  /** Pilots with no reading for this behaviour. Never silently dropped. */
  missing: number;
}

/**
 * The caption, which is also the chart's accessible name. It states the three
 * readings the picture carries — the field size, where this pilot sat, and how
 * far that is from the average in the standard deviations the table speaks in.
 *
 * Deliberately unitless: the unit is named once, in the axis title, rather
 * than three times in one sentence, and the sheet's own table below the chart
 * prints every figure with its unit.
 */
export function captionText(a: CaptionArgs): string {
  const value = formatMetricValue(a.unit, a.subjectValue);
  const mean = formatMetricValue(a.unit, a.mean);
  const z = a.sd === 0 ? 0 : (a.subjectValue - a.mean) / a.sd;

  const placing =
    Math.abs(z) < LEVEL_Z
      ? `${a.subjectName} sat at ${value}, level with the field average.`
      : `${a.subjectName} sat at ${value}, ${Math.abs(z).toFixed(1)} SD ${
          z > 0 ? "above" : "below"
        } the field average of ${mean}.`;

  const band =
    a.ringed === 0
      ? "The shaded band is one standard deviation either side of that average."
      : a.ringed === 1
        ? `The shaded band is one standard deviation either side of that average, and the ringed dot is the pilot closest to ${a.subjectName} overall.`
        : `The shaded band is one standard deviation either side of that average, and the ringed dots are the ${numberWord(
            a.ringed
          )} pilots closest to ${a.subjectName} overall.`;

  const missing =
    a.missing === 0
      ? ""
      : a.missing === 1
        ? " 1 pilot had no reading for this behaviour and is not shown."
        : ` ${a.missing} pilots had no reading for this behaviour and are not shown.`;

  return `${a.metricLabel} for ${a.n} pilot${a.n === 1 ? "" : "s"}. ${placing} ${band}${missing}`;
}

export interface MetricDistributionProps {
  /** The behaviour to draw, already converted to the reader's units. */
  metric: MetricReport;
  /** The report's pilots, for names. Paired by trackFile rather than by index
   * — perPilot carries its own key, and pairing by position is the bug class
   * this codebase has been bitten by before. */
  pilots: { trackFile: string; pilotName: string }[];
  subjectTrackFile: string;
  /** Neighbours to ring, closest first. */
  ringed: { trackFile: string }[];
}

export function MetricDistribution({
  metric,
  pilots,
  subjectTrackFile,
  ringed,
}: MetricDistributionProps) {
  const nameByTrack = new Map(pilots.map((p) => [p.trackFile, p.pilotName]));
  const ringedSet = new Set(ringed.map((r) => r.trackFile));

  const points = metric.perPilot
    .filter((p) => p.value !== null && Number.isFinite(p.value))
    .map((p) => ({
      trackFile: p.trackFile,
      value: p.value as number,
      name: nameByTrack.get(p.trackFile) ?? p.trackFile,
    }));
  const missing = metric.perPilot.length - points.length;

  const stats = fieldStats(points.map((p) => p.value));
  const subject = points.find((p) => p.trackFile === subjectTrackFile);
  // One dot is not a spread, and a subject with no reading has nothing to be
  // placed against — say nothing rather than draw a lane the caption cannot
  // describe. The sheet's table still lists everyone either way.
  if (!stats || !subject || points.length < 2) return null;

  const { mean, sd } = stats;
  const plot = { left: MARGIN.left, right: W - MARGIN.right };
  // The band is unioned into the domain rather than assumed to fall inside it:
  // on a two-pilot field mean ± sd lands exactly on the ends, and on a skewed
  // one it is not worth proving which side it clears.
  const domain = extent([...points.map((p) => p.value), mean - sd, mean + sd]) ?? [
    mean,
    mean,
  ];
  const x = linearScale(domain, [plot.left + DOT_R + 2, plot.right - DOT_R - 2]);
  const ticks = niceTicks(domain, TICK_TARGET);

  // Markers, laid out most important first so it is never the reader's own
  // name that gets bumped to the far row. Centred and clamped by its own width
  // so nothing runs off an edge.
  const markers: { key: string; x: number; label: string; you?: boolean }[] = [
    { key: "you", x: subject.value, label: subject.name, you: true },
    { key: "mean", x: mean, label: "Field average" },
  ];
  // A zero-SD field (every pilot identical) has no band to label, and two
  // rules drawn on top of the average would say nothing.
  if (sd > 0) {
    markers.push({ key: "sd-lo", x: mean - sd, label: "−1 SD" });
    markers.push({ key: "sd-hi", x: mean + sd, label: "+1 SD" });
  }

  const placed: (typeof markers[number] & { labelX: number; labelY: number })[] = [];
  const rowEnds: number[] = LABEL_ROWS.map(() => -Infinity);
  for (const m of markers) {
    const half = labelWidth(m.label) / 2;
    const labelX = Math.min(W - half - 2, Math.max(half + 2, x(m.x)));
    let row = LABEL_ROWS.findIndex((_, i) => labelX - half > rowEnds[i] + 4);
    if (row < 0) row = LABEL_ROWS.length - 1;
    rowEnds[row] = Math.max(rowEnds[row], labelX + half);
    placed.push({ ...m, labelX, labelY: LABEL_ROWS[row] });
  }

  const caption = captionText({
    metricLabel: metric.label,
    unit: metric.unit,
    n: points.length,
    subjectName: subject.name,
    subjectValue: subject.value,
    mean,
    sd,
    ringed: points.filter((p) => ringedSet.has(p.trackFile)).length,
    missing,
  });

  return (
    <figure className="mt-1 max-w-2xl space-y-1">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={caption}
      >
        {/* The ±1 SD band, behind everything: it is the frame the field is
            read against, not a mark in its own right. */}
        {sd > 0 ? (
          <rect
            aria-hidden
            x={x(mean - sd)}
            y={LANE_Y - BAND_HALF}
            width={Math.max(0, x(mean + sd) - x(mean - sd))}
            height={BAND_HALF * 2}
            className="fill-muted-foreground/10"
          />
        ) : null}

        {/* The lane, so the dots sit on something rather than float. */}
        <line
          x1={plot.left}
          x2={plot.right}
          y1={LANE_Y}
          y2={LANE_Y}
          className="stroke-border"
          strokeWidth={1}
        />

        {/* Rules under the dots — one drawn over a dot hides the very pilot
            the reader came to find. */}
        {placed.map((m) => (
          <g key={m.key}>
            <line
              x1={x(m.x)}
              x2={x(m.x)}
              y1={m.labelY + 4}
              y2={LANE_Y + 12}
              strokeWidth={m.you ? 2 : 1}
              strokeDasharray={m.you ? undefined : "3 3"}
              className={cn(m.you ? "stroke-chart-1" : "stroke-muted-foreground/60")}
            />
            <text
              aria-hidden
              x={m.labelX}
              y={m.labelY}
              textAnchor="middle"
              className={cn(
                "fill-current stroke-background text-[10px] [paint-order:stroke] [stroke-width:3px]",
                m.you ? "font-medium text-foreground" : "text-muted-foreground"
              )}
            >
              {m.label}
            </text>
          </g>
        ))}

        {/* Every pilot. Partial opacity so overlap darkens — that stacking IS
            the density reading, and is why these are not bars. */}
        <g aria-hidden>
          {points.map((p) =>
            p.trackFile === subjectTrackFile ? null : (
              <circle
                key={p.trackFile}
                cx={x(p.value)}
                cy={LANE_Y}
                r={DOT_R}
                className="fill-foreground/30"
              >
                <title>{`${p.name} — ${formatMetricValue(metric.unit, p.value)} ${metric.unit}`}</title>
              </circle>
            )
          )}
        </g>

        {/* The nearest neighbours, ringed rather than recoloured: colour is
            never the only channel here either, and a ring survives sitting on
            top of the darkened clump the field makes. */}
        <g aria-hidden>
          {points
            .filter((p) => ringedSet.has(p.trackFile) && p.trackFile !== subjectTrackFile)
            .map((p) => (
              <circle
                key={p.trackFile}
                cx={x(p.value)}
                cy={LANE_Y}
                r={DOT_R + 2.5}
                fill="none"
                strokeWidth={1.5}
                className="stroke-chart-2"
              >
                <title>{`${p.name} — ${formatMetricValue(metric.unit, p.value)} ${metric.unit}`}</title>
              </circle>
            ))}
        </g>

        {/* The reader, drawn last and ringed against the surface so it stays
            findable inside a dense clump of the field. */}
        <circle
          cx={x(subject.value)}
          cy={LANE_Y}
          r={DOT_R + 2}
          className="fill-chart-1 stroke-background stroke-2"
        >
          <title>{`${subject.name} — ${formatMetricValue(metric.unit, subject.value)} ${metric.unit}`}</title>
        </circle>

        {/* Round intermediate ticks: without them a reader has no way to place
            a dot between the two ends. Formatted by the shared field-analysis
            tick formatter, so a percentage reads "40%" here exactly as it does
            on the scatter, and the axis is titled by the shared helper. */}
        <g aria-hidden className="text-[10px] text-muted-foreground">
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={x(t)}
                x2={x(t)}
                y1={LANE_Y + 8}
                y2={LANE_Y + 12}
                className="stroke-border"
                strokeWidth={1}
              />
              <text x={x(t)} y={TICK_LABEL_Y} textAnchor="middle" className="fill-current">
                {formatTickValue(metric.unit, t)}
              </text>
            </g>
          ))}
          <XAxisTitle left={plot.left} right={plot.right} y={AXIS_TITLE_Y}>
            {axisTitleFor(metric)}
          </XAxisTitle>
        </g>
      </svg>
      <figcaption className="text-xs text-muted-foreground">{caption}</figcaption>
    </figure>
  );
}
