/**
 * React Aria Components form fields, styled to match ui/input.tsx + ui/field.tsx.
 *
 * RAC fields are self-labelling: <TextField><Label/><Input/><Description/>
 * <FieldError/></TextField> wires ids, aria-describedby and validation state
 * automatically — no useId() plumbing at call sites. FieldError renders only
 * when the field is invalid (native or custom validation via `validate`).
 */
import {
  TextField as AriaTextField,
  NumberField as AriaNumberField,
  SearchField as AriaSearchField,
  Input as AriaInput,
  Label as AriaLabel,
  Text,
  FieldError as AriaFieldError,
  Group,
  Button as AriaButton,
  type TextFieldProps,
  type NumberFieldProps,
  type SearchFieldProps,
  type InputProps,
  type ValidationResult,
} from "react-aria-components";

import { cn } from "@/react/lib/utils";
import { MinusIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";

export const inputClass =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none placeholder:text-muted-foreground data-focused:border-ring data-focused:ring-3 data-focused:ring-ring/50 data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:bg-input/50 data-disabled:opacity-50 data-invalid:border-destructive data-invalid:ring-destructive/20 md:text-sm dark:bg-input/30";

export function Label({ className, ...props }: React.ComponentProps<typeof AriaLabel>) {
  return (
    <AriaLabel
      className={cn("w-fit text-sm leading-snug font-medium", className)}
      {...props}
    />
  );
}

/** Muted helper text under a field (RAC Text slot="description"). */
export function Description({ className, ...props }: React.ComponentProps<typeof Text>) {
  return (
    <Text
      slot="description"
      className={cn("text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

export function FieldError({
  className,
  ...props
}: React.ComponentProps<typeof AriaFieldError>) {
  return (
    <AriaFieldError
      className={cn("text-xs font-medium text-destructive", className as string)}
      {...props}
    />
  );
}

export function Input({ className, ...props }: InputProps) {
  return <AriaInput className={cn(inputClass, className as string)} {...props} />;
}

interface FieldExtras {
  label?: React.ReactNode;
  description?: React.ReactNode;
  placeholder?: string;
  errorMessage?: string | ((validation: ValidationResult) => string);
}

/** Text input with wired label/description/error. */
export function TextField({
  label,
  description,
  placeholder,
  errorMessage,
  className,
  ...props
}: Omit<TextFieldProps, "className"> & FieldExtras & { className?: string }) {
  return (
    <AriaTextField className={cn("group flex flex-col gap-2", className)} {...props}>
      {label ? <Label>{label}</Label> : null}
      <Input placeholder={placeholder} />
      {description ? <Description>{description}</Description> : null}
      <FieldError>{errorMessage}</FieldError>
    </AriaTextField>
  );
}

/**
 * Numeric input with locale-aware parsing and stepper buttons — RAC handles
 * min/max clamping, step rounding, and the ARIA spinbutton pattern.
 */
export function NumberField({
  label,
  description,
  placeholder,
  errorMessage,
  className,
  ...props
}: Omit<NumberFieldProps, "className"> & FieldExtras & { className?: string }) {
  return (
    <AriaNumberField className={cn("group flex flex-col gap-2", className)} {...props}>
      {label ? <Label>{label}</Label> : null}
      <Group
        className={cn(
          "flex h-8 w-full min-w-0 items-stretch overflow-hidden rounded-lg border border-input bg-transparent transition-colors",
          "data-focus-within:border-ring data-focus-within:ring-3 data-focus-within:ring-ring/50",
          "data-disabled:pointer-events-none data-disabled:opacity-50 data-invalid:border-destructive dark:bg-input/30"
        )}
      >
        <AriaButton
          slot="decrement"
          className="flex w-7 shrink-0 cursor-default items-center justify-center border-r border-input text-muted-foreground outline-none data-hovered:bg-muted data-hovered:text-foreground data-pressed:bg-muted data-disabled:opacity-40"
        >
          <MinusIcon className="size-3.5" />
        </AriaButton>
        <AriaInput
          placeholder={placeholder}
          // The caret owns horizontal keys; without this, a NumberField inside
          // a grid cell hands ArrowLeft/Right to the grid's cell navigation.
          onKeyDown={(e) => {
            if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
              e.stopPropagation();
            }
          }}
          className="w-full min-w-0 bg-transparent px-2.5 py-1 text-center text-base tabular-nums outline-none placeholder:text-muted-foreground md:text-sm"
        />
        <AriaButton
          slot="increment"
          className="flex w-7 shrink-0 cursor-default items-center justify-center border-l border-input text-muted-foreground outline-none data-hovered:bg-muted data-hovered:text-foreground data-pressed:bg-muted data-disabled:opacity-40"
        >
          <PlusIcon className="size-3.5" />
        </AriaButton>
      </Group>
      {description ? <Description>{description}</Description> : null}
      <FieldError>{errorMessage}</FieldError>
    </AriaNumberField>
  );
}

/** Search input with the built-in clear (Esc / ✕) behaviour. */
export function SearchField({
  label,
  description,
  placeholder,
  className,
  ...props
}: Omit<SearchFieldProps, "className"> & FieldExtras & { className?: string }) {
  return (
    <AriaSearchField
      className={cn("group flex flex-col gap-2", className)}
      {...props}
    >
      {label ? (
        <Label>{label}</Label>
      ) : props["aria-label"] ? null : (
        <Label className="sr-only">Search</Label>
      )}
      <Group
        className={cn(
          "flex h-8 w-full min-w-0 items-center gap-1.5 rounded-lg border border-input bg-transparent px-2.5 transition-colors",
          "data-focus-within:border-ring data-focus-within:ring-3 data-focus-within:ring-ring/50 dark:bg-input/30"
        )}
      >
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <AriaInput
          placeholder={placeholder}
          className="w-full min-w-0 bg-transparent py-1 text-base outline-none placeholder:text-muted-foreground md:text-sm [&::-webkit-search-cancel-button]:hidden"
        />
        <AriaButton className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none group-data-empty:invisible data-hovered:text-foreground data-focus-visible:ring-2 data-focus-visible:ring-ring/50">
          <XIcon className="size-3.5" />
          <span className="sr-only">Clear search</span>
        </AriaButton>
      </Group>
      {description ? <Description>{description}</Description> : null}
    </AriaSearchField>
  );
}

/** Fieldset-style group: legend + stacked fields (checkbox groups etc). */
export function FieldGroup({
  label,
  children,
  className,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div role="group" className={cn("flex flex-col gap-2", className)}>
      <span className="text-sm font-medium">{label}</span>
      {children}
    </div>
  );
}
