/**
 * Standalone React Aria Components ListBox — a keyboard-navigable option list
 * used with a SearchField for the route editor's waypoint picker (the old
 * list was plain <button>s with no arrow-key navigation or selection
 * semantics).
 */
import {
  ListBox as AriaListBox,
  ListBoxItem as AriaListBoxItem,
  type ListBoxProps,
  type ListBoxItemProps,
} from "react-aria-components";

import { cn } from "@/react/lib/utils";

export function ListBox<T extends object>({
  className,
  ...props
}: Omit<ListBoxProps<T>, "className"> & { className?: string }) {
  return (
    <AriaListBox
      className={cn(
        "overflow-y-auto rounded border border-border p-0.5 outline-none data-focus-visible:ring-2 data-focus-visible:ring-ring/50",
        className
      )}
      {...props}
    />
  );
}

export function ListBoxItem({
  className,
  ...props
}: Omit<ListBoxItemProps, "className"> & { className?: string }) {
  return (
    <AriaListBoxItem
      className={cn(
        "flex w-full cursor-default items-baseline gap-2 rounded px-1.5 py-1 text-left text-sm outline-none select-none",
        "data-hovered:bg-accent data-focused:bg-accent data-focused:text-accent-foreground",
        className
      )}
      {...props}
    />
  );
}
