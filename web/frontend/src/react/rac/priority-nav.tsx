/**
 * PriorityNav — a navigation row that never wraps: the links that fit stay in
 * the row, the rest collapse into a "More" menu at its end (the "priority
 * plus" pattern, issue #639).
 *
 * It replaces `flex-wrap`, which turned the app header into two lines and the
 * competition page's section bar into three on a phone — a sticky block eating
 * a third of the viewport before the page itself started.
 *
 * How it decides, and why the decision is stable:
 *
 *  - The row is `overflow-hidden` and never wraps, so a link that does not fit
 *    is clipped rather than pushed onto a second line. The page itself still
 *    never scrolls sideways (WCAG 1.4.10 reflow).
 *  - A link that does not fit is hidden with `visibility`, NOT `display`, so it
 *    KEEPS its space. That is the whole trick: hiding a link cannot move the
 *    ones before it, so the measurement never depends on its own result —
 *    no oscillation, and no cached widths to go stale when a label changes.
 *    `visibility: hidden` also takes the link out of the tab order and out of
 *    the accessibility tree, so the clipped copy is not a second announcement
 *    of the menu entry.
 *  - The trigger is absolutely positioned, so it takes no part in the row's
 *    layout either. Its width is only RESERVED once something already
 *    overflows: reserving it unconditionally would collapse the last link of a
 *    row that fits with room to spare.
 *
 * SSR-safe: the first render puts every link in the row and the trigger out of
 * sight, which is what the server emits and what hydration matches — the
 * measure runs in an effect afterwards, and hides links that were clipped and
 * invisible anyway, so there is nothing to flash. The row is nowrap in the
 * markup rather than only after the effect, which is right for the SPA (it
 * needs JavaScript to render at all) and deliberately NOT what the static
 * pages' header does — see SiteHeader.astro, where the same behaviour is
 * applied by script so a no-JS visitor keeps the wrapping row.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "./button";
import { Menu, MenuItem, MenuTrigger } from "./menu";
import { cn } from "@/react/lib/utils";

export type PriorityNavItem = {
  /** Stable key. */
  id: string;
  /** Plain-text label for the overflow menu. */
  label: string;
  /** The row's own rendering — a NavLink, a Link, a plain `<a>`. */
  children: React.ReactNode;
  /** Where the overflow entry goes. Give this or `onAction`. */
  href?: string;
  /**
   * Used instead of `href` where a real navigation is the wrong answer: the
   * comp page's `#tasks` / `#activity` entries, which must scroll the reader
   * down the page they are already on. A routed href would hand the click to
   * react-router, which pushes a new entry and starts it at the top
   * (lib/scroll-restoration.ts) — the one thing an in-page anchor must not do.
   */
  onAction?: () => void;
  /** Marks the entry, and the trigger holding it, as the page being read. */
  isCurrent?: boolean;
};

const NOTHING_HIDDEN: ReadonlySet<string> = new Set();

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * Which items are clipped by the row's right edge, remeasured whenever
 * anything could have moved them.
 *
 * Returning the previous set when nothing changed is what keeps the
 * after-every-render measure from looping.
 */
