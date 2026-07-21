/**
 * React Aria Components RadioGroup + Radio, styled to match ui/radio-group.tsx.
 * The label is part of each Radio (RAC wraps the box in a real <label>), so
 * call sites don't wire htmlFor/ids; the group label/description use the same
 * slot components as the other kit fields.
 */
import {
  Radio as AriaRadio,
  RadioGroup as AriaRadioGroup,
  type RadioProps as AriaRadioProps,
  type RadioGroupProps as AriaRadioGroupProps,
} from "react-aria-components";

import { cn } from "@/react/lib/utils";
import { Label, Description, FieldError } from "./field";

export function RadioGroup({
  label,
  description,
  errorMessage,
  className,
  children,
  ...props
}: Omit<AriaRadioGroupProps, "className" | "children"> & {
  label?: React.ReactNode;
  description?: React.ReactNode;
  errorMessage?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <AriaRadioGroup className={cn("flex flex-col gap-2", className)} {...props}>
      {label ? <Label>{label}</Label> : null}
      {children}
      {description ? <Description>{description}</Description> : null}
      <FieldError>{errorMessage}</FieldError>
    </AriaRadioGroup>
  );
}

export function Radio({
  className,
  children,
  ...props
}: Omit<AriaRadioProps, "className" | "children"> & {
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <AriaRadio
      className={cn(
        "group flex w-fit items-center gap-2 text-sm leading-snug data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      {({ isSelected }) => (
        <>
          <span
            aria-hidden
            className={cn(
              "relative flex aspect-square size-4 shrink-0 rounded-full border border-input transition-colors dark:bg-input/30",
              "group-data-focus-visible:border-ring group-data-focus-visible:ring-3 group-data-focus-visible:ring-ring/50",
              isSelected && "border-primary bg-primary"
            )}
          >
            {isSelected ? (
              <span className="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary-foreground" />
            ) : null}
          </span>
          {children}
        </>
      )}
    </AriaRadio>
  );
}
