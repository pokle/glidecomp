/**
 * SegmentedControl — two to five mutually exclusive VIEWS of the same
 * content, the control Apple's HIG gives that job (a pilot class over an
 * analysis report). It is not tabs: nothing here owns a panel, the page
 * underneath simply reads differently. And it is not a select: every option
 * is on screen, one tap away, which is the point of it on a phone.
 *
 * Built on RAC `ToggleButtonGroup` in single, non-empty selection, so a
 * screen reader hears a radio group and arrow keys move between options.
 * Drawn as the kit's tab strip is (rac/tabs.tsx), so the two read as one
 * family; each segment is 44 px or more at every pointer, because it lives in
 * the page bar's second layer and every control there is 44 px (docs/interaction-guide.md,
 * the page bar).
 *
 * Full width by default — on a phone each segment is then as wide as it can
 * be — and `className="sm:w-fit"` or similar narrows it where there is room.
 * Past five options it stops being glanceable: use a select instead.
 */
import {
  ToggleButtonGroup,
  ToggleButton,
  type Key,
} from "react-aria-components";
import { cn } from "@/react/lib/utils";

export function SegmentedControl({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <ToggleButtonGroup
      aria-label={ariaLabel}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[value]}
      onSelectionChange={(keys: Set<Key>) => {
        const [next] = keys;
        if (next !== undefined && String(next) !== value) onChange(String(next));
      }}
      className={cn(
        // 51 px with the 3 px pill padding, so each SEGMENT — the thing a
        // finger hits — is 45 px; the tab strip's coarse-pointer height.
        "flex h-[3.1875rem] w-full min-w-0 items-stretch rounded-lg bg-muted p-[3px] text-muted-foreground",
        className
      )}
    >
      {options.map((o) => (
        <ToggleButton
          key={o.value}
          id={o.value}
          className={cn(
            // An unselected label is `text-muted-foreground`, as on a tab: the
            // 4.5:1 that opacity could not reach on --muted (rac/tabs.tsx).
            "inline-flex min-w-0 flex-1 cursor-default items-center justify-center rounded-md border border-transparent px-3 text-sm font-medium outline-none select-none pointer-coarse:text-base",
            "data-hovered:text-foreground",
            "data-focus-visible:border-ring data-focus-visible:ring-3 data-focus-visible:ring-ring/50",
            "data-selected:bg-background data-selected:text-foreground data-selected:shadow-sm dark:data-selected:border-input dark:data-selected:bg-input/30"
          )}
        >
          <span className="truncate">{o.label}</span>
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
