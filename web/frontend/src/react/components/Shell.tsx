/**
 * Shared app chrome: header nav + footer around each routed page.
 * IA v2 (#277): Competitions leads, My Flights second, and account actions
 * live in a right-aligned user menu instead of a Settings tab + footer
 * sign-out. Site super admins also get the floating "Preview as" pill.
 */
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { EyeIcon, XIcon } from "lucide-react";
import { Button, ToggleButton } from "@/react/rac/button";
import {
  Menu,
  MenuHeader,
  MenuItem,
  MenuSection,
  MenuSeparator,
  MenuTrigger,
} from "@/react/rac/menu";
import { PriorityNav, type PriorityNavItem } from "@/react/rac/priority-nav";
import { Separator } from "@/react/rac/separator";
import { cn } from "@/react/lib/utils";
import { RacRouterProvider } from "@/react/rac/router";
import { needsOnboarding, signOut } from "../../auth/client";
import {
  DEV_SIGN_IN_ENABLED,
  signInAsDev,
  useGoToSignIn,
  useUser,
  type PreviewRole,
} from "../lib/user";
import { useScrollRestoration } from "../lib/scroll-restoration";

declare const __GIT_SHA__: string;

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "text-sm font-medium transition-colors hover:text-foreground",
    isActive ? "text-foreground underline underline-offset-8" : "text-muted-foreground"
  );

