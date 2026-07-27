/**
 * Lazy entry point for the date / datetime / time pickers.
 *
 * The real implementation (`./date-picker.impl`) pulls in react-aria-components
 * (~74 KB gzip). The pickers only ever appear in admin dialogs, so there's no
 * reason to ship that weight in the initial page load or the SSR worker bundle.
 * Each picker is `React.lazy`-loaded here into a shared async chunk, wrapped in
 * a Suspense boundary whose fallback is a field-shaped skeleton (matching the
 * picker's box so the swap-in doesn't shift layout). Call sites import from
 * this module unchanged — the split is invisible to them.
 *
 * SSR-safe: the pickers render only inside admin dialogs (gated `isAdmin &&
 * open`, both false during server render), so a lazy picker never reaches
 * renderToString and the impl chunk is never needed on the server.
 */
import { lazy, Suspense } from "react";

import { cn } from "@/react/lib/utils";
import type {
  DatePickerProps,
  DateTimePickerProps,
  TimePickerProps,
} from "./date-picker.impl";

export type {
  DatePickerProps,
  DateTimePickerProps,
  TimePickerProps,
} from "./date-picker.impl";

// All three resolve the same chunk; the first picker to render loads it and the
// rest reuse it.
const LazyDatePicker = lazy(() =>
  import("./date-picker.impl").then((m) => ({ default: m.DatePicker }))
);
const LazyDateTimePicker = lazy(() =>
  import("./date-picker.impl").then((m) => ({ default: m.DateTimePicker }))
);
const LazyTimePicker = lazy(() =>
  import("./date-picker.impl").then((m) => ({ default: m.TimePicker }))
);

/** Placeholder matching the picker's field box (see impl `fieldBox`) so the
 * skeleton → real-field swap doesn't jump. */
function FieldSkeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "h-8 w-full min-w-0 animate-pulse rounded-lg border border-input bg-input/30",
        className
      )}
    />
  );
}

export function DatePicker(props: DatePickerProps) {
  return (
    <Suspense fallback={<FieldSkeleton className={props.className} />}>
      <LazyDatePicker {...props} />
    </Suspense>
  );
}

export function DateTimePicker(props: DateTimePickerProps) {
  return (
    <Suspense fallback={<FieldSkeleton className={props.className} />}>
      <LazyDateTimePicker {...props} />
    </Suspense>
  );
}

export function TimePicker(props: TimePickerProps) {
  return (
    <Suspense fallback={<FieldSkeleton className={props.className} />}>
      <LazyTimePicker {...props} />
    </Suspense>
  );
}
