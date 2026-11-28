/**
 * FloatingWindow — a detail pane that floats over the page on a phone, the
 * way a video does in picture-in-picture (owner's decision, 28 November 2026;
 * docs/interaction-guide.md 2.8 holds the rule and this is its one owner).
 *
 * It replaces {@link MasterDetail}'s PINNED pane where a caller opts in. A
 * pinned map held half of a phone's screen for as long as the reader was in
 * its section, and the only way out was to hide it altogether. The window
 * covers a corner instead, and the reader decides which:
 *
 * - DRAG it and it comes to rest in the nearest corner. It never stops in
 *   between, so there is nothing to tidy up.
 * - Drag or flick it OFF A SIDE and it is put away, leaving a tab on that
 *   edge. The tab brings it back.
 * - TAP the small window and it becomes large. Small, it is a picture: every
 *   touch moves the window, none moves the map. Large, the map is live, and
 *   the window moves by the grabber at its top. The button in its corner
 *   makes it small again.
 * - While the reader TYPES, it puts itself away, and comes back afterwards.
 *   That is how it stays clear of the on-screen keyboard without following
 *   the keyboard from script, which is what the fixed bars could not do.
 *
 * Every one of those has a control that is not a drag (guide 2.9, WCAG
 * 2.5.7): a tap on the grabber opens them as a menu, and the tab is a button.
 *
 * ## How it is built
 *
 * - The window is `position: fixed`, so it cannot live inside MasterDetail:
 *   an `@container` is a containing block for fixed descendants in the
 *   browsers that still apply layout containment to it. The detail is
 *   rendered through a portal into ONE element this component owns, and that
 *   element is moved between the page's flow and `<body>`. A move is not a
 *   remount: a map keeps its WebGL context, its camera and its layers when
 *   the screen is turned or the window widens.
 * - At rest it is positioned by CSS alone: a corner is `top`/`bottom` and
 *   `left`/`right`, with the safe-area insets. Script moves it only while a
 *   finger is on it, and animates it to where the CSS already put it. So
 *   Safari's moving toolbars, a rotation and a zoom need no listener.
 * - The server renders the detail in the flow, and so does the first client
 *   render. The portal starts in a layout effect, before the first paint.
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
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  MapIcon,
  PictureInPicture2Icon,
} from "lucide-react";
import { Button } from "@/react/rac/button";
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

/** What the reader sees: a small picture, the large live window, or its tab. */
export type FloatMode = "small" | "large" | "tucked";

/**
 * A floating detail's state, owned by the page so that it can lay the detail
 * out for the window (`mode`) and bring the window back when the reader asks
 * the detail a question (`reveal`). From {@link useFloatingDetail}; passed to
 * MasterDetail as `floating`.
 */
