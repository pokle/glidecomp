/**
 * React Aria Components TagGroup — a labelled, keyboard-navigable set of
 * tags. Used for the task's pilot classes (read-only: reads as a list to AT
 * instead of loose text), and as a compact multi-select where a column of
 * checkboxes would cost more vertical space than the choice is worth — the
 * behaviour filters on the pilot-similarity sheet.
 *
 * Pass `selectionMode="multiple"` with `selectedKeys`/`onSelectionChange` for
 * the second shape. Note what RAC actually emits there: a TagGroup is a
 * `role="grid"` of single-cell rows, NOT a listbox or a set of checkboxes —
 * the grid pattern is what lets a tag carry a remove button and still be
 * keyboard-reachable. Selection is announced by `aria-selected` on each row,
 * and arrow-key roving focus comes for free. A reader who needs the plainer
 * "choose from a list" announcement should reach for `rac/list-box.tsx` with
 * `selectionMode="multiple"` instead and give up the chip shape.
 *
 * Selection styling is below, so a read-only group (no selectionMode, nothing
 * ever selected) is unaffected by it.
 */
import {
  TagGroup as AriaTagGroup,
  TagList,
  Tag as AriaTag,
  Label,
  type TagGroupProps,
  type TagProps,
} from "react-aria-components";

import { cn } from "@/react/lib/utils";

export function TagGroup({
  label,
  className,
  children,
  ...props
}: Omit<TagGroupProps, "className" | "children"> & {
  label?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <AriaTagGroup className={cn("flex flex-col gap-1", className)} {...props}>
      {label ? <Label className="sr-only">{label}</Label> : null}
      <TagList className="flex flex-wrap gap-1.5">{children}</TagList>
    </AriaTagGroup>
  );
}

export function Tag({ className, ...props }: Omit<TagProps, "className"> & { className?: string }) {
  return (
    <AriaTag
      className={cn(
        "inline-flex w-fit items-center rounded-4xl border border-border px-2 text-xs font-medium whitespace-nowrap text-foreground outline-none",
        "data-focus-visible:ring-2 data-focus-visible:ring-ring/50",
        // Selectable groups get a taller target and a filled selected state.
        // Colour is never the only channel: RAC sets aria-checked on every tag
        // in a selectable group, so the state is announced either way.
        "h-5 data-[selection-mode]:h-7 data-[selection-mode]:cursor-default data-[selection-mode]:px-2.5",
        "data-[selection-mode]:data-hovered:bg-muted",
        "data-selected:border-primary data-selected:bg-primary data-selected:text-primary-foreground",
        "data-selected:data-hovered:bg-primary/90",
        className
      )}
      {...props}
    />
  );
}
