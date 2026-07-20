/**
 * The shared time axis, drawn: vertical hour gridlines and the wall-clock
 * tick labels. Every chart in the day-profile panel renders both from the
 * SAME TimeAxis object, which is what keeps a vertical scan meaningful
 * across the stack.
 */
import type { TimeAxis } from "./time-axis";

export function TimeGridColumns({
  axis,
  top,
  bottom,
}: {
  axis: TimeAxis;
  top: number;
  bottom: number;
}) {
  return (
    <>
      {axis.ticks.map((t) => (
        <line
          key={t.ms}
          x1={axis.x(t.ms)}
          x2={axis.x(t.ms)}
          y1={top}
          y2={bottom}
          className="stroke-border"
          strokeWidth={1}
        />
      ))}
    </>
  );
}

export function TimeTickLabels({ axis, y }: { axis: TimeAxis; y: number }) {
  return (
    <g aria-hidden className="text-[10px] text-muted-foreground">
      {axis.ticks.map((t) => (
        <text key={t.ms} x={axis.x(t.ms)} y={y} textAnchor="middle" className="fill-current">
          {t.label}
        </text>
      ))}
    </g>
  );
}
