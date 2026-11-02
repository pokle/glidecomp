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
 * Filtering is the caller's job, so pass items already narrowed (usually with
 * useFilter's `contains`). The wrapper turns RAC's own filter off: `items`
 * lands on the ListBox, not the ComboBox, so RAC still tested every option's
 * textValue for containing the input, and hid any option the caller meant to
 * show that does not: the Team field's "Did you mean Alpha Gliders?" for
 * "Alpha Gilders", or a geocoder's result labelled differently from the query. Map an empty query
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
 *
 * `variant="field"` is the other job a combo box does: a FORM field whose
 * value is usually one of a known few (the pilot page's Team, which offers
 * the roster's teams). It looks like the TextField beside it, the same height
 * and no magnifier, because it is one. A tap on it opens the list even when it
 * already has focus. React Aria closes the list whenever anything around the
 * field scrolls, and a scroll follows focus more often than not: the browser
 * bringing a half-hidden field into view, or the kit form centring the field
 * it is reporting (rac/form.tsx). Without the tap, the list that focus opened
 * was gone a frame later, and only typing brought it back.
 *
 * And nothing stays SELECTED in a field: its text is its value, and a choice
 * from the list only fills it in. A selected option made React Aria move its
 * virtual focus onto that option whenever the list reopened, which fires a
 * blur at the input mid-keystroke; on an iPhone a held Backspace after
 * picking a team deleted one letter and stopped. React Aria closes the list
 * only when the selection CHANGES, so with none kept the field closes it, a
 * frame after the choice has filled in the text (which React Aria answers by
 * opening the list).
 */
import { useContext, useRef } from "react";
import {
  ComboBox as AriaComboBox,
  ComboBoxStateContext,
  Input as AriaInput,
  ListBox as AriaListBox,
  ListBoxItem as AriaListBoxItem,
  Popover,
  Group,
  type ComboBoxProps as AriaComboBoxProps,
  type InputProps,
  type ListBoxItemProps,
} from "react-aria-components";
import { SearchIcon } from "lucide-react";

import { cn } from "@/react/lib/utils";
import { Label, Description, FieldError } from "./field";
import { popoverClass } from "./select";

/** The open/close state React Aria keeps for a combo box. */
type ListState = NonNullable<React.ContextType<typeof ComboBoxStateContext>>;

/** The caller filters (see the note at the top), so RAC shows what it is given. */
const showEverything = () => true;

export function ComboBox<T extends object>({
  label,
  description,
  errorMessage,
  placeholder,
  className,
  listClassName,
  items,
  renderEmptyState,
  variant = "search",
  children,
  onSelectionChange,
  ...props
}: Omit<AriaComboBoxProps<T>, "className" | "children" | "items"> & {
  /** A search box (the default), or a form field (see the note above). */
  variant?: "search" | "field";
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
  // The field variant's state, for closing the list after a choice (see above).
  const stateRef = useRef<ListState | null>(null);
  const field = variant === "field";
  return (
    <AriaComboBox
      className={cn("group flex flex-col gap-2", className)}
      menuTrigger="input"
      defaultFilter={showEverything}
      {...props}
      {...(field ? { selectedKey: null } : {})}
      onSelectionChange={(key) => {
        onSelectionChange?.(key);
        // A frame later: the choice changes the field's text, and React Aria
        // reopens the list for a changed text while the field has focus.
        if (field && key != null) requestAnimationFrame(() => stateRef.current?.close());
      }}
    >
      {label ? <Label>{label}</Label> : <Label className="sr-only">Search</Label>}
      <Group
        className={cn(
          "flex w-full min-w-0 items-center gap-1.5 rounded-lg border border-input bg-card transition-colors",
          variant === "field" ? "h-9 px-3" : "h-8 px-2.5",
          "data-focus-within:border-ring data-focus-within:ring-3 data-focus-within:ring-ring/50 dark:bg-input/30"
        )}
      >
        {variant === "search" ? (
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : null}
        {/* Same reasoning as SearchField (see the note there), and it matters
            more here: this input already owns a suggestion popover, so a
            browser autofill panel would fight it for the same screen space. */}
        <ComboBoxInput
          opensOnTap={field}
          stateRef={stateRef}
          placeholder={placeholder}
          autoComplete="off"
          // A name in a form field starts its words with capitals; a search
          // does not care. Never autocorrect: it "fixes" names into typos.
          autoCapitalize={variant === "field" ? "words" : "none"}
          autoCorrect="off"
          spellCheck={false}
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

/** The combo box's input; `opensOnTap` is the field variant's tap (see the note at the top). */
function ComboBoxInput({
  opensOnTap,
  stateRef,
  ...props
}: InputProps & {
  opensOnTap: boolean;
  stateRef: React.RefObject<ListState | null>;
}) {
  const state = useContext(ComboBoxStateContext);
  stateRef.current = state;
  return (
    <AriaInput
      {...props}
      onClick={
        opensOnTap
          ? () => {
              // Open only: a tap to move the caret must not close the list.
              // Nothing to show is not opened, rather than flashed empty.
              if (state && !state.isOpen && state.collection.size > 0) state.open(null, "manual");
            }
          : undefined
      }
    />
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
