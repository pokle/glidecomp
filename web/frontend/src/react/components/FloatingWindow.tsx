/**
 * A detail that floats over the page on a phone, the way a video does in
 * picture-in-picture (owner's decisions, 28 November 2026;
 * docs/interaction-guide.md 2.8 holds the rule and this is its one owner).
 *
 * It replaces {@link MasterDetail}'s PINNED pane where a caller opts in. A
 * pinned map held half of a phone's screen for as long as the reader was in
 * its section, and the only way out was to hide it altogether. The window
 * covers a corner instead, and the reader decides which:
 *
 * - It is held by the GRABBER at its top (and, large, by its last row
 *   anywhere but a control). Dragged, it comes to rest in the nearest corner.
 *   It never stops in between, so there is nothing to tidy up.
 * - Dragged or flicked OFF A SIDE it is put away, leaving a tab on that edge.
 *   The tab brings it back.
 * - The button in its top right corner makes it LARGE or SMALL. The map is
 *   live at both sizes: a touch on the map moves the map.
 * - While the reader TYPES, it puts itself away, and comes back afterwards.
 *   That is how it stays clear of the on-screen keyboard without following
 *   the keyboard from script, which is what the fixed bars could not do.
 *
 * Every one of those has a control that is not a drag (guide 2.9, WCAG
 * 2.5.7): a tap on the grabber opens them as a menu, and the tab is a button.
 *
 * ## One detail, three places
 *
 * The detail is ONE subtree, rendered through a portal into one element the
 * hook owns (the HOST). The host is moved, never remounted, between:
 *
 * - the FLOW slot: the pane's place in the page, side by side;
 * - the WINDOW: straight after the page bar (`main > header`), where nothing
 *   above it is a containing block for `position: fixed`;
 * - the FULL slot: the detail's own page, at full size (guide 2.1: a figure
 *   at full size is a page with a URL, left with Back).
 *
 * So a map keeps its WebGL context, its camera and whatever was drawn on it
 * when the window changes size, when the screen is turned, and when the
 * reader opens the full-size page and comes back. That last one needs the
 * two routes to render the SAME component, with {@link FloatingContent} at
 * the same place in its tree: the router then keeps the instance.
 *
 * At rest the window is positioned by CSS alone: a corner is `top`/`bottom`
 * and `left`/`right`, with the safe-area insets. Script moves it only while
 * a finger is on it, and animates it to where the CSS already put it. So
 * Safari's moving toolbars, a rotation and a zoom need no listener.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  MapIcon,
  Maximize2Icon,
  PictureInPicture2Icon,
} from "lucide-react";
import { Menu, MenuItem } from "@/react/rac/menu";
import { cn } from "@/react/lib/utils";
import { readStoredCollapsed } from "./master-detail-split";
import {
  DEFAULT_FLOAT,
  DRAG_SLOP_PX,
  opensKeyboard,
  readStoredFloat,
  releaseVelocity,
  settle,
  writeStoredFloat,
  type FloatEdge,
  type FloatSide,
  type FloatState,
} from "./floating-window";

/**
 * Where the detail is and how the reader sees it: the window, small or
 * large; its tab, when put away; or the full-size page.
 */
export type FloatMode = "small" | "large" | "tucked" | "full";

type SlotKind = "flow" | "full";

/**
 * A floating detail's state, owned by the page so that it can lay the detail
 * out for where it is (`mode`) and bring the window back when the reader
 * asks the detail a question (`reveal`). From {@link useFloatingDetail}.
 */
