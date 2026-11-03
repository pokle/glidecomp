/**
 * SPA scroll management.
 *
 * With the browser's native `history.scrollRestoration` ("auto"), Safari
 * restores a history entry's scroll offset on back/forward *immediately* —
 * before React has re-rendered the page, whose content loads async and is
 * momentarily only a short "Loading…" document. iOS Safari pins the
 * viewport beyond the end of that short document and fails to re-clamp
 * when the content grows, leaving a blank white screen until a manual
 * scroll or reload (observed going back from the score-details page to
 * the task page).
 *
 * So the SPA owns scrolling instead:
 * - forward navigations (PUSH/REPLACE) start at the top;
 * - a REPLACE that only corrects or annotates the page the reader is already
 *   on (the canonical slug settling, a query parameter written) leaves them
 *   where they are, and carries their offset over to the entry's new key;
 * - back/forward (POP) restores the offset saved for that history entry
 *   ({@link restoreScroll}): once the document has grown tall enough to show
 *   it, and then HELD there for a moment while late content above it settles.
 *   The reader taking over scrolling ends both at once.
 *
 * ## A same-page replace does not cancel a restore (issue #844)
 *
 * Back to a task-analysis page landed at the top, two ways:
 * - The restore was the layout effect's cleanup, so the next location change
 *   cancelled it — and the next location change was usually the page's own:
 *   the list's default selection written into the query, or the canonical
 *   slug replacing a bare id. Both are REPLACEs of the page being restored,
 *   which leave the scroll alone, so the restore was cancelled and nothing
 *   took its place. The restore in flight now lives in a ref, and only a
 *   navigation to another page (or another Back) cancels it.
 * - A REPLACE gives the entry a new key, and offsets are saved per key from
 *   scroll events. A reader who scrolled, then flipped the thermals' map on
 *   (`?map=1`) and left without scrolling again had no offset under the new
 *   key, so Back restored nothing. A same-page REPLACE now copies the offset
 *   across.
 *
 * ## Late content above the restored offset (issue #846)
 *
 * An offset is saved against the page as the reader left it, and restored
 * against the page as it is DURING its reload. Back to the comp page from a
 * task's diagram restored while the scores above the task list still said
 * "Loading scores…", a line shorter than the table that replaced it. Two
 * things then put the reader short of where they were:
 * - the browser's scroll anchoring (CSS `overflow-anchor`) keeps the content
 *   on screen in place as the scores grow above it — which keeps the
 *   transitional page's view, the wrong one;
 * - with no anchoring, nothing moves at all, which is right; but a page that
 *   grew and shrank on the way could clamp the offset.
 * Anchoring is not the fix, then, it is half the fault. While a restore holds,
 * the root's `overflow-anchor` is `none` — which is how Safari, iOS included,
 * behaved anyway before version 27 added scroll anchoring — and the offset is
 * re-applied whenever the page lets it drift. The held offset is the right
 * one because Back shows the same page the reader left: once its late content
 * is in, the layout is the one the offset was measured on.
 *
 * The hold never fights the reader. Any wheel, touch, key or pointer press
 * ends it, and so does any scroll the hold did not cause (a scrollbar drag,
 * find-in-page): the page is then theirs, anchoring and all.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

/** Saved scroll offsets per history entry (location.key). In-memory is
 * enough: a full reload starts a fresh document at the top anyway. */
const savedPositions = new Map<string, number>();

/** How long a restore waits for async content to reach the target height. */
export const RESTORE_GRACE_MS = 3000;
/**
 * How long after Back the restored offset is held against late content. Late
 * means a section loading its own data after the page's — the comp page's
 * scores, a task analysis's debrief — and an e2e delays one by 800 ms.
 */
export const HOLD_MS = 3000;
/** The hold also outlasts layout changes: it ends once the document's height
 * has been still this long… */
export const SETTLE_MS = 500;
/** …but never later than this, whatever the page keeps doing. */
export const HOLD_LIMIT_MS = 10_000;
/** Sub-pixel offsets (a phone's device pixel ratio) are not a drift. */
const TOLERANCE_PX = 1;

/** Input that means the reader has taken over scrolling. A pointer press
 * covers a scrollbar drag in the browsers that report one. */
const TAKEOVER_EVENTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

/** A Back/Forward restore in flight. */
export interface ScrollRestore {
  /** The offset being restored — the reader's position while it is active. */
  readonly target: number;
  /** Waiting to restore, or holding the restored offset. */
  readonly active: boolean;
  /** Stop now, leaving the scroll wherever it is. */
  cancel(): void;
}

/**
 * Restore `target` once the document is tall enough to show it (or the grace
 * period runs out), then hold it while the layout settles — see the notes at
 * the top of this file. Browser-only: call it from an effect.
 */
