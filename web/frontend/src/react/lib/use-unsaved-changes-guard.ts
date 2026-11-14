/**
 * Guard against silently losing edits on a page with an unsaved form.
 *
 * Two layers while `dirty`:
 *
 * - `beforeunload` covers reloads, tab closes and external links;
 * - a capture-phase click listener covers in-app navigation (BrowserRouter has
 *   no useBlocker, so same-origin link clicks are intercepted before React's
 *   own handlers, confirmed with the app dialog, then re-navigated).
 *
 * "Re-navigated" means the way the link itself would have gone. A link to a
 * page of the app goes through the router. A same-origin link to a page the
 * SERVER answers — Home, About, the scoring guides, `/analysis`, a file — is a
 * real page load: sent through the router, it rendered the app's own "page
 * not found" over an address that was perfectly good, which is what
 * "Discard changes" on the header's GlideComp link did. A `download` link
 * leaves nothing, so it is not asked about at all.
 *
 * ## Back is not guarded
 *
 * Back is the browser's Back, and it leaves without asking (CLAUDE.md, "No
 * full-screen overlays"; #817). Until 2026-11 this guard held a history entry
 * of its own while the form was dirty, so that a Back could be answered with
 * "Discard changes?" — and that entry had to share the stack with every sheet
 * and dialog doing the same, which took a module of its own to keep straight
 * and still left a dead entry behind now and then. Browser navigation must
 * simply work; we do not imitate it. Where an editor keeps its work in the
 * draft store (`lib/draft-store.ts`: the waypoints editor, the route editor),
 * Back loses nothing and means "not now". Where a page has no draft (the
 * settings pages, the pilot page), Back leaves the edits behind, as it would
 * on any web form.
 *
 * Extracted from the Settings page's profile form so the comp settings
 * sub-pages share one guard; `e2e/settings-save-ux.spec.ts` and
 * `e2e/comp-settings-pages.spec.ts` pin the behaviour, the second in the
 * mobile Playwright project as well.
 */
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { isSpaRoute } from "../../spa-routes";
import { useConfirm } from "./confirm";

export function useUnsavedChangesGuard(
  dirty: boolean,
  options: {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    /**
     * Links that do not leave the work: another page of the same editor.
     * The waypoints editor is several pages over one stored draft (#811), so
     * going from the list to a waypoint's page is not leaving it — only a
     * link out of the editor asks.
     */
    isWithin?: (url: URL) => boolean;
    /**
     * Run when the reader answers "Discard changes" to a link, before the
     * navigation — for work that would otherwise outlive the page (a draft in
     * storage, lib/draft-store.ts), so that discarding really discards.
     */
    onDiscard?: () => void;
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
      // A download saves a file and leaves the page, and its edits, where
      // they are.
      if (anchor.hasAttribute("download")) return;
      const href = anchor.getAttribute("href") ?? "";
      const url = new URL(href, window.location.href);
      // External links fall through to beforeunload; same-page hashes are fine.
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.hash) return;
      if (guardRef.current.options.isWithin?.(url)) return;

      // Stop the navigation at document level — stopImmediatePropagation so
      // React's root listeners (and any sibling duplicate) never see the
      // click — then re-run it iff the user confirms.
      e.preventDefault();
      e.stopImmediatePropagation();
      const guard = guardRef.current;
      // One question at a time: a second click while it is on screen is not
      // a second dialog.
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
          if (!ok) return;
          guard.options.onDiscard?.();
          if (isSpaRoute(url.pathname)) {
            guard.navigate(url.pathname + url.search + url.hash);
          } else {
            // A page the server answers, not the router. The reader has
            // already said "Discard", so the browser's own "Leave site?"
            // must not ask again.
            window.removeEventListener("beforeunload", onBeforeUnload);
            window.location.assign(url.href);
          }
        });
    };
    document.addEventListener("click", onClickCapture, true);

    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClickCapture, true);
    };
  }, [dirty]);
}
