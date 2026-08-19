/**
 * Guard against silently losing edits on a page with an unsaved form.
 *
 * Two layers while `dirty`: beforeunload covers reloads / tab closes /
 * external links; the capture-phase click listener covers in-app navigation
 * (BrowserRouter has no useBlocker, so same-origin link clicks are
 * intercepted before React's own handlers, confirmed with the app dialog,
 * then re-navigated).
 *
 * Extracted from the Settings page's profile form so the comp settings
 * sub-pages share one guard; `e2e/settings-save-ux.spec.ts` pins the
 * behaviour.
 */
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useConfirm } from "./confirm";

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
  const guardRef = useRef({ confirm, navigate, options, prompting: false });
  guardRef.current.confirm = confirm;
  guardRef.current.navigate = navigate;
  guardRef.current.options = options;

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
      if (guard.prompting) return;
      guard.prompting = true;
      void guard
        .confirm({
          title: guard.options.title,
          message: guard.options.message,
          confirmLabel: guard.options.confirmLabel ?? "Discard changes",
          cancelLabel: guard.options.cancelLabel ?? "Keep editing",
          destructive: true,
        })
        .then((ok) => {
          guard.prompting = false;
          if (ok) guard.navigate(url.pathname + url.search + url.hash);
        });
    };
    document.addEventListener("click", onClickCapture, true);

    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClickCapture, true);
    };
  }, [dirty]);
}
