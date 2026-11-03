/**
 * Where keyboard focus goes when the page changes (WCAG 2.4.3, and the
 * accessibility standard's "focus is never lost", §4.2).
 *
 * The overlays rule in CLAUDE.md made every full-screen sheet and dialog a
 * page. A dialog moved focus into itself and gave it back to its trigger on
 * close; a page does neither by itself. Pressing Expand, QR code or a
 * pilot's row unmounts the control that was pressed, so focus fell to
 * `<body>` — a screen reader announced nothing, and the next Tab started at
 * the top of the document. Back did the same on the way out. So:
 *
 * - **Arriving on a new page** (a link, `navigate()`): focus goes to the
 *   page's `<h1>` — what a reader needs to hear first — once it has
 *   rendered, or to `<main>` while there is none. Unless the page has
 *   already put focus somewhere in it itself (an autofocused field): that
 *   was a decision, and this does not overrule it.
 * - **Back and Forward**: focus goes back to the control the reader left the
 *   page from — the link, the row — found again by what it points at, once
 *   it has rendered. That is "focus returns to the trigger", which the
 *   dialog used to do.
 * - **The same page with a corrected address** (a canonical-path replace, a
 *   query change): nothing moves, by the rule scroll restoration uses.
 *
 * Programmatic focus moves no scroll (`preventScroll`): scroll restoration
 * owns the scroll position.
 */
import { useEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

/** How to find a control again after its page re-rendered. */
type FocusTarget = { href: string } | { id: string } | { rowKey: string };

/** The control last activated on each history entry, by the entry's key. */
const lastFocused = new Map<string, FocusTarget>();

/** Frames to wait for the page to render what focus is meant to land on. */
const WAIT_FRAMES = 90;

function describe(el: Element | null): FocusTarget | null {
  if (!el || el === document.body) return null;
  const link = el.closest("a[href]");
  if (link) return { href: link.getAttribute("href") ?? "" };
  if (el.id) return { id: el.id };
  // A row of a kit list (React Aria's GridList and Table rows carry their key).
  const row = el.closest("[data-key]");
  const key = row?.getAttribute("data-key");
  if (key) return { rowKey: key };
  return null;
}

function find(main: HTMLElement, target: FocusTarget): HTMLElement | null {
  if ("href" in target) {
    for (const a of main.querySelectorAll<HTMLElement>("a[href]")) {
      if (a.getAttribute("href") === target.href) return a;
    }
    return null;
  }
  if ("id" in target) {
    const el = document.getElementById(target.id);
    return el && main.contains(el) ? el : null;
  }
  return main.querySelector<HTMLElement>(`[data-key="${CSS.escape(target.rowKey)}"]`);
}

/** The page has focus somewhere of its own choosing, inside the content. */
function pageChoseFocus(main: HTMLElement): boolean {
  const active = document.activeElement;
  return !!active && active !== main && main.contains(active);
}

function focusHeading(main: HTMLElement): boolean {
  const h1 = main.querySelector<HTMLElement>("h1");
  if (!h1) return false;
  if (!h1.hasAttribute("tabindex")) {
    h1.setAttribute("tabindex", "-1");
    h1.classList.add("outline-none");
  }
  h1.focus({ preventScroll: true });
  return true;
}

export function useRouteFocus(): void {
  const location = useLocation();
  const navigationType = useNavigationType();
  const currentKey = useRef(location.key);
  const prevPathname = useRef(location.pathname);
  const first = useRef(true);

  // Keep, per entry, the control the reader activated — by a click, or by
  // Enter or Space on what had focus (a list row answers those without a
  // click). It cannot be read at navigation time, when React has already
  // swapped the page out; nor from `focusin`, which the next page's own
  // autofocus fires before this knows the entry has changed.
  useEffect(() => {
    const record = (el: Element | null) => {
      const target = describe(el);
      if (target) lastFocused.set(currentKey.current, target);
    };
    const onClick = (e: MouseEvent) => record(e.target as Element | null);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") record(document.activeElement);
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  useEffect(() => {
    currentKey.current = location.key;
    const samePathname = location.pathname === prevPathname.current;
    prevPathname.current = location.pathname;
    // The page the browser opened: the browser's own focus, untouched.
    if (first.current) {
      first.current = false;
      return;
    }
    const preserve =
      (location.state as { preserveScroll?: boolean } | null)?.preserveScroll ?? false;
    if (navigationType === "REPLACE" && (preserve || samePathname)) return;
    if (navigationType === "PUSH" && samePathname) return;

    const main = document.getElementById("main-content");
    if (!main) return;
    const back = navigationType === "POP" ? lastFocused.get(location.key) : undefined;
    let frame = 0;
    let frames = 0;
    const settle = () => {
      if (pageChoseFocus(main)) return;
      const found = back ? find(main, back) : null;
      if (found) {
        found.focus({ preventScroll: true });
        return;
      }
      // Back with nothing to return to waits for it as long as a forward
      // arrival waits for its heading; past that, the heading will do.
      const done = !back && focusHeading(main);
      if (done) return;
      if (++frames < WAIT_FRAMES) {
        frame = requestAnimationFrame(settle);
        return;
      }
      if (!focusHeading(main) && document.activeElement === document.body) {
        main.focus({ preventScroll: true });
      }
    };
    // While the page renders, focus is on <main> rather than lost.
    if (document.activeElement === document.body || !document.activeElement) {
      main.focus({ preventScroll: true });
    }
    frame = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(frame);
  }, [location, navigationType]);
}
