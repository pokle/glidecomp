/**
 * React Aria Components ProgressBar, styled to match ui/progress.tsx: an
 * optional label row (label node + right-aligned value text) above a thin
 * track. This is **task completion** (role="progressbar") — for a measurement
 * within a range, use rac/meter.tsx instead (same distinction meter.tsx
 * documents from the other side).
 *
 * Label the bar either with the `label` node (pass an element carrying an id
 * and point aria-labelledby at it) or a plain aria-label.
 */
import {
  ProgressBar as AriaProgressBar,
  type ProgressBarProps as AriaProgressBarProps,
} from "react-aria-components";

import { cn } from "@/react/lib/utils";

export function ProgressBar({
  label,
  valueText,
  className,
  ...props
}: Omit<AriaProgressBarProps, "className" | "children"> & {
  /** Rendered before the track, e.g. a heading element. */
  label?: React.ReactNode;
  /** Right-aligned text on the label row, e.g. "2 of 4 steps". */
  valueText?: React.ReactNode;
  className?: string;
}) {
  return (
    <AriaProgressBar
      className={cn("flex flex-wrap items-center gap-3", className)}
      {...props}
    >
      {({ percentage }) => (
        <>
          {label}
          {valueText != null ? (
            <span className="ml-auto text-sm text-muted-foreground tabular-nums">
              {valueText}
            </span>
          ) : null}
          <div className="relative flex h-1 w-full items-center overflow-x-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${percentage ?? 0}%` }}
            />
          </div>
        </>
      )}
    </AriaProgressBar>
  );
}
