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
 * - back/forward (POP) restores the offset saved for that history entry,
 *   but only once the document has grown tall enough to show it (bounded
 *   by a grace period), and gives up the moment the user scrolls
 *   themselves.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

/** Saved scroll offsets per history entry (location.key). In-memory is
 * enough: a full reload starts a fresh document at the top anyway. */
const savedPositions = new Map<string, number>();

/** How long a restore waits for async content to reach the target height. */
const RESTORE_GRACE_MS = 3000;

function restoreScrollWhenTallEnough(target: number): () => void {
  let cancelled = false;
  const started = performance.now();
  const cancel = () => {
    cancelled = true;
  };
  // The user taking over scrolling wins over a pending restore.
  window.addEventListener("wheel", cancel, { once: true, passive: true });
  window.addEventListener("touchstart", cancel, { once: true, passive: true });
  const tick = () => {
    if (cancelled) return;
    const maxScroll =
      document.documentElement.scrollHeight - window.innerHeight;
    if (maxScroll >= target || performance.now() - started > RESTORE_GRACE_MS) {
      window.scrollTo(0, Math.min(target, Math.max(0, maxScroll)));
      return;
    }
    requestAnimationFrame(tick);
  };
  tick();
  return cancel;
}

export function useScrollRestoration(): void {
  const location = useLocation();
  const navigationType = useNavigationType();
  const currentKey = useRef(location.key);

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
    return () => window.removeEventListener("scroll", save);
  }, []);

  useLayoutEffect(() => {
    // Runs synchronously after the DOM swap, before the browser dispatches
    // any clamp-induced scroll event — so re-keying here keeps the old
    // entry's saved offset intact.
    currentKey.current = location.key;

    if (navigationType === "POP") {
      const target = savedPositions.get(location.key) ?? 0;
      if (target > 0) return restoreScrollWhenTallEnough(target);
    }
    window.scrollTo(0, 0);
  }, [location.key, navigationType]);
}
