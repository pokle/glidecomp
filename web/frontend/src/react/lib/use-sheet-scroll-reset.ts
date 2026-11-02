/**
 * Keeps the page behind a full-screen sheet scrolled to the top while the
 * sheet is open, and puts the reader's place back when it closes.
 *
 * Found on an iPhone, and only there: a sheet opened over a scrolled list
 * stopped answering taps. Tapping Name did nothing, and nothing in the
 * console said why. Web Inspector on the stuck phone showed the page
 * scrolled 154 px under React Aria's scroll lock (`overflow: hidden` on
 * <html>), and Safari's visual viewport still panned 72 px by a keyboard that
 * had already gone. Safari then DREW the sheet (`position: fixed`) in one
 * place and HIT-TESTED it in another: the sheet's box measured y = -72, and a
 * tap on the Name field landed on the inert page behind it. Scrolling the
 * window back to 0 from the inspector made the very next tap work.
 *
 * It took a keyboard to set up (the bottom bar's search, or a field in an
 * earlier sheet) and a scrolled page, so it came and went with no fixed
 * steps. Hence two halves:
 *
 *   - **On open**, the page goes to the top. The sheet's backdrop covers it,
 *     so nobody sees the jump.
 *   - **When a keyboard closes** while the sheet is open (the visual viewport
 *     grows back to the window's height) and Safari has left the page or the
 *     viewport panned, it is put back to 0 again. Not while a keyboard is
 *     up: that is Safari bringing the focused field into view.
 *
 * On close, the outermost sheet scrolls the page back to where the reader
 * left it, so the list they came from is where it was.
 */
import { useEffect } from "react";

/** How many sheets are open; only the outermost one saves and restores. */
let open = 0;
let saved: { x: number; y: number } | null = null;
/** A restore waiting for its frame (see the cleanup). */
let pending: { frame: number; at: { x: number; y: number } } | null = null;

function toTop() {
  if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
}

export function useSheetScrollReset(): void {
  useEffect(() => {
    if (open++ === 0) {
      // A sheet that opens before the last one's restore has run (StrictMode
      // re-running this effect, or one sheet replacing another) keeps the
      // place that restore was going back to: the page is at 0 by now.
      if (pending) {
        cancelAnimationFrame(pending.frame);
        saved = pending.at;
        pending = null;
      } else {
        saved = { x: window.scrollX, y: window.scrollY };
      }
    }
    toTop();

    const vv = window.visualViewport;
    const onViewport = () => {
      if (!vv) return;
      // A keyboard is up while the visual viewport is clearly shorter than
      // the window. One pixel of slack for fractional heights.
      const keyboardUp = vv.height < window.innerHeight - 1;
      if (!keyboardUp && (window.scrollY !== 0 || vv.offsetTop !== 0)) toTop();
    };
    vv?.addEventListener("resize", onViewport);

    return () => {
      vv?.removeEventListener("resize", onViewport);
      if (--open === 0 && saved) {
        const at = saved;
        saved = null;
        // A frame later: what the sheet hid comes back in the same commit
        // (the pilots page's bottom bar, and the page padding it adds), and
        // until it has, the page is too short to scroll back to `at.y`.
        const frame = requestAnimationFrame(() => {
          pending = null;
          window.scrollTo(at.x, at.y);
        });
        pending = { frame, at };
      }
    };
  }, []);
}