export function Shell() {
  const { user, loading } = useUser();
  const goToSignIn = useGoToSignIn();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useScrollRestoration();
  const flightsHref = user?.username ? `/u/${user.username}` : "/u/me";

  // NavLink works out its own active state, but the overflow menu needs the
  // same answer for a link that is no longer in the row — so the rule NavLink
  // uses by default (this path, or anything under it) is spelt out once here.
  const isCurrent = (to: string) => pathname === to || pathname.startsWith(`${to}/`);
  const navItems: PriorityNavItem[] = [
    {
      id: "comp",
      label: "Competitions",
      href: "/comp",
      isCurrent: isCurrent("/comp"),
      children: (
        <NavLink to="/comp" className={navLinkClass}>
          Competitions
        </NavLink>
      ),
    },
    {
      id: "flights",
      label: "My Flights",
      href: flightsHref,
      isCurrent: isCurrent(flightsHref),
      children: (
        <NavLink to={flightsHref} className={navLinkClass}>
          My Flights
        </NavLink>
      ),
    },
    // The one thing a pilot who has just landed came here to do, so it is
    // reachable from every page. Mirrored in SiteHeader.astro.
    {
      id: "submit",
      label: "Submit track",
      href: "/submit",
      isCurrent: isCurrent("/submit"),
      children: (
        <NavLink to="/submit" className={navLinkClass}>
          Submit track
        </NavLink>
      ),
    },
  ];

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
    // Every routed page can now use RAC links (breadcrumbs are app-wide), so
    // the RAC->react-router bridge lives here once rather than in each page.
    // SSR-safe: it only uses useNavigate/useHref, which work under StaticRouter.
    <RacRouterProvider>
    <div className="flex min-h-dvh flex-col">
      {/* Skip link (WCAG 2.4.1, accessibility-standard §4.3): the first
          focusable element, visually hidden until focused, jumping keyboard/AT
          users past the header straight to <main>. Keep in sync with the static
          Base.astro skip link. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:border focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg focus:ring-3 focus:ring-ring/50"
      >
        Skip to main content
      </a>
      {/* Always-present glass menu bar (Inscribe-style): translucent background
          with backdrop blur, so content scrolls beneath it. On phones
          (max-sm) and short landscape viewports it scrolls away with the
          page instead of pinning — vertical space is too precious there
          (the score-details map is sticky and was left peeking out from
          under the glass). Keep this in sync with SiteHeader.astro. */}
      <header className="sticky top-0 z-40 border-b bg-background/70 backdrop-blur-xl backdrop-saturate-150 pt-safe max-sm:static [@media(max-height:500px)]:static print:hidden">
        {/* The glass itself stays full-bleed — `pt-safe` on the header pushes
            only its CONTENT below the status bar, and the gutter grows past a
            landscape notch (issue #642).

            One row: the links that do not fit fold into PriorityNav's "More"
            menu rather than wrapping the bar onto a second line (issue #639).
            The bar keeps `flex-wrap` all the same — PriorityNav shrinks to
            nothing before anything else can wrap, so the only case left is the
            brand and the account slot ALONE outgrowing the viewport, and
            wrapping is the right answer to that. Keep in sync with
            SiteHeader.astro. */}
        <nav
          aria-label="Main"
          className="mx-auto flex min-h-[60px] w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-gutter-safe py-3"
        >
          {/* Home is a static (Astro) page, so use a full navigation. */}
          <a
            href="/"
            className="shrink-0 font-brand text-base font-semibold tracking-tight"
          >
            GlideComp
          </a>
          <PriorityNav
            items={navItems}
            className="flex-1 gap-x-6"
            menuLabel="More pages"
          />
          <div className="shrink-0">
            {user ? (
              <UserMenu name={user.name ?? user.email ?? "Account"} />
            ) : !loading ? (
              <div className="flex items-center gap-2">
                {DEV_SIGN_IN_ENABLED ? (
                  <Button variant="outline" onPress={() => void signInAsDev()}>
                    Sign in (dev)
                  </Button>
                ) : null}
                <Button onPress={() => goToSignIn()}>Sign in</Button>
              </div>
            ) : null}
          </div>
        </nav>
      </header>

      {/* tabIndex=-1 so the skip link actually lands keyboard focus here (the
          scroll position alone isn't enough for AT). */}
      <main
        id="main-content"
        tabIndex={-1}
        // A page opts into a wider measure by putting `data-wide-page` on
        // anything it renders. Only the task field-analysis report does: it
        // spends 12rem of its width on the PageToc rail and then lays its
        // ranking table out beside a chart, which does not fit inside 6xl.
        // Without this its own `xl:max-w-[87rem]` was silently clamped here
        // and the docs layout came out NARROWER than the plain one.
        className="mx-auto w-full max-w-6xl flex-1 px-gutter-safe pt-6 pb-12 focus:outline-none [&:has([data-wide-page])]:max-w-[89rem]"
      >
        <Outlet />
      </main>

      <Separator className="print:hidden" />

      {/* Chrome, not content — a printed page keeps only the page itself. */}
      <footer className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-gutter-safe pt-4 pb-gutter-safe text-sm text-muted-foreground print:hidden">
        <span>
          GlideComp{" "}
          <a
            href={`https://github.com/pokle/glidecomp/commit/${__GIT_SHA__}`}
            target="_blank"
            rel="noopener noreferrer"
            data-git-sha={__GIT_SHA__}
            className="underline underline-offset-4 hover:text-foreground"
          >
            {__GIT_SHA__.slice(0, 7)}
          </a>
        </span>
        <a href="/about" className="underline underline-offset-4 hover:text-foreground">
          About
        </a>
        <a href="/scoring" className="underline underline-offset-4 hover:text-foreground">
          Scoring
        </a>
        <a href="/legal" className="underline underline-offset-4 hover:text-foreground">
          Privacy &amp; Terms
        </a>
        <a
          href="https://github.com/pokle/glidecomp"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-4 hover:text-foreground"
        >
          GitHub
        </a>
        <a
          href="https://www.youtube.com/@poklet"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-4 hover:text-foreground"
        >
          YouTube
        </a>
      </footer>

      <PreviewAsPill />
    </div>
    </RacRouterProvider>
  );
}

