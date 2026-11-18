/**
 * Selecting a mark on a chart by pointing NEAR it — by touch, mouse or pen.
 *
 * The scatter and line charts answered a mouse over the mark itself and
 * nothing else. Each dot had a 24-unit halo for a target, on a chart scaled
 * to a phone that is about 14px across, and their one instruction read
 * "Hover or focus a dot" on a screen with no hover (issue #860).
 *
 * Now the chart is the target, and the mark nearest the pointer is chosen:
 *
 * - **Touch and pen**: a tap chooses the nearest mark, however far it is,
 *   and so does a finger dragged across. `touch-action: pan-y` leaves
 *   vertical scrolling to the page, so a finger moving down still scrolls.
 * - **Mouse**: moving near a mark is a hover, as it always was, and moving
 *   away or leaving ends it. A click near a mark chooses it. "Near" is
 *   {@link MOUSE_REACH_PX}: a mouse can point, so empty space stays empty.
 *
 * "Chooses" means the chart moves FOCUS to that mark (`focusMark`). The
 * charts already name, emphasise and announce the focused mark for the
 * keyboard, so a tap and an arrow key end in the same state, and tapping
 * away from the chart ends it the way tabbing away does. Nothing is left
 * selected that only a second tap could clear.
 *
 * The weather charts' `HourColumns.tsx` is the same idea along one axis.
 */
import type { CSSProperties, MouseEvent, PointerEvent } from "react";
import type { Nearest } from "./nearest";

/**
 * How near a mouse has to be to a mark to hover or choose it, in CSS pixels.
 * Wider than the 12 units the marks' own halos gave, and far short of the
 * whole chart: a mouse crossing the chart on its way elsewhere should not
 * light up a pilot across the page with every pixel it moves.
 */
export const MOUSE_REACH_PX = 32;

export interface NearestPointerProps {
  style: CSSProperties;
  onPointerDown: (e: PointerEvent<SVGSVGElement>) => void;
  onPointerMove: (e: PointerEvent<SVGSVGElement>) => void;
  onPointerLeave: (e: PointerEvent<SVGSVGElement>) => void;
  onMouseDown: (e: MouseEvent<SVGSVGElement>) => void;
}

/** Move focus to a mark without the page scrolling to it: the reader's
 * finger is already on the chart. */
export function focusMark(el: SVGElement | null | undefined): void {
  el?.focus({ preventScroll: true });
}

/** Charts whose last press chose a mark; see `onMouseDown` below. */
const pressChose = new WeakSet<Element>();

export function nearestPointerProps({
  viewBoxWidth,
  nearest,
  onHover,
  onPick,
}: {
  /** The `<svg>`'s viewBox width, to turn a pointer position into viewBox
   * units. The charts scale uniformly, so one number does both axes. */
  viewBoxWidth: number;
  /** The mark nearest a point, and its distance, in viewBox units. */
  nearest: (x: number, y: number) => Nearest | null;
  /** A mouse near a mark (its index), or no longer near one (null). */
  onHover: (index: number | null) => void;
  /** A tap, a click, or a finger dragging: this mark is chosen. */
  onPick: (index: number) => void;
}): NearestPointerProps {
  /** The mark this pointer reaches, as an index; null for none. */
  const reached = (e: PointerEvent<SVGSVGElement>): number | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const scale = viewBoxWidth / rect.width;
    const hit = nearest((e.clientX - rect.left) * scale, (e.clientY - rect.top) * scale);
    if (!hit) return null;
    return e.pointerType === "mouse" && hit.distance / scale > MOUSE_REACH_PX
      ? null
      : hit.index;
  };
  return {
    style: { touchAction: "pan-y" },
    onPointerDown: (e) => {
      const i = reached(e);
      if (i === null) return;
      pressChose.add(e.currentTarget);
      onPick(i);
    },
    onPointerMove: (e) => {
      const i = reached(e);
      // A mouse moving is a hover. A finger or a pen only moves while it is
      // down, so its move is a drag through the marks.
      if (e.pointerType === "mouse") onHover(i);
      else if (i !== null) onPick(i);
    },
    onPointerLeave: (e) => {
      // Only a mouse "leaves". A finger lifting is not the end of reading.
      if (e.pointerType === "mouse") onHover(null);
    },
    // The browser's own answer to a press is to move focus to whatever is
    // under it, or to nothing. Where `onPointerDown` has just put focus on a
    // mark, this keeps it there. A press that chose nothing is left alone,
    // so a click on empty space still takes focus off the chart.
    onMouseDown: (e) => {
      if (pressChose.delete(e.currentTarget)) e.preventDefault();
    },
  };
}
