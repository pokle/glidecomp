/**
 * React Aria Components Popover — a standalone overlay for content the user
 * needs TIME to read.
 *
 * Use this rather than rac/tooltip.tsx whenever the content is prose: a
 * tooltip is hover-triggered (so unreachable on touch), dismisses on the
 * slightest pointer move, and is not meant to hold a paragraph. The
 * field-analysis pages use it for each metric's method description.
 *
 * Styling reuses `popoverClass` from rac/select.tsx — the same surface,
 * shadow and enter/exit animation as the select and combo-box overlays.
 */
import {
  DialogTrigger,
  Popover as AriaPopover,
  Dialog as AriaDialog,
  OverlayArrow,
  type PopoverProps as AriaPopoverProps,
} from "react-aria-components";

import { cn } from "@/react/lib/utils";
import { popoverClass } from "./select";

export { DialogTrigger as PopoverTrigger };

export function Popover({
  className,
  children,
  ...props
}: Omit<AriaPopoverProps, "className" | "children"> & {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <AriaPopover
      offset={8}
      className={cn(popoverClass, "max-w-xs p-3", className)}
      {...props}
    >
      <OverlayArrow>
        <svg
          aria-hidden
          width={12}
          height={12}
          viewBox="0 0 12 12"
          className="block fill-popover stroke-foreground/10 group-data-[placement=bottom]:rotate-180"
        >
          <path d="M0 0 L6 6 L12 0" />
        </svg>
      </OverlayArrow>
      {/* The Dialog wrapper is what gives the popover focus containment and
          Esc-to-dismiss; without it the content is not reachable by keyboard. */}
      <AriaDialog className="text-sm outline-none">{children}</AriaDialog>
    </AriaPopover>
  );
}