/** Right-aligned account menu: avatar initials → Settings, Sign out. */
function UserMenu({ name }: { name: string }) {
  const navigate = useNavigate();
  const initials =
    name
      .split(/\s+/)
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?";

  return (
    <MenuTrigger>
      <Button
        aria-label="Account menu"
        variant="ghost"
        size="icon"
        className="rounded-full border bg-muted text-xs font-semibold data-hovered:bg-accent"
      >
        {initials}
      </Button>
      <Menu placement="bottom end">
        {/* The name labels the group, so it has to sit in a MenuSection —
            a bare Header in the Menu is unlabelled decoration. */}
        <MenuSection>
          <MenuHeader className="max-w-56 truncate font-normal">{name}</MenuHeader>
          <MenuSeparator />
          {/* A real anchor: RacRouterProvider routes the click client-side,
              and middle-click / open-in-new-tab still work. */}
          <MenuItem href="/settings">Settings</MenuItem>
          <MenuItem
            onAction={async () => {
              await signOut();
              navigate("/");
              window.location.reload();
            }}
          >
            Sign out
          </MenuItem>
        </MenuSection>
      </Menu>
    </MenuTrigger>
  );
}

const PREVIEW_ROLES: Array<{ role: PreviewRole; label: string }> = [
  { role: "out", label: "Signed out" },
  { role: "pilot", label: "Pilot" },
  { role: "admin", label: "Comp admin" },
  { role: "actual", label: "Super admin" },
];

/**
 * Floating role switcher for site super admins: presentation-only preview of
 * the signed-out / pilot / comp-admin experience (the API still sees the real
 * superadmin session throughout).
 *
 * Minimised to a small pill in the bottom-right corner so it doesn't obscure
 * the page; click to expand the role switcher, click again (or ✕) to collapse.
 */
function PreviewAsPill() {
  const { isSuperAdmin, previewRole, setPreviewRole } = useUser();
  const [open, setOpen] = useState(false);
  if (!isSuperAdmin) return null;

  const active = PREVIEW_ROLES.find(({ role }) => role === previewRole);
  const previewing = previewRole !== "actual";

  if (!open) {
    return (
      <Button
        aria-label={`Preview as${active ? `: ${active.label}` : ""}. Click to change.`}
        variant="ghost"
        onPress={() => setOpen(true)}
        className={cn(
          "fixed right-safe-3 bottom-safe-3 z-50 h-auto gap-1.5 rounded-full border py-1 pr-3 pl-2.5 text-xs font-medium shadow-lg print:hidden",
          previewing
            ? "bg-primary text-primary-foreground data-hovered:bg-primary"
            : "bg-card text-muted-foreground data-hovered:bg-card data-hovered:text-foreground"
        )}
      >
        <EyeIcon className="size-3.5" aria-hidden="true" />
        <span className="whitespace-nowrap">{previewing ? active?.label : "Preview as"}</span>
      </Button>
    );
  }

  return (
    <div
      role="group"
      aria-label="Preview as"
      className="fixed right-safe-3 bottom-safe-3 z-50 flex items-center gap-1 rounded-full border bg-card py-1 pr-1.5 pl-3.5 text-xs shadow-lg print:hidden"
    >
      <span className="mr-1 whitespace-nowrap text-muted-foreground">Preview as</span>
      {PREVIEW_ROLES.map(({ role, label }) => (
        // ToggleButton, not Button: each role is a pressed/unpressed state, and
        // RAC renders the aria-pressed these were hand-rolling.
        <ToggleButton
          key={role}
          variant="ghost"
          isSelected={previewRole === role}
          onChange={() => setPreviewRole(role)}
          className={cn(
            "h-auto rounded-full px-2.5 py-1 text-xs font-medium",
            previewRole === role
              ? "bg-primary text-primary-foreground data-hovered:bg-primary"
              : "text-muted-foreground data-hovered:text-foreground"
          )}
        >
          {label}
        </ToggleButton>
      ))}
      <Button
        aria-label="Minimise preview switcher"
        variant="ghost"
        onPress={() => setOpen(false)}
        className="ml-0.5 size-auto rounded-full p-1 text-muted-foreground data-hovered:text-foreground"
      >
        <XIcon className="size-3.5" aria-hidden="true" />
      </Button>
    </div>
  );
}
