/**
 * MasterDetail — the app's one master/detail layout (issue #455, generalised).
 *
 * A list (the MASTER) paired with the one thing it selects, locates or
 * highlights (the DETAIL): the separation ranking and its metric chart, the
 * thermal census and its rose, the waypoint table and its map, the turnpoint
 * list and its route diagram. Before this component each of those laid the
 * pair out its own way, and on a phone three of the four let the detail
 * scroll away — so acting on a row updated something off screen.
 *
 * The behaviour, identical everywhere:
 *
 * - STACKED (narrow), THE DETAIL IS PINNED. It is first in the DOM, sticks to
 *   the top of the viewport while any of the master is on screen, and
 *   releases with the master's last row — so a row picked at the bottom
 *   changes a detail that is right there. A "Hide <noun>" toggle folds the
 *   pane away for readers who only want the list; the page is the one scroll
 *   context (no inner scrollbox on the master — that was tried in #553 and
 *   one ordinary page scroll defeated it).
 * - SIDE BY SIDE (wide), the detail is the sticky right-hand column, pinned
 *   under the Shell's glass header, covering nothing.
 *
 * Pinning is why the stacked layout is BLOCK flow with grid applied only at
 * the wide breakpoint: as a single-column grid item the pane's containing
 * block would be its own grid row, and `position: sticky` could never carry
 * it over the master below.
 *
 * The pinned pane owes two debts, owed knowingly (see #553, which removed an
 * earlier pinned design over them): scroll-margin constants sized to the
 * pane's stuck footprint keep keyboard-focused rows from stopping behind it
 * (WCAG 2.4.11), and its buttons must stay hit-testable inside a padded
 * ancestor while stuck — a Chromium regression the task-analysis e2e guards
 * by clicking Expand mid-scroll.
 *
 * The split is a CONTAINER query (`@5xl`), not `lg:`, because the width a
 * section gets is not a function of the viewport alone — rails, cards and
 * page measures all intervene. 64rem is the smallest container that leaves
 * the widest master (the ranking table) its min-content beside a useful pane.
 *
 * Sticky offsets are dictated by whatever owns the top of the viewport, which
 * is why `stackedTop` exists. Today that is always the Shell's 60px glass
 * header — which is `static` under `sm` and on short viewports, where the pane
 * pins to the very top instead. The task-analysis pages used to carry a fixed
 * table-of-contents bar above it and needed their own offset; the report is a
 * page per section now, and small enough to need no rail.
 */
import { useId, useState, type ReactNode } from "react";
import { Button } from "@/react/rac/button";
import { cn } from "@/react/lib/utils";

/** What owns the top of the viewport while stacked (see file doc). */
const STACKED_TOP = {
  /** The Shell header — static under sm and on short viewports, so the pane
   * pins flush to the top there. */
  header: "top-[60px] max-sm:top-0 [@media(max-height:500px)]:top-0",
} as const;

/**
 * Full-bleed classes for the stuck pane: it must cover rows edge to edge as
 * they pass under it, so it cancels and re-applies the horizontal padding of
 * whatever surface it lives on, and paints that surface's own background.
 */
const BLEED = {
  /** Inside a `Card` (p-5). */
  card: "-mx-5 bg-card px-5",
  /** Directly on a page main (px-4 sm:px-6). */
  page: "-mx-4 bg-background px-4 sm:-mx-6 sm:px-6",
} as const;

