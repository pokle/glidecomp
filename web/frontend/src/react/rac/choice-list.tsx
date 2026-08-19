/**
 * ChoiceList — "pick one of N" as a list of full-width rows with a checkmark
 * on the chosen one, the way a phone's settings app does it.
 *
 * It replaces BOTH desktop controls on the settings pages: the radio group (a
 * 16px dot beside a label, sized for a mouse) and `SimpleSelect` (a floating
 * popover, which on a phone opens over the thing you were reading and can be
 * covered by the keyboard). Same information, no overlay, and the whole row
 * is the target rather than the dot.
 *
 * Built on RAC's RadioGroup/Radio, so the ARIA contract, arrow-key roving
 * focus and the real `<input type="radio">` underneath are unchanged — only
 * the presentation differs from `rac/radio-group.tsx`, which stays as the
 * compact form for dense dialogs.
 *
 * `SearchableChoiceList` is the same row, collapsed: it shows the current
 * value and expands **in flow** to a search box over a filtered list. In
 * flow, not floating, for the reason `comp/QuickTaskField.tsx` gives — on a
 * phone the keyboard covers a floating list. Use it past a dozen or so
 * options (the ~400 IANA timezones are the case it was built for).
 */
import { useId, useMemo, useState } from "react";
import {
  Radio as AriaRadio,
  RadioGroup as AriaRadioGroup,
  Button as AriaButton,
  useFilter,
} from "react-aria-components";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { cn } from "@/react/lib/utils";
import { cardSurface } from "./card";
import { Description, Label, SearchField } from "./field";
import { ListBox, ListBoxItem } from "./list-box";

export interface Choice {
  value: string;
  label: string;
  /** Secondary line under the label. */
  description?: string;
}

/** The shared row: 44px minimum target, label left, trailing status glyph. */
const rowClass =
  "flex min-h-11 w-full cursor-default items-center gap-3 px-4 py-2.5 text-left text-sm outline-none " +
  "data-hovered:bg-muted/50 data-pressed:bg-muted data-disabled:opacity-50 " +
  "data-focus-visible:ring-2 data-focus-visible:ring-ring/50 data-focus-visible:ring-inset";

export function ChoiceList({
  label,
  description,
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: {
  label?: React.ReactNode;
  description?: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  options: Choice[];
  /** Use when there is no visible `label` to name the group. */
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <AriaRadioGroup
      value={value}
      onChange={onChange}
      aria-label={ariaLabel}
      className={cn("flex flex-col gap-2", className)}
    >
      {label ? <Label>{label}</Label> : null}
      <div className={cn(cardSurface, "divide-y divide-border overflow-hidden")}>
        {options.map((option) => (
          <AriaRadio key={option.value} value={option.value} className={rowClass}>
            {({ isSelected }) => (
              <>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={cn(isSelected && "font-medium")}>
                    {option.label}
                  </span>
                  {option.description ? (
                    <span className="text-muted-foreground">
                      {option.description}
                    </span>
                  ) : null}
                </span>
                {/* Kept in the layout when unselected (`invisible`, not
                    absent) so choosing doesn't reflow the row's text. */}
                <CheckIcon
                  aria-hidden
                  className={cn(
                    "size-4 shrink-0 text-primary",
                    !isSelected && "invisible"
                  )}
                />
              </>
            )}
          </AriaRadio>
        ))}
      </div>
      {description ? <Description>{description}</Description> : null}
    </AriaRadioGroup>
  );
}

export function SearchableChoiceList({
  label,
  description,
  value,
  onChange,
  options,
  searchLabel,
  searchPlaceholder,
  emptyLabel = "Not set",
  className,
}: {
  label: string;
  description?: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  options: Choice[];
  /** Accessible name for the search box (e.g. "Search timezones"). */
  searchLabel: string;
  searchPlaceholder?: string;
  /** Shown on the row when `value` matches no option. */
  emptyLabel?: string;
  className?: string;
}) {
  const labelId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { contains } = useFilter({ sensitivity: "base" });

  const selected = options.find((o) => o.value === value) ?? null;
  const filtered = useMemo(
    () => (query ? options.filter((o) => contains(o.label, query)) : options),
    // `contains` is a fresh closure each render; the query and list are the
    // real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [options, query]
  );

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className={cn("flex flex-col gap-2", className)}
    >
      <h3 id={labelId} className="text-sm font-medium">
        {label}
      </h3>
      <div className={cn(cardSurface, "overflow-hidden")}>
        <AriaButton
          onPress={() => {
            setOpen((o) => !o);
            setQuery("");
          }}
          aria-expanded={open}
          aria-labelledby={labelId}
          className={rowClass}
        >
          <span className="min-w-0 flex-1 truncate font-medium">
            {selected?.label ?? emptyLabel}
          </span>
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180"
            )}
          />
        </AriaButton>
        {open ? (
          <div className="flex flex-col gap-2 border-t border-border p-3">
            <SearchField
              aria-label={searchLabel}
              placeholder={searchPlaceholder}
              value={query}
              onChange={setQuery}
              autoFocus
            />
            <ListBox
              aria-label={searchLabel}
              selectionMode="single"
              selectedKeys={value ? [value] : []}
              onSelectionChange={(keys) => {
                const key = keys === "all" ? null : [...keys][0];
                if (key == null) return;
                onChange(String(key));
                setOpen(false);
                setQuery("");
              }}
              items={filtered}
              className="max-h-72 border-0"
              renderEmptyState={() => (
                <div className="px-2 py-1.5 text-sm text-muted-foreground">
                  No matches.
                </div>
              )}
            >
              {(item: Choice) => (
                <ListBoxItem
                  id={item.value}
                  textValue={item.label}
                  className="min-h-11 items-center data-selected:font-medium"
                >
                  {item.label}
                </ListBoxItem>
              )}
            </ListBox>
          </div>
        ) : null}
      </div>
      {description ? <Description>{description}</Description> : null}
    </div>
  );
}
