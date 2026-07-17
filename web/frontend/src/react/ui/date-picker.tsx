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

// The field box mirrors ui/input.tsx so pickers sit flush with text inputs.
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

const cellClass = ({
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
    "flex size-8 cursor-default items-center justify-center rounded-md text-sm outline-none",
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

/** The calendar dropdown shared by DatePicker and DateTimePicker. */
function CalendarPopover() {
  return (
    <Popover className="z-50 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md outline-none">
      <Dialog className="outline-none">
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
                <CalendarHeaderCell className="size-8 text-xs font-normal text-muted-foreground">
                  {day}
                </CalendarHeaderCell>
              )}
            </CalendarGridHeader>
            <CalendarGridBody>
              {(date) => <CalendarCell date={date} className={cellClass} />}
            </CalendarGridBody>
          </CalendarGrid>
        </Calendar>
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
}

/** Date-only picker. Value is a bare calendar date ("YYYY-MM-DD"). */
export function DatePicker({
  value,
  onChange,
  clearable,
  className,
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
          <AriaButton className={trailingButton} aria-label="Open calendar">
            <CalendarIcon className="size-4" />
          </AriaButton>
        </Group>
        <CalendarPopover />
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
