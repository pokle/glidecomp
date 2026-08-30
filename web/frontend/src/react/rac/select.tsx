/**
 * React Aria Components Select, styled to match the shadcn kit it replaced.
 *
 * A single component with label/description wiring (like rac/field.tsx):
 * <Select label="…"><SelectItem id="…">…</SelectItem></Select>. Items use RAC
 * ListBox semantics — typeahead, keyboard selection and form integration come
 * built in.
 *
 * ## When a Select is still the right control (issue #638)
 *
 * The mobile-first direction is "generally no popovers", and every **form
 * field** on a settings-style surface has moved to `rac/choice-list.tsx`
 * (`ChoiceList` / `CheckList` / `SearchableChoiceList`) — a list in flow,
 * where a phone keyboard cannot cover it and the whole row is the target.
 *
 * What stays here is the other kind of control: a **view or filter control**,
 * which sits above the content it acts on rather than in a form that gets
 * saved. Converting those would be actively worse — a filter rendered as a
 * card of rows pushes the thing you are filtering off the screen, which is the
 * opposite of the problem the conversion set out to solve. The surviving call
 * sites are the task-analysis class and metric pickers, the scores-view
 * picker and the manage table's per-row pilot status (a row action, where a
 * list in flow would blow the row apart).
 *
 * So: **is this value part of a form the user will Save?** Then it belongs in
 * `choice-list.tsx`. Is it choosing what to look at? Then it belongs here.
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

/**
 * Shared surface for every kit popover (Select, ComboBox, Menu, Popover).
 *
 * **Never add `position` here (no `fixed!`, no positioned ancestor).** RAC
 * portals a popover to `<body>` and positions it with `position: absolute`
 * against the initial containing block: `top` in document coordinates, and —
 * when a popover flips UPWARDS — `bottom` against the viewport-sized ICB.
 * Both are only correct while `body` is *static* (globals.css keeps it so).
 * The two historical failures, each found in production: with
 * `body { position: relative }` an upward-flipped popover (the CIVL ranking
 * picker, low in a tall dialog) landed `scrollHeight - innerHeight` px too
 * low; with `fixed!` patched over that, every downward popover on a scrolled
 * page (the manual-flight dialog's turnpoint select, deep in the task page)
 * opened `scrollY` px below the viewport. Diagnose by rect, not by eye — the
 * popover is open and in the DOM either way, just off-screen.
 */
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
  label,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  /** A VISIBLE label, wired up by RAC — prefer this to `ariaLabel`. */
  label?: React.ReactNode;
  ariaLabel?: string;
  className?: string;
}) {
  const toKey = (v: string): Key => (v === "" ? EMPTY_KEY : v);
  const fromKey = (k: Key): string => (k === EMPTY_KEY ? "" : String(k));
  return (
    <Select
      label={label}
      // aria-label WINS over a visible <Label>, so passing both would leave the
      // name a screen reader announces free to drift from the words on screen
      // (WCAG 2.2 SC 2.5.3). The visible label is the better one when present.
      aria-label={label ? undefined : ariaLabel}
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
