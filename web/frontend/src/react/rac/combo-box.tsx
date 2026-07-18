/**
 * React Aria Components ComboBox — a text input whose suggestions float in a
 * popover below (or above, when there's no room) the field.
 *
 * Reach for this, not SearchField + a bare ListBox, whenever typing filters a
 * list of options. ComboBox owns the ARIA combobox contract — role="combobox"
 * on the input with aria-expanded/aria-controls wired to the popover, and
 * arrow-key virtual focus that keeps the caret in the input — none of which a
 * searchbox sitting beside a detached listbox provides.
 *
 * Filtering is the caller's job: RAC does none for a controlled `items`, so
 * pass items already narrowed with useFilter's `contains`. Map an empty query
 * to an empty list so the popover stays shut at rest, and gate
 * `allowsEmptyCollection` on having a query so `renderEmptyState`'s "no
 * matches" still shows while searching.
 *
 * If you also control `selectedKey`, react-stately makes resetting the input
 * YOUR job and signals it with `onSelectionChange(null)` on the Esc/blur
 * revert — handle that key or Esc will appear to do nothing.
 *
 * Styled to match SearchField (same bordered group + search icon) so the two
 * read as one control; the popover reuses rac/select.tsx's popoverClass.
 */
import {
  ComboBox as AriaComboBox,
  Input as AriaInput,
  ListBox as AriaListBox,
  ListBoxItem as AriaListBoxItem,
  Popover,
  Group,
  type ComboBoxProps as AriaComboBoxProps,
  type ListBoxItemProps,
} from "react-aria-components";
import { SearchIcon } from "lucide-react";

import { cn } from "@/react/lib/utils";
import { Label, Description, FieldError } from "./field";
import { popoverClass } from "./select";

export function ComboBox<T extends object>({
  label,
  description,
  errorMessage,
  placeholder,
  className,
  listClassName,
  items,
  renderEmptyState,
  children,
  ...props
}: Omit<AriaComboBoxProps<T>, "className" | "children" | "items"> & {
  label?: React.ReactNode;
  description?: React.ReactNode;
  errorMessage?: string;
  placeholder?: string;
  className?: string;
  /** Extra classes for the popover's ListBox — typically a max-h-* cap. */
  listClassName?: string;
  items?: Iterable<T>;
  renderEmptyState?: () => React.ReactNode;
  children: React.ReactNode | ((item: T) => React.ReactNode);
}) {
  return (
    <AriaComboBox
      className={cn("group flex flex-col gap-2", className)}
      menuTrigger="input"
      {...props}
    >
      {label ? <Label>{label}</Label> : <Label className="sr-only">Search</Label>}
      <Group
        className={cn(
          "flex h-8 w-full min-w-0 items-center gap-1.5 rounded-lg border border-input bg-transparent px-2.5 transition-colors",
          "data-focus-within:border-ring data-focus-within:ring-3 data-focus-within:ring-ring/50 dark:bg-input/30"
        )}
      >
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <AriaInput
          placeholder={placeholder}
          className="w-full min-w-0 bg-transparent py-1 text-base outline-none placeholder:text-muted-foreground md:text-sm"
        />
        {/* Deliberately no trailing toggle/clear button. react-aria's
            ariaHideOutside aria-hides everything except the input and the
            popover while the list is open — including RAC's own trigger — so
            any button here is hidden from AT exactly when it's on screen.
            Dismiss with Esc, clear by blurring or picking. */}
      </Group>
      {description ? <Description>{description}</Description> : null}
      <FieldError>{errorMessage}</FieldError>
      <Popover className={cn(popoverClass, "w-(--trigger-width)")}>
        <AriaListBox
          items={items}
          renderEmptyState={renderEmptyState}
          className={cn("max-h-64 overflow-y-auto outline-none", listClassName)}
        >
          {children}
        </AriaListBox>
      </Popover>
    </AriaComboBox>
  );
}

export function ComboBoxItem({
  className,
  ...props
}: Omit<ListBoxItemProps, "className"> & { className?: string }) {
  return (
    <AriaListBoxItem
      className={cn(
        "flex w-full cursor-default items-baseline gap-2 rounded px-1.5 py-1 text-left text-sm outline-none select-none",
        "data-hovered:bg-accent data-focused:bg-accent data-focused:text-accent-foreground",
        className
      )}
      {...props}
    />
  );
}
