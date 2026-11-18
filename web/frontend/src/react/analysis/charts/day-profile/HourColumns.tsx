/**
 * Selecting an hour on a weather chart — by touch, mouse or keyboard.
 *
 * The charts used to answer a mouse and nothing else: a transparent rect per
 * hour with `onMouseEnter`. A tap did nothing, a keyboard could not reach
 * them, and the figures were printed nowhere else, so on a phone the exact
 * numbers did not exist (issue #860).
 *
 * Now ONE hour is selected for the whole stack, and the panel owns it:
 *
 * - **Touch**: tap a chart, or drag along it. `touch-action: pan-y` leaves
 *   vertical scrolling to the page, so a finger moving across scrubs through
 *   the hours and a finger moving down scrolls. Dragging matters: a whole
 *   daylight day is a dozen columns, each about 22px wide on a phone.
 * - **Mouse**: moving over a chart selects, as hovering always did, and
 *   leaving clears.
 * - **Keyboard**: each chart is one tab stop; arrow keys, Home and End walk
 *   its hours. Every column is named with that chart's figures for the hour.
 *
 * The selected hour is a band drawn through every chart of the stack, which
 * is also what shows a keyboard user where focus is. Each chart prints its
 * own figures for that hour in its legend row (MetLegend.tsx).
 */
import { useRef, useState } from "react";
import { formatTimeRange } from "@/react/lib/time";
import type { TimeAxis } from "./time-axis";
import type { ChartFrame } from "./frame";

const HOUR_MS = 3_600_000;

/** The column an instant falls in. The selection is an instant, not a
 * column: two charts in one stack may bucket their hours differently. */
export function columnAt<T extends { tMs: number }>(
  columns: readonly T[],
  ms: number | null
): T | null {
  if (ms === null) return null;
  return columns.find((c) => ms >= c.tMs && ms < c.tMs + HOUR_MS) ?? null;
}

/** "14:00–15:00 AEDT" for the hour starting at `tMs`. */
export function hourRange(tMs: number, timeZone: string | undefined): string {
  return formatTimeRange(
    new Date(tMs).toISOString(),
    new Date(tMs + HOUR_MS).toISOString(),
    timeZone
  );
}

export interface HourColumn {
  /** Start of the hour, epoch ms. */
  tMs: number;
  /** Accessible name: the hour and this chart's figures for it. */
  label: string;
}

/**
 * Pointer handlers for a chart's `<svg>`: which hour is under the pointer.
 * Worked out from the pointer's x, not from enter events on the columns —
 * a touch is captured by the element it went down on, so its drag never
 * "enters" the next column.
 */
export function useHourPointer(
  frame: ChartFrame,
  axis: TimeAxis,
  columns: readonly HourColumn[],
  onSelect: (tMs: number | null) => void
) {
  const hourAt = (e: React.PointerEvent<SVGSVGElement>): number | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const x = ((e.clientX - rect.left) / rect.width) * frame.width;
    const hit = columns.find((c) => x >= axis.x(c.tMs) && x < axis.x(c.tMs + HOUR_MS));
    return hit ? hit.tMs : null;
  };
  const select = (e: React.PointerEvent<SVGSVGElement>) => {
    const tMs = hourAt(e);
    if (tMs !== null) onSelect(tMs);
  };
  return {
    style: { touchAction: "pan-y" as const },
    onPointerDown: select,
    onPointerMove: select,
    onPointerLeave: (e: React.PointerEvent<SVGSVGElement>) => {
      // Only a mouse "leaves". A finger lifting is not the end of reading:
      // the figures it chose stay until another hour is chosen.
      if (e.pointerType === "mouse") onSelect(null);
    },
  };
}

/** The band for the selected hour and the focusable column for each hour.
 * Drawn last in the chart, over everything; all of it is transparent but the
 * band. */
export function HourColumns({
  columns,
  axis,
  top,
  bottom,
  selectedMs,
  onSelect,
}: {
  columns: readonly HourColumn[];
  axis: TimeAxis;
  top: number;
  bottom: number;
  selectedMs: number | null;
  onSelect: (tMs: number | null) => void;
}) {
  const refs = useRef<(SVGGElement | null)[]>([]);
  const [focusIndex, setFocusIndex] = useState(0);
  // The chart's one tab stop is the selected hour where it has one.
  const selectedColumn = columnAt(columns, selectedMs);
  const selectedIndex = selectedColumn ? columns.indexOf(selectedColumn) : -1;
  const tabIndex = selectedIndex >= 0 ? selectedIndex : Math.min(focusIndex, columns.length - 1);

  function onKeyDown(e: React.KeyboardEvent, i: number) {
    let next: number;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = Math.min(i + 1, columns.length - 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = Math.max(i - 1, 0);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = columns.length - 1;
    else return;
    e.preventDefault();
    if (next !== i) refs.current[next]?.focus();
  }

  return (
    <>
      {columns.map((c, i) => {
        const x0 = axis.x(c.tMs);
        const width = Math.max(0, axis.x(c.tMs + HOUR_MS) - x0);
        const selected = i === selectedIndex;
        return (
          <g
            key={c.tMs}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="img"
            aria-label={c.label}
            tabIndex={i === tabIndex ? 0 : -1}
            data-hour={c.tMs}
            data-selected={selected ? "" : undefined}
            className="group cursor-default outline-none"
            onKeyDown={(e) => onKeyDown(e, i)}
            onFocus={() => {
              setFocusIndex(i);
              onSelect(c.tMs);
            }}
          >
            <rect
              x={x0}
              y={top}
              width={width}
              height={Math.max(0, bottom - top)}
              className={
                (selected ? "fill-foreground/10 " : "fill-transparent ") +
                "group-focus-visible:stroke-ring group-focus-visible:[stroke-width:2px]"
              }
            />
          </g>
        );
      })}
    </>
  );
}
