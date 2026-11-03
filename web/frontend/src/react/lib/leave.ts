/**
 * Leaving a page that another page opened (#823).
 *
 * The overlays rule in CLAUDE.md made every editor, figure and form a page of
 * its own, so "close" became "leave this page". There are two ways to arrive
 * on one, and they leave differently:
 *
 * - **Opened from a page of this app** — a pilot's row, the route editor's
 *   Add turnpoint, a thermal's Maximise. That is a real step forward in the
 *   browser's history, so leaving is a real Back: the page underneath returns
 *   exactly as it was left, its scroll and query included, and Forward still
 *   works.
 * - **Arrived at directly** — a reload, a bookmark, a link opened in a new
 *   tab. There is nothing of ours behind it to go Back to (Back would leave
 *   the site), so leaving REPLACES this page with the one it belongs to.
 *
 * The opener says which by marking the history entry it pushes
 * ({@link openedHere}); the page asks with {@link useLeave}. One marker, read
 * one way: the pages had grown six names for it (`fromList`, `fromRoute`,
 * `fromWaypoints`, …), each checked by its own copy of the same three lines.
 *
 * A history entry's state survives a reload and Back/Forward, so a page that
 * was opened here still knows it after the reader reloads it. It is the only
 * thing that does `navigate(-1)` for a page — `no-overlays.test.ts` holds that.
 */
import { useLocation, useNavigate } from "react-router-dom";

/** The key in a history entry's state that marks it as opened from a page of ours. */
const OPENED_HERE = "openedHere";

/**
 * Router options for a link or `navigate()` that opens a page from this one,
 * with any state of its own beside the marker:
 * `navigate(path, openedHere())`, `<Link routerOptions={openedHere()}>`.
 */
export function openedHere(state: Record<string, unknown> = {}): {
  state: Record<string, unknown>;
} {
  return { state: { ...state, [OPENED_HERE]: true } };
}

/** Whether the history entry with this state was opened from a page of ours. */
export function wasOpenedHere(state: unknown): boolean {
  return (
    typeof state === "object" &&
    state !== null &&
    (state as Record<string, unknown>)[OPENED_HERE] === true
  );
}

/**
 * Leave this page for `fallback`, the page it belongs to: a real Back when a
 * page of ours opened it, else a replace with `fallback` (see the note above).
 */
export function useLeave(): (fallback: string) => void {
  const location = useLocation();
  const navigate = useNavigate();
  return (fallback) => {
    if (wasOpenedHere(location.state)) navigate(-1);
    else navigate(fallback, { replace: true });
  };
}
