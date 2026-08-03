/**
 * React Aria Components Separator, styled to match the shadcn kit it replaced.
 *
 * RAC renders the `role="separator"` / `aria-orientation` contract itself, so
 * this is a thin styling wrapper. Unlike the Base UI one it doesn't emit
 * `data-horizontal`/`data-vertical`, so the axis classes are picked here.
 */
import {
  Separator as AriaSeparator,
  type SeparatorProps as AriaSeparatorProps,
} from "react-aria-components";

import { cn } from "@/react/lib/utils";

export function Separator({
  className,
  orientation = "horizontal",
  ...props
}: AriaSeparatorProps & { className?: string }) {
  return (
    <AriaSeparator
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border",
        orientation === "vertical" ? "w-px self-stretch" : "h-px w-full",
        className
      )}
      {...props}
    />
  );
}
