/**
 * React Aria Components Checkbox + CheckboxGroup, styled to match the shadcn
 * kit it replaced. The label is part of the component (a real <label> wrapping
 * the box), so call sites don't wire htmlFor/ids. CheckboxGroup manages the
 * selected-values array — the pilot-classes field becomes value/onChange of a
 * string[] with zero toggle bookkeeping.
 */
import {
  Checkbox as AriaCheckbox,
  CheckboxGroup as AriaCheckboxGroup,
  type CheckboxProps as AriaCheckboxProps,
  type CheckboxGroupProps as AriaCheckboxGroupProps,
} from "react-aria-components";

import { cn } from "@/react/lib/utils";
import { Label, Description, FieldError } from "./field";
import { CheckIcon, MinusIcon } from "lucide-react";

export function Checkbox({
  className,
  children,
  hint,
  ...props
}: Omit<AriaCheckboxProps, "className" | "children"> & {
  className?: string;
  children?: React.ReactNode;
  /** Muted helper line under the label. */
  hint?: React.ReactNode;
}) {
  return (
    <AriaCheckbox
      className={cn(
        "group flex w-fit items-start gap-2 text-sm leading-snug data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      {({ isSelected, isIndeterminate }) => (
        <>
          <span
            aria-hidden
            className={cn(
              "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input transition-colors dark:bg-input/30",
              "group-data-focus-visible:border-ring group-data-focus-visible:ring-3 group-data-focus-visible:ring-ring/50",
              (isSelected || isIndeterminate) &&
                "border-primary bg-primary text-primary-foreground"
            )}
          >
            {/* Indeterminate needs its OWN glyph, not the unchecked box: a
                tri-state parent over a group of children ("some of these are
                on") is indistinguishable from "none of these are on" without
                one, and the whole point of the third state is that it says
                something the other two cannot. RAC already sets the input's
                native `indeterminate` property, so this is presentation only. */}
            {isIndeterminate ? (
              <MinusIcon className="size-3.5" />
            ) : isSelected ? (
              <CheckIcon className="size-3.5" />
            ) : null}
          </span>
          <span className="flex flex-col gap-0.5">
            {children}
            {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
          </span>
        </>
      )}
    </AriaCheckbox>
  );
}

export function CheckboxGroup({
  label,
  description,
  errorMessage,
  className,
  children,
  ...props
}: Omit<AriaCheckboxGroupProps, "className" | "children"> & {
  label?: React.ReactNode;
  description?: React.ReactNode;
  errorMessage?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <AriaCheckboxGroup
      className={cn("flex flex-col gap-2", className)}
      {...props}
    >
      {label ? <Label>{label}</Label> : null}
      {children}
      {description ? <Description>{description}</Description> : null}
      <FieldError>{errorMessage}</FieldError>
    </AriaCheckboxGroup>
  );
}
