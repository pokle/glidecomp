/**
 * Shared app chrome: header nav + footer around each routed page.
 * IA v2 (#277): Competitions leads, My Flights second, and account actions
 * live in a right-aligned user menu instead of a Settings tab + footer
 * sign-out. Site super admins also get the floating "Preview as" pill.
 */
import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { EyeIcon, XIcon } from "lucide-react";
import { Button } from "@/react/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/react/ui/dropdown-menu";
import { Separator } from "@/react/ui/separator";
import { cn } from "@/react/lib/utils";
import { signOut } from "../../auth/client";
import {
  DEV_SIGN_IN_ENABLED,
  signInAsDev,
  goToSignIn,
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
  const navigate = useNavigate();
  useScrollRestoration();
  const flightsHref = user?.username ? `/u/${user.username}` : "/u/me";

  // A signed-in user with no username hasn't finished onboarding. Onboarding
  // is mandatory, so send them there from *anywhere* under this Shell — not
  // just My Flights — otherwise a fresh sign-in (which lands on /comp) sails
  // past it. Onboarding renders outside this Shell, so there's no redirect
  // loop, and it bounces already-onboarded users straight back out.
  useEffect(() => {
    if (loading) return;
    if (user && !user.username) navigate("/onboarding", { replace: true });
  }, [user, loading, navigate]);

  return (
    <div className="flex min-h-dvh flex-col">
      {/* Always-present glass menu bar (Inscribe-style): translucent background
          with backdrop blur, so content scrolls beneath it. */}
      <header className="sticky top-0 z-40 border-b bg-background/70 backdrop-blur-xl backdrop-saturate-150">
        <nav
          aria-label="Main"
          className="mx-auto flex min-h-[60px] w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3"
        >
          {/* Home is a static (Astro) page, so use a full navigation. */}
          <a href="/" className="font-brand text-base font-semibold tracking-tight">
            GlideComp
          </a>
          <NavLink to="/comp" className={navLinkClass}>
            Competitions
          </NavLink>
          <NavLink to={flightsHref} className={navLinkClass}>
            My Flights
          </NavLink>
          <div className="ml-auto">
            {user ? (
              <UserMenu name={user.name ?? user.email ?? "Account"} />
            ) : !loading ? (
              <div className="flex items-center gap-2">
                {DEV_SIGN_IN_ENABLED ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void signInAsDev()}
                  >
                    Sign in (dev)
                  </Button>
                ) : null}
                <Button type="button" onClick={() => goToSignIn()}>
                  Sign in
                </Button>
              </div>
            ) : null}
          </div>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pt-6 pb-12">
        <Outlet />
      </main>

      <Separator />

      <footer className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-4 text-sm text-muted-foreground">
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
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="Account menu"
            className="flex size-8 items-center justify-center rounded-full border bg-muted text-xs font-semibold hover:bg-accent"
          />
        }
      >
        {initials}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/* Base UI's GroupLabel throws without a surrounding Group. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="max-w-56 truncate font-normal text-muted-foreground">
            {name}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => navigate("/settings")}>Settings</DropdownMenuItem>
          <DropdownMenuItem
            onClick={async () => {
              await signOut();
              navigate("/");
              window.location.reload();
            }}
          >
            Sign out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
      <button
        type="button"
        aria-label={`Preview as${active ? `: ${active.label}` : ""}. Click to change.`}
        onClick={() => setOpen(true)}
        className={cn(
          "fixed right-3 bottom-3 z-50 flex items-center gap-1.5 rounded-full border py-1 pr-3 pl-2.5 text-xs font-medium shadow-lg",
          previewing
            ? "bg-primary text-primary-foreground"
            : "bg-card text-muted-foreground hover:text-foreground"
        )}
      >
        <EyeIcon className="size-3.5" aria-hidden="true" />
        <span className="whitespace-nowrap">{previewing ? active?.label : "Preview as"}</span>
      </button>
    );
  }

  return (
    <div
      role="group"
      aria-label="Preview as"
      className="fixed right-3 bottom-3 z-50 flex items-center gap-1 rounded-full border bg-card py-1 pr-1.5 pl-3.5 text-xs shadow-lg"
    >
      <span className="mr-1 whitespace-nowrap text-muted-foreground">Preview as</span>
      {PREVIEW_ROLES.map(({ role, label }) => (
        <button
          key={role}
          type="button"
          aria-pressed={previewRole === role}
          className={cn(
            "rounded-full px-2.5 py-1 font-medium",
            previewRole === role
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
          onClick={() => setPreviewRole(role)}
        >
          {label}
        </button>
      ))}
      <button
        type="button"
        aria-label="Minimise preview switcher"
        onClick={() => setOpen(false)}
        className="ml-0.5 rounded-full p-1 text-muted-foreground hover:text-foreground"
      >
        <XIcon className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
