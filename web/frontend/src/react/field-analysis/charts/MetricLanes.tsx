/**
 * A family's behaviours as a stack of percentile lanes — one lane per
 * behaviour, one dot per pilot, all on ONE shared 0–100 axis.
 *
 * This answers the question a family IS, and which nothing else on the page
 * answers: *was this pilot good across the whole of climbing, or only one part
 * of it?* The per-pilot table below carries exact values but its columns are
 * in different units, so they cannot be compared with each other; the
 * percentile heatmap compares everything at once but as luminance, with no
 * numbers and — since it stopped grouping by family — no family reading at all.
 *
 * The pilot connector is what makes it a profile rather than five unrelated
 * strips: hover anyone (here, in the table, in the heatmap, in a cluster chip —
 * `PilotHighlightContext` is page-wide) and a line joins their dots down the
 * lanes. Exactly one line ever exists, which is the whole reason this is not
 * parallel coordinates: forty polylines over six axes is spaghetti, and the
 * usual fix is to stop drawing thirty-five of them.
 *
 * The line BREAKS across a lane where the pilot has no value. Drawing through
 * would invent a value nobody has, and null here means "not applicable", never
 * a score of zero.
 *
 * Two honest-presentation rules the caption states rather than assumes:
 * a percentile axis makes every lane's distribution uniform by construction,
 * so position says who-is-where and never how spread the field was (hence the
 * value labels at each lane's ends, and no quartile band — on this axis it
 * would always be 25–75); and right is the end the behaviour is EXPECTED to be
 * better at, never a claim that it paid on this task. Neutral metrics are not
 * oriented at all and wear †.
 *
 * Accessibility: one `role="img"` figure whose name reads every lane in words
 * (`lanesAccessibleName`), naming the table below as the data equivalent —
 * the same contract `PercentileHeatmap` states. The dots are deliberately not
 * focusable: six lanes of forty pilots would be 240 tab stops, and every value
 * is already in a keyboard-navigable table a few pixels down.
 *
 * Hand-rolled SVG, and all geometry is arithmetic from the data — never a DOM
 * measurement — so it renders identically in a test, on workerd, and in a
 * browser. See charts/chart-utils.ts and day-profile/met-shared.ts.
 */
import { useMemo, useState } from "react";
import { formatMetricValue, type FieldAnalysisReport, type MetricReport } from "../types";
import { unitWords } from "../units";
import { usePilotHighlight } from "../PilotHighlightContext";
import { formatTickValue, linearScale } from "./chart-utils";
import {
  buildLanes,
  lanesAccessibleName,
  lanesCaption,
  type Lane,
  type LanePoint,
} from "./metric-lanes";

const W = 560;
/** Gutter for the behaviour names; the plot starts here. */
const PLOT_LEFT = 138;
/** Plot ends here; the coverage count sits to its right. */
const PLOT_RIGHT = 508;
const TOP_PAD = 6;
/** Dot row plus the value-label row beneath it. */
const LANE_H = 34;
/** Where in a lane the dots sit. */
const DOT_DY = 11;
/** Where in a lane the value labels sit. */
const LABEL_DY = 25;
/** Tick labels and the axis title. */
const AXIS_H = 30;
const TICKS = [0, 25, 50, 75, 100];
/** Minimum gap between two value labels before the middle one is dropped. */
const LABEL_MIN_GAP = 54;

/** A lane's dots, keyed for the connector. */
function pointOf(lane: Lane, trackFile: string | null): LanePoint | null {
  if (!trackFile) return null;
  return lane.points.find((p) => p.trackFile === trackFile) ?? null;
}