export interface FloatingDetail {
  /** null while the detail is in the page's flow: side by side, on the
   * server, and until the layout has been measured. */
  mode: FloatMode | null;
  /** Bring a tucked window back. The reader asked to see something in it. */
  reveal: () => void;
  /** For MasterDetail and FloatingWindow. Not for pages. */
  internal: {
    state: FloatState;
    active: boolean;
    typing: boolean;
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
  const reveal = useCallback(() => {
    const s = stateRef.current;
    if (!s.tucked) return;
    // Back as the small window, on the half of the screen the reader is not
    // looking at: what they pressed is where their eyes are.
    const pressed = document.activeElement;
    const rect =
      pressed && pressed !== document.body ? pressed.getBoundingClientRect() : null;
    const edge: FloatEdge = rect
      ? rect.top + rect.height / 2 < window.innerHeight / 2
        ? "bottom"
        : "top"
      : s.edge;
    beforeChange.current?.();
    update({ ...s, tucked: false, size: "small", edge });
  }, [update]);

  // Out of the keyboard's way. Only where a keyboard takes screen: with a
  // mouse and real keys, a map that left whenever a field was focused would
  // be a map that could not be read while searching.
  useEffect(() => {
    if (!active) return;
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
  }, [active]);

  const mode: FloatMode | null = !active
    ? null
    : state.tucked || typing
      ? "tucked"
      : state.size;

  return useMemo(
    () => ({
      mode,
      reveal,
      internal: { state, active, typing, setActive, update, beforeChange },
    }),
    [mode, reveal, state, active, typing, update]
  );
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
  small: "size-[min(11rem,46vw)]",
  large: cn(
    "w-[calc(100vw-1.5rem-env(safe-area-inset-left,0px)-env(safe-area-inset-right,0px))] max-w-[32rem]",
    "h-[min(24rem,55dvh)] [@media(max-height:500px)]:h-[calc(100dvh-5.5rem)] [@media(max-height:500px)]:max-w-[24rem]"
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

export function FloatingWindow({
  float,
  label,
  ariaLabel,
  children,
}: {
  float: FloatingDetail;
  /** The noun, lower case: "map". As MasterDetail's `detailLabel`. */
  label: string;
  /** The window's name as a region. */
  ariaLabel: string;
  children: ReactNode;
}) {
  const { state, active, typing, update, beforeChange } = float.internal;
  const { mode } = float;
  const hidden = mode === "tucked";

  const slotRef = useRef<HTMLDivElement>(null);
  const [el, setEl] = useState<HTMLDivElement | null>(null);

  // The one element the detail lives in, wherever it is shown.
  useLayoutEffect(() => {
    const node = document.createElement("div");
    slotRef.current?.appendChild(node);
    setEl(node);
    return () => {
      node.remove();
      setEl(null);
    };
  }, []);

  /** Where the window was drawn before the change now being made. */
  const flipFrom = useRef<DOMRect | null>(null);
  /** A release that changes nothing still has to animate home. */
  const [settleTick, setSettleTick] = useState(0);
  /** Which control takes focus after the reader's own action. */
  const focusNext = useRef<"window" | "tab" | null>(null);
  const tabRef = useRef<HTMLButtonElement>(null);

  const captureFlip = useCallback(() => {
    if (el && active) flipFrom.current = el.getBoundingClientRect();
  }, [el, active]);

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
      if (next.size !== state.size) suppressClickUntil.current = performance.now() + 350;
      update(next);
    },
    [captureFlip, update, state.size]
  );

  // Place, dress and animate the element. One effect, because the order is
  // the point: it must be in its new place before that place is measured.
  useLayoutEffect(() => {
    if (!el) return;
    if (!active) {
      if (slotRef.current && el.parentElement !== slotRef.current) {
        slotRef.current.appendChild(el);
      }
    } else if (!el.hasAttribute("data-floating")) {
      // Straight after the page bar: where the pinned pane was read, and the
      // first stop after the bar for a keyboard. At the end of the body it
      // was read after the footer, forty Tab presses away.
      const bar = document.querySelector("main > header");
      if (bar) bar.insertAdjacentElement("afterend", el);
      else document.body.appendChild(el);
    }
    el.className = active
      ? cn(
          WINDOW,
          EDGE[state.edge],
          SIDE[state.side],
          SIZE[state.size],
          hidden && TUCKED[state.side]
        )
      : "contents";
    el.inert = active && hidden;
    if (active) {
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
    if (active && first && !reducedMotion() && typeof el.animate === "function") {
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
  }, [el, active, hidden, mode, state.edge, state.side, state.size, ariaLabel, settleTick]);

  // Resting at the bottom, the window would cover the page's last lines for
  // good: the page cannot scroll further to bring them out. So the page is
  // made that much longer while it rests there.
  useEffect(() => {
    if (!el || !active || hidden || state.edge !== "bottom") return;
    const body = document.body;
    const before = body.style.paddingBottom;
    body.style.paddingBottom = `${el.offsetHeight + 24}px`;
    return () => {
      body.style.paddingBottom = before;
    };
  }, [el, active, hidden, state.edge, state.size]);

  // -- Dragging ------------------------------------------------------------

  const drag = useRef<Drag | null>(null);
  /**
   * A drag ends in a click on the element that held the pointer, in most
   * browsers. Not in all (Safari sends none after a touch drag), so this is
   * a time and not a flag: a flag nothing clears would swallow the reader's
   * next real press.
   */
  const suppressClickUntil = useRef(0);
  const clickIsDragEnd = (e: { timeStamp: number }) => e.timeStamp < suppressClickUntil.current;

  // A drag whose handle went away (the window changed under the finger: the
  // keyboard came up, a step brought it back) is over.
  useEffect(() => {
    drag.current = null;
    if (el) {
      delete el.dataset.dragging;
      el.style.transform = "";
    }
  }, [el, mode, active]);
  const [menuOpen, setMenuOpen] = useState(false);
  const grabberRef = useRef<HTMLButtonElement>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (!el || e.button !== 0) return;
    // A second finger does not take over a drag that is under way.
    if (drag.current?.moved) return;
    // Inside the detail, only what the page marked as a place to hold the
    // window by, and never a control that has a use for the touch itself.
    if (e.currentTarget.hasAttribute("data-float-detail")) {
      const t = e.target instanceof Element ? e.target : null;
      if (!t?.closest("[data-float-drag]") || t.closest("input, button, a, select")) return;
    }
    // The bar's own buttons are buttons, not a handle.
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

  // Large, the window has no bar: a bar spent a row of a small screen on
  // three words. A grabber floats over the top of the map and a corner
  // button makes the window small. The grabber is also a button: a tap opens
  // the same moves as a menu, which is the way that is not a drag.
  const chrome =
    active && mode === "large" ? (
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
          aria-label={`Move or hide ${label}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          data-float-handle=""
          data-float-focus=""
          className="absolute top-0 left-1/2 z-30 flex h-11 w-24 -translate-x-1/2 cursor-grab touch-none justify-center rounded-b-lg pt-1.5 outline-none select-none focus-visible:ring-3 focus-visible:ring-ring in-data-dragging:cursor-grabbing"
        >
          <span
            aria-hidden
            className="h-1.5 w-12 rounded-full bg-white shadow-md ring-1 ring-black/60"
          />
        </button>
        <Menu
          placement="bottom"
          popover={{ triggerRef: grabberRef, isOpen: menuOpen, onOpenChange: setMenuOpen }}
          autoFocus="first"
          aria-label={`Move or hide ${label}`}
          onAction={(id) => {
            setMenuOpen(false);
            if (id === "smaller") act({ ...state, size: "small" });
            else if (id === "hide") act({ ...state, tucked: true }, "tab");
            else if (id === "edge") {
              act({ ...state, edge: state.edge === "top" ? "bottom" : "top" });
            } else if (id === "side") {
              act({ ...state, side: state.side === "left" ? "right" : "left" });
            }
          }}
        >
          <MenuItem id="smaller">Make smaller</MenuItem>
          <MenuItem id="hide">Hide</MenuItem>
          <MenuItem id="edge">
            {state.edge === "top" ? "Move to the bottom" : "Move to the top"}
          </MenuItem>
          <MenuItem id="side">
            {state.side === "left" ? "When small, keep on the right" : "When small, keep on the left"}
          </MenuItem>
        </Menu>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Make ${label} smaller`}
          onPress={() => act({ ...state, size: "small" })}
          className="absolute right-0 bottom-0 z-30 size-11"
        >
          <PictureInPicture2Icon className="size-5" />
        </Button>
      </>
    ) : null;

  const picture = active && mode !== "large";

  const content = (
    <>
      {chrome}
      {/* The same element in every mode, so the detail is never remounted.
          A picture takes no input: the window's one button is over it. */}
      <div
        key="detail"
        inert={picture}
        data-float-detail=""
        {...(active && mode === "large"
          ? { ...handle, onPointerUp: (e) => void endDrag(e, false) }
          : {})}
        className={active ? "flex min-h-0 flex-1 flex-col" : "contents"}
      >
        {children}
      </div>
      {active && mode === "small" ? (
        <button
          type="button"
          {...handle}
          onPointerUp={(e) => void endDrag(e, false)}
          onClick={(e) => {
            if (clickIsDragEnd(e)) return;
            act({ ...state, size: "large" });
          }}
          onKeyDown={(e) => {
            // Arrows move it between corners; Enter and Space enlarge it.
            const next =
              e.key === "ArrowLeft" ? { side: "left" as const }
              : e.key === "ArrowRight" ? { side: "right" as const }
              : e.key === "ArrowUp" ? { edge: "top" as const }
              : e.key === "ArrowDown" ? { edge: "bottom" as const }
              : null;
            if (!next) return;
            e.preventDefault();
            act({ ...state, ...next });
          }}
          aria-label={`Enlarge ${label}`}
          data-float-focus=""
          className="absolute inset-0 z-30 cursor-grab touch-none rounded-[inherit] outline-none select-none focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset in-data-dragging:cursor-grabbing"
        />
      ) : null}
    </>
  );

  // Only a window the reader put away has a tab. One that stepped aside for
  // the keyboard comes back by itself, and a tab would sit on the keyboard.
  const tab =
    active && state.tucked
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
              "fixed z-30 flex h-16 touch-pan-y flex-col items-center justify-center gap-0.5 border border-border bg-card text-foreground shadow-lg outline-none print:hidden",
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
      <div ref={slotRef} className="contents">
        {el ? createPortal(content, el) : children}
      </div>
      {tab}
    </>
  );
}