export interface FloatingDetail {
  /** null while the detail is in the page's flow: side by side, on the
   * server, and until the layout has been measured. */
  mode: FloatMode | null;
  /** Bring a tucked window back. The reader asked to see something in it,
   * by pressing `pressed`: the window returns clear of it. */
  reveal: (pressed?: Element | null) => void;
  /** For MasterDetail, FloatSlot and FloatingContent. Not for pages. */
  internal: {
    state: FloatState;
    active: boolean;
    typing: boolean;
    host: HTMLDivElement | null;
    slots: Record<SlotKind, HTMLElement | null>;
    slotRef: Record<SlotKind, (el: HTMLElement | null) => void>;
    setActive: (active: boolean) => void;
    update: (next: FloatState) => void;
    /** Set by the window: called before a change it should animate. */
    beforeChange: { current: (() => void) | null };
  };
}

/**
 * `storageKey` is the one MasterDetail remembers this pane's fold under, so a
 * reader who had hidden the pinned pane meets the window already tucked.
 */
export function useFloatingDetail(storageKey: string): FloatingDetail {
  const [state, setState] = useState<FloatState>(DEFAULT_FLOAT);
  const [active, setActive] = useState(false);
  const [typing, setTyping] = useState(false);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [slots, setSlots] = useState<Record<SlotKind, HTMLElement | null>>({
    flow: null,
    full: null,
  });

  // The one element the detail lives in, wherever it is shown. In a layout
  // effect: the server and the first client render have no host and draw
  // nothing, and the detail arrives before the first paint.
  useLayoutEffect(() => {
    const node = document.createElement("div");
    setHost(node);
    return () => {
      node.remove();
      setHost(null);
    };
  }, []);

  const slotRef = useMemo(() => {
    const set = (kind: SlotKind) => (el: HTMLElement | null) =>
      setSlots((prev) => (prev[kind] === el ? prev : { ...prev, [kind]: el }));
    return { flow: set("flow"), full: set("full") };
  }, []);

  // In an effect, not an initialiser: there is no localStorage on the server.
  useEffect(() => {
    const stored = readStoredFloat(storageKey);
    if (stored) setState(stored);
    else if (readStoredCollapsed(storageKey)) {
      setState({ ...DEFAULT_FLOAT, tucked: true });
    }
  }, [storageKey]);

  const update = useCallback(
    (next: FloatState) => {
      setState(next);
      writeStoredFloat(storageKey, next);
    },
    [storageKey]
  );

  const stateRef = useRef(state);
  stateRef.current = state;
  const beforeChange = useRef<(() => void) | null>(null);
  const reveal = useCallback((pressed?: Element | null) => {
    const s = stateRef.current;
    if (!s.tucked) return;
    // Back as the small window, on the half of the screen the reader is not
    // looking at. The caller says what was pressed: focus does not, because
    // Safari does not focus a button that is tapped.
    const rect = pressed?.getBoundingClientRect() ?? null;
    const edge: FloatEdge = rect
      ? rect.top + rect.height / 2 < window.innerHeight / 2
        ? "bottom"
        : "top"
      : s.edge;
    beforeChange.current?.();
    update({ ...s, tucked: false, size: "small", edge });
  }, [update]);

  const floating = active && !slots.full;

  // Out of the keyboard's way. Only where a keyboard takes screen: with a
  // mouse and real keys, a map that left whenever a field was focused would
  // be a map that could not be read while searching.
  useEffect(() => {
    if (!floating) return;
    if (!window.matchMedia("(pointer: coarse)").matches) return;
    const onIn = (e: FocusEvent) => {
      if (opensKeyboard(e.target as HTMLElement | null)) setTyping(true);
    };
    const onOut = (e: FocusEvent) => {
      setTyping(opensKeyboard(e.relatedTarget as HTMLElement | null));
    };
    if (opensKeyboard(document.activeElement as HTMLElement | null)) setTyping(true);
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    return () => {
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
      setTyping(false);
    };
  }, [floating]);

  const mode: FloatMode | null = slots.full
    ? "full"
    : !active
      ? null
      : state.tucked || typing
        ? "tucked"
        : state.size;

  return useMemo(
    () => ({
      mode,
      reveal,
      internal: { state, active, typing, host, slots, slotRef, setActive, update, beforeChange },
    }),
    [mode, reveal, state, active, typing, host, slots, slotRef, update]
  );
}

