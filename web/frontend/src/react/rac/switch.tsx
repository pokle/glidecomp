/**
 * Switch — an on/off setting as a phone-style row: label (and its hint) on
 * the left, the control on the RIGHT, with the whole row as the target.
 *
 * The kit's `checkbox` is a 16px box that leads its label — right for a dense
 * dialog or a list of task classes, wrong for a settings page, where every
 * other row (`nav-list`, `choice-list`) puts its status on the right and gives
 * you 44px to hit. This is the boolean member of that family.
 *
 * Built on RAC's Switch, so the control is a real focusable input with
 * `role="switch"` and `aria-checked` — semantically an on/off setting rather
 * than a form checkbox, which is what these actually are. RAC wraps the whole
 * row in a `<label>`, so tapping the text toggles it, and the hint stays part
 * of the accessible name exactly as `rac/checkbox` already does it.
 *
 * `SwitchList` groups consecutive rows onto one card with dividers, the way a
 * phone's settings app does. Dialogs keep `rac/checkbox`.
 */
import { Switch as AriaSwitch, type SwitchProps } from "react-aria-components";

import { cn } from "@/react/lib/utils";
import { cardSurface } from "./card";

/** The track + thumb. Kept here so a row and a bare Switch cannot drift. */
function SwitchTrack({ isSelected }: { isSelected: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors",
        "group-data-focus-visible:ring-2 group-data-focus-visible:ring-ring/50 group-data-focus-visible:ring-offset-2",
        isSelected ? "bg-primary" : "bg-input dark:bg-input/60"
      )}
    >
      <span
        className={cn(
          "size-5 rounded-full bg-background shadow-sm transition-transform",
          isSelected && "translate-x-5"
        )}
      />
    </span>
  );
}

export function SwitchField({
  checked,
  onChange,
  label,
  hint,
  className,
  ...props
}: Omit<SwitchProps, "className" | "children" | "isSelected" | "onChange"> & {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: React.ReactNode;
  /** Muted helper line under the label. */
  hint?: React.ReactNode;
  className?: string;
}) {
  return (
    <AriaSwitch
      isSelected={checked}
      onChange={onChange}
      className={cn(
        "group flex min-h-11 w-full cursor-default items-center gap-3 px-4 py-2.5 text-left text-sm outline-none",
        "data-hovered:bg-muted/50 data-pressed:bg-muted data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      {({ isSelected }) => (
        <>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span>{label}</span>
            {hint ? (
              <span className="text-xs text-muted-foreground">{hint}</span>
            ) : null}
          </span>
          <SwitchTrack isSelected={isSelected} />
        </>
      )}
    </AriaSwitch>
  );
}

/** Consecutive switch rows on one card, divided — the settings-app grouping. */
export function SwitchList({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        cardSurface,
        "divide-y divide-border overflow-hidden",
        className
      )}
    >
      {children}
    </div>
  );
}
