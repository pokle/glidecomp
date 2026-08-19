/**
 * Timezone-aware date / datetime / time pickers (replaces native
 * <input type="date|datetime-local|time">, which clears inconsistently in
 * Safari). Built on react-aria-components + @internationalized/date: the
 * field is a custom segmented control (identical in every browser, keyboard
 * accessible, WCAG 2.2 AA) with a calendar popover.
 *
 * Each picker keeps the same string in / string out contract the native
 * inputs had, so they drop into existing state and the comp-zone ↔ UTC
 * helpers in `../lib/time.ts` unchanged:
 *   - DatePicker      "YYYY-MM-DD"        (bare calendar date)
 *   - DateTimePicker  "YYYY-MM-DDTHH:MM"  (wall clock in the comp zone)
 *   - TimePicker      "HH:MM"             (wall clock in the comp zone)
 * The value is always a *wall clock*; the comp's timezone is presentational
 * (shown via the caller's label) — conversion to the stored UTC instant stays
 * in time.ts, exactly as before.
 *
 * Locale is pinned to en-GB so the segment order is day-first, matching the
 * app's date rendering (see time.ts `formatInstant`), regardless of the
 * viewer's own locale.
 *
 * This module carries the heavy react-aria-components dependency (~74 KB gzip).
 * It is **not imported directly** — `./date-picker.tsx` lazy-loads it into its
 * own async chunk so the weight stays out of the initial and SSR bundles and
 * only loads when an admin opens a dialog. Import the pickers from
 * `./date-picker`, never from here.
 */
import * as React from "react";
import {
  parseDate,
  parseDateTime,
  parseTime,
  type CalendarDate,
  type CalendarDateTime,
  type Time,
} from "@internationalized/date";
import {
  DatePicker as AriaDatePicker,
  TimeField as AriaTimeField,
  DateInput,
  DateSegment,
  Group,
  Button as AriaButton,
  Popover,
  Dialog,
  Calendar,
  CalendarGrid,
  CalendarGridHeader,
  CalendarHeaderCell,
  CalendarGridBody,
  CalendarCell,
  Heading,
  I18nProvider,
} from "react-aria-components";
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Clock,
  X,
} from "lucide-react";

import { cn } from "@/react/lib/utils";

/** Day-first segments (DD/MM/YYYY), matching the app's en-GB date rendering. */
const LOCALE = "en-GB";

// The field box mirrors rac/field.tsx's input so pickers sit flush with text inputs.
const fieldBox = cn(
  "flex h-8 w-full min-w-0 items-center rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors md:text-sm dark:bg-input/30",
  "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
  "data-[disabled]:pointer-events-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50"
);

const segmentClass = ({ isPlaceholder }: { isPlaceholder: boolean }) =>
  cn(
    "rounded px-0.5 tabular-nums outline-none focus:bg-accent focus:text-accent-foreground",
    isPlaceholder && "text-muted-foreground"
  );

const trailingButton =
  "ml-1 inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50";

const navButton =
  "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[disabled]:opacity-40";

/**
 * Two cell scales. `touch` (44px) is the inline calendar's — the whole point
 * of putting the calendar on the page instead of in a popover. `compact`
 * (32px) is the dropdown's, and grows to the same 44px on a coarse pointer
 * (issue #641): a mouse picks a 32px day cell precisely, a thumb does not,
 * and 31 of them sit edge to edge with no spacing to fall back on. The header
 * cells match the column WIDTH but stay short: they hold day initials, not
 * targets.
 */
const CELL_SCALE = {
  compact: { cell: "size-8 pointer-coarse:size-11", head: "size-8 pointer-coarse:w-11" },
  touch: { cell: "size-11", head: "h-8 w-11" },
} as const;

type CellScale = keyof typeof CELL_SCALE;

