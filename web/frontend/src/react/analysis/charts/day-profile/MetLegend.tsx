/**
 * A weather chart's legend: one entry per line on the chart, each behind a
 * short sample of ITS OWN stroke.
 *
 * The labels used to sit inside the plot, at the right-hand end of their
 * lines. At a readable size they do not fit there: "flying height ~1457 m"
 * with its swatch is half the width of a phone's plot, and it was already
 * printing across its own line (issue #860). So they are a row of real text
 * above the plot, which wraps — and which prints each line's figure for the
 * selected hour beside its name.
 *
 * The swatch is what tells the lines apart — the wind chart's two are the
 * same colour and differ only by dash, and the thermal chart's two cross on
 * exactly the day worth reading. Pass the SAME stroke object to the `<path>`
 * and to the legend, so the two can never drift apart.
 */
import { windArrowPath } from "./met-shared";

/** Stroke appearance shared by a series' line and its legend swatch. */
export interface SeriesStroke {
  /** CSS colour, typically a `var(--chart-N)` token. */
  stroke: string;
  strokeWidth: number;
  /** The series' `strokeDasharray`; omitted for a solid line. */
  dash?: string;
  opacity?: number;
}

export interface LegendEntry extends Partial<SeriesStroke> {
  key: string;
  text: string;
  /**
   * This series' figure for the selected hour, printed after its name —
   * the legend is where the exact figures are read (issue #860). A share
   * price chart does the same: the numbers are beside the chart they belong
   * to, nothing floats over the plot, and nothing is hover-only.
   */
  value?: string | null;
  /** "line" (default) samples the stroke; "arrow" draws the wind glyph;
   * "box" is a filled swatch (`fillClass`); "dot" a point mark; "note" is
   * text alone. */
  kind?: "line" | "arrow" | "box" | "dot" | "note";
  /** Tailwind background class for a "box" or "dot" swatch; a "box" with an
   * `opacity` is drawn at it. */
  fillClass?: string;
}

/** Height held for the legend below the `sm` breakpoint, in lines of text.
 * The row gets longer when an hour is chosen and its figures are printed;
 * without the reserve the charts would move under the finger choosing it. */
const MIN_LINES = {
  1: "min-h-4",
  2: "min-h-8 sm:min-h-4",
  3: "min-h-12 sm:min-h-4",
  4: "min-h-16 sm:min-h-4",
} as const;

export type LegendLines = keyof typeof MIN_LINES;

export function MetLegend({
  entries,
  when,
  lines = 1,
  className = "",
}: {
  entries: LegendEntry[];
  /** The selected hour, printed first so the figures after it say which
   * hour they are for. */
  when?: string | null;
  lines?: LegendLines;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      data-chart-legend
      className={`flex flex-wrap content-start gap-x-4 gap-y-0 text-xs text-muted-foreground ${MIN_LINES[lines]} ${className}`}
    >
      {when ? (
        <span data-chart-when className="font-medium text-foreground">
          {when}
        </span>
      ) : null}
      {entries.map((e) => (
        <span key={e.key} className="inline-flex items-center gap-1.5">
          {e.kind === "note" ? null : e.kind === "box" ? (
            <span
              className={`inline-block size-3 shrink-0 rounded-xs border border-border ${e.fillClass ?? ""}`}
              // A scale of shades (the cloud chart's cover) is one fill at
              // several opacities, the same ones its cells are drawn in.
              style={e.opacity === undefined ? undefined : { opacity: e.opacity }}
            />
          ) : e.kind === "dot" ? (
            <span className={`inline-block size-1.5 shrink-0 rounded-full ${e.fillClass ?? ""}`} />
          ) : (
            <svg viewBox="0 0 18 12" className="h-3 w-[18px] shrink-0">
              {e.kind === "arrow" ? (
                <path
                  d={windArrowPath(13)}
                  transform="translate(9 6) rotate(90)"
                  fill="none"
                  style={{ stroke: e.stroke }}
                  strokeWidth={e.strokeWidth}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={e.opacity}
                />
              ) : (
                <line
                  x1={1}
                  x2={17}
                  y1={6}
                  y2={6}
                  style={{ stroke: e.stroke }}
                  strokeWidth={e.strokeWidth}
                  strokeDasharray={e.dash}
                  strokeLinecap="round"
                  opacity={e.opacity}
                />
              )}
            </svg>
          )}
          <span>
            {e.text}
            {e.value ? <span className="font-medium text-foreground"> {e.value}</span> : null}
          </span>
        </span>
      ))}
    </div>
  );
}
