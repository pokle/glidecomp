/**
 * "Has this element come near the viewport yet?" — the gate in front of the
 * map components.
 *
 * Mapbox is 764 KB of JavaScript across two chunks, and both map pages
 * (`/comp/:id/waypoints`, the pilot score page) mounted it the instant the
 * page did, so it competed with the content the visitor actually came to
 * read. Gating on intersection helps twice: a map below the fold is never
 * downloaded at all, and a map that IS visible still starts a beat later —
 * the observer can only fire after layout — so it no longer contends with
 * first paint.
 *
 * Latches: once true it stays true, so scrolling away never tears down a live
 * map.
 *
 * The ref it hands back is a CALLBACK ref, and that is load-bearing rather
 * than a style choice: both map pages render a loading state first and only
 * render the map's container once their data arrives. An effect that reads a
 * `useRef` object sees null on mount and has no reason to run again, so the
 * element that appears a moment later is never observed and the panel says
 * "Loading map…" forever. React calls a callback ref when the node attaches,
 * whenever that happens.
 *
 * SSR-safe by construction. It returns false on the first render in every
 * environment, so the server's markup and the client's first render agree; the
 * observer is wired up in an effect, which the server never runs.
 */
import { useCallback, useEffect, useState } from "react";

export interface InViewOptions {
  /** Start loading before the element is strictly on screen. */
  rootMargin?: string;
}

export function useInView<T extends HTMLElement>(
  { rootMargin = "300px" }: InViewOptions = {}
): [(node: T | null) => void, boolean] {
  const [el, setEl] = useState<T | null>(null);
  const [inView, setInView] = useState(false);
  // Identity-stable, so attaching it never detaches on a re-render.
  const ref = useCallback((node: T | null) => setEl(node), []);

  useEffect(() => {
    if (inView) return;
    if (!el) return;
    // No IntersectionObserver (very old browser, or a jsdom test): show the
    // thing rather than hide it forever. Degrading to "load it" is the safe
    // direction — the failure mode is the old behaviour, not a blank panel.
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setInView(true);
      },
      { rootMargin }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, inView, rootMargin]);

  return [ref, inView];
}