function useClippedItems(
  rowRef: React.RefObject<HTMLDivElement | null>,
  triggerRef: React.RefObject<HTMLDivElement | null>,
  itemsKey: string
): ReadonlySet<string> {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(NOTHING_HIDDEN);

  const measure = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    const items = Array.from(
      row.querySelectorAll<HTMLElement>("[data-priority-item]")
    );
    const edge = row.getBoundingClientRect().right;
    // Half a pixel of slack: sub-pixel layout reports an item that fits
    // exactly as overflowing by a fraction, and the row would collapse a link
    // for nothing.
    const rightOf = (el: HTMLElement, limit: number) =>
      el.getBoundingClientRect().right > limit + 0.5;

    const next = new Set<string>();
    // Two passes, because the trigger's width is only worth reserving once
    // something is already clipped. A row that fits keeps every link and
    // renders no trigger at all.
    if (items.some((el) => rightOf(el, edge))) {
      const trigger = triggerRef.current;
      const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      const limit = edge - (trigger ? trigger.offsetWidth + gap : 0);
      for (const el of items) {
        if (rightOf(el, limit)) next.add(el.dataset.priorityItem ?? "");
      }
    }
    setHidden((prev) => (sameIds(prev, next) ? prev : next));
  }, [rowRef, triggerRef]);

  // After every render, not only on resize: a label can change width without
  // the row changing size at all ("Tasks (0)" → "Tasks (12)" once the comp
  // loads), and a ResizeObserver on the row alone would never see it.
  useEffect(measure);

  useEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    // The items too: a web font arriving re-widths every label without
    // rendering anything and without resizing the row.
    for (const el of row.querySelectorAll("[data-priority-item]")) {
      observer.observe(el);
    }
    return () => observer.disconnect();
    // itemsKey: an item appearing (the admin-only roster link) needs observing.
  }, [measure, rowRef, itemsKey]);

  return hidden;
}

export function PriorityNav({
  items,
  className,
  menuLabel,
}: {
  items: PriorityNavItem[];
  /** Applied to the row. Bring the gap — the measure reads `column-gap`. */
  className?: string;
  /**
   * The trigger's accessible name, and through it the menu's: RAC labels a
   * menu from its trigger with `aria-labelledby`, which wins over any
   * `aria-label` put on the menu itself. So this is what tells one "More" from
   * another — the comp page carries two, the header's and the section bar's.
   * It must contain the visible "More" (WCAG 2.5.3, label in name).
   */
  menuLabel?: string;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const hidden = useClippedItems(
    rowRef,
    triggerRef,
    items.map((item) => item.id).join(" ")
  );
  const overflow = items.filter((item) => hidden.has(item.id));
  const holdsCurrent = overflow.some((item) => item.isCurrent);

  return (
    <div
      ref={rowRef}
      className={cn("relative flex min-w-0 items-center overflow-hidden", className)}
    >
      {items.map((item) => (
        <span
          key={item.id}
          data-priority-item={item.id}
          className={cn("shrink-0", hidden.has(item.id) && "invisible")}
        >
          {item.children}
        </span>
      ))}
      <div
        ref={triggerRef}
        // The count is the assertion the e2e reads: how many links this bar
        // has folded away at the width it is being viewed at.
        data-priority-overflow={overflow.length}
        className={cn(
          "absolute inset-y-0 right-0 flex items-center",
          overflow.length === 0 && "invisible"
        )}
      >
        <MenuTrigger>
          <Button
            variant="ghost"
            size="sm"
            // `touch-target` rather than a bigger button: the trigger sits in a
            // bar whose height is set by the links beside it, and growing it
            // would set the bar's height instead (globals.css, issue #641).
            className={cn(
              "touch-target gap-1 px-2 text-sm font-medium text-muted-foreground",
              "data-hovered:text-foreground data-[current]:text-foreground"
            )}
            data-current={holdsCurrent || undefined}
            aria-label={menuLabel}
          >
            More
            <ChevronDownIcon aria-hidden="true" className="size-3.5" />
          </Button>
          <Menu placement="bottom end">
            {overflow.map((item) => (
              <MenuItem
                key={item.id}
                href={item.href}
                onAction={item.onAction}
                textValue={item.label}
                // The reader loses the row's active underline when the link
                // they are on folds away, so the menu carries the marking
                // instead. It is `data-current` and a visually hidden phrase
                // rather than `aria-current`: RAC filters an item's props
                // through `filterDOMProps`, which passes `data-*` and drops
                // every `aria-*` outside the labelling four — so an
                // `aria-current` here would reach neither the DOM nor AT, and
                // the marking would exist in ink alone.
                data-current={item.isCurrent || undefined}
                className="data-[current]:font-semibold data-[current]:text-foreground"
              >
                {item.label}
                {item.isCurrent ? <span className="sr-only"> (current page)</span> : null}
              </MenuItem>
            ))}
          </Menu>
        </MenuTrigger>
      </div>
    </div>
  );
}
