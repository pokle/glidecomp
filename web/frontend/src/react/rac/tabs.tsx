/**
 * React Aria Components Tabs, styled to match the shadcn kit they replaced
 * (default variant, horizontal). RAC wires the ARIA tabs pattern — roving-tabindex arrow-key
 * navigation, automatic selection on focus, and panel association — and only
 * the selected TabPanel renders its content.
 *
 * Controlled usage mirrors the old value/onValueChange with RAC's
 * selectedKey/onSelectionChange; Tab and TabPanel pair up by `id`.
 *
 * The tab strip scrolls sideways when it is wider than its container (the
 * scores page's views overflowed a phone while every class was a tab of its
 * own — issue #640 — and four views still do at 320 px), with a fade at
 * whichever end still has tabs behind it.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  Tabs as AriaTabs,
  TabList as AriaTabList,
  Tab as AriaTab,
  TabPanel as AriaTabPanel,
  TabListStateContext,
  type TabsProps,
  type TabListProps,
  type TabProps,
  type TabPanelProps,
} from "react-aria-components";

import { cn } from "@/react/lib/utils";

/** Set under the kit `Tabs`, so its two render passes can be told apart. */
const InsideTabsContext = createContext(false);

export function Tabs({
  className,
  children,
  ...props
}: Omit<TabsProps, "className" | "children"> & {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <AriaTabs className={cn("flex flex-col gap-2", className)} {...props}>
      <InsideTabsContext.Provider value={true}>{children}</InsideTabsContext.Provider>
    </AriaTabs>
  );
}

/**
 * True in the pass RAC renders only to collect the tabs (see `TabsContent`):
 * inside the kit `Tabs`, with no tab list state yet. The page bar asks, so
 * that in that pass it renders its tab strip and nothing else. On the server
 * the pass is real markup, in a `<template>`, and it held a second `<h1>`.
 */
export function useTabsCollectionPass(): boolean {
  const inside = useContext(InsideTabsContext);
  const state = useContext(TabListStateContext);
  return inside && state === null;
}

/**
 * Which ends of the strip still have tabs behind them. Recomputed on scroll,
 * on resize, and after every render — a tab added or removed (classes arrive
 * with the scores) changes `scrollWidth` without resizing the strip itself,
 * so a ResizeObserver alone would miss it. Returning the previous object when
 * nothing changed keeps the after-every-render measure from looping.
 */
function useOverflowFades(ref: React.RefObject<HTMLDivElement | null>) {
  const [fades, setFades] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // 1px slack: sub-pixel widths make a strip that cannot scroll report a
    // fraction of a pixel of overflow, which would fade an end forever.
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft < el.scrollWidth - el.clientWidth - 1;
    setFades((prev) =>
      prev.start === start && prev.end === end ? prev : { start, end }
    );
  }, [ref]);

  useEffect(measure);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.addEventListener("scroll", measure, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [measure, ref]);

  return fades;
}

/**
 * Keeps the selected tab on screen. Focus already drags the strip along for
 * arrow-key navigation, but a selection made anywhere else does not — a
 * ?task= deep link opens "Scores by task", the last tab of the widest strip
 * we have, and without this the phone shows a row with nothing selected in it.
 */
function useSelectedTabInView(ref: React.RefObject<HTMLDivElement | null>) {
  const state = useContext(TabListStateContext);
  const selectedKey = state?.selectedKey;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const selected = el.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!selected) return;
    const strip = el.getBoundingClientRect();
    const tab = selected.getBoundingClientRect();
    // Clear the 3px pill padding as well, so a tab never sits flush against
    // the fade that says there is more behind it.
    const gutter = 3;
    if (tab.left < strip.left + gutter) {
      el.scrollLeft -= strip.left + gutter - tab.left;
    } else if (tab.right > strip.right - gutter) {
      el.scrollLeft += tab.right - (strip.right - gutter);
    }
  }, [selectedKey, ref]);
}

