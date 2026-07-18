/**
 * React Aria Components Table, styled to match ui/table.tsx.
 *
 * Unlike the plain shadcn table (styling over <table>), RAC Table is an ARIA
 * grid: arrow-key cell navigation, focusable rows with onAction/href (whole-row
 * "click" affordances with real keyboard semantics), optional sorting, and —
 * via useDragAndDrop — keyboard-accessible row reordering. It still renders
 * native <table>/<tr>/<td> elements, so SSR/SEO output is unchanged.
 */
import { useContext } from "react";
import {
  Table as AriaTable,
  TableHeader as AriaTableHeader,
  TableBody as AriaTableBody,
  Column as AriaColumn,
  Row as AriaRow,
  Cell as AriaCell,
  TableStateContext,
  type TableProps,
  type TableHeaderProps,
  type TableBodyProps,
  type ColumnProps,
  type RowProps,
  type CellProps,
} from "react-aria-components";

import { cn } from "@/react/lib/utils";

export function Table({ className, ...props }: Omit<TableProps, "className"> & { className?: string }) {
  return (
    <div className="relative w-full overflow-x-auto">
      <AriaTable
        className={cn("w-full caption-bottom text-sm outline-none", className)}
        {...props}
      />
    </div>
  );
}

export function TableHeader<T extends object>({
  className,
  ...props
}: Omit<TableHeaderProps<T>, "className"> & { className?: string }) {
  return <AriaTableHeader className={cn("border-b", className)} {...props} />;
}

export function TableBody<T extends object>({
  className,
  ...props
}: Omit<TableBodyProps<T>, "className"> & { className?: string }) {
  return (
    <AriaTableBody
      className={cn("[&_tr:last-child]:border-0", className as string)}
      {...props}
    />
  );
}

export function Column({ className, ...props }: Omit<ColumnProps, "className"> & { className?: string }) {
  return (
    <AriaColumn
      className={cn(
        "h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground outline-none",
        "data-focus-visible:ring-2 data-focus-visible:ring-ring/50",
        className
      )}
      {...props}
    />
  );
}

export function Row<T extends object>({
  className,
  ...props
}: Omit<RowProps<T>, "className"> & { className?: string }) {
  return (
    <AriaRow
      className={cn(
        "border-b transition-colors outline-none data-hovered:bg-muted/50 data-selected:bg-muted",
        "data-focus-visible:ring-2 data-focus-visible:ring-ring/50",
        // Row-level actions (onAction/href) get a pointer, matching the old
        // cursor-pointer standings rows.
        "data-[href]:cursor-pointer",
        // Drag-and-drop states (route editor grid).
        "data-dragging:opacity-50 data-drop-target:outline-2 data-drop-target:outline-primary",
        className
      )}
      {...props}
    />
  );
}

/**
 * Wrap a cell's inline editor (text field, number field, select) in this to
 * suspend the grid's arrow-key cell navigation while focus is inside it —
 * react-aria Table captures Arrow/Home/End at the cell level otherwise, so
 * the caret could never move within the editor. Uses the same
 * setKeyboardNavigationDisabled "edit mode" flag RAC's column resizer uses;
 * navigation resumes the moment focus leaves the zone (Tab, click, Esc).
 */
export function CellEditZone({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const state = useContext(TableStateContext);
  return (
    <div
      className={className}
      onFocus={() => state?.setKeyboardNavigationDisabled(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) {
          state?.setKeyboardNavigationDisabled(false);
        }
      }}
    >
      {children}
    </div>
  );
}

export function Cell({ className, ...props }: Omit<CellProps, "className"> & { className?: string }) {
  return (
    <AriaCell
      className={cn(
        "p-2 align-middle whitespace-nowrap outline-none",
        "data-focus-visible:ring-2 data-focus-visible:ring-ring/50",
        className
      )}
      {...props}
    />
  );
}
