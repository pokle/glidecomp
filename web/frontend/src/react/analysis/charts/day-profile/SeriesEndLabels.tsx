/**
 * Inline series labels at the right-hand end of a line chart, each preceded
 * by a short sample of ITS OWN stroke.
 *
 * The panel's weather charts label their lines inline rather than in a legend
 * box — at this size a box costs more room than the two words it explains.
 * But a bare word only identifies a line by the position it happens to sit
 * at, and the two lines on the thermal chart cross on exactly the day worth
 * reading (cloud base passing the mixed-layer top). The swatch settles it:
 * solid orange or dashed pink, same weight and dash pattern as the line
 * itself, so the label is readable wherever the lines end up.
 *
 * Pass the SAME style object to the `<path>` and to the label, so the two can
 * never drift apart.
 */
import { approxTextWidth } from "./met-shared";

/** Stroke appearance shared by a series' line and its label swatch. */
export interface SeriesStroke {
  /** CSS colour, typically a `var(--chart-N)` token. */
  stroke: string;
  strokeWidth: number;
  /** The series' `strokeDasharray`; omitted for a solid line. */
  dash?: string;
  opacity?: number;
}

export interface SeriesEndLabel extends SeriesStroke {
  key: string;
  text: string;
  /** Text baseline, already separated/clamped by the caller. */
  y: number;
}

const FONT_PX = 9;
const SWATCH_LEN = 14;
/** Between swatch and text, and between the text and the plot's right edge. */
const SWATCH_GAP = 4;
/** Baseline → optical middle of a 9 px line of text. */
const MID_RISE = 3;

export function SeriesEndLabels({ x, labels }: { x: number; labels: SeriesEndLabel[] }) {
  return (
    <g aria-hidden className="text-[9px] text-muted-foreground">
      {labels.map(({ key, text, y, stroke, strokeWidth, dash, opacity }) => {
        // Text stays right-anchored to the plot edge (it always has, and the
        // labels line up down the stack); the swatch is placed from an
        // estimate of the text's width, deliberately a slight over-estimate
        // so a wrong guess opens a small gap rather than overprinting.
        const swatchRight = x - approxTextWidth(text, FONT_PX) - SWATCH_GAP;
        return (
          <g key={key}>
            <line
              x1={swatchRight - SWATCH_LEN}
              x2={swatchRight}
              y1={y - MID_RISE}
              y2={y - MID_RISE}
              style={{ stroke }}
              strokeWidth={strokeWidth}
              strokeDasharray={dash}
              strokeLinecap="round"
              opacity={opacity}
            />
            <text x={x} y={y} textAnchor="end" className="fill-current">
              {text}
            </text>
          </g>
        );
      })}
    </g>
  );
}
