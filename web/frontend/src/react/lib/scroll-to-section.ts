/**
 * Smooth scroll to an element by DOM id and move keyboard focus to it.
 *
 * Extracted from PageToc so in-page anchor links (PageToc, OverviewBlock)
 * share identical navigation and focus behaviour without drifting.
 *
 * After smooth scrolling, moves keyboard focus to the target element (or its
 * first focusable child), setting tabindex="-1" where needed so keyboard users
 * land where they navigated.
 */
export function scrollToSection(id: string, onBeforeScroll?: () => void) {
  onBeforeScroll?.();
  if (typeof window === "undefined" || typeof document === "undefined") return;
  // Two frames: one for React to commit, one for a just-expanded
  // disclosure panel to exist before we measure and scroll to it.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      const target = el.matches("a,button,[tabindex]")
        ? el
        : (el.querySelector<HTMLElement>("a,button,[tabindex],h1,h2,h3,h4") ?? el);
      if (!target.hasAttribute("tabindex") && !target.matches("a,button")) {
        target.setAttribute("tabindex", "-1");
      }
      target.focus({ preventScroll: true });
    })
  );
}
