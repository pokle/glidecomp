/**
 * React Aria Components GridList — a vertical list of interactive rows with
 * keyboard navigation, drag-and-drop reorder and focusable children.
 *
 * Unlike rac/table.tsx (an ARIA grid whose cells capture Arrow/Home/End for
 * cell navigation — see gotcha #2 in the RAC adoption guide), a GridList row is
 * a single stack item. With `keyboardNavigationBehavior="tab"` the arrow keys
 * move between rows while Tab moves through a row's focusable children, so
 * inline editors keep their carets with no CellEditZone plumbing. This is the
 * foundation for the route editor's turnpoint list view (cards instead of a
 * cramped horizontally-scrolling table).
 */
import {
  GridList as AriaGridList,
  GridListItem as AriaGridListItem,
  type GridListProps,
  type GridListItemProps,
} from "react-aria-components";

import { cn } from "@/react/lib/utils";

export function GridList<T extends object>({
  className,
  ...props
}: Omit<GridListProps<T>, "className"> & { className?: string }) {
  return (
    <AriaGridList
      // Tab (not arrows) reaches a row's inline editors; arrows move rows.
      keyboardNavigationBehavior="tab"
      className={cn(
        "flex flex-col gap-2 outline-none data-focus-visible:ring-2 data-focus-visible:ring-ring/50",
        className
      )}
      {...props}
    />
  );
}

export function GridListItem<T extends object>({
  className,
  ...props
}: Omit<GridListItemProps<T>, "className"> & { className?: string }) {
  return (
    <AriaGridListItem
      className={cn(
        "group/item rounded-lg border border-border bg-card p-2 outline-none transition-colors",
        "data-hovered:border-input data-focus-visible-within:border-ring data-focus-visible-within:ring-2 data-focus-visible-within:ring-ring/50",
        // Drag-and-drop states (mirror rac/table.tsx Row).
        "data-dragging:opacity-50 data-drop-target:border-primary data-drop-target:outline-2 data-drop-target:outline-primary",
        className
      )}
      {...props}
    />
  );
}