export function restoreScroll(target: number): ScrollRestore {
  const root = document.documentElement;
  const started = performance.now();
  const anchorBefore = root.style.overflowAnchor;
  root.style.overflowAnchor = "none";

  let active = true;
  let restored = false;
  let frame = 0;
  let lastHeight = -1;
  let lastChange = started;

  const maxScroll = () => Math.max(0, root.scrollHeight - window.innerHeight);

  const stop = () => {
    if (!active) return;
    active = false;
    cancelAnimationFrame(frame);
    for (const type of TAKEOVER_EVENTS) window.removeEventListener(type, stop);
    window.removeEventListener("scroll", onScroll);
    root.style.overflowAnchor = anchorBefore;
  };

  // A scroll the hold did not cause ends it. Its own scrollTo lands on the
  // target, and a document too short for the target clamps to its end; any
  // other offset was somebody else's doing.
  function onScroll() {
    if (!restored) return;
    const y = window.scrollY;
    const max = maxScroll();
    if (Math.abs(y - target) <= TOLERANCE_PX) return;
    if (target > max && y >= max - TOLERANCE_PX) return;
    stop();
  }

  const tick = () => {
    if (!active) return;
    const now = performance.now();
    const height = root.scrollHeight;
    if (height !== lastHeight) {
      lastHeight = height;
      lastChange = now;
    }
    const max = maxScroll();
    if (!restored) {
      if (max >= target || now - started > RESTORE_GRACE_MS) {
        restored = true;
        window.scrollTo(0, Math.min(target, max));
      }
    } else {
      const want = Math.min(target, max);
      if (Math.abs(window.scrollY - want) > TOLERANCE_PX) window.scrollTo(0, want);
    }
    const settled = now - started > HOLD_MS && now - lastChange > SETTLE_MS;
    if (restored && (settled || now - started > HOLD_LIMIT_MS)) {
      stop();
      return;
    }
    frame = requestAnimationFrame(tick);
  };

  for (const type of TAKEOVER_EVENTS) {
    window.addEventListener(type, stop, { passive: true });
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  tick();

  return {
    target,
    get active() {
      return active;
    },
    cancel: stop,
  };
}

export function useScrollRestoration(): void {
  const location = useLocation();
  const navigationType = useNavigationType();
  const currentKey = useRef(location.key);
  const prevPathname = useRef(location.pathname);
  // The Back/Forward restore in flight. A ref, not the layout effect's
  // cleanup: a same-page REPLACE straight after Back must not cancel it.
  const restoring = useRef<ScrollRestore | null>(null);

  // Record the offset continuously while the user is on a page. It can't be
  // captured at navigation time: React swaps the DOM first, the shrunken
  // document clamps scrollY to 0, and the real offset is gone. Our own
  // scrollTo calls below also fire scroll events, which conveniently
  // re-save the correct offset under the new entry's key.
  useEffect(() => {
    if ("scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual";
    }
    const save = () => savedPositions.set(currentKey.current, window.scrollY);
    window.addEventListener("scroll", save, { passive: true });
    return () => {
      window.removeEventListener("scroll", save);
      restoring.current?.cancel();
    };
  }, []);

  useLayoutEffect(() => {
    // Runs synchronously after the DOM swap, before the browser dispatches
    // any clamp-induced scroll event — so re-keying here keeps the old
    // entry's saved offset intact.
    currentKey.current = location.key;
    const samePathname = location.pathname === prevPathname.current;
    prevPathname.current = location.pathname;

    if (navigationType === "POP") {
      restoring.current?.cancel();
      restoring.current = null;
      const target = savedPositions.get(location.key) ?? 0;
      if (target > 0) restoring.current = restoreScroll(target);
      else window.scrollTo(0, 0);
      return;
    }
    // A REPLACE that only corrects the address of the page the reader is
    // already on must not move them: the canonical `${slug}-${id}` settling
    // over a bare-id URL (marked with preserveScroll, and able to arrive
    // SECONDS late on a slow connection — yanking a reader who has scrolled
    // back to the top), or a filter rewriting the query string (same
    // pathname, e.g. the task-analysis class select). A replace that lands
    // on a DIFFERENT page (the /profile → /settings kind) still starts at
    // the top.
    const samePage =
      navigationType === "REPLACE" &&
      (((location.state as { preserveScroll?: boolean } | null)?.preserveScroll ??
        false) ||
        samePathname);
    if (samePage) {
      // The entry has a new key and the reader has not moved, so their
      // offset is this key's too — without it, Back to this entry found no
      // offset unless they happened to scroll again after the replace. While
      // a restore is still in flight their offset is the one it is restoring.
      const pending = restoring.current?.active ? restoring.current.target : null;
      savedPositions.set(location.key, pending ?? window.scrollY);
      return;
    }
    restoring.current?.cancel();
    restoring.current = null;
    window.scrollTo(0, 0);
  }, [location, navigationType]);
}
