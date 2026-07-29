/**
 * The report card's vocabulary, defined once at the foot of the page.
 *
 * The page is written for a pilot who does not know GAP, and it uses about a
 * dozen terms that pilot has no way to look up from where they are standing:
 * ESS, the speed section, nominal anything, validity, the goal ratio, the
 * leading coefficient, made good, the optimized task line. Several of the
 * explanation strings do expand a term on first use, but a reader who scrolls
 * to the middle of the page meets them cold, and expanding every term at
 * every use would bury the sentences doing the actual explaining.
 *
 * A collapsed disclosure is the right shape for that: invisible to a reader
 * who does not need it, one click for a reader who does, and — because the
 * RAC disclosure renders its panel in print regardless of state — present on
 * paper, where nothing can be clicked.
 *
 * Each term links to where /scoring/gap covers it, so the glossary is a
 * junction rather than a dead end. Definitions are one sentence and avoid
 * defining jargon with more jargon, which is the failure mode here.
 */
import { Disclosure } from "@/react/rac/disclosure";

interface Term {
  term: string;
  /** Where /scoring/gap covers it, when it covers it. */
  href?: string;
  definition: string;
}

/**
 * Ordered roughly as the page uses them — flight first, then the day, then
 * the components — rather than alphabetically, so a reader scanning after
 * hitting a term meets it near where they left off.
 */
const TERMS: Term[] = [
  {
    term: "Start cylinder (SSS)",
    href: "/scoring/gap#how-a-task-works",
    definition:
      "The circle around the start turnpoint. The race clock begins when you cross it in the required direction, or at the start gate you took.",
  },
  {
    term: "Speed section",
    href: "/scoring/gap#how-a-task-works",
    definition:
      "The timed part of the task: from the start to the end of the speed section. Time points are earned here, and only here.",
  },
  {
    term: "End of speed section (ESS)",
    href: "/scoring/gap#how-a-task-works",
    definition:
      "Where the clock stops — usually a cylinder shortly before goal, so pilots are not racing all the way to the ground.",
  },
  {
    term: "Optimized task line",
    href: "/scoring/gap#how-a-task-works",
    definition:
      "The shortest legal way around the turnpoints, clipping each cylinder rather than flying to its centre. Every distance on this page is measured along it.",
  },
  {
    term: "Made good",
    href: "/scoring/gap#distance-points",
    definition:
      "How far along that line you got — not how far you flew. Wandering off course adds kilometres to your track but none to your distance made good.",
  },
  {
    term: "Minimum distance",
    href: "/scoring/gap#minimum-distance",
    definition:
      "A floor: a pilot who flies less than this is scored as if they flew it, so a short flight is never worth less than nothing.",
  },
  {
    term: "Nominal distance / time / goal / launch",
    href: "/scoring/gap#task-validity",
    definition:
      "What the organiser expected of a good day — a typical task length, duration, share of pilots in goal, and share of pilots launching. They are the yardsticks the day is measured against, not targets anyone must hit.",
  },
  {
    term: "Validity",
    href: "/scoring/gap#task-validity",
    definition:
      "How much of a full 1000-point day this task was worth. A day where few launched, nobody got far, or the winner was round very quickly counts for less in the overall standings.",
  },
  {
    term: "Goal ratio",
    href: "/scoring/gap#scoring-components",
    definition:
      "The share of flying pilots who made goal. It decides how the day's points are split between distance and the other components.",
  },
  {
    term: "Leading coefficient",
    href: "/scoring/gap#leading-coefficient",
    definition:
      "A measure of how much of the race you spent out in front, as an area under your distance-over-time curve. Lower is better; the absolute number means nothing on its own, only the comparison does.",
  },
  {
    term: "Distance difficulty",
    href: "/scoring/gap#distance-difficulty",
    definition:
      "Hang gliding only: half the distance points are weighted by where the field landed out, so getting past a stretch that stopped many pilots is worth more than easy kilometres.",
  },
  {
    term: "Jump the gun",
    href: "/scoring/gap#total-score",
    definition:
      "Starting before the first start gate opened. Paraglider pilots are scored only to the start cylinder; hang glider pilots take a penalty that grows with how early they were.",
  },
];

export function ScoringGlossary() {
  return (
    <Disclosure title="Terms on this page" className="mt-4">
      <dl className="mt-2 space-y-3">
        {TERMS.map((t) => (
          <div key={t.term}>
            <dt className="text-sm font-medium">
              {t.href ? (
                <a href={t.href} className="underline underline-offset-2">
                  {t.term}
                </a>
              ) : (
                t.term
              )}
            </dt>
            <dd className="text-xs text-muted-foreground">{t.definition}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">
        <a href="/scoring/gap" className="underline underline-offset-2">
          The full guide to GAP scoring
        </a>
      </p>
    </Disclosure>
  );
}