export function MetricLanes({
  metrics,
  pilots,
  /** Names the figure — "Climbing" for a family, the selection for a builder. */
  subject,
}: {
  metrics: MetricReport[];
  pilots: FieldAnalysisReport["pilots"];
  subject: string;
}) {
  const { highlight, setHighlight } = usePilotHighlight();
  const [readout, setReadout] = useState<{ lane: Lane; point: LanePoint } | null>(null);

  const lanes = useMemo(() => buildLanes(metrics, pilots), [metrics, pilots]);

  // One lane is a worse DistributionStrip, and the strip is already one ⓘ
  // away from every metric name. The comparison is the point.
  if (lanes.length < 2) return null;

  // Whose profile the connector draws. A percentile axis spreads the field
  // near-evenly by construction, so with nobody picked the lanes are rows of
  // dots and little else — and print and a reader who never hovers get only
  // that. So the winner is drawn by default, the same "show the strongest
  // finding on first paint" the separation ranking and the leg waterfall
  // already do. Hovering anyone replaces them.
  const leader = [...pilots].sort((a, b) => a.rank - b.rank)[0] ?? null;
  const shownTrack = highlight ?? leader?.trackFile ?? null;
  const shownPilot = highlight
    ? pilots.find((p) => p.trackFile === highlight) ?? null
    : leader;

  const H = TOP_PAD + lanes.length * LANE_H + AXIS_H;
  const x = linearScale([0, 100], [PLOT_LEFT, PLOT_RIGHT]);
  const laneTop = (i: number) => TOP_PAD + i * LANE_H;
  const axisY = TOP_PAD + lanes.length * LANE_H;

  // The connector: the highlighted pilot's dots, in lane order, split into
  // runs of consecutive lanes where they actually have a value.
  const connector: Array<Array<{ x: number; y: number }>> = [];
  if (shownTrack) {
    let run: Array<{ x: number; y: number }> = [];
    lanes.forEach((lane, i) => {
      const p = pointOf(lane, shownTrack);
      if (!p) {
        if (run.length > 1) connector.push(run);
        run = [];
        return;
      }
      run.push({ x: x(p.pct), y: laneTop(i) + DOT_DY });
    });
    if (run.length > 1) connector.push(run);
  }

  function readoutText({ lane, point }: { lane: Lane; point: LanePoint }): string {
    // Deliberately the same shape of sentence the heatmap's readout uses —
    // the two describe the same quantity and must not word it differently.
    const position = lane.neutral
      ? `${Math.round(point.pct)}th percentile by value (no good/bad direction)`
      : `better than ${Math.round(point.pct)}% of the field`;
    return `${point.pilotName} — ${lane.label}: ${formatMetricValue(
      lane.unit,
      point.value
    )} ${unitWords(lane.unit)}, ${position} of the ${lane.n} measured here.`;
  }

  return (
    <figure className="space-y-1 break-inside-avoid">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={lanesAccessibleName(lanes, subject)}
        onMouseLeave={() => {
          setReadout(null);
          setHighlight(null);
        }}
      >
        {/* Gridlines first, so every dot overprints them. */}
        <g aria-hidden>
          {TICKS.map((t) => (
            <line
              key={t}
              x1={x(t)}
              x2={x(t)}
              y1={TOP_PAD}
              y2={axisY}
              className={t === 50 ? "stroke-border" : "stroke-border/50"}
              strokeWidth={1}
            />
          ))}
        </g>

        {/* Lanes: name, baseline, every pilot's dot, and the end values. */}
        {lanes.map((lane, i) => {
          const top = laneTop(i);
          const cy = top + DOT_DY;
          const pcts = lane.points.map((p) => p.pct);
          const minPct = Math.min(...pcts);
          const maxPct = Math.max(...pcts);
          // Real dot positions, not the axis ends: the leftmost dot is where
          // the lane's low value actually is.
          const marks = lane.degenerate
            ? [{ key: "only", value: lane.median, at: 50, anchor: "middle" as const }]
            : [
                { key: "low", value: lane.low, at: minPct, anchor: "start" as const },
                { key: "median", value: lane.median, at: 50, anchor: "middle" as const },
                { key: "high", value: lane.high, at: maxPct, anchor: "end" as const },
              ].filter(
                (m, j, all) =>
                  j === 0 || Math.abs(x(m.at) - x(all[j - 1].at)) > LABEL_MIN_GAP
              );

          return (
            <g key={lane.metricId}>
              <text
                aria-hidden
                x={PLOT_LEFT - 8}
                y={cy + 3}
                textAnchor="end"
                className="fill-current text-[10px] text-muted-foreground"
              >
                {lane.shortLabel}
                {lane.neutral ? " †" : lane.direction === "higher" ? " ↑" : " ↓"}
              </text>

              <line
                x1={PLOT_LEFT}
                x2={PLOT_RIGHT}
                y1={cy}
                y2={cy}
                className="stroke-border"
                strokeWidth={1}
              />

              {lane.points.map((p) => (
                <circle
                  key={p.trackFile}
                  cx={x(p.pct)}
                  cy={cy}
                  r={4}
                  className="fill-chart-1/50"
                />
              ))}

              <g aria-hidden className="text-[9px] text-muted-foreground">
                {marks.map((m) => (
                  <text
                    key={m.key}
                    x={x(m.at)}
                    y={top + LABEL_DY}
                    textAnchor={m.anchor}
                    className="fill-current"
                  >
                    {formatTickValue(lane.unit, m.value)}
                  </text>
                ))}
              </g>

              <text
                aria-hidden
                x={PLOT_RIGHT + 6}
                y={cy + 3}
                className="fill-current text-[9px] text-muted-foreground"
              >
                {lane.n}/{pilots.length}
              </text>
            </g>
          );
        })}

        {/* The highlighted pilot's profile. Ink, not a chart hue: the dots
            carry identity, this is an annotation over them. */}
        {connector.map((run, i) => (
          <polyline
            key={i}
            aria-hidden
            points={run.map((p) => `${p.x},${p.y}`).join(" ")}
            className="fill-none stroke-foreground"
            strokeWidth={1.5}
          />
        ))}

        {/* Their dots, drawn last so the connector passes behind them. */}
        {lanes.map((lane, i) => {
          const p = pointOf(lane, shownTrack);
          if (!p) return null;
          return (
            <circle
              key={lane.metricId}
              aria-hidden
              cx={x(p.pct)}
              cy={laneTop(i) + DOT_DY}
              r={5}
              className="fill-chart-1 stroke-foreground stroke-2"
            />
          );
        })}

        {/* Hit targets last so they sit above every mark. Invisible and
            oversized, per WCAG 2.5.8 — a 4px dot is not a pointer target. */}
        {lanes.map((lane, i) =>
          lane.points.map((p) => (
            <circle
              key={`${lane.metricId}-${p.trackFile}`}
              cx={x(p.pct)}
              cy={laneTop(i) + DOT_DY}
              r={9}
              className="fill-transparent"
              onMouseEnter={() => {
                setHighlight(p.trackFile);
                setReadout({ lane, point: p });
              }}
            />
          ))
        )}

        <g aria-hidden className="text-[9px] text-muted-foreground">
          {TICKS.map((t) => (
            <text
              key={t}
              x={x(t)}
              y={axisY + 12}
              textAnchor={t === 0 ? "start" : t === 100 ? "end" : "middle"}
              className="fill-current"
            >
              {t}
            </text>
          ))}
          <text x={(PLOT_LEFT + PLOT_RIGHT) / 2} y={axisY + 24} textAnchor="middle" className="fill-current">
            percentile in this field
          </text>
        </g>
      </svg>

      {/* Visual mirror of hover; the table below is the accessible read.
          Hidden in print — an invitation to hover means nothing on paper. */}
      <p aria-hidden className="min-h-4 text-xs text-muted-foreground print:hidden">
        {readout
          ? readoutText(readout)
          : shownPilot
            ? `Showing #${shownPilot.rank} ${shownPilot.pilotName} — hover any dot to follow a different pilot.`
            : "Hover a dot to follow that pilot through every lane."}
      </p>

      {/* Paper has no hover, so the line above never prints — but the
          connector does, and an unattributed line is worse than none. Same
          swap the pilot-class select makes: the control disappears, its state
          becomes a sentence. */}
      {shownPilot ? (
        <p className="hidden text-xs text-muted-foreground print:block">
          Profile drawn: #{shownPilot.rank} {shownPilot.pilotName}.
        </p>
      ) : null}

      <figcaption className="text-xs text-muted-foreground">
        {lanesCaption(lanes)}
      </figcaption>
    </figure>
  );
}
