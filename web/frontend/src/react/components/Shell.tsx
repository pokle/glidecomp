/**
 * Shared app chrome around each routed page: the skip link, `<main>` and the
 * footer.
 *
 * There is no header here. Every page renders its own bar (`rac/page-bar.tsx`,
 * issue #863) as the first thing inside `<main>`: the bar holds the page's
 * `<h1>`, which is where focus goes on arrival (lib/route-focus.ts), so it has
 * to be inside the landmark. The main menu, the account and the super admin's
 * "Preview as" are in the bar of every top-level page.
 */
import { useEffect } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { Separator } from "@/react/rac/separator";
import { RacRouterProvider } from "@/react/rac/router";
import { needsOnboarding } from "../../auth/client";
import { useUser } from "../lib/user";
import { useScrollRestoration } from "../lib/scroll-restoration";
import { useRouteFocus } from "../lib/route-focus";

declare const __GIT_SHA__: string;

/** A footer link: a 44 px row for a finger, and still a line of links to the eye. */
const footerLink =
  "inline-flex min-h-11 items-center underline underline-offset-4 hover:text-foreground";

export function Shell() {
  const { user, loading } = useUser();
  const navigate = useNavigate();
  useScrollRestoration();
  useRouteFocus();

  // A signed-in user missing a username or a display name hasn't finished
  // onboarding (needsOnboarding() carries the why). Onboarding is mandatory,
  // so send them there from *anywhere* under this Shell — not just My Flights
  // — otherwise a fresh sign-in (which lands on /comp) sails past it.
  // Onboarding renders outside this Shell, so there's no redirect loop, and it
  // bounces already-onboarded users straight back out.
  useEffect(() => {
    if (loading) return;
    if (user && needsOnboarding(user)) navigate("/onboarding", { replace: true });
  }, [user, loading, navigate]);

  return (
    // Every routed page uses RAC links (the bar's menus are app-wide), so the
    // RAC->react-router bridge lives here once rather than in each page.
    // SSR-safe: it only uses useNavigate/useHref, which work under StaticRouter.
    <RacRouterProvider>
      <div className="flex min-h-dvh flex-col">
        {/* Skip link (WCAG 2.4.1, accessibility-standard §4.3): the first
            focusable element, visually hidden until focused, jumping keyboard/AT
            users straight to <main>. Keep in sync with the static Base.astro
            skip link. */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:border focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg focus:ring-3 focus:ring-ring/50"
        >
          Skip to main content
        </a>

        {/* No gutter and no width of its own: the page's bar is full-bleed and
            sticks to the top of this element, and `Page` (rac/page-bar.tsx)
            gives the content its column. tabIndex=-1 so the skip link actually
            lands keyboard focus here (the scroll position alone isn't enough
            for AT). */}
        <main id="main-content" tabIndex={-1} className="w-full flex-1 focus:outline-none">
          <Outlet />
        </main>

        {/* Chrome, not content — a printed page keeps only the page itself.
            It is page content at the foot of the page, never a bar fixed
            there. A page that is one thing with the screen to itself
            (`Page fill`, a map at full size) has no footer under it: that
            page must not scroll. */}
        <div className="print:hidden [body:has([data-page-fill])_&]:hidden">
          <Separator />
          <footer className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 px-gutter-safe pt-2 pb-gutter-safe text-sm text-muted-foreground">
            <span className="inline-flex min-h-11 items-center gap-1">
              GlideComp
              <a
                href={`https://github.com/pokle/glidecomp/commit/${__GIT_SHA__}`}
                target="_blank"
                rel="noopener noreferrer"
                data-git-sha={__GIT_SHA__}
                className={footerLink}
              >
                {__GIT_SHA__.slice(0, 7)}
              </a>
            </span>
            <a href="/about" className={footerLink}>
              About
            </a>
            <a href="/scoring" className={footerLink}>
              Scoring
            </a>
            <a href="/legal" className={footerLink}>
              Privacy &amp; Terms
            </a>
            <a
              href="https://github.com/pokle/glidecomp"
              target="_blank"
              rel="noopener noreferrer"
              className={footerLink}
            >
              GitHub
            </a>
            <a
              href="https://www.youtube.com/@poklet"
              target="_blank"
              rel="noopener noreferrer"
              className={footerLink}
            >
              YouTube
            </a>
          </footer>
        </div>
      </div>
    </RacRouterProvider>
  );
}
