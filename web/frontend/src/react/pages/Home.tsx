/** Landing page — React port of index.html. */
import { Link } from "react-router-dom";
import { Button } from "@/react/ui/button";
import { signInWithGoogle } from "../lib/user";

export function Home() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-10">
      <h1 className="font-brand text-2xl font-bold">GlideComp</h1>
      <p className="text-muted-foreground">
        Competition track log analysis for hanggliding and paragliding
      </p>

      <div>
        <Button type="button" onClick={() => signInWithGoogle()}>
          Login with Google
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        <em>(It's free!)</em>
      </p>
      <p className="text-sm text-muted-foreground">
        By signing in, you agree to our{" "}
        <Link to="/legal" className="underline underline-offset-4">
          Privacy Policy &amp; Terms
        </Link>
      </p>

      <img
        src="/glidecomp-screenshot.png"
        alt="GlideComp analysis interface showing a map with flight tracks and waypoints"
        className="rounded-lg border"
      />

      <a href="/replay" className="mt-4 flex flex-col gap-2">
        <img
          src="/3dvis-screenshot.jpg"
          alt="3D flight replay showing colourful glider tracks weaving between task cylinders"
          className="rounded-lg border"
        />
        <h2 className="text-lg font-bold">3D Flight Replay</h2>
        <span className="text-sm text-muted-foreground">Experimental</span>
        <p>
          An experimental 3D replay of a competition (Corryong Cup 2026 Task 1). Shows the flight
          path of all gliders all together.
        </p>
        <p className="text-sm text-muted-foreground">28 June 2026</p>
      </a>

      <footer className="mt-8 flex flex-wrap gap-x-4 gap-y-1 border-t pt-4 text-sm text-muted-foreground">
        <Link to="/u/me" className="underline">
          Sign in
        </Link>
        <a
          href="https://github.com/pokle/glidecomp"
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          GitHub
        </a>
        <a
          href="https://www.youtube.com/@poklet"
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          YouTube
        </a>
        <Link to="/scoring" className="underline">
          Scoring
        </Link>
        <Link to="/about" className="underline">
          About
        </Link>
        <Link to="/legal" className="underline">
          Privacy &amp; Terms
        </Link>
        <Link to="/comp" className="underline">
          Competitions
        </Link>
      </footer>
    </main>
  );
}
