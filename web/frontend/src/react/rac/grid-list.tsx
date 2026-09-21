/**
 * React Aria Components GridList — a vertical list of interactive rows with
 * keyboard navigation and focusable children.
 *
 * Unlike rac/table.tsx (an ARIA grid whose cells capture Arrow/Home/End for
 * cell navigation — see gotcha #2 in the RAC adoption guide), a GridList row is
 * a single stack item. With `keyboardNavigationBehavior="tab"` the arrow keys
 * move between rows while Tab moves through a row's focusable children, so
 * inline editors and per-row buttons keep their carets and their tab order with
 * no CellEditZone plumbing.
 *
 * Two looks, because both are wanted:
 *
 * - `variant="cards"` (the default) — each row is its own bordered card.
 * - `variant="rows"` — one card surface with hairline-divided rows inside it,
 *   the shape rac/nav-list.tsx paints (it shares the very same row class). Use
 *   it where the list belongs to the same family as the app's settings lists
 *   but needs a collection underneath: the route editor's turnpoint list is a
 *   GridList because its rows hold buttons, which a NavList's `<a>` rows
 *   cannot legally contain.
 */
import type { ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import {
  GridList as AriaGridList,
  GridListItem as AriaGridListItem,
  type GridListProps,
  type GridListItemProps,
} from "react-aria-components";

import { cn } from "@/react/lib/utils";
import { cardSurface } from "./card";
import { navRowClass } from "./nav-list";

export type GridListVariant = "cards" | "rows";

const listClass: Record<GridListVariant, string> = {
  cards: "flex flex-col gap-2 outline-none data-focus-visible:ring-2 data-focus-visible:ring-ring/50",
  rows: cn(cardSurface, "divide-y divide-border overflow-hidden outline-none"),
};

const itemClass: Record<GridListVariant, string> = {
  cards:
    "group/item rounded-lg border border-border bg-card p-2 outline-none transition-colors " +
    "data-hovered:border-input data-focus-visible-within:border-ring data-focus-visible-within:ring-2 data-focus-visible-within:ring-ring/50 " +
    // Drag-and-drop states (mirror rac/table.tsx Row). Nothing uses the hooks
    // today — see gotcha #4 — but the look belongs with the component.
    "data-dragging:opacity-50 data-drop-target:border-primary data-drop-target:outline-2 data-drop-target:outline-primary",
  // The NavList row, verbatim — plus the same focus-within ring the card
  // variant uses, since a row here can hold buttons of its own.
  rows: cn(
    navRowClass,
    "group/item transition-colors data-focus-visible-within:ring-2 data-focus-visible-within:ring-ring/50 data-focus-visible-within:ring-inset"
  ),
};

export function GridList<T extends object>({
  className,
  variant = "cards",
  ...props
}: Omit<GridListProps<T>, "className"> & {
  className?: string;
  variant?: GridListVariant;
}) {
  return (
    <AriaGridList
      // Tab (not arrows) reaches a row's inline editors; arrows move rows.
      keyboardNavigationBehavior="tab"
      className={cn(listClass[variant], className)}
      {...props}
    />
  );
}

export function GridListItem<T extends object>({
  className,
  variant = "cards",
  ...props
}: Omit<GridListItemProps<T>, "className"> & {
  className?: string;
  variant?: GridListVariant;
}) {
  return (
    <AriaGridListItem
      className={cn(itemClass[variant], className)}
      {...props}
    />
  );
}

/**
 * The inside of one list row: something at the left, a name with a line of
 * detail under it, something at the right, and a chevron if there is more
 * behind the row.
 *
 * Three lists had written this out identically — the waypoints editor, the
 * altitude review and the route editor's turnpoints — and two of them also
 * restated the `flex items-center gap-3` their `variant="rows"` row already
 * had. This is that shape, once, so the fourth list is free and the three
 * cannot drift apart.
 *
 * It is the row's CONTENT, not the row: {@link GridListItem} stays the
 * collection item, because that is what carries the id, the text value and
 * what pressing the row does — all of which differ per list, and one of which
 * (a row that does nothing) is a deliberate state.
 *
 * ```tsx
 * <GridListItem variant="rows" id={row.id} textValue={row.code}>
 *   <RowContent
 *     leading={<Button size="icon-sm" …/>}
 *     title={row.code}
 *     detail={`${row.coords} · ${row.altitude}`}
 *     chevron
 *   />
 * </GridListItem>
 * ```
 */
export function RowContent({
  leading,
  title,
  detail,
  action,
  chevron = false,
  detailClassName,
  children,
}: {
  /** Left of the name — an icon button, or a fixed-width column of labels. */
  leading?: ReactNode;
  /** The row's name. Truncates rather than wrapping: rows stay one height. */
  title: ReactNode;
  /**
   * The second line: the row's own facts, in the small mono/tabular voice
   * every one of these lists uses. Passed as a node, so a list that needs
   * `sr-only` wording inside it (the turnpoint list reads out "radius" where
   * sighted readers get "r.") still can.
   */
  detail?: ReactNode;
  /** Right of the name, before the chevron — a per-row button or a figure. */
  action?: ReactNode;
  /**
   * Say that there IS something behind this row. Off by default, because a
   * row that opens nothing must not claim to: the read-only waypoints list
   * and the turnpoint list in reorder mode are both that case.
   */
  chevron?: boolean;
  /** Extra classes for the detail line — a colour, `font-mono`, `leading-tight`. */
  detailClassName?: string;
  /**
   * Anything else under the detail line, NOT truncated — a sentence the reader
   * has to be able to finish. The altitude review's rows say in words what to
   * do about the numbers on the detail line, and "Too far apart for terrain —
   * check the coordinates" cut off at "Too far apart for te…" would be the
   * row telling a reader less than nothing.
   */
  children?: ReactNode;
}) {
  return (
    <>
      {leading}
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{title}</p>
        {/* One line, clipped: coordinates, a radius, an altitude. A row that
            wrapped would make the list's rows different heights, which is
            what a reader scans down.

            Deliberately `text-xs`, and NOT raised with the rest of the type
            floor (issue #704): this line is CLIPPED rather than wrapped, and
            it carries data. At `text-sm` the same 250px of phone row truncated
            "−36.185833, 147.976669 · 640 m · r=400 m" down to the coordinates
            and an ellipsis — a legible line that no longer says the thing.
            Bigger type is not worth less information. */}
        {detail === undefined ? null : (
          <p className={cn("truncate text-xs text-muted-foreground", detailClassName)}>
            {detail}
          </p>
        )}
        {children}
      </div>
      {action}
      {chevron ? (
        <ChevronRightIcon
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
      ) : null}
    </>
  );
}