export function TabList<T extends object>({
  className,
  ...props
}: Omit<TabListProps<T>, "className"> & { className?: string }) {
  const listRef = useRef<HTMLDivElement>(null);
  const fades = useOverflowFades(listRef);
  useSelectedTabInView(listRef);

  return (
    // min-w-0 so the strip can shrink when it is a flex item (Dashboard puts
    // an action button beside it) rather than pushing the row wide.
    <div className="relative w-fit min-w-0 max-w-full">
      <AriaTabList
        ref={listRef}
        className={cn(
          // justify-start, not justify-center: the strip is w-fit, so centring
          // only ever applies once it overflows — and centred overflow spills
          // equally off BOTH ends, putting the first tab behind a scroll
          // origin that scrollLeft can never reach.
          "inline-flex h-8 w-fit max-w-full items-center justify-start rounded-lg bg-muted p-[3px] text-muted-foreground pointer-coarse:h-[3.1875rem]",
          // The scrollbar is hidden because it would eat half of an h-8 pill
          // on platforms that reserve space for one; the fades below and the
          // clipped tab edge are the affordance instead.
          "overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          className
        )}
        {...props}
      />
      {/* Purely decorative: what is behind them is reachable by swiping, by
          arrow keys (RAC scrolls the focused tab into view), and by the
          scroll wheel. No tabIndex — unlike rac/table's scrollLabel region,
          every item in this scroller is itself a tab stop, so a second stop
          would add nothing for WCAG 2.1.1 and one more Tab press for all. */}
      {fades.start ? (
        <div
          aria-hidden="true"
          data-tab-fade="start"
          className="pointer-events-none absolute inset-y-0 left-0 w-6 rounded-l-lg bg-linear-to-r from-muted to-muted/0"
        />
      ) : null}
      {fades.end ? (
        <div
          aria-hidden="true"
          data-tab-fade="end"
          className="pointer-events-none absolute inset-y-0 right-0 w-6 rounded-r-lg bg-linear-to-l from-muted to-muted/0"
        />
      ) : null}
    </div>
  );
}

export function Tab({
  className,
  ...props
}: Omit<TabProps, "className"> & { className?: string }) {
  return (
    <AriaTab
      className={cn(
        // An unselected label is `text-muted-foreground` in both themes. In
        // light it was the foreground at 60% opacity, 4.16:1 on the strip's
        // --muted, under the 4.5:1 that text needs. accent-text.test.ts
        // measures any text dimmed by opacity now.
        "relative inline-flex h-[calc(100%-1px)] flex-1 cursor-default items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-all outline-none select-none pointer-coarse:px-5 pointer-coarse:text-base",
        "data-hovered:text-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
        "data-focus-visible:border-ring data-focus-visible:ring-3 data-focus-visible:ring-ring/50",
        "data-selected:bg-background data-selected:text-foreground data-selected:shadow-sm dark:data-selected:border-input dark:data-selected:bg-input/30 dark:data-selected:text-foreground",
        className
      )}
      {...props}
    />
  );
}

export function TabPanel({
  className,
  ...props
}: Omit<TabPanelProps, "className"> & { className?: string }) {
  return (
    <AriaTabPanel
      className={cn(
        // `text-base`: a panel holds the page's content, so it carries the
        // page's body size (issue #704). The Tab LABELS above stay `text-sm` —
        // a segmented control's label is a control label, not body, and the
        // strip is only h-8 tall.
        "flex-1 text-base outline-none data-focus-visible:ring-2 data-focus-visible:ring-ring/50",
        className as string
      )}
      {...props}
    />
  );
}

/**
 * Whatever is inside `<Tabs>` that is neither the tab list nor a panel: the
 * rest of a page whose tab strip is the page bar's second layer, so that
 * `Tabs` has to wrap the whole page (rac/page-bar.tsx, `below`).
 *
 * RAC renders the children of `Tabs` TWICE: once in a hidden tree, only to
 * collect the tabs, and once for real. A `Tab` and a `TabPanel` know to do
 * nothing in the hidden pass; ordinary content does not, so it mounted twice,
 * ran its effects twice (a freshness poll, a fetch) and portalled a second
 * copy of any open dialog into the document. This renders its children in the
 * real pass only. The tab list's state exists only there, which is how the
 * two passes are told apart with nothing but RAC's public API.
 */
export function TabsContent({ children }: { children: React.ReactNode }) {
  return useTabsCollectionPass() ? null : <>{children}</>;
}