const makeCellClass =
  (scale: CellScale) =>
  ({
    isSelected,
    isDisabled,
    isOutsideMonth,
    isFocusVisible,
    isUnavailable,
  }: {
    isSelected: boolean;
    isDisabled: boolean;
    isOutsideMonth: boolean;
    isFocusVisible: boolean;
    isUnavailable: boolean;
  }) =>
    cn(
      "flex cursor-default items-center justify-center rounded-md text-sm outline-none",
      CELL_SCALE[scale].cell,
      !isSelected &&
        !isDisabled &&
        "hover:bg-accent hover:text-accent-foreground",
      isSelected && "bg-primary text-primary-foreground",
      (isDisabled || isUnavailable) && "text-muted-foreground opacity-50",
      isOutsideMonth && "text-muted-foreground/40",
      isFocusVisible && "ring-2 ring-ring/50"
    );

function parseSafe<T>(raw: string, parse: (s: string) => T): T | null {
  if (!raw) return null;
  try {
    return parse(raw);
  } catch {
    return null;
  }
}

/** The trailing "clear" (×) affordance, shown only when there's a value. */
function ClearButton({ onClear }: { onClear: () => void }) {
  return (
    <button
      type="button"
      aria-label="Clear"
      className={trailingButton}
      // Keep the popover/segment focus from stealing the pointerdown.
      onClick={onClear}
    >
      <X className="size-4" />
    </button>
  );
}

/**
 * The month grid itself. Rendered either inside the dropdown or straight into
 * the page — it reads its state from the DatePicker's CalendarContext either
 * way, so the overlay is presentation, not plumbing.
 */
function CalendarBody({ scale = "compact" }: { scale?: CellScale }) {
  return (
    <Calendar className="w-fit">
      <header className="flex items-center justify-between pb-2">
        <AriaButton slot="previous" className={navButton}>
          <ChevronLeft className="size-4" />
        </AriaButton>
        <Heading className="text-sm font-medium" />
        <AriaButton slot="next" className={navButton}>
          <ChevronRight className="size-4" />
        </AriaButton>
      </header>
      <CalendarGrid className="border-collapse">
        <CalendarGridHeader>
          {(day) => (
            <CalendarHeaderCell
              className={cn(
                CELL_SCALE[scale].head,
                "text-xs font-normal text-muted-foreground"
              )}
            >
              {day}
            </CalendarHeaderCell>
          )}
        </CalendarGridHeader>
        <CalendarGridBody>
          {(date) => (
            <CalendarCell date={date} className={makeCellClass(scale)} />
          )}
        </CalendarGridBody>
      </CalendarGrid>
    </Calendar>
  );
}

/**
 * The calendar dropdown shared by DatePicker and DateTimePicker.
 *
 * No `position` override — RAC's own absolute positioning is only correct
 * against a static body; see rac/select.tsx's popoverClass (gotcha #22).
 */
function CalendarPopover() {
  return (
    <Popover className="z-50 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md outline-none">
      {/* 7 × 44px + padding overflows a 320px viewport, so the grid scrolls
          inside the panel rather than off the side of the screen. */}
      <Dialog className="max-w-[calc(100vw-1.5rem)] overflow-x-auto outline-none">
        <CalendarBody />
      </Dialog>
    </Popover>
  );
}

