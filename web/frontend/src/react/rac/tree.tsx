/**
 * React Aria Components Tree — hierarchical rows with expand/collapse and
 * full keyboard navigation (Up/Down move rows, Left/Right collapse/expand,
 * Tab reaches a row's focusable children such as inline links).
 *
 * First consumer: the Dashboard's Competition flights section, which groups
 * flights under their competition. RAC renders every item as a sibling
 * `role="row"` carrying `data-level`, so container styles like `divide-y`
 * work across the whole hierarchy; indentation is per-level via
 * `data-[level=…]` variants in TreeItem (levels beyond 3 need a consumer
 * className — add deeper variants when a deeper consumer exists).
 */
import {
  Tree as AriaTree,
  TreeItem as AriaTreeItem,
  TreeItemContent,
  Button as AriaButton,
  type TreeProps,
  type TreeItemProps,
} from "react-aria-components";
import { ChevronRightIcon } from "lucide-react";

import { cn } from "@/react/lib/utils";

export { TreeItemContent };

export function Tree<T extends object>({
  className,
  ...props
}: Omit<TreeProps<T>, "className"> & { className?: string }) {
  return (
    <AriaTree
      className={cn(
        "flex flex-col outline-none data-focus-visible:ring-2 data-focus-visible:ring-ring/50",
        className
      )}
      {...props}
    />
  );
}

export function TreeItem<T extends object>({
  className,
  ...props
}: Omit<TreeItemProps<T>, "className"> & { className?: string }) {
  return (
    <AriaTreeItem
      className={cn(
        "group/tree-item flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 outline-none transition-colors",
        "data-hovered:bg-muted/50 data-focus-visible:ring-2 data-focus-visible:ring-inset data-focus-visible:ring-ring/50",
        "data-[level=2]:pl-10 data-[level=3]:pl-16",
        className
      )}
      {...props}
    />
  );
}

/**
 * The expand/collapse affordance for a TreeItem with children. Render it
 * first inside TreeItemContent; RAC wires the press handling and
 * aria-expanded via the chevron slot. Rows without children should render
 * nothing in its place (the level-based indent keeps leaf rows aligned).
 */
export function TreeChevron({ className }: { className?: string }) {
  return (
    <AriaButton
      slot="chevron"
      className={cn(
        "-ml-1 flex size-6 shrink-0 items-center justify-center rounded outline-none",
        "data-hovered:bg-muted data-focus-visible:ring-2 data-focus-visible:ring-ring/50",
        className
      )}
    >
      <ChevronRightIcon
        aria-hidden
        className="size-4 text-muted-foreground transition-transform group-data-expanded/tree-item:rotate-90"
      />
    </AriaButton>
  );
}
