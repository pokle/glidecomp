/**
 * The shared time axis, drawn: vertical hour gridlines and the wall-clock
 * tick labels. Every chart in the day-profile panel renders both from the
 * SAME TimeAxis object, which is what keeps a vertical scan meaningful
 * across the stack.
 */
import { tickLabelStride, type TimeAxis } from "./time-axis";
import type { ChartFrame } from "./frame";
import { approxTextWidth } from "./met-shared";
import { W, PLOT_LEFT, PLOT_RIGHT } from "./shared";
import { XAxisTitle } from "@/react/charts/AxisTitle";

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

/**
 * The wall-clock labels under a chart. With a `frame` they are drawn at the
 * frame's type size and thinned so neighbours never touch; without one they
 * keep the fixed 10-unit type the charts that have not had their label pass
 * still use.
 */
export function TimeTickLabels({
  axis,
  y,
  frame,
}: {
  axis: TimeAxis;
  y: number;
  frame?: ChartFrame;
}) {
  const stride = frame
    ? tickLabelStride(axis, approxTextWidth("00:00", frame.fontSize) + frame.fontSize * 0.7)
    : 1;
  return (
    <g
      aria-hidden
      fontSize={frame?.fontSize}
      className={frame ? "text-muted-foreground" : "text-[10px] text-muted-foreground"}
    >
      {axis.ticks.map((t, i) =>
        i % stride === 0 ? (
          <text key={t.ms} x={axis.x(t.ms)} y={y} textAnchor="middle" className="fill-current">
            {t.label}
          </text>
        ) : null
      )}
    </g>
  );
}

/**
 * The shared axis's title, in its own strip UNDER the whole stack.
 *
 * Every chart in the panel repeats the hour ticks — that is what makes a
 * vertical scan legible — but the axis is one axis, so its title is written
 * once, at the bottom, rather than five times. Its own `<svg>` on the panel's
 * viewBox and plot bounds, so it lines up with the ticks above it without any
 * caller doing geometry.
 */
export function TimeAxisTitle({ zone, frame }: { zone: string; frame?: ChartFrame }) {
  if (frame) {
    const h = frame.fontSize * 1.4;
    return (
      <svg viewBox={`0 0 ${frame.width} ${h}`} className="h-auto w-full" aria-hidden>
        <XAxisTitle
          left={frame.plotLeft}
          right={frame.plotRight}
          y={frame.fontSize}
          fontSize={frame.fontSize}
        >
          {`time of day (${zone})`}
        </XAxisTitle>
      </svg>
    );
  }
  return (
    <svg viewBox={`0 0 ${W} 14`} className="h-auto w-full" aria-hidden>
      <XAxisTitle left={PLOT_LEFT} right={PLOT_RIGHT} y={10}>
        {`time of day (${zone})`}
      </XAxisTitle>
    </svg>
  );
}
