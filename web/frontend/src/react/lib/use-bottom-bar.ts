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
 * **Only while the bar itself has focus.** The first version lifted the bar
 * for ANY keyboard, and it stuck halfway up an iPhone's screen. The pilot
 * sheet hides the bar while it is open; pressing Done brought the bar back in
 * the same render that removed the sheet's focused field, so it measured the
 * sheet's keyboard on its way out and lifted itself above it. iOS then put
 * the keyboard away without a `resize` the bar ever heard, and the bar stayed
 * up until the page was next resized (switching apps did it). A keyboard
 * opened for anything else is not the bar's business: it lifts while focus is
 * inside it, and drops to the bottom the moment focus leaves.
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
      const focused = bar.contains(document.activeElement);
      const keyboard =
        !vv || !focused || vv.scale > 1.01
          ? 0
          : Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      bar.style.setProperty("--keyboard-inset", `${Math.round(keyboard)}px`);
    };
    // A keyboard animates in after focus lands, so the resize is what says
    // how tall it is; focusout drops the bar back at once rather than waiting
    // for a resize that iOS may never send.
    vv?.addEventListener("resize", lift);
    vv?.addEventListener("scroll", lift);
    bar.addEventListener("focusin", lift);
    bar.addEventListener("focusout", (e) => {
      // Moving between the search box and its clear button is still inside.
      if (!bar.contains(e.relatedTarget as Node | null)) {
        bar.style.setProperty("--keyboard-inset", "0px");
      }
    });
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