interface PickerBaseProps {
  id?: string;
  /** True to render a trailing clear (×) button when a value is set. */
  clearable?: boolean;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

export interface DatePickerProps extends PickerBaseProps {
  /** "YYYY-MM-DD", or "" when unset. */
  value: string;
  onChange: (value: string) => void;
  /**
   * Render the calendar **in the page**, under the segments, instead of in a
   * dropdown — the settings-page form: no overlay to open, nothing for a
   * phone keyboard to cover, and 44px day cells. Dialogs keep the dropdown,
   * where an always-open calendar would outgrow the panel.
   */
  inline?: boolean;
}

/** Date-only picker. Value is a bare calendar date ("YYYY-MM-DD"). */
export function DatePicker({
  value,
  onChange,
  clearable,
  className,
  inline,
  ...rest
}: DatePickerProps) {
  const dateValue = parseSafe(value, parseDate) as CalendarDate | null;
  return (
    <I18nProvider locale={LOCALE}>
      <AriaDatePicker
        {...rest}
        value={dateValue}
        onChange={(v) => onChange(v ? v.toString() : "")}
        granularity="day"
        className={cn("w-full", className)}
      >
        <Group className={fieldBox}>
          <DateInput className="flex flex-1 items-center">
            {(segment) => (
              <DateSegment segment={segment} className={segmentClass} />
            )}
          </DateInput>
          {clearable && dateValue ? (
            <ClearButton onClear={() => onChange("")} />
          ) : null}
          {/* No trigger when the calendar is already on the page. */}
          {inline ? null : (
            <AriaButton className={trailingButton} aria-label="Open calendar">
              <CalendarIcon className="size-4" />
            </AriaButton>
          )}
        </Group>
        {inline ? (
          <div className="mt-2 w-fit max-w-full overflow-x-auto rounded-lg border border-border p-3">
            <CalendarBody scale="touch" />
          </div>
        ) : (
          <CalendarPopover />
        )}
      </AriaDatePicker>
    </I18nProvider>
  );
}

export interface DateTimePickerProps extends PickerBaseProps {
  /** "YYYY-MM-DDTHH:MM" wall clock in the comp zone, or "" when unset. */
  value: string;
  onChange: (value: string) => void;
}

/** Date+time picker. Value is a wall clock ("YYYY-MM-DDTHH:MM"); the comp
 * timezone is presentational (label it via the caller). */
export function DateTimePicker({
  value,
  onChange,
  clearable,
  className,
  ...rest
}: DateTimePickerProps) {
  const dateValue = parseSafe(value, parseDateTime) as CalendarDateTime | null;
  return (
    <I18nProvider locale={LOCALE}>
      <AriaDatePicker
        {...rest}
        value={dateValue}
        // CalendarDateTime.toString() → "YYYY-MM-DDTHH:MM:SS"; keep the minute form.
        onChange={(v) => onChange(v ? v.toString().slice(0, 16) : "")}
        granularity="minute"
        hourCycle={24}
        className={cn("w-full", className)}
      >
        <Group className={fieldBox}>
          <DateInput className="flex flex-1 items-center">
            {(segment) => (
              <DateSegment segment={segment} className={segmentClass} />
            )}
          </DateInput>
          {clearable && dateValue ? (
            <ClearButton onClear={() => onChange("")} />
          ) : null}
          <AriaButton className={trailingButton} aria-label="Open calendar">
            <CalendarIcon className="size-4" />
          </AriaButton>
        </Group>
        <CalendarPopover />
      </AriaDatePicker>
    </I18nProvider>
  );
}

export interface TimePickerProps extends PickerBaseProps {
  /** "HH:MM" wall clock in the comp zone, or "" when unset. */
  value: string;
  onChange: (value: string) => void;
}

/** Time-only picker (24h). Value is a wall clock ("HH:MM"). */
export function TimePicker({
  value,
  onChange,
  clearable,
  className,
  ...rest
}: TimePickerProps) {
  const timeValue = parseSafe(value, parseTime) as Time | null;
  return (
    <I18nProvider locale={LOCALE}>
      <AriaTimeField
        {...rest}
        value={timeValue}
        // Time.toString() → "HH:MM:SS"; keep the minute form.
        onChange={(v) => onChange(v ? v.toString().slice(0, 5) : "")}
        granularity="minute"
        hourCycle={24}
        className={cn("w-full", className)}
      >
        <Group className={fieldBox}>
          <DateInput className="flex flex-1 items-center">
            {(segment) => (
              <DateSegment segment={segment} className={segmentClass} />
            )}
          </DateInput>
          {clearable && timeValue ? (
            <ClearButton onClear={() => onChange("")} />
          ) : (
            <Clock className="ml-1 size-4 shrink-0 text-muted-foreground" />
          )}
        </Group>
      </AriaTimeField>
    </I18nProvider>
  );
}
