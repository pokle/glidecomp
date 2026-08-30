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
 * The behaviour, identical everywhere except where a caller opts into
 * `navigation` (see the bottom of this note):
 *
 * - STACKED (narrow), THE DETAIL IS PINNED. It is first in the DOM, sticks to
 *   the top of the viewport while any of the master is on screen, and
 *   releases with the master's last row — so a row picked at the bottom
 *   changes a detail that is right there. A "Hide <noun>" toggle folds the
 *   pane away for readers who only want the list; the page is the one scroll
 *   context (no inner scrollbox on the master — that was tried in #553 and
 *   one ordinary page scroll defeated it).
 * - SIDE BY SIDE (wide), the detail is the sticky right-hand column, pinned
 *   under the Shell's glass header, covering nothing. A drag handle sits in
 *   the gutter between the two — pointer and arrow keys — so the reader can
 *   give the list or the pane more of the row. The share is remembered per
 *   `detailLabel` (chart / map / diagram / …) and does not apply stacked:
 *   there the pane is either pinned or the whole view.
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
 *
 * ## `navigation`: one pane at a time, stacked
 *
 * A pinned pane is the right stacked answer when the detail is SMALL — a
 * map, a diagram — and the reader is really working the list. It is the
 * wrong answer when the detail is a page in its own right: the thermal
 * detail is a rose, five readouts, a climb profile and two tables, and the
 * ranking's chart is a scatter, a distribution and the metric's method
 * behind a disclosure — no cap that leaves the list usable leaves those
 * readable.
 *
 * So a caller may pass `navigation` and get the phone behaviour people expect
 * of a master/detail: stacked shows the LIST alone, choosing a row shows the
 * DETAIL alone with a back control, and — because the caller keeps the
 * selection in the URL — the browser's own Back returns to the list. Wide is
 * untouched: both halves side by side, the detail the sticky right column.
 *
 * Which of the two is showing is the caller's `showingDetail`, derived from
 * the URL, so the server and the first client render always agree. The
 * hiding is done by the same `@5xl` container query as the split, never by a
 * measured width — the two can then never disagree about the breakpoint.
 * `onWideChange` reports that same breakpoint back (a ResizeObserver on the
 * container), for the ONE decision CSS cannot make: whether choosing a row is
 * a navigation that pushes history (stacked) or just a change of view (side
 * by side). It must not decide anything that is rendered.
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { ArrowLeftIcon } from "lucide-react";
import { Button } from "@/react/rac/button";
import { cn } from "@/react/lib/utils";
import {
  DEFAULT_MASTER_SHARE,
  MAX_MASTER_SHARE,
  MIN_MASTER_SHARE,
  SHARE_STEP,
  clampMasterShare,
  masterShareFromPointer,
  readStoredMasterShare,
  writeStoredMasterShare,
} from "./master-detail-split";

