/**
 * Axis titles — what each axis measures, stated IN the plot.
 *
 * Every chart here already had tick labels carrying units, and several
 * explained their axes in the figcaption underneath instead ("across is what
 * was measured, up is a better rank"). That is the wrong place: a caption is
 * read once, an axis is consulted continuously, and a screenshot or a printed
 * page can separate the two. ConsistencyMap was the only chart that titled its
 * axes properly; these helpers are that pattern extracted so the rest can.
 *
 * Both are `aria-hidden` for the same reason the tick labels are: every chart
 * on these pages is a `role="img"` whose accessible name already states its
 * reading in words, and its exact data lives in a table below. A screen reader
 * gets the sentence; these are the sighted reader's version of it.
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
 * near-universal convention — and the one ConsistencyMap already uses, so the
 * two cannot disagree.
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
 * A chart's own title, top-left inside the plot — what this chart is, where
 * the eye lands first.
 *
 * The day-profile stack established this (`Weather: wind` on MetWindChart);
 * the pilot-derived charts in the same stack had nothing, so a reader scrolling
 * the stack lost track of which quantity they were looking at. Same type size
 * and weight as the modelled charts' titles so the stack reads as one thing.
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
