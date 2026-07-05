/**
 * Shared app chrome: header nav + footer around each routed page.
 * React port of nav.ts's initNav()/buildFooterHTML().
 */
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { Separator } from "@base-ui/react/separator";
import { signOut } from "../../auth/client";
import { signInWithGoogle, useUser } from "../lib/user";

declare const __GIT_SHA__: string;

export function Shell() {
  const { user, loading } = useUser();
  const navigate = useNavigate();
  const flightsHref = user?.username ? `/u/${user.username}` : "/u/me";

  return (
    <div>
      <header>
        <nav aria-label="Main">
          <Link to="/">GlideComp</Link>{" "}
          <NavLink to={flightsHref}>My Flights</NavLink>{" "}
          <NavLink to="/comp">Competitions</NavLink>{" "}
          {user ? (
            <>
              <NavLink to="/profile">My Profile</NavLink>{" "}
              <NavLink to="/settings" aria-label="Account settings">
                Settings
              </NavLink>
            </>
          ) : null}
          {!user && !loading ? (
            <button type="button" onClick={() => signInWithGoogle()}>
              Sign in
            </button>
          ) : null}
        </nav>
      </header>

      <main>
        <Outlet />
      </main>

      <Separator />

      <footer>
        <span>
          GlideComp{" "}
          <a
            href={`https://github.com/pokle/glidecomp/commit/${__GIT_SHA__}`}
            target="_blank"
            rel="noopener noreferrer"
            data-git-sha={__GIT_SHA__}
          >
            {__GIT_SHA__.slice(0, 7)}
          </a>
        </span>{" "}
        <a href="https://github.com/pokle/glidecomp" target="_blank" rel="noopener noreferrer">
          GitHub
        </a>{" "}
        <a href="https://www.youtube.com/@poklet" target="_blank" rel="noopener noreferrer">
          YouTube
        </a>{" "}
        <a href="/scoring.html">Scoring</a> <a href="/theme-editor">Theme Editor</a>{" "}
        <a href="/legal.html">Privacy &amp; Terms</a>{" "}
        {user ? (
          <button
            type="button"
            onClick={async () => {
              await signOut();
              navigate("/");
              window.location.reload();
            }}
          >
            Sign out
          </button>
        ) : null}
      </footer>
    </div>
  );
}
