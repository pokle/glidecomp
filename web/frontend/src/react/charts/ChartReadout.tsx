/**
 * The line above a chart that names the mark a reader has selected, and
 * until then says that one can be.
 *
 * **Above the plot, not under it.** A reader on a phone selects with a
 * finger, and a hand covers what is below it; the line used to sit under
 * the plot, where a finger dragged through the dots hid it. The weather
 * charts print their figures above the plot for the same reason (issue
 * #860).
 *
 * **It holds its height.** The sentence is longer than the prompt and wraps
 * on a phone, and the plot is under it, so without the room held the chart
 * would move under the finger choosing from it. `lines` is how many lines
 * the longest sentence takes at phone width.
 *
 * `aria-hidden`: every mark already announces itself to a screen reader, so
 * a live region here would say it twice. Hidden in print, where an
 * invitation to select means nothing.
 */
const MIN_LINES = {
  1: "min-h-4",
  2: "min-h-8 sm:min-h-4",
  3: "min-h-12 sm:min-h-8",
} as const;

export function ChartReadout({
  prompt,
  lines = 1,
  children,
}: {
  /** What the line says while nothing is selected. */
  prompt: string;
  lines?: keyof typeof MIN_LINES;
  /** The selected mark, in words; null or absent for none. */
  children?: string | null;
}) {
  return (
    <p
      aria-hidden
      data-chart-readout
      className={`text-xs text-muted-foreground print:hidden ${MIN_LINES[lines]}`}
    >
      {children ? <span className="font-medium text-foreground">{children}</span> : prompt}
    </p>
  );
}
