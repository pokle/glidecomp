import { useEffect, useState } from "react";

/**
 * `false` during SSR and the first client (hydration) render, `true` after the
 * component has mounted in the browser.
 *
 * Use it to defer any output that cannot be byte-identical on the server and in
 * the browser's first render to a post-hydration re-render — the viewer's local
 * time zone, or an ICU `timeZoneName: "short"` abbreviation, whose values differ
 * between the workerd SSR runtime and the browser (see `lib/time.ts`). Rendering
 * the deterministic form first (offset-only, UTC) and enriching once mounted
 * keeps the SSR markup and the first client render in agreement, so React never
 * reports a hydration mismatch, while settled UI still gets the nicer form.
 *
 * This is the one shared primitive for that pattern; prefer it over an ad-hoc
 * `useState(false)` + `useEffect` so the intent (and the SSR-safety reason) is
 * named at every call site.
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
