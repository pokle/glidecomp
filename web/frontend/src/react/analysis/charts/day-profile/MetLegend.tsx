/**
 * A weather chart's legend: one entry per line on the chart, each behind a
 * short sample of ITS OWN stroke.
 *
 * The labels used to sit inside the plot, at the right-hand end of their
 * lines. At a readable size they do not fit there: "flying height ~1457 m"
 * with its swatch is half the width of a phone's plot, and it was already
 * printing across its own line (issue #860). So they are a row of real text
 * above the plot, which wraps.
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
  /** "line" (default) samples the stroke; "arrow" draws the wind glyph;
   * "note" is text alone — a fact about the dataset, not a series. */
  kind?: "line" | "arrow" | "note";
}

export function MetLegend({ entries }: { entries: LegendEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div
      aria-hidden
      className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground"
    >
      {entries.map((e) => (
        <span key={e.key} className="inline-flex items-center gap-1.5">
          {e.kind === "note" ? null : (
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
          {e.text}
        </span>
      ))}
    </div>
  );
}
