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
