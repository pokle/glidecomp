/** Scoring formats overview page — React port of scoring.html. */
import { useEffect } from "react";
import { Link } from "react-router-dom";

export function Scoring() {
  useEffect(() => {
    document.title = "GlideComp - Scoring";
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground p-6 bg-hills">
      <div className="max-w-2xl mx-auto">
        <header className="mb-10">
          <Link
            to="/"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Back
          </Link>
          <h1 className="text-3xl font-bold flex items-center gap-3">
            <img src="/icon.svg" alt="GlideComp logo" className="w-8 h-8" />
            Scoring
          </h1>
          <p className="text-muted-foreground mt-1">How GlideComp scores competitions</p>
        </header>

        <section className="mb-10">
          <div className="space-y-4 text-sm leading-relaxed">
            <p className="text-muted-foreground">
              Every GlideComp competition is scored with one of two formats, chosen by the
              organiser in the competition settings. Pick a format below to read how it works in
              detail.
            </p>
          </div>
        </section>

        {/* GAP */}
        <Link
          to="/scoring/gap"
          className="block mb-6 p-5 rounded-lg border border-border bg-card hover:border-primary/60 transition-colors group"
        >
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xl font-bold">
              GAP <span className="text-sm font-normal text-muted-foreground">race to goal</span>
            </h2>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-muted-foreground group-hover:text-foreground transition-colors"
            >
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">
            The standard CIVL scoring used at most paragliding and hang gliding competitions.
            Pilots race a set course through turnpoints to a goal. A perfect task day is worth 1000
            points, shared between distance, time, leading and arrival based on how each pilot
            performed relative to the field. Best for tasks with a defined route and goal.
          </p>
          <span className="inline-flex items-center gap-1 text-sm font-medium mt-3 text-foreground group-hover:underline">
            Read how GAP works
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </span>
        </Link>

        {/* Open Distance */}
        <Link
          to="/scoring/open-distance"
          className="block mb-6 p-5 rounded-lg border border-border bg-card hover:border-primary/60 transition-colors group"
        >
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xl font-bold">
              Open distance{" "}
              <span className="text-sm font-normal text-muted-foreground">
                fly as far as you can
              </span>
            </h2>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-muted-foreground group-hover:text-foreground transition-colors"
            >
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Everyone launches from the same spot and flies as far as they can, with no set goal.
            Each task has a single take-off turnpoint, and your score is simply the metres of open
            distance flown — the straight-line distance from the point you leave the take-off
            cylinder to the furthest point you reached. Best for free-distance and record-style
            days.
          </p>
          <span className="inline-flex items-center gap-1 text-sm font-medium mt-3 text-foreground group-hover:underline">
            Read how open distance works
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </span>
        </Link>

        <footer className="pt-6 border-t border-border text-sm text-muted-foreground flex items-center gap-4">
          <a
            href="https://github.com/pokle/glidecomp"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
            </svg>
            GlideComp on GitHub
          </a>
          <Link to="/about" className="hover:text-foreground transition-colors">
            About
          </Link>
          <Link to="/legal" className="hover:text-foreground transition-colors">
            Privacy &amp; Terms
          </Link>
        </footer>
      </div>
    </div>
  );
}
