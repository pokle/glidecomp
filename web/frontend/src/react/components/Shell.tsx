/**
 * Shared app chrome: header nav + footer around each routed page.
 * React port of nav.ts's initNav()/buildFooterHTML().
 */
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { Button } from "@/react/ui/button";
import { Separator } from "@/react/ui/separator";
import { cn } from "@/react/lib/utils";
import { signOut } from "../../auth/client";
import { signInWithGoogle, useUser } from "../lib/user";

declare const __GIT_SHA__: string;

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "text-sm font-medium transition-colors hover:text-foreground",
    isActive ? "text-foreground underline underline-offset-8" : "text-muted-foreground"
  );

export function Shell() {
  const { user, loading } = useUser();
  const navigate = useNavigate();
  const flightsHref = user?.username ? `/u/${user.username}` : "/u/me";

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b">
        <nav
          aria-label="Main"
          className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3"
        >
          <Link to="/" className="text-base font-bold">
            GlideComp
          </Link>
          <NavLink to={flightsHref} className={navLinkClass}>
            My Flights
          </NavLink>
          <NavLink to="/comp" className={navLinkClass}>
            Competitions
          </NavLink>
          {user ? (
            <>
              <NavLink to="/profile" className={navLinkClass}>
                My Profile
              </NavLink>
              <NavLink to="/settings" aria-label="Account settings" className={navLinkClass}>
                Settings
              </NavLink>
            </>
          ) : null}
          {!user && !loading ? (
            <Button type="button" className="ml-auto" onClick={() => signInWithGoogle()}>
              Sign in
            </Button>
          ) : null}
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
        <Link to="/scoring" className="underline underline-offset-4 hover:text-foreground">
          Scoring
        </Link>
        <Link to="/legal" className="underline underline-offset-4 hover:text-foreground">
          Privacy &amp; Terms
        </Link>
        {user ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={async () => {
              await signOut();
              navigate("/");
              window.location.reload();
            }}
          >
            Sign out
          </Button>
        ) : null}
      </footer>
    </div>
  );
}
