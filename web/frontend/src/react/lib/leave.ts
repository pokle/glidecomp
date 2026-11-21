/**
 * Leaving a page: the bar's back control, a form's Cancel, a page that
 * closes itself after a save (#823).
 *
 * The overlays rule in CLAUDE.md made every editor, figure and form a page of
 * its own, so "close" became "leave this page". There are two ways to have
 * arrived on one, and they leave differently:
 *
 * - **From another page of this app.** That was a real step forward in the
 *   browser's history, so leaving is a real Back: the page underneath returns
 *   exactly as it was left, its scroll and query included, and Forward still
 *   works. The bar's back control and the browser's Back then do the same
 *   thing, on every page.
 * - **Directly** — a shared link, a bookmark, a new tab, the installed app's
 *   first screen. There is nothing of ours behind it (Back would leave the
 *   site, and the installed app has no Back at all), so leaving REPLACES this
 *   page with the one it belongs to: the page above it.
 *
 * ## How it tells which
 *
 * react-router numbers every history entry it writes (`history.state.idx`),
 * starting at 0 for the entry a document was loaded on. An entry past 0 was
 * reached from a page of this app. The number survives a reload and
 * Back/Forward, so a page still knows after the reader reloads it.
 *
 * Until 2026-11-21 the OPENER had to say so, by marking the entry it pushed
 * (`openedHere()`), and a link that was not marked made the bar's back go up
 * to the parent page while the browser's Back went where the reader had come
 * from. About sixteen links were marked and the rest were not: from the comp
 * analysis into a task's analysis, the bar went to the task page. Nothing
 * failed and nothing warned. The page asks the history now, so no link has
 * anything to remember.
 *
 * It is the only thing that does `navigate(-1)` for a page —
 * `no-overlays.test.ts` holds that.
 */
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/**
 * Where this entry is in react-router's history stack, or null under a
 * history react-router did not write (a MemoryRouter in a unit test, the
 * server).
 */
export function historyIndex(): number | null {
  if (typeof window === "undefined") return null;
  const state = window.history.state as { idx?: unknown } | null;
  return typeof state?.idx === "number" ? state.idx : null;
}

/** Whether a page of this app is behind this one in the browser's history. */
export function cameFromThisApp(): boolean {
  const index = historyIndex();
  return index !== null && index > 0;
}

/**
 * Leave this page for `fallback`, the page it belongs to: a real Back when a
 * page of this app is behind it, else a replace with `fallback` (see the
 * note above).
 */
export function useLeave(): (fallback: string) => void {
  const navigate = useNavigate();
  return (fallback) => {
    if (cameFromThisApp()) navigate(-1);
    else navigate(fallback, { replace: true });
  };
}

/**
 * The name each page of this visit went by, by its place in the history
 * stack, so the back control can say where Back will go. Kept for the life
 * of the document: after a reload the pages behind are not named until they
 * are visited again, and the control then says "Back".
 */
const pageNames = new Map<number, string>();

/**
 * What the bar's back control is called, and the bar's own page remembered
 * for the next page's control.
 *
 * - A page of this app is behind this one: "Back to <its name>", or "Back"
 *   where the name is not known.
 * - Arrived directly: "Back to <the page above>", which is where it goes.
 *
 * The server and the first client render say "Back to <the page above>":
 * the server has no history, and the two must agree for hydration.
 */
export function useBackLabel(title: string, parentLabel: string | undefined): string {
  const location = useLocation();
  const up = parentLabel ? `Back to ${parentLabel}` : "Back";
  const [label, setLabel] = useState(up);
  useEffect(() => {
    const index = historyIndex();
    if (index !== null) pageNames.set(index, title);
    if (index === null || index === 0) {
      setLabel(up);
      return;
    }
    const behind = pageNames.get(index - 1);
    setLabel(behind ? `Back to ${behind}` : "Back");
    // `location.key` is the entry: a Back or a link is a new one to read.
  }, [location.key, title, up]);
  return label;
}