/** The `@5xl` container query above, in pixels, for `onWideChange`. */
const WIDE_PX = 64 * 16;

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
  defaultMasterShare = DEFAULT_MASTER_SHARE,
  paneWidthClassName = "mx-auto max-w-[35rem] @5xl:max-w-none",
  paneClassName,
  hideDetailInPrint = false,
  navigation,
  onWideChange,
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
  /** Side-by-side list share before the reader drags, 0–1. Default 5/8
   * (the old 5fr/3fr). Waypoints pass ½ so the map and table start even. */
  defaultMasterShare?: number;
  /** Width classes shared by the pane and its toggle row. The default caps a
   * stacked pane at the width past which a 560-unit chart is only magnified;
   * pass e.g. "w-full" for content that wants the whole line (a map). */
  paneWidthClassName?: string;
  /** Extra classes on the pane region (rarely needed). */
  paneClassName?: string;
  /** Hide the pane on paper — for callers that print a fuller alternative. */
  hideDetailInPrint?: boolean;
  /** Opt the STACKED layout out of pinning and into one-pane-at-a-time (see
   * the file doc). The caller owns which one is showing — in the URL, so
   * Back is the way out of the detail — and this component only lays it out. */
  navigation?: {
    /** Stacked: is the detail the current view? Wide: ignored, both show. */
    showingDetail: boolean;
    /** The stacked-only back control's label, e.g. "All thermals". */
    backLabel: string;
    onBack: () => void;
  };
  /** Told, from a ResizeObserver, whether the layout is currently side by
   * side. For behaviour only — never for anything rendered (see file doc). */
  onWideChange?: (wide: boolean) => void;
}) {
  // Folded away only while stacked — side by side there is no screen to
  // reclaim, and the control that unfolds it is hidden. Owned here so it
  // survives the caller swapping the detail's content on a new selection.
  const [collapsed, setCollapsed] = useState(false);
  const detailId = useId();
  const masterId = useId();
  const [masterShare, setMasterShare] = useState(() =>
    clampMasterShare(defaultMasterShare)
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const paneWrapRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const masterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stored = readStoredMasterShare(detailLabel);
    if (stored != null) setMasterShare(stored);
  }, [detailLabel]);

  // The measured breakpoint. Held here as well as reported up because the
  // focus move below is stacked-only; it renders nothing, so the server and
  // the first client paint agree whatever it turns out to be.
  const [wide, setWide] = useState(false);
  // Latest callback without re-subscribing the observer on every render — a
  // caller passing an inline arrow must not cost a disconnect per keystroke.
  const wideCb = useRef(onWideChange);
  wideCb.current = onWideChange;
  // Reported separately from the state so the notification is a plain effect
  // of the observation, not a side effect inside a state updater (which
  // StrictMode would run twice).
  const wideRef = useRef<boolean | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const next = (entries[0]?.contentRect.width ?? 0) >= WIDE_PX;
      if (next === wideRef.current) return;
      wideRef.current = next;
      setWide(next);
      wideCb.current?.(next);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Stacked, swapping list for detail is a NAVIGATION: focus has to travel
  // with it or a keyboard reader is left pointing at a node that is now
  // `display: none`. Arriving, the page is scrolled to the pane's WRAPPER
  // rather than the pane — the way back out sits just above it, and landing
  // with it already off the top of the screen is the one thing this layout
  // must not do. Going back moves focus without scrolling at all: the
  // browser has just restored the list's own scroll position on popstate,
  // and stealing it to the top would undo that.
  const showingDetail = navigation?.showingDetail ?? false;
  const prevShowing = useRef(showingDetail);
  useEffect(() => {
    if (!navigation) return;
    if (showingDetail === prevShowing.current) return;
    prevShowing.current = showingDetail;
    if (wide) return;
    if (showingDetail) {
      paneWrapRef.current?.scrollIntoView({ block: "start" });
      paneRef.current?.focus({ preventScroll: true });
    } else masterRef.current?.focus({ preventScroll: true });
    // `navigation` is a fresh object every render; its showingDetail is the
    // only part this effect reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showingDetail, wide]);

  if (detail === null) return <>{master}</>;

  return (
    <div ref={containerRef} className="@container">
      <div
        ref={gridRef}
        className="@5xl:grid @5xl:items-start print:block"
        style={{
          // Ignored while stacked (the box is not a grid). Side by side the
          // handle is the middle `auto` column, replacing the old gap-6.
          gridTemplateColumns: `minmax(0, ${masterShare}fr) auto minmax(0, ${1 - masterShare}fr)`,
        }}
      >
        <div
          ref={paneWrapRef}
          className={cn(
            navigation
              ? cn(
                  // Stacked there is nothing to pin against: the pane IS the
                  // view, and the page scrolls it. Hidden while the list is
                  // the view — by the same container query as the split, so
                  // the two can never disagree about the breakpoint.
                  "@5xl:sticky @5xl:z-10",
                  // Clearing whatever owns the top of the viewport, for the
                  // scrollIntoView above — the same thing STACKED_TOP names,
                  // and it is nothing at all on a phone.
                  "scroll-mt-20 max-sm:scroll-mt-2 [@media(max-height:500px)]:scroll-mt-2",
                  // `print:block` because paper is not a phone: the page
                  // prints whole, both halves, whichever one is on screen.
                  !showingDetail && "hidden @5xl:block print:block"
                )
              : cn(
                  // Stacked, the pane pins to the top and the master pages
                  // beneath it, covered edge to edge by the bleed surface.
                  "sticky z-10 pb-3",
                  STACKED_TOP[stackedTop],
                  BLEED[bleed],
                  "@5xl:mx-0 @5xl:bg-transparent @5xl:px-0 @5xl:pb-0"
                ),
            // Side by side it becomes the sticky right-hand column, where it
            // pins against the Shell's 60px glass header and covers nothing.
            // order-3: list, handle, pane.
            "@5xl:top-20 @5xl:order-3",
            // Paper has no viewport to pin to.
            "print:static print:z-auto print:m-0 print:bg-transparent print:p-0",
            hideDetailInPrint && "print:hidden"
          )}
        >
          <div
            className={cn(
              "flex pb-1 @5xl:hidden print:hidden",
              navigation ? "justify-start pb-2" : "justify-end",
              paneWidthClassName
            )}
          >
            {navigation ? (
              <Button variant="outline" size="sm" onPress={navigation.onBack}>
                <ArrowLeftIcon className="size-4" />
                {navigation.backLabel}
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={!collapsed}
                aria-controls={detailId}
                onPress={() => setCollapsed(!collapsed)}
              >
                {collapsed ? `Show ${detailLabel}` : `Hide ${detailLabel}`}
              </Button>
            )}
          </div>
          <div
            id={detailId}
            ref={paneRef}
            // A region, not a bare div: it is read before the master it
            // belongs to, so it has to say what it is. tabIndex makes the
            // capped, scrollable box reachable without a mouse (WCAG 2.1.1),
            // and is where focus lands on a stacked navigation.
            role="region"
            aria-labelledby={detailHeadingId}
            aria-label={detailAriaLabel}
            tabIndex={0}
            className={cn(
              "rounded-lg border bg-card outline-none",
              paneWidthClassName,
              navigation
                ? // Stacked the pane is the whole view, so it takes the page's
                  // scroll rather than a cap of its own; the cap comes back
                  // with the side-by-side column.
                  "@5xl:max-h-[calc(100vh-7rem)] @5xl:overflow-y-auto"
                : "overflow-y-auto max-h-[19rem] sm:max-h-[23rem] @5xl:max-h-[calc(100vh-7rem)]",
              "focus-visible:ring-2 focus-visible:ring-ring/50",
              "print:max-h-none print:overflow-visible",
              !navigation && collapsed && "hidden @5xl:block",
              paneClassName
            )}
          >
            {detail}
          </div>
        </div>
        <SplitHandle
          share={masterShare}
          detailLabel={detailLabel}
          detailId={detailId}
          masterId={masterId}
          gridRef={gridRef}
          onShareChange={(next) => {
            setMasterShare(next);
            writeStoredMasterShare(detailLabel, next);
          }}
          onReset={() => {
            const next = clampMasterShare(defaultMasterShare);
            setMasterShare(next);
            writeStoredMasterShare(detailLabel, next);
          }}
        />
        <div
          id={masterId}
          ref={masterRef}
          // Focus target for the way back out of a stacked detail. -1 keeps it
          // out of the tab order: it is a destination, not a stop.
          tabIndex={navigation ? -1 : undefined}
          className={cn(
            "min-w-0 outline-none @5xl:order-1",
            navigation
              ? showingDetail && "hidden @5xl:block print:block"
              : cn(
                  // Focus must not stop behind the pinned pane (WCAG 2.4.11).
                  // Its stacked height is a constant cap, so its bottom edge
                  // is a constant too: 60px sticky offset + the ~2.25rem
                  // toggle row + the pane's 19rem (sm: 23rem) cap + its pb-3.
                  // Rows AND cells, because RAC's grid navigation scrolls
                  // whichever it moved focus to. Folded, only the toggle row
                  // is stuck, so the clearance shrinks with it rather than
                  // shoving rows mid-screen.
                  collapsed
                    ? "[&_tr]:scroll-mt-28 [&_td]:scroll-mt-28 [&_th]:scroll-mt-28"
                    : cn(
                        "[&_tr]:scroll-mt-[26rem] [&_td]:scroll-mt-[26rem] [&_th]:scroll-mt-[26rem]",
                        "sm:[&_tr]:scroll-mt-[30rem] sm:[&_td]:scroll-mt-[30rem] sm:[&_th]:scroll-mt-[30rem]"
                      )
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

/**
 * The gutter between list and pane. Hidden stacked and on paper; side by
 * side it is a full-height hit target with a grip that stays on screen as
 * the list scrolls (sticky under the shell). Window-splitter pattern:
 * role=separator, arrows move it, Home/End the stops, double-click resets.
 */
function SplitHandle({
  share,
  detailLabel,
  detailId,
  masterId,
  gridRef,
  onShareChange,
  onReset,
}: {
  share: number;
  detailLabel: string;
  detailId: string;
  masterId: string;
  gridRef: RefObject<HTMLDivElement | null>;
  onShareChange: (share: number) => void;
  onReset: () => void;
}) {
  const dragging = useRef(false);
  const [active, setActive] = useState(false);

  const applyPointer = (clientX: number, handle: HTMLElement) => {
    const grid = gridRef.current;
    if (!grid) return;
    onShareChange(
      masterShareFromPointer(
        clientX,
        grid.getBoundingClientRect(),
        handle.getBoundingClientRect().width
      )
    );
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging.current = true;
    setActive(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    applyPointer(e.clientX, e.currentTarget);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    setActive(false);
    applyPointer(e.clientX, e.currentTarget);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = share - SHARE_STEP;
    else if (e.key === "ArrowRight") next = share + SHARE_STEP;
    else if (e.key === "Home") next = MIN_MASTER_SHARE;
    else if (e.key === "End") next = MAX_MASTER_SHARE;
    if (next == null) return;
    e.preventDefault();
    onShareChange(clampMasterShare(next));
  };

  const listPct = Math.round(share * 100);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize list and ${detailLabel}`}
      aria-controls={`${masterId} ${detailId}`}
      aria-valuemin={Math.round(MIN_MASTER_SHARE * 100)}
      aria-valuemax={Math.round(MAX_MASTER_SHARE * 100)}
      aria-valuenow={listPct}
      aria-valuetext={`${listPct} percent list, ${100 - listPct} percent ${detailLabel}`}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      className={cn(
        "group relative z-20 hidden w-7 cursor-col-resize touch-none select-none self-stretch",
        "@5xl:flex @5xl:order-2 print:hidden",
        "pointer-coarse:w-11",
        "justify-center outline-none",
        "hover:bg-muted/60 focus-visible:bg-muted/60",
        "focus-visible:ring-2 focus-visible:ring-ring/50"
      )}
    >
      {/* Seam down the whole row so the split is visible even when the
          grip has stuck away from the pointer. */}
      <div
        aria-hidden
        className={cn(
          "absolute inset-y-2 left-1/2 w-1 -translate-x-1/2 rounded-full bg-muted-foreground/35",
          "group-hover:bg-foreground/50 group-focus-visible:bg-ring",
          active && "bg-foreground/60"
        )}
      />
      {/* Grip stays under the header as the list scrolls, so the handle
          does not vanish into a 2000px table. */}
      <div
        aria-hidden
        className={cn(
          "sticky top-40 z-10 flex h-12 w-6 flex-col items-center justify-center gap-0.5 rounded-md border-2 border-border bg-muted shadow-sm",
          "group-hover:border-foreground/40 group-focus-visible:border-ring",
          active && "border-foreground/50"
        )}
      >
        <span className="grid grid-cols-2 gap-0.5">
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} className="size-1 rounded-full bg-foreground/70" />
          ))}
        </span>
      </div>
    </div>
  );
}
