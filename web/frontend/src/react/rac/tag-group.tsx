/**
 * React Aria Components TagGroup — a labelled, keyboard-navigable set of
 * tags. Used for the task's pilot classes: reads as a list to AT instead of
 * loose text.
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
        "inline-flex h-5 w-fit items-center rounded-4xl border border-border px-2 text-xs font-medium whitespace-nowrap text-foreground outline-none",
        "data-focus-visible:ring-2 data-focus-visible:ring-ring/50",
        className
      )}
      {...props}
    />
  );
}
