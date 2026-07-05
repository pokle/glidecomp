/** Landing page — React port of index.html. */
import { Link } from "react-router-dom";
import { signInWithGoogle } from "../lib/user";

export function Home() {
  return (
    <main>
      <h1>GlideComp</h1>
      <p>Competition track log analysis for hanggliding and paragliding</p>

      <button type="button" onClick={() => signInWithGoogle()}>
        Login with Google
      </button>
      <p>
        <em>(It's free!)</em>
      </p>
      <p>
        By signing in, you agree to our <a href="/legal.html">Privacy Policy &amp; Terms</a>
      </p>

      <img
        src="/glidecomp-screenshot.png"
        alt="GlideComp analysis interface showing a map with flight tracks and waypoints"
      />

      <a href="/replay">
        <img
          src="/3dvis-screenshot.jpg"
          alt="3D flight replay showing colourful glider tracks weaving between task cylinders"
        />
        <h2>3D Flight Replay</h2>
        <span>Experimental</span>
        <p>
          An experimental 3D replay of a competition (Corryong Cup 2026 Task 1). Shows the flight
          path of all gliders all together.
        </p>
        <p>28 June 2026</p>
      </a>

      <footer>
        <Link to="/u/me">Sign in</Link>{" "}
        <a href="https://github.com/pokle/glidecomp" target="_blank" rel="noopener noreferrer">
          GitHub
        </a>{" "}
        <a href="https://www.youtube.com/@poklet" target="_blank" rel="noopener noreferrer">
          YouTube
        </a>{" "}
        <a href="/scoring.html">Scoring</a> <a href="/about.html">About</a>{" "}
        <a href="/legal.html">Privacy &amp; Terms</a> <Link to="/comp">Competitions</Link>
      </footer>
    </main>
  );
}
