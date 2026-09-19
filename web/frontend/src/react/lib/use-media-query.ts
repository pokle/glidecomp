/**
 * Subscribe to a CSS media query from React.
 *
 * For the rare case where a breakpoint has to choose which COMPONENT mounts,
 * not merely how one looks. Tailwind handles the looks, and the app reaches
 * for CSS first everywhere it can (see components/MasterDetail.tsx, which
 * switches a whole layout on container queries alone). This exists for the
 * waypoints editor, where the two widths want genuinely different components:
 * a phone gets a list of waypoints that open as sheets, and a wide screen gets
 * the Tabulator grid — which is lazily imported, holds its own row state, and
 * must not be built at all when it is not the editor on screen.
 *
 * SSR-safe. The query is read lazily, so the first CLIENT render already has
 * the right answer and no layout flashes; on the server there is no
 * `window` and the answer is `false`. That default is only ever seen by
 * server-rendered markup, and the one caller is admin-only chrome that the
 * server never renders (there is no session there, so `isAdmin` is false) —
 * so it cannot cause a hydration mismatch. A future caller on the public side
 * of a server-rendered page would need to think about that, and should
 * probably use a container query instead.
 */
import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(query);
    // Re-read on subscribe: the query can have changed between the lazy
    // initial read and the effect (a rotated phone, a resized window).
    setMatches(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