export function MasterDetail({
  master,
  detail,
  detailLabel,
  detailHeadingId,
  detailAriaLabel,
  stackedTop = "header",
  bleed = "card",
  wideCols = "@5xl:grid-cols-[minmax(0,5fr)_minmax(0,3fr)]",
  paneWidthClassName = "mx-auto max-w-[35rem] @5xl:max-w-none",
  paneClassName,
  hideDetailInPrint = false,
}: {
  master: ReactNode;
  /** null renders the master alone (no pane, no toggle, no scroll margins). */
  detail: ReactNode;
  /** The noun on the fold toggle: "Hide chart" / "Show map" / "Hide diagram". */
  detailLabel: string;
  /** id of a heading INSIDE the detail, for the region's aria-labelledby.
   * Provide this or `detailAriaLabel` — the pane is read before the master
   * it belongs to, so it has to say what it is. */
  detailHeadingId?: string;
  /** aria-label for the region when the detail carries no heading. */
  detailAriaLabel?: string;
  stackedTop?: keyof typeof STACKED_TOP;
  bleed?: keyof typeof BLEED;
  /** The wide grid template, as a LITERAL `@5xl:grid-cols-[…]` class (the
   * Tailwind scanner must see it in source). Master is column 1, detail 2. */
  wideCols?: string;
  /** Width classes shared by the pane and its toggle row. The default caps a
   * stacked pane at the width past which a 560-unit chart is only magnified;
   * pass e.g. "w-full" for content that wants the whole line (a map). */
  paneWidthClassName?: string;
  /** Extra classes on the pane region (rarely needed). */
  paneClassName?: string;
  /** Hide the pane on paper — for callers that print a fuller alternative. */
  hideDetailInPrint?: boolean;
}) {
  // Folded away only while stacked — side by side there is no screen to
  // reclaim, and the control that unfolds it is hidden. Owned here so it
  // survives the caller swapping the detail's content on a new selection.
  const [collapsed, setCollapsed] = useState(false);
  const detailId = useId();

  if (detail === null) return <>{master}</>;

  return (
    <div className="@container">
      <div className={cn("@5xl:grid @5xl:items-start @5xl:gap-6 print:block", wideCols)}>
        <div
          className={cn(
            // Stacked, the pane pins to the top and the master pages beneath
            // it, covered edge to edge by the bleed surface.
            "sticky z-10 pb-3",
            STACKED_TOP[stackedTop],
            BLEED[bleed],
            // Side by side it becomes the sticky right-hand column, where it
            // pins against the Shell's 60px glass header and covers nothing.
            "@5xl:top-20 @5xl:order-2 @5xl:mx-0 @5xl:bg-transparent @5xl:px-0 @5xl:pb-0",
            // Paper has no viewport to pin to.
            "print:static print:z-auto print:m-0 print:bg-transparent print:p-0",
            hideDetailInPrint && "print:hidden"
          )}
        >
          <div
            className={cn(
              "flex justify-end pb-1 @5xl:hidden print:hidden",
              paneWidthClassName
            )}
          >
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={!collapsed}
              aria-controls={detailId}
              onPress={() => setCollapsed(!collapsed)}
            >
              {collapsed ? `Show ${detailLabel}` : `Hide ${detailLabel}`}
            </Button>
          </div>
          <div
            id={detailId}
            // A region, not a bare div: it is read before the master it
            // belongs to, so it has to say what it is. tabIndex makes the
            // capped, scrollable box reachable without a mouse (WCAG 2.1.1).
            role="region"
            aria-labelledby={detailHeadingId}
            aria-label={detailAriaLabel}
            tabIndex={0}
            className={cn(
              "overflow-y-auto rounded-lg border bg-card outline-none",
              paneWidthClassName,
              "max-h-[19rem] sm:max-h-[23rem] @5xl:max-h-[calc(100vh-7rem)]",
              "focus-visible:ring-2 focus-visible:ring-ring/50",
              "print:max-h-none print:overflow-visible",
              collapsed && "hidden @5xl:block",
              paneClassName
            )}
          >
            {detail}
          </div>
        </div>
        <div
          className={cn(
            "min-w-0 @5xl:order-1",
            // Focus must not stop behind the pinned pane (WCAG 2.4.11). Its
            // stacked height is a constant cap, so its bottom edge is a
            // constant too: 60px sticky offset + the ~2.25rem toggle row +
            // the pane's 19rem (sm: 23rem) cap + its pb-3. Rows AND cells,
            // because RAC's grid navigation scrolls whichever it moved focus
            // to. Folded, only the toggle row is stuck, so the clearance
            // shrinks with it rather than shoving rows mid-screen.
            collapsed
              ? "[&_tr]:scroll-mt-28 [&_td]:scroll-mt-28 [&_th]:scroll-mt-28"
              : cn(
                  "[&_tr]:scroll-mt-[26rem] [&_td]:scroll-mt-[26rem] [&_th]:scroll-mt-[26rem]",
                  "sm:[&_tr]:scroll-mt-[30rem] sm:[&_td]:scroll-mt-[30rem] sm:[&_th]:scroll-mt-[30rem]"
                ),
            // Side by side the pane is a column that covers nothing, but a
            // focused row still has to clear the Shell's glass header.
            "@5xl:[&_tr]:scroll-mt-24 @5xl:[&_td]:scroll-mt-24 @5xl:[&_th]:scroll-mt-24"
          )}
        >
          {master}
        </div>
      </div>
    </div>
  );
}
