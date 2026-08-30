/**
 * The mark that identifies one highlighted pilot on a rank scatter — a
 * diamond in --chart-5, not another blue circle. Shape AND colour, because
 * a ring in --ring on a --chart-1 fill was the same blue and vanished
 * (accessibility standard §3.1: never colour alone).
 *
 * One path, two homes: the scatter draws it over the field, and the
 * Highlight a pilot field shows the same glyph as a legend so the two
 * cannot disagree.
 */
import { cn } from "@/react/lib/utils";

/** Half the diagonal, in RankScatter viewBox units. */
export const HIGHLIGHT_MARK_SIZE = 8;
export const HIGHLIGHT_MARK_STROKE = 3;

export function PilotHighlightMark({
  x,
  y,
  size = HIGHLIGHT_MARK_SIZE,
  className,
}: {
  x: number;
  y: number;
  size?: number;
  className?: string;
}) {
  return (
    <path
      aria-hidden
      d={`M${x},${y - size} L${x + size},${y} L${x},${y + size} L${x - size},${y} Z`}
      strokeWidth={HIGHLIGHT_MARK_STROKE}
      className={cn("fill-chart-5 stroke-background", className)}
    />
  );
}

/** The scatter's diamond, sized for the Highlight a pilot control row. */
export function PilotHighlightLegend({ className }: { className?: string }) {
  const box = 24;
  const c = box / 2;
  return (
    <svg
      viewBox={`0 0 ${box} ${box}`}
      className={cn("size-5 shrink-0", className)}
      aria-hidden
    >
      <PilotHighlightMark x={c} y={c} />
    </svg>
  );
}