/**
 * A place the detail can be shown: `flow` is the pane's place in the page,
 * `full` is its own page. Wherever a `full` slot is mounted the detail is in
 * it; otherwise it floats while stacked and sits in `flow` side by side.
 */
export function FloatSlot({
  float,
  kind,
  className = "contents",
  ...rest
}: {
  float: FloatingDetail;
  kind: SlotKind;
  className?: string;
  "aria-label"?: string;
  role?: string;
}) {
  return <div ref={float.internal.slotRef[kind]} className={className} {...rest} />;
}

// Whole class strings: Tailwind reads the source, not the running program.
/** Under the page bar (3.75rem). On a short screen the bar is static and
 * scrolls away, but at the top of the page it is there, so the window keeps
 * clear of it at every height rather than sit on the bar's buttons. */
const EDGE: Record<FloatEdge, string> = {
  top: "top-[calc(4.25rem+env(safe-area-inset-top,0px))]",
  bottom: "bottom-safe-3",
};
const SIDE: Record<FloatSide, string> = {
  left: "left-[calc(0.75rem+env(safe-area-inset-left,0px))]",
  right: "right-safe-3",
};
const SIZE = {
  small: "size-[min(11.5rem,48vw)]",
  large: cn(
    "w-[calc(100vw-1.5rem-env(safe-area-inset-left,0px)-env(safe-area-inset-right,0px))] max-w-[32rem]",
    "h-[min(24rem,55svh)] [@media(max-height:500px)]:h-[calc(100svh-5.5rem)] [@media(max-height:500px)]:max-w-[24rem]"
  ),
} as const;
/** Past its own side, and out of the accessibility tree with it. */
const TUCKED: Record<FloatSide, string> = {
  left: "invisible -translate-x-[calc(100%+2rem)]",
  right: "invisible translate-x-[calc(100%+2rem)]",
};
/** z-30: over the page, under the page bar (z-40) and every popover (z-50). */
const WINDOW =
  "fixed z-30 flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl print:visible print:static print:mt-4 print:h-80 print:w-full print:max-w-none print:translate-x-0 print:shadow-none";

const MOVE_MS = 320;
const MOVE_EASING = "cubic-bezier(0.22, 0.9, 0.3, 1)";

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
  samples: { x: number; y: number; t: number }[];
}

/** The window's own buttons, drawn like the map provider's: white in both
 * themes, because they sit on a map and not on the page. */
const CONTROL =
  "flex size-9 items-center justify-center rounded-md border border-black/20 bg-white text-[#333] shadow-md outline-none [-webkit-tap-highlight-color:transparent] pointer-coarse:size-11 focus-visible:ring-3 focus-visible:ring-ring";

/**
 * The detail itself, and the window around it while it floats. Render it
 * ONCE, at a place in the page's tree that is the same on the report page and
 * on the full-size page, so the router keeps it across the two.
 */
