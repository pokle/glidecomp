/**
 * React Aria Components Slider — a value picked from a continuous range.
 *
 * New to the kit. Added here rather than reached for from elsewhere because
 * `src/react/one-kit.test.ts` fails the build if a second component library
 * comes back, and CLAUDE.md's answer to a missing component is to add it to
 * `rac/` — not to install one.
 *
 * Deliberately a Slider and not a NumberField: it is for a quantity where the
 * POSITION in the range is the point ("how far round the task did they get"),
 * and where any value is as valid as any other. A field would ask somebody to
 * type a number they do not have in mind.
 *
 * The value is always printed beside the label — a slider whose reading you
 * cannot see is a control you have to guess at, and the thumb position alone
 * is not an accessible reading (WCAG 1.4.1). RAC's `SliderOutput` is a real
 * `<output>` wired to the input, so a screen reader announces changes without
 * an `aria-live` region of our own.
 */
import {
  Slider as AriaSlider,
  SliderOutput,
  SliderThumb,
  SliderTrack,
  Label as AriaLabel,
} from "react-aria-components";

import { cn } from "@/react/lib/utils";

export function Slider({
  label,
  value,
  onChange,
  minValue = 0,
  maxValue = 100,
  step = 1,
  /** How to render the number beside the label. Defaults to the bare value. */
  format,
  description,
  className,
}: {
  label: React.ReactNode;
  value: number;
  onChange: (value: number) => void;
  minValue?: number;
  maxValue?: number;
  step?: number;
  format?: (value: number) => string;
  description?: React.ReactNode;
  className?: string;
}) {
  return (
    <AriaSlider
      value={value}
      onChange={onChange}
      minValue={minValue}
      maxValue={maxValue}
      step={step}
      className={cn("flex flex-col gap-1.5", className)}
    >
      <div className="flex items-baseline justify-between gap-3">
        <AriaLabel className="text-sm font-medium">{label}</AriaLabel>
        <SliderOutput className="text-sm tabular-nums text-muted-foreground">
          {({ state }) =>
            format ? format(state.getThumbValue(0)) : state.getThumbValueLabel(0)
          }
        </SliderOutput>
      </div>
      <SliderTrack className="group relative flex h-6 w-full items-center">
        {({ state }) => (
          <>
            <div className="h-1.5 w-full rounded-full bg-muted" />
            <div
              className="absolute h-1.5 rounded-full bg-primary"
              style={{ width: `${state.getThumbPercent(0) * 100}%` }}
            />
            <SliderThumb
              className={cn(
                "top-1/2 size-4 rounded-full border border-primary bg-background shadow-sm",
                // A visible focus state is not optional; the thumb is the only
                // thing a keyboard user can be on.
                "data-focus-visible:ring-3 data-focus-visible:ring-ring/50",
                "data-dragging:scale-110"
              )}
            />
          </>
        )}
      </SliderTrack>
      {description ? (
        <p className="text-xs text-muted-foreground">{description}</p>
      ) : null}
    </AriaSlider>
  );
}
