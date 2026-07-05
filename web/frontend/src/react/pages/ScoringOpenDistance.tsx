/**
 * Open distance scoring guide — React port of scoring-open-distance.html.
 * (No KaTeX needed: its formula boxes are plain text, not math delimiters.)
 */
import { useEffect } from "react";
import { Link } from "react-router-dom";

export function ScoringOpenDistance() {
  useEffect(() => {
    document.title = "GlideComp - How Open Distance Scoring Works";
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground p-6 bg-hills">
      <div className="max-w-2xl mx-auto">
        <header className="mb-10">
          <Link
            to="/scoring"
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
            Scoring
          </Link>
          <h1 className="text-3xl font-bold flex items-center gap-3">
            <img src="/icon.svg" alt="GlideComp logo" className="w-8 h-8" />
            How Open Distance Scoring Works
          </h1>
          <p className="text-muted-foreground mt-1">
            Fly as far as you can — the simplest way to score a competition day
          </p>
        </header>

        {/* Table of Contents */}
        <nav className="mb-10 p-4 rounded-lg border border-border bg-card">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Contents
          </h2>
          <ul className="space-y-1 text-sm">
            <li>
              <a href="#what-is-open-distance" className="hover:underline">
                What is Open Distance?
              </a>
            </li>
            <li>
              <a href="#how-a-task-works" className="hover:underline">
                How a Task Works
              </a>
            </li>
            <li>
              <a href="#how-distance-is-measured" className="hover:underline">
                How Your Distance is Measured
              </a>
            </li>
            <li>
              <a href="#your-score" className="hover:underline">
                Your Score
              </a>
            </li>
            <li>
              <a href="#glidecomp-notes" className="hover:underline">
                GlideComp Implementation Notes
              </a>
            </li>
          </ul>
        </nav>

        {/* What is Open Distance? */}
        <section id="what-is-open-distance" className="mb-14">
          <h2 className="text-2xl font-bold mb-4">What is Open Distance?</h2>
          <div className="space-y-4 text-sm leading-relaxed">
            <p className="text-muted-foreground">
              Open distance is the simplest way to run a competition day. Everyone takes off from
              the same launch and then flies as far as they can — there is no set course and no
              goal to reach. The only thing that matters is how far you get from launch.
            </p>
            <p className="text-muted-foreground">
              This is the classic "free distance" or record-style format, and it contrasts with{" "}
              <Link to="/scoring/gap" className="underline hover:text-foreground">
                GAP scoring
              </Link>
              , where pilots race a defined course of turnpoints to a goal. Open distance has no
              speed section, no turnpoints to tag, and no time, leading or arrival points — your
              whole score is the distance you flew.
            </p>
          </div>
        </section>

        {/* How a Task Works */}
        <section id="how-a-task-works" className="mb-14">
          <h2 className="text-2xl font-bold mb-4">How a Task Works</h2>
          <div className="space-y-4 text-sm leading-relaxed">
            <p className="text-muted-foreground">
              An open-distance task defines exactly one turnpoint: the <strong>Take-off</strong>.
              It is a cylinder around the launch, and it marks the point from which distance is
              measured. There is no start gate, no intermediate turnpoints, and no goal.
            </p>
            <p className="text-muted-foreground">
              You launch, leave the take-off cylinder, and fly. When you land (or the day ends),
              your flight is scored on how far you travelled from the take-off.
            </p>
          </div>
        </section>

        {/* How Your Distance is Measured */}
        <section id="how-distance-is-measured" className="mb-14">
          <h2 className="text-2xl font-bold mb-4">How Your Distance is Measured</h2>
          <div className="space-y-4 text-sm leading-relaxed">
            <p className="text-muted-foreground">
              Your scored distance is the straight-line distance from the point you{" "}
              <strong>exit the take-off cylinder</strong> to the single{" "}
              <strong>furthest point</strong> your track reached:
            </p>
            <p className="bg-muted/50 rounded px-3 py-2 inline-block">
              Distance = furthest straight-line distance from the take-off exit to any point you
              flew
            </p>
            <p className="text-muted-foreground">A few things follow from this:</p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ml-2">
              <li>
                <strong>Measured from the take-off exit, not the centre.</strong> Distance is
                counted from where your track crosses out of the take-off cylinder, so the radius
                of the cylinder is not counted as free distance.
              </li>
              <li>
                <strong>Only getting further counts.</strong> The score is straight-line
                displacement from launch, so circling to climb in a thermal does not add to it —
                only reaching a point further away does.
              </li>
              <li>
                <strong>The furthest point wins, not the landing point.</strong> If you fly out to
                a far point and then drift back towards launch before landing, you are scored on
                the furthest point you reached, not where you touched down.
              </li>
              <li>
                <strong>Distances use the WGS84 ellipsoid</strong> (the same geodesic maths used
                everywhere else in GlideComp), so they match what you would measure on the map.
              </li>
            </ul>
            <p className="text-muted-foreground">
              If a pilot never leaves the take-off cylinder, their distance is zero. If a track
              happens to start already outside the cylinder (for example the logger was switched on
              after launch), distance is measured from the first recorded point instead, so the
              flight still scores.
            </p>
          </div>
        </section>

        {/* Your Score */}
        <section id="your-score" className="mb-14">
          <h2 className="text-2xl font-bold mb-4">Your Score</h2>
          <div className="space-y-4 text-sm leading-relaxed">
            <p className="text-muted-foreground">
              Your score for the task is simply your open distance in <strong>metres</strong>:
            </p>
            <p className="bg-muted/50 rounded px-3 py-2 inline-block">
              Score = metres of open distance flown
            </p>
            <p className="text-muted-foreground">
              Pilots are ranked by distance, furthest first. There is no 1000-point pool, no task
              validity, and no distance/time/leading/arrival split — those all belong to GAP. The
              distance you flew <em>is</em> the score.
            </p>
            <p className="text-muted-foreground">
              Any penalty an organiser applies is subtracted from your score in metres. Across a
              multi-day competition, your total is the sum of your task scores — that is, the total
              distance you flew over all the days.
            </p>
          </div>
        </section>

        {/* GlideComp Implementation Notes */}
        <section id="glidecomp-notes" className="mb-14">
          <h2 className="text-2xl font-bold mb-4">GlideComp Implementation Notes</h2>
          <div className="space-y-4 text-sm leading-relaxed">
            <p className="text-muted-foreground">
              A competition is set to open distance in its scoring settings, and then every task in
              it is scored this way. Because the format has no goal or turnpoints, each task must
              define exactly one turnpoint — the Take-off — and GlideComp will not let you save a
              task with any other route while the competition is on open distance.
            </p>
            <p className="text-muted-foreground">
              Every scoring decision is explainable and unit-tested, and the scoring engine source
              code is open and available on{" "}
              <a
                href="https://github.com/pokle/glidecomp"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-foreground"
              >
                GitHub
              </a>
              .
            </p>
            <p className="text-muted-foreground">
              Looking for the other format? See{" "}
              <Link to="/scoring/gap" className="underline hover:text-foreground">
                how GAP scoring works
              </Link>
              .
            </p>
          </div>
        </section>

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
          <Link to="/scoring" className="hover:text-foreground transition-colors">
            Scoring
          </Link>
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