export function FloatingContent({
  float,
  label,
  ariaLabel,
  fullTo,
  children,
}: {
  float: FloatingDetail;
  /** The noun, lower case: "map". */
  label: string;
  /** The window's name as a region. */
  ariaLabel: string;
  /** The detail's own page, at full size. The large window links to it. */
  fullTo?: string;
  children: ReactNode;
}) {
  const { state, active, typing, update, beforeChange, host: el, slots } = float.internal;
  const { mode } = float;
  const full = mode === "full";
  const floating = active && !full;
  const hidden = mode === "tucked";

  /** Where the window was drawn before the change now being made. */
  const flipFrom = useRef<DOMRect | null>(null);
  /** A release that changes nothing still has to animate home. */
  const [settleTick, setSettleTick] = useState(0);
  /** Which control takes focus after the reader's own action. */
  const focusNext = useRef<"window" | "tab" | null>(null);
  const tabRef = useRef<HTMLButtonElement>(null);
  const elRef = useRef<HTMLDivElement | null>(null);
  elRef.current = el;
  /** Where the host is now, so it is moved only when that changes. */
  const placed = useRef<"flow" | "window" | "full" | null>(null);

  const captureFlip = useCallback(() => {
    if (el && floating) flipFrom.current = el.getBoundingClientRect();
  }, [el, floating]);

  useEffect(() => {
    beforeChange.current = captureFlip;
    return () => {
      beforeChange.current = null;
    };
  }, [beforeChange, captureFlip]);

  /** A change the reader made by a control: animate it, and follow it. */
  const act = useCallback(
    (next: FloatState, focus: "window" | "tab" | null = "window") => {
      captureFlip();
      focusNext.current = focus;
      if (next.size !== state.size) resizeGuardUntil.current = performance.now() + 400;
      update(next);
    },
    [captureFlip, update, state.size]
  );

  // Place, dress and animate the host. One effect, because the order is the
  // point: it must be in its new place before that place is measured.
  useLayoutEffect(() => {
    if (!el) return;
    const want = full ? "full" : floating ? "window" : "flow";
    const flowOrFull = want === "full" ? slots.full : slots.flow;
    if (want === "window") {
      if (placed.current !== "window" || !el.isConnected) {
        // Straight after the page bar: where the pinned pane was read, and
        // the first stop after the bar for a keyboard. At the end of the
        // body it was read after the footer, forty Tab presses away.
        const bar = document.querySelector("main > header");
        if (bar) bar.insertAdjacentElement("afterend", el);
        else document.body.appendChild(el);
      }
    } else if (flowOrFull) {
      if (el.parentElement !== flowOrFull) flowOrFull.appendChild(el);
    } else {
      // Nowhere to show it yet (the page is still loading its slot).
      el.remove();
    }
    const animate = want === "window" && placed.current === "window";
    placed.current = want;

    el.className =
      want === "window"
        ? cn(
            WINDOW,
            EDGE[state.edge],
            SIDE[state.side],
            SIZE[state.size],
            hidden && TUCKED[state.side]
          )
        : want === "full"
          ? "relative flex min-h-0 flex-1 flex-col"
          : "contents";
    el.inert = want === "window" && hidden;
    if (want === "window") {
      el.setAttribute("role", "region");
      el.setAttribute("aria-label", ariaLabel);
      el.dataset.floating = mode ?? "";
      el.dataset.corner = `${state.edge}-${state.side}`;
    } else {
      el.removeAttribute("role");
      el.removeAttribute("aria-label");
      delete el.dataset.floating;
      delete el.dataset.corner;
    }
    el.style.transform = "";
    el.style.transition = "";

    const first = flipFrom.current;
    flipFrom.current = null;
    if (animate && first && !reducedMotion() && typeof el.animate === "function") {
      const last = el.getBoundingClientRect();
      if (last.width > 0 && last.height > 0) {
        const dx = first.left - last.left;
        const dy = first.top - last.top;
        const sx = first.width / last.width;
        const sy = first.height / last.height;
        // `visibility` rides along so a window on its way out is seen going.
        el.animate(
          [
            {
              transformOrigin: "0 0",
              transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
              visibility: "visible",
            },
            { transformOrigin: "0 0", transform: "none", visibility: "visible" },
          ],
          { duration: MOVE_MS, easing: MOVE_EASING }
        );
      }
    }

    const focus = focusNext.current;
    focusNext.current = null;
    if (focus === "tab") tabRef.current?.focus({ preventScroll: true });
    else if (focus === "window") {
      el.querySelector<HTMLElement>("[data-float-focus]")?.focus({ preventScroll: true });
    }
  }, [
    el,
    full,
    floating,
    hidden,
    mode,
    slots.flow,
    slots.full,
    state.edge,
    state.side,
    state.size,
    ariaLabel,
    settleTick,
  ]);

  // Resting at the bottom, the window would cover the page's last lines for
  // good: the page cannot scroll further to bring them out. So the page is
  // made that much longer while it rests there.
  useEffect(() => {
    // Kept while it steps aside for the keyboard: the page must not jump
    // under a reader who has just begun to type.
    if (!el || !floating || state.tucked || state.edge !== "bottom") return;
    const body = document.body;
    const before = body.style.paddingBottom;
    const apply = () => {
      body.style.paddingBottom = `${el.offsetHeight + 24}px`;
    };
    apply();
    // Its height follows the screen (a turn, a toolbar), not only its size.
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(apply);
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      body.style.paddingBottom = before;
    };
  }, [el, floating, state.tucked, state.edge]);

  // -- Dragging ------------------------------------------------------------

  const drag = useRef<Drag | null>(null);
  /**
   * A drag ends in a click on the element that held the pointer, in most
   * browsers. Not in all (Safari sends none after a touch drag), so this is
   * a time and not a flag: a flag nothing clears would swallow the reader's
   * next real press.
   */
  const suppressClickUntil = useRef(0);
  /**
   * A change of size draws the new face under the finger that asked for it,
   * and a second tap of a double tap would land on it and undo the change.
   * A new press does NOT clear this one: the second tap is a new press.
   */
  const resizeGuardUntil = useRef(0);
  const clickIsDragEnd = (e: { timeStamp: number }) =>
    e.timeStamp < suppressClickUntil.current || performance.now() < resizeGuardUntil.current;

  // A drag whose handle went away (the window changed under the finger: the
  // keyboard came up, a step brought it back) is over.
  useEffect(() => {
    drag.current = null;
    if (el) {
      delete el.dataset.dragging;
      el.style.transform = "";
    }
  }, [el, mode, floating]);
  const [menuOpen, setMenuOpen] = useState(false);
  const grabberRef = useRef<HTMLButtonElement>(null);
  // Without a MenuTrigger the menu opens with focus on its box, where Enter
  // does nothing until an arrow key has been pressed. Put it on the first
  // row, as the kit's triggered menus do.
  useEffect(() => {
    if (!menuOpen) return;
    const id = window.setTimeout(() => {
      const menu = document.activeElement;
      if (menu?.getAttribute("role") !== "menu") return;
      menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    }, 50);
    return () => window.clearTimeout(id);
  }, [menuOpen]);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    // A new press: any click from here on is its own, not an old drag's.
    suppressClickUntil.current = 0;
    if (!el || e.button !== 0) return;
    // A second finger does not take over a drag that is under way.
    if (drag.current?.moved) return;
    // Inside the detail, only what the page marked as a place to hold the
    // window by, and never a control that has a use for the touch itself.
    if (e.currentTarget.hasAttribute("data-float-detail")) {
      const t = e.target instanceof Element ? e.target : null;
      if (!t?.closest("[data-float-drag]") || t.closest("input, button, a, select")) return;
    }
    drag.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      samples: [{ x: e.clientX, y: e.clientY, t: e.timeStamp }],
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!el || !d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < DRAG_SLOP_PX) return;
      d.moved = true;
      // An animation still running would fight the finger.
      for (const a of el.getAnimations()) a.cancel();
      el.dataset.dragging = "";
    }
    d.samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
    if (d.samples.length > 12) d.samples.shift();
    el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
  };

  const endDrag = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
    const d = drag.current;
    if (!el || !d || d.pointerId !== e.pointerId) return null;
    drag.current = null;
    delete el.dataset.dragging;
    if (!d.moved) return "tap" as const;
    suppressClickUntil.current = e.timeStamp + 400;
    const rect = el.getBoundingClientRect();
    flipFrom.current = rect;
    const next = cancelled
      ? state
      : settle(state, {
          cx: rect.left + rect.width / 2,
          cy: rect.top + rect.height / 2,
          width: rect.width,
          ...releaseVelocity(d.samples, e.timeStamp),
          vw: document.documentElement.clientWidth,
          vh: window.innerHeight,
        });
    if (next.tucked) focusNext.current = "tab";
    update(next);
    setSettleTick((t) => t + 1);
    return "drag" as const;
  };

  const handle = {
    onPointerDown,
    onPointerMove,
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void endDrag(e, true),
    // Capture can be taken away without a cancel. Whatever is left is over.
    onLostPointerCapture: (e: ReactPointerEvent<HTMLElement>) => void endDrag(e, true),
  };

  // The tab: a tap brings the window back, and so does pulling it inward.
  const tabDrag = useRef<{ id: number; x: number } | null>(null);
  const show = () => act({ ...state, tucked: false });
  const small = mode === "small";
  const toggleSize = () => act({ ...state, size: small ? "large" : "small" });

  // The window has no bar: a bar spent a row of a small screen on words. A
  // grabber floats over the top of the map, and the buttons that size the
  // window sit in its top right corner at both sizes. The grabber is also a
  // button: a tap opens the same moves as a menu, which is the way that is
  // not a drag, and the arrow keys carry the window between corners.
  const chrome =
    floating && (mode === "small" || mode === "large") ? (
      <>
        <button
          ref={grabberRef}
          type="button"
          {...handle}
          onPointerUp={(e) => void endDrag(e, false)}
          onClick={(e) => {
            // The click that ends a drag is not a tap.
            if (!clickIsDragEnd(e)) setMenuOpen(true);
          }}
          onKeyDown={(e) => {
            const next =
              e.key === "ArrowLeft" ? { side: "left" as const }
              : e.key === "ArrowRight" ? { side: "right" as const }
              : e.key === "ArrowUp" ? { edge: "top" as const }
              : e.key === "ArrowDown" ? { edge: "bottom" as const }
              : null;
            if (!next) return;
            e.preventDefault();
            act({ ...state, ...next }, null);
          }}
          aria-label={`Move or hide ${label}`}
          aria-description="Arrow keys move it to another corner."
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          data-float-handle=""
          className={cn(
            "absolute top-0 left-1/2 z-30 flex h-11 -translate-x-1/2 cursor-grab touch-none justify-center rounded-b-lg pt-1.5 outline-none select-none [-webkit-tap-highlight-color:transparent] focus-visible:ring-3 focus-visible:ring-ring in-data-dragging:cursor-grabbing",
            small ? "w-16" : "w-24"
          )}
        >
          <span
            aria-hidden
            className={cn(
              "h-1.5 rounded-full bg-white shadow-md ring-1 ring-black/60",
              small ? "w-9" : "w-12"
            )}
          />
        </button>
        <Menu
          placement="bottom"
          popover={{ triggerRef: grabberRef, isOpen: menuOpen, onOpenChange: setMenuOpen }}
          autoFocus="first"
          aria-label={`Move or hide ${label}`}
          onAction={(id) => {
            setMenuOpen(false);
            // The closing menu hands focus back to the grabber, which the
            // action may have just removed. Once it has finished, put focus
            // on whatever stands in the grabber's place.
            window.setTimeout(() => {
              const a = document.activeElement;
              if (a && a !== document.body && a.isConnected) return;
              (
                tabRef.current ??
                elRef.current?.querySelector<HTMLElement>("[data-float-focus]")
              )?.focus({ preventScroll: true });
            }, 250);
            if (id === "size") toggleSize();
            else if (id === "hide") act({ ...state, tucked: true }, "tab");
            else if (id === "edge") {
              act({ ...state, edge: state.edge === "top" ? "bottom" : "top" });
            } else if (id === "side") {
              act({ ...state, side: state.side === "left" ? "right" : "left" });
            }
          }}
        >
          <MenuItem id="size">{small ? "Make larger" : "Make smaller"}</MenuItem>
          <MenuItem id="hide">Hide</MenuItem>
          <MenuItem id="edge">
            {state.edge === "top" ? "Move to the bottom" : "Move to the top"}
          </MenuItem>
          {/* Large, the window is as wide as the screen: it has no side. */}
          {small ? (
            <MenuItem id="side">
              {state.side === "left" ? "Move to the right" : "Move to the left"}
            </MenuItem>
          ) : null}
        </Menu>
        <div className="absolute top-1.5 right-1.5 z-30 flex gap-1.5">
          {!small && fullTo ? (
            <Link to={fullTo} title={`Expand ${label}`} aria-label={`Expand ${label}`} className={CONTROL}>
              <Maximize2Icon aria-hidden className="size-5" />
            </Link>
          ) : null}
          <button
            type="button"
            title={small ? `Enlarge ${label}` : `Make ${label} smaller`}
            aria-label={small ? `Enlarge ${label}` : `Make ${label} smaller`}
            data-float-focus=""
            onClick={(e) => {
              if (!clickIsDragEnd(e)) toggleSize();
            }}
            className={CONTROL}
          >
            <PictureInPicture2Icon aria-hidden className="size-5" />
          </button>
        </div>
      </>
    ) : null;

  const content = (
    <>
      {chrome}
      {/* The same element in every mode, so the detail is never remounted. */}
      <div
        key="detail"
        data-float-detail=""
        {...(floating && mode === "large"
          ? { ...handle, onPointerUp: (e) => void endDrag(e, false) }
          : {})}
        className={floating || full ? "flex min-h-0 flex-1 flex-col" : "contents"}
      >
        {children}
      </div>
    </>
  );

  // Only a window the reader put away has a tab. One that stepped aside for
  // the keyboard comes back by itself, and a tab would sit on the keyboard.
  const tab =
    floating && state.tucked
      ? createPortal(
          <button
            ref={tabRef}
            type="button"
            aria-label={`Show ${label}`}
            data-float-tab={state.side}
            onClick={show}
            onPointerDown={(e) => {
              tabDrag.current = { id: e.pointerId, x: e.clientX };
            }}
            onPointerMove={(e) => {
              const d = tabDrag.current;
              if (!d || d.id !== e.pointerId) return;
              const inward = state.side === "right" ? d.x - e.clientX : e.clientX - d.x;
              if (inward > DRAG_SLOP_PX * 2) {
                tabDrag.current = null;
                show();
              }
            }}
            onPointerUp={() => {
              tabDrag.current = null;
            }}
            onPointerCancel={() => {
              tabDrag.current = null;
            }}
            className={cn(
              "fixed z-30 flex h-16 touch-pan-y [-webkit-tap-highlight-color:transparent] flex-col items-center justify-center gap-0.5 border border-border bg-card text-foreground shadow-lg outline-none print:hidden",
              "transition-opacity duration-300 starting:opacity-0",
              "focus-visible:ring-3 focus-visible:ring-ring",
              EDGE[state.edge],
              state.side === "right"
                ? "right-0 w-[calc(2.75rem+env(safe-area-inset-right,0px))] rounded-l-xl border-r-0 pr-[env(safe-area-inset-right,0px)]"
                : "left-0 w-[calc(2.75rem+env(safe-area-inset-left,0px))] rounded-r-xl border-l-0 pl-[env(safe-area-inset-left,0px)]",
              // Stepped aside for the keyboard as well: nothing to offer yet.
              typing && "hidden"
            )}
          >
            {state.side === "right" ? (
              <ChevronLeftIcon aria-hidden className="size-4 text-muted-foreground" />
            ) : (
              <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground" />
            )}
            <MapIcon aria-hidden className="size-5" />
          </button>,
          document.body
        )
      : null;

  return (
    <>
      {el ? createPortal(content, el) : null}
      {tab}
    </>
  );
}
