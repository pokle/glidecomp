/**
 * Axis furniture shared by every hand-rolled SVG chart in the app: axis
 * titles, the corner unit stamp, and a chart's own in-plot title.
 *
 * Why these exist at all: several charts had let the FIGCAPTION do their axes'
 * job. RankScatter's opened "Each dot is a pilot: across is what was measured,
 * up is a better rank" — a sentence that existed only because its x axis had
 * no title and its y axis said "rank" in 10px grey in a corner. A caption is
 * read once; an axis is consulted continuously, and a screenshot or a printed
 * page separates the two. field-analysis/charts/ConsistencyMap was the one
 * chart doing it properly, and this is its pattern extracted.
 *
 * Promoted out of field-analysis/charts/ for the same reason `scale.ts` was:
 * the report card's score charts draw the same furniture, and two chart
 * families spelling it two ways is exactly the drift a shared module prevents.
 * Everything here is presentation-only with no DOM access, so it is safe in
 * the SSR bundle (both the public comp pages and the report card render
 * server-side).
 *
 * Everything here is `aria-hidden`, on the same grounds the tick labels are:
 * every chart in this codebase is a `role="img"` whose accessible name states
 * its reading in words, with a table below carrying the exact values. A screen
 * reader gets the sentence; these are the sighted reader's version of it.
 */

/** Centred under the plot, naming what runs across. */
export function XAxisTitle({
  left,
  right,
  y,
  children,
}: {
  left: number;
  right: number;
  /** Baseline, in viewBox units — below the tick labels, not on them. */
  y: number;
  children: string;
}) {
  return (
    <text
      aria-hidden
      x={(left + right) / 2}
      y={y}
      textAnchor="middle"
      className="fill-current text-[10px] text-muted-foreground"
    >
      {children}
    </text>
  );
}

/**
 * Rotated up the left edge, naming what runs up. Reads bottom-to-top, the
 * near-universal convention — and the one ConsistencyMap already used, so the
 * two cannot disagree.
 *
 * Reach for this over {@link AxisUnit} when the axis needs NAMING, not just a
 * unit: where the reader could otherwise mistake which end is good ("rank — 1
 * is the winner"), or where the quantity is not obvious from the chart's
 * surroundings ("behind the leader (minutes)").
 */
export function YAxisTitle({
  x,
  top,
  bottom,
  children,
}: {
  /** Distance from the left edge of the viewBox — inside the plot's left
   * margin, clear of the tick labels. */
  x: number;
  top: number;
  bottom: number;
  children: string;
}) {
  const cy = (top + bottom) / 2;
  return (
    <text
      aria-hidden
      x={x}
      y={cy}
      textAnchor="middle"
      transform={`rotate(-90 ${x} ${cy})`}
      className="fill-current text-[10px] text-muted-foreground"
    >
      {children}
    </text>
  );
}

/**
 * The unit stamp above the y ticks ("pts", "m") — deliberately NOT the same
 * thing as a {@link YAxisTitle}, and kept because for some charts it is the
 * honest answer.
 *
 * The distinction: a stamp says what the NUMBERS are, a title says what the
 * AXIS is. On the report card's score curves the y axis is points and nothing
 * else, and the section heading above already names the component being
 * scored — so "pts" is complete, and a rotated title would only restate that
 * heading. Where a corner label was hiding a real ambiguity instead (which end
 * of "rank" is good?), naming the axis is a title's job and the corner form
 * was the bug.
 *
 * Placement is fixed here rather than passed, so every chart's stamp lands in
 * the same spot relative to its plot.
 */
export function AxisUnit({
  left,
  top,
  children,
}: {
  /** The plot's left edge and top, in viewBox units. */
  left: number;
  top: number;
  children: string;
}) {
  return (
    <text
      aria-hidden
      x={left - 6}
      y={top - 2}
      textAnchor="end"
      className="fill-current text-[10px] text-muted-foreground"
    >
      {children}
    </text>
  );
}

/**
 * A chart's own title, top-left inside the plot — what this chart is, where
 * the eye lands first.
 *
 * The day-profile stack established this ("Weather: wind" on MetWindChart);
 * the pilot-derived charts in the same stack had nothing, so a reader
 * scrolling the stack lost track of which quantity they were looking at. Same
 * type size and weight as the modelled charts' titles so the stack reads as
 * one thing.
 */
export function ChartTitle({
  x,
  y,
  children,
}: {
  x: number;
  y: number;
  children: string;
}) {
  return (
    <text
      aria-hidden
      x={x}
      y={y}
      className="fill-current text-[10px] font-medium text-muted-foreground"
    >
      {children}
    </text>
  );
}
