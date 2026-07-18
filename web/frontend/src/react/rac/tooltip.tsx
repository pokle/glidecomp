/**
 * React Aria Components Tooltip — replaces the `title` attribute hints
 * (which never worked for keyboard or touch users). Wrap the trigger:
 * <TooltipTrigger><Button/><Tooltip>hint</Tooltip></TooltipTrigger>.
 */
import {
  TooltipTrigger as AriaTooltipTrigger,
  Tooltip as AriaTooltip,
  OverlayArrow,
  type TooltipProps,
  type TooltipTriggerComponentProps,
} from "react-aria-components";

import { cn } from "@/react/lib/utils";

/** Trigger with a snappier default delay than RAC's 1.5s. */
export function TooltipTrigger(props: TooltipTriggerComponentProps) {
  return <AriaTooltipTrigger delay={600} closeDelay={200} {...props} />;
}

export function Tooltip({
  className,
  children,
  ...props
}: Omit<TooltipProps, "className" | "children"> & {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <AriaTooltip
      offset={6}
      className={cn(
        "z-50 max-w-64 rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-md",
        "data-entering:animate-in data-entering:fade-in-0 data-entering:zoom-in-95 data-exiting:animate-out data-exiting:fade-out-0 data-entering:duration-100 data-exiting:duration-100",
        className
      )}
      {...props}
    >
      <OverlayArrow>
        <svg width={8} height={8} viewBox="0 0 8 8" className="fill-foreground group-data-[placement=bottom]:rotate-180">
          <path d="M0 0 L4 4 L8 0" />
        </svg>
      </OverlayArrow>
      {children}
    </AriaTooltip>
  );
}
