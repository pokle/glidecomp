/**
 * Guard against silently losing edits on a page with an unsaved form.
 *
 * Three layers while `dirty`:
 *
 * - `beforeunload` covers reloads, tab closes and external links;
 * - a capture-phase click listener covers in-app navigation (BrowserRouter has
 *   no useBlocker, so same-origin link clicks are intercepted before React's
 *   own handlers, confirmed with the app dialog, then re-navigated);
 * - a {@link useBackDismiss} layer covers Back — the browser's button and a
 *   phone's back gesture, which neither of the other two ever sees.
 *
 * Back was the gap (a `popstate` is not a click and not an unload), and it
 * mattered more once `lib/use-back-dismiss.ts` made Back first-class
 * navigation on the waypoints page: it now walks out of one sheet per press,
 * and the press after the last one dropped an afternoon of typing without a
 * word.
 *
 * ## What Back does here
 *
 * The guard holds a history entry of its own for as long as the form is dirty,
 * and it holds the GROUND FLOOR of the layer stack (`useBackDismiss`'s third
 * argument): a Back aimed at a sheet belongs to the sheet, so Back closes the
 * open overlays one at a time and only then reaches this. That is not merely
 * the arming order — on the waypoints page it is editing an altitude INSIDE
 * the review sheet that turns the form dirty, two layers deep, and the guard
 * waits for those layers to close before taking an entry at all.
 *
 * On that press the entry is put straight back ({@link BackDismissLayer.rearm})
 * before the dialog is opened, so the reader has not moved and "Keep editing"
 * is a no-op by construction rather than by a compensating push. "Discard
 * changes" unwinds instead: the confirm dialog pushes an entry of its own
 * while it is open, so leaving means walking back out of both, which
 * {@link BackDismissLayer.unwind} does by reading the entries rather than by
 * counting them.
 *
 * A confirmed LINK click unwinds too, and then pushes. Without that the
 * guard's entry would be left buried between the page and the link's
 * destination, and Back from the destination would land on it, do nothing
 * visible, and have to be pressed again.
 *
 * Extracted from the Settings page's profile form so the comp settings
 * sub-pages share one guard; `e2e/settings-save-ux.spec.ts`,
 * `e2e/comp-settings-pages.spec.ts` and `e2e/comp-waypoints.spec.ts` pin the
 * behaviour, the last two in the mobile Playwright project as well.
 */
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useConfirm } from "./confirm";
import { useBackDismiss, type BackDismissLayer } from "./use-back-dismiss";

export function useUnsavedChangesGuard(
  dirty: boolean,
  options: {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
  }
): void {
  const confirm = useConfirm();
  const navigate = useNavigate();

  // confirm/navigate/options go through a ref so the effect keys on `dirty`
  // alone — the confirm context value changes identity on every provider
  // render, and having it in the deps re-armed the listener mid-dispatch
  // (double dialogs). Options are read fresh at prompt time.
  const guardRef = useRef({
    confirm,
    navigate,
    options,
    prompting: false,
    layer: null as BackDismissLayer | null,
  });
  guardRef.current.confirm = confirm;
  guardRef.current.navigate = navigate;
  guardRef.current.options = options;

  /**
   * Ask, once. Resolves to what the reader chose; a second ask while one is
   * already on screen resolves false rather than stacking dialogs.
   */
  function ask(): Promise<boolean> {
    const guard = guardRef.current;
    if (guard.prompting) return Promise.resolve(false);
    guard.prompting = true;
    return guard
      .confirm({
        title: guard.options.title,
        message: guard.options.message,
        confirmLabel: guard.options.confirmLabel ?? "Discard changes",
        cancelLabel: guard.options.cancelLabel ?? "Keep editing",
        destructive: true,
      })
      .then((ok) => {
        guard.prompting = false;
        return ok;
      });
  }
  const askRef = useRef(ask);
  askRef.current = ask;

  // The Back layer. `dirty` arms and disarms it, and saving therefore releases
  // its entry the same way closing a sheet does — nothing stray is left behind.
  // `ground`: this guards the PAGE, so it waits under every overlay.
  const layer = useBackDismiss(() => {
    const guard = guardRef.current;
    // Stand the reader back where they were before answering: the press has
    // already moved them off this layer's entry.
    guard.layer?.rearm();
    void askRef.current().then((ok) => {
      // Finish the press: out of this layer's entry, out of the dialog's, and
      // then one real step back — which is the one they made.
      if (ok) guard.layer?.unwind(() => window.history.back());
    });
  }, dirty, true);
  guardRef.current.layer = layer;

  useEffect(() => {
    if (!dirty) return;

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);

    const onClickCapture = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.("a[href]");
      if (!anchor || anchor.getAttribute("target") === "_blank") return;
      const href = anchor.getAttribute("href") ?? "";
      const url = new URL(href, window.location.href);
      // External links fall through to beforeunload; same-page hashes are fine.
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.hash) return;

      // Stop the navigation at document level — stopImmediatePropagation so
      // React's root listeners (and any sibling duplicate) never see the
      // click — then re-run it iff the user confirms.
      e.preventDefault();
      e.stopImmediatePropagation();
      const guard = guardRef.current;
      void askRef.current().then((ok) => {
        if (!ok) return;
        const to = url.pathname + url.search + url.hash;
        // Drop the guard's own entry (and the dialog's) before pushing the
        // destination, so the reader's stack is the one they would have had
        // with no guard in the way.
        guard.layer?.unwind(() => guard.navigate(to));
      });
    };
    document.addEventListener("click", onClickCapture, true);

    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClickCapture, true);
    };
  }, [dirty]);
}
