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
 * What is left is the pair that belongs to no section: how the field's airtime
 * divided between flight phases, and how many pilots the scores hold that this
 * analysis could not measure. The names and reasons behind that count are
 * reference material a reader consults once — on a task where eight pilots
 * flew without tracklogs the list ran longer than every fact above it put
 * together — so `excludedHref` points at the page that carries them.
 *
 * Renders nothing at all when it has neither: a report stored before the split
 * existed (v12 or earlier, served while it revalidates) can leave this with
 * nothing to say, and an empty card is worse than no card.
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
  if (!basis.airtimeSplit && excluded.length === 0) return null;

  return (
    <Card aria-label="Analysis basis">
      {/* Three shares of one whole, read against each other, so the bars take
          the full width rather than sit in a column beside anything. */}
      {basis.airtimeSplit ? (
        <dl>
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
            basis.airtimeSplit ? "mt-4 border-t pt-3 text-sm" : "text-sm"
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
