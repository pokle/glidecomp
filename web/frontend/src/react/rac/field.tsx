/**
 * React Aria Components form fields, styled to match the shadcn kit they replaced.
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
  TextArea as AriaTextArea,
  Label as AriaLabel,
  Text,
  FieldError as AriaFieldError,
  Group,
  Button as AriaButton,
  type TextFieldProps,
  type NumberFieldProps,
  type SearchFieldProps,
  type InputProps,
  type TextAreaProps,
  type ValidationResult,
} from "react-aria-components";

import { cn } from "@/react/lib/utils";
import { MinusIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";

export const inputClass =
  "h-9 w-full min-w-0 rounded-lg border border-input bg-card px-3 py-1 text-base transition-colors outline-none placeholder:text-muted-foreground data-focused:border-ring data-focused:ring-3 data-focused:ring-ring/50 data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:bg-input/50 data-disabled:opacity-50 data-invalid:border-destructive data-invalid:ring-destructive/20 md:text-sm dark:bg-input/30";

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

/** `ref` is declared explicitly: RAC's own InputProps omits it (v1 still uses
 *  forwardRef), and callers need the element for caret work. */
export function Input({
  className,
  ref,
  ...props
}: InputProps & { ref?: React.Ref<HTMLInputElement> }) {
  return (
    <AriaInput ref={ref} className={cn(inputClass, className as string)} {...props} />
  );
}

/**
 * Multi-line sibling of Input, sharing its box styling. Same `ref` note as
 * Input. `rows` sets the starting height; callers that grow with the content
 * drive `style.height` themselves.
 */
export function TextArea({
  className,
  ref,
  ...props
}: TextAreaProps & { ref?: React.Ref<HTMLTextAreaElement> }) {
  return (
    <AriaTextArea
      ref={ref}
      className={cn(inputClass, "h-auto resize-y", className as string)}
      {...props}
    />
  );
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
          // 44px tall on a coarse pointer (issue #641), which is what makes
          // the steppers beside it a full 44px target rather than a 28×36 sliver.
          "flex h-9 w-full min-w-0 items-stretch overflow-hidden rounded-lg border border-input bg-card transition-colors pointer-coarse:h-11",
          "data-focus-within:border-ring data-focus-within:ring-3 data-focus-within:ring-ring/50",
          "data-disabled:pointer-events-none data-disabled:opacity-50 data-invalid:border-destructive dark:bg-input/30"
        )}
      >
        <AriaButton
          slot="decrement"
          className="flex w-7 shrink-0 cursor-default items-center justify-center border-r border-input pointer-coarse:w-11 text-muted-foreground outline-none data-hovered:bg-muted data-hovered:text-foreground data-pressed:bg-muted data-disabled:opacity-40"
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
          className="flex w-7 shrink-0 cursor-default items-center justify-center border-l border-input pointer-coarse:w-11 text-muted-foreground outline-none data-hovered:bg-muted data-hovered:text-foreground data-pressed:bg-muted data-disabled:opacity-40"
        >
          <PlusIcon className="size-3.5" />
        </AriaButton>
      </Group>
      {description ? <Description>{description}</Description> : null}
      <FieldError>{errorMessage}</FieldError>
    </AriaNumberField>
  );
}

/**
 * The two shapes a search box takes.
 *
 * `floating` is the pill that rides at the bottom of the screen over a list
 * (the pilots page's search-and-add bar, after iOS Contacts): thumb height, an
 * opaque surface because rows scroll underneath it, and a clear button big
 * enough to hit with a thumb rather than the 20px a desktop field gets away
 * with.
 */
const SEARCH_GROUP = {
  default: "h-9 rounded-lg bg-card px-3 dark:bg-input/30",
  floating:
    "h-12 rounded-full bg-card/95 px-4 shadow-lg backdrop-blur-sm dark:bg-card/95",
} as const;
const SEARCH_CLEAR = {
  default: "size-5 rounded",
  floating: "-mr-2 size-10 rounded-full",
} as const;

/** Search input with the built-in clear (Esc / ✕) behaviour. */
export function SearchField({
  label,
  description,
  placeholder,
  className,
  variant = "default",
  ...props
}: Omit<SearchFieldProps, "className"> &
  FieldExtras & { className?: string; variant?: keyof typeof SEARCH_GROUP }) {
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
          "flex w-full min-w-0 items-center gap-1.5 border border-input transition-colors",
          SEARCH_GROUP[variant],
          "data-focus-within:border-ring data-focus-within:ring-3 data-focus-within:ring-ring/50"
        )}
      >
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        {/* A filter-the-page box is never a field to autofill or "correct".
            Without autoComplete, Safari classifies the input from its
            placeholder/label text and will offer Contacts — the waypoints
            filter ("Filter by code, name or coordinates…") popped up the
            address book over the grid. `off` is honoured for Contacts autofill
            (the "Safari ignores autocomplete=off" caveat is about passwords).
            autoCapitalize/autoCorrect/spellCheck are the iOS half: stop it
            capitalising the first letter and autocorrecting codes like
            CUDGWE. */}
        <AriaInput
          placeholder={placeholder}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={cn(
            "w-full min-w-0 bg-transparent py-1 text-base outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden",
            variant === "default" && "md:text-sm"
          )}
        />
        <AriaButton
          className={cn(
            "flex shrink-0 items-center justify-center text-muted-foreground outline-none group-data-empty:invisible data-hovered:text-foreground data-focus-visible:ring-2 data-focus-visible:ring-ring/50",
            SEARCH_CLEAR[variant]
          )}
        >
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
