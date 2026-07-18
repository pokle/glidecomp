/**
 * React Aria Components Select, styled to match ui/select.tsx.
 *
 * A single component with label/description wiring (like rac/field.tsx):
 * <Select label="…"><SelectItem id="…">…</SelectItem></Select>. Items use RAC
 * ListBox semantics — typeahead, keyboard selection and form integration come
 * built in.
 */
import {
  Select as AriaSelect,
  SelectValue,
  ListBox,
  ListBoxItem,
  Popover,
  Button as AriaButton,
  type SelectProps as AriaSelectProps,
  type ListBoxItemProps,
  type Key,
} from "react-aria-components";

import { cn } from "@/react/lib/utils";
import { Label, Description, FieldError } from "./field";
import { CheckIcon, ChevronDownIcon } from "lucide-react";

export const popoverClass =
  "z-50 min-w-36 overflow-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none data-entering:animate-in data-entering:fade-in-0 data-entering:zoom-in-95 data-exiting:animate-out data-exiting:fade-out-0 data-exiting:zoom-out-95 data-entering:duration-100 data-exiting:duration-100";

export function Select<T extends object>({
  label,
  description,
  errorMessage,
  className,
  children,
  items,
  ...props
}: Omit<AriaSelectProps<T>, "className" | "children"> & {
  label?: React.ReactNode;
  description?: React.ReactNode;
  errorMessage?: string;
  className?: string;
  items?: Iterable<T>;
  children: React.ReactNode | ((item: T) => React.ReactNode);
}) {
  return (
    <AriaSelect className={cn("group flex flex-col gap-2", className)} {...props}>
      {label ? <Label>{label}</Label> : null}
      <AriaButton
        className={cn(
          "flex h-8 w-full min-w-40 items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none",
          "data-focus-visible:border-ring data-focus-visible:ring-3 data-focus-visible:ring-ring/50 data-disabled:cursor-not-allowed data-disabled:opacity-50 data-invalid:border-destructive dark:bg-input/30 dark:data-hovered:bg-input/50"
        )}
      >
        <SelectValue className="flex flex-1 truncate text-left data-placeholder:text-muted-foreground" />
        <ChevronDownIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </AriaButton>
      {description ? <Description>{description}</Description> : null}
      <FieldError>{errorMessage}</FieldError>
      <Popover className={cn(popoverClass, "max-h-80 w-(--trigger-width)")}>
        <ListBox items={items} className="outline-none">
          {children}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}

export function SelectItem({
  className,
  children,
  ...props
}: Omit<ListBoxItemProps, "className"> & {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <ListBoxItem
      // textValue drives typeahead; default to the string content.
      textValue={typeof children === "string" ? children : undefined}
      className={cn(
        "relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-none select-none",
        "data-focused:bg-accent data-focused:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      {({ isSelected }) => (
        <>
          <span className="flex flex-1 gap-2 truncate">{children}</span>
          {isSelected ? (
            <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center">
              <CheckIcon className="size-4" />
            </span>
          ) : null}
        </>
      )}
    </ListBoxItem>
  );
}

/**
 * Drop-in replacement for comp/fields.tsx SimpleSelect: string value in/out.
 * RAC disallows `null` keys, so "" round-trips through a sentinel key.
 */
const EMPTY_KEY = "__empty__";

export function SimpleSelect({
  value,
  onChange,
  options,
  disabled,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const toKey = (v: string): Key => (v === "" ? EMPTY_KEY : v);
  const fromKey = (k: Key): string => (k === EMPTY_KEY ? "" : String(k));
  return (
    <Select
      aria-label={ariaLabel}
      selectedKey={toKey(value)}
      onSelectionChange={(k) => {
        if (k != null) onChange(fromKey(k));
      }}
      isDisabled={disabled}
      className={cn("w-fit", className)}
    >
      {options.map((o) => (
        <SelectItem key={o.value} id={toKey(o.value)}>
          {o.label}
        </SelectItem>
      ))}
    </Select>
  );
}
