/**
 * Chrome fixed to the bottom of the screen that has to stay usable: the
 * pilots page's search-and-add bar, which sits there the way iOS Contacts
 * puts its search beside a +.
 *
 * Two things a bottom bar breaks, and this hook mends both.
 *
 * **Other floating things sit where it sits.** The toaster and the
 * super-admin "Preview as" pill are both pinned bottom-right, which is
 * exactly where the + is. So the bar publishes its height as `--bottom-bar`
 * on `<html>` while it is mounted, and those two add it to their own offset
 * (lib/toast.tsx, the `bottom-safe-3` utility in globals.css). A page with no
 * bar leaves the variable unset and nothing moves.
 *
 * **The end of the page is under it.** The body is padded by the bar's
 * height while it is mounted, so the last row of a list — and the site footer
 * after it — scroll up clear of the bar instead of stopping behind it.
 *
 * **The keyboard covers it.** A `position: fixed; bottom: 0` element is
 * anchored to the LAYOUT viewport, and on iOS Safari (and on Chrome for
 * Android, whose default is the same) an on-screen keyboard shrinks only the
 * VISUAL viewport — so the search box you just tapped into is underneath the
 * keyboard you are typing on. The gap between the bottom of the visual
 * viewport and the bottom of the layout viewport is the keyboard; it is
 * written to `--keyboard-inset` on the bar itself, and the bar adds it to its
 * `bottom`.
 *
 * Pinch-zoom shrinks the visual viewport too, without any keyboard, so a
 * zoomed-in page lifts nothing. Desktop browsers never shrink it at all.
 *
 * Client-only: everything happens when the bar mounts, so it is safe on a
 * page the server renders.
 */
import { useCallback, type RefCallback } from "react";

/**
 * Put the returned ref on the bar. A ref callback rather than an effect,
 * because a bar commonly mounts later than its page — the pilots page shows
 * its bar only once the roster has loaded — and an effect keyed on the page's
 * mount found no bar there, did nothing, and never ran again. React 19 calls
 * the cleanup this returns when the bar unmounts.
 */
export function useBottomBar(): RefCallback<HTMLElement> {
  return useCallback((bar: HTMLElement | null) => {
    if (!bar || typeof window === "undefined") return;
    const root = document.documentElement;

    const publish = () => {
      root.style.setProperty("--bottom-bar", `${bar.offsetHeight}px`);
      document.body.style.paddingBottom = `${bar.offsetHeight}px`;
    };
    const resize = new ResizeObserver(publish);
    resize.observe(bar);
    publish();

    const vv = window.visualViewport;
    const lift = () => {
      if (!vv) return;
      const keyboard =
        vv.scale > 1.01 ? 0 : Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      bar.style.setProperty("--keyboard-inset", `${Math.round(keyboard)}px`);
    };
    vv?.addEventListener("resize", lift);
    vv?.addEventListener("scroll", lift);
    lift();

    return () => {
      resize.disconnect();
      vv?.removeEventListener("resize", lift);
      vv?.removeEventListener("scroll", lift);
      root.style.removeProperty("--bottom-bar");
      document.body.style.paddingBottom = "";
    };
  }, []);
}
