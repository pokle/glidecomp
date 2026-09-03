/**
 * What the analysis rests on, once the readings themselves have gone to the
 * sections they belong to.
 *
 * It used to be a row of tiles — pilots, airtime, thermals, working band —
 * with nothing to say which section each reading belonged to. Every one of
 * them now sits on the box for the section it describes, the working band
 * beside the thermals it is the band OF, which says more than any of them did
 * in a row of four. See analysis/basis-facts.ts.
 *
 * What is left belongs to no section: how hard the day was, how the field's
 * airtime divided between flight phases, and how many pilots the scores hold
 * that this analysis could not measure. The names and reasons behind that
 * count are reference material a reader consults once — on a task where eight
 * pilots flew without tracklogs the list ran longer than every fact above it
 * put together — so `excludedHref` points at the page that carries them.
 *
 * The goal share leads, because it is the fact the rest of the page has to be
 * read against rather than one more reading among them: several of the
 * behaviours below only separate the field on one kind of day, and one of
 * them (gliding wide of the course line) reverses sign between an easy day
 * and a hard one. See TaskAnalysisBasis.goalCount.
 *
 * Renders nothing at all when it has none of the three: a stored report from
 * before one of these fields existed is SERVED while it revalidates, and can
 * leave this with nothing to say. An empty card is worse than no card.
 */
import { Card } from "@/react/rac/card";
import { AirtimeSplitBar } from "./charts/AirtimeSplitBar";
import { EXCLUDED_PILOTS_ID } from "./Footnotes";
import type { TaskAnalysisBasis } from "./types";

export function AnalysisBasis({
  basis,
  excluded,
  excludedHref,
}: {
  basis: TaskAnalysisBasis;
  excluded: { pilot_name: string; reason: string }[];
  /** Where the excluded pilots are named. A prop rather than a bare `#`
   * anchor: the list is on its own page (the method section), so this box
   * cannot assume it is on the same one. */
  excludedHref?: string;
}) {
  // `goalCount` is optional (a v25-or-earlier row, served while it
  // revalidates) and ZERO is a real reading — the hardest day there is — so
  // this tests for undefined, never for falsiness. A field of no pilots is
  // the one case with nothing to say: "0 of 0" is a degenerate report, not a
  // difficult day.
  const goal =
    basis.goalCount !== undefined && basis.pilotCount > 0
      ? {
          count: basis.goalCount,
          pct: Math.round((100 * basis.goalCount) / basis.pilotCount),
        }
      : null;

  if (!goal && !basis.airtimeSplit && excluded.length === 0) return null;

  return (
    <Card aria-label="Analysis basis">
      {/* How hard the day was, in the terms pilots use for it. Counted over
          the analysed field, which is the same population every correlation
          on this page was measured over — and the same one the exclusion note
          below accounts for. */}
      {goal ? (
        <p className="text-sm">
          <strong className="tabular-nums">
            {goal.count} of {basis.pilotCount}
          </strong>{" "}
          made goal{" "}
          <span className="tabular-nums text-muted-foreground">
            ({goal.pct}%)
          </span>
        </p>
      ) : null}

      {/* Three shares of one whole, read against each other, so the bars take
          the full width rather than sit in a column beside anything. */}
      {basis.airtimeSplit ? (
        <dl className={goal ? "mt-4 border-t pt-3" : undefined}>
          <div>
            <dt className="text-xs text-muted-foreground">Airtime split</dt>
            <dd className="text-sm tabular-nums">
              <AirtimeSplitBar split={basis.airtimeSplit} />
            </dd>
          </div>
        </dl>
      ) : null}

      {/* The count belongs here rather than on a section's box: it qualifies
          the whole analysis, not one reading in it. */}
      {excluded.length > 0 ? (
        <p
          className={
            goal || basis.airtimeSplit
              ? "mt-4 border-t pt-3 text-sm"
              : "text-sm"
          }
        >
          <strong>{excluded.length}</strong> pilot
          {excluded.length === 1 ? " is" : "s are"} in the scores but not in
          this analysis.{" "}
          <a
            href={excludedHref ?? `#${EXCLUDED_PILOTS_ID}`}
            className="text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Which, and why
          </a>
        </p>
      ) : null}
    </Card>
  );
}
