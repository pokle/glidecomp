/**
 * React Aria Components progress indicators — "something is happening".
 *
 * Three pieces, because the shapes are genuinely different:
 *
 * - `ProgressBar` — a thin track, determinate (a percentage) or indeterminate
 *   (`isIndeterminate`, work in flight with no known duration). This is **task
 *   completion** (role="progressbar") — for a measurement within a range, use
 *   rac/meter.tsx instead (same distinction meter.tsx documents from the other
 *   side).
 * - `Spinner` — the circular version, for beside a label or inside a button.
 * - `Loading` — a whole page section waiting on an API response: the app's
 *   `role="status"` + "Loading scores…" convention with a spinner in front.
 *
 * **Why indeterminate matters:** ARIA's answer to "this region is busy" is a
 * progressbar with no `aria-valuenow`, which is exactly what RAC renders for
 * `isIndeterminate`. A spinner is a skin over that, not a separate thing.
 *
 * Label a bar either with the `label` node (pass an element carrying an id and
 * point aria-labelledby at it) or a plain aria-label.
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
      {({ percentage, isIndeterminate }) => (
        <>
          {label}
          {valueText != null ? (
            <span className="ml-auto text-sm text-muted-foreground tabular-nums">
              {valueText}
            </span>
          ) : null}
          <div className="relative flex h-1 w-full items-center overflow-x-hidden rounded-full bg-muted">
            {isIndeterminate ? (
              // Width comes from the animation's left/right pair (see
              // globals.css) so the stripe can grow and shrink as it travels;
              // a translated fixed-width bar looks mechanical by comparison.
              <div className="gc-progress-indeterminate rounded-full bg-primary" />
            ) : (
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${percentage ?? 0}%` }}
              />
            )}
          </div>
        </>
      )}
    </AriaProgressBar>
  );
}

/** Tailwind sizes for `Spinner`; `sm` is the in-button/inline size. */
const SPINNER_SIZE = {
  sm: "size-4",
  md: "size-5",
  lg: "size-8",
} as const;

/**
 * A circular indeterminate indicator. Two modes, and picking the right one is
 * the whole point:
 *
 * - **With `label`** it is a real `role="progressbar"` carrying that label —
 *   use this when the spinner is the ONLY thing saying "busy". Inside a RAC
 *   `Button` with `isPending` this is the required shape: the button publishes
 *   a ProgressBarContext id and folds the bar's label into its own accessible
 *   name, which is the text RAC announces when the pending state flips.
 * - **Without `label`** it is `aria-hidden` decoration — use this whenever
 *   visible text already says what is loading (see `Loading` below), so a
 *   screen reader doesn't read the same sentence twice.
 *
 * Reduced motion: the ring stops rotating (the global rule in globals.css
 * would stop it regardless). The gap in the ring means the stopped state still
 * reads as an indicator rather than a plain circle — and in both modes there
 * is always a label or adjacent text carrying the actual meaning.
 */
export function Spinner({
  label,
  size = "sm",
  className,
}: {
  /** Accessible name; omit to render decoration for adjacent visible text. */
  label?: string;
  size?: keyof typeof SPINNER_SIZE;
  className?: string;
}) {
  const ring = (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={cn(
        SPINNER_SIZE[size],
        "animate-spin motion-reduce:animate-none",
        label == null && className
      )}
      // Decoration in the unlabelled case; in the labelled case the wrapping
      // ProgressBar owns the role and this is its rendering.
      aria-hidden
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        // Three quarters of the circumference (2πr ≈ 56.5), so a quarter of
        // the ring is missing — the gap is what reads as motion.
        strokeDasharray="42 57"
        className="opacity-90"
      />
    </svg>
  );

  if (label == null) return ring;

  return (
    <AriaProgressBar
      isIndeterminate
      aria-label={label}
      className={cn("inline-flex", className)}
    >
      {ring}
    </AriaProgressBar>
  );
}

/**
 * A page section waiting on an API response: `role="status"` (an implicit
 * polite live region, so the wait is announced rather than silent) around the
 * sentence saying what is loading, with a decorative spinner in front.
 *
 * Pass the sentence as children — it is both the visible text and what a
 * screen reader reads, so don't add an aria-label repeating it.
 *
 *     <Loading>Loading scores…</Loading>
 */
export function Loading({
  children,
  size = "sm",
  className,
}: {
  children: React.ReactNode;
  size?: keyof typeof SPINNER_SIZE;
  className?: string;
}) {
  return (
    <p
      role="status"
      className={cn("flex items-center gap-2 text-muted-foreground", className)}
    >
      <Spinner size={size} className="shrink-0" />
      {children}
    </p>
  );
}
