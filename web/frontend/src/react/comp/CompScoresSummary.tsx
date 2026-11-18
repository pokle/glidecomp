/**
 * Compact whole-comp scores summary for the comp hub: the top 3 of each
 * class (overall totals) and the link to the full scores page — the hub
 * answers "who's winning?" at a glance, /comp/:id/scores holds the full
 * apparatus (all pilots, per-task scores, Top 3 per task, Teams).
 *
 * That last sentence used to be printed under the list, in prose. It said
 * nothing the section header's "Full scores" button and the "+ N more pilots"
 * link either side of it did not already say, so it is a comment now.
 *
 * Shares the SSR-seedable useCompScores state machine with the scores page,
 * so the summary is in the server HTML like the old inline section was.
 *
 * The podium is the scores page's own rows (comp/score-rows.tsx): each opens
 * the pilot's scores, and "+ N more pilots" is a row of the same list that
 * opens the full standings on that class — a target as big as the rows above
 * it, where it was a line of small print.
 */
import { Link as AriaLink } from "react-aria-components";
import { ChevronRightIcon } from "lucide-react";
import { LinkButton } from "@/react/rac/button";
import { navRowClass } from "@/react/rac/nav-list";
import { Card } from "@/react/rac/card";
import { SectionHeader } from "../components/SectionHeader";
import { ordinal } from "../lib/format";
import { compPilotScoresPath, compScoresPath } from "../lib/slug";
import { Points, ScoreLinkRow, ScoreList } from "./score-rows";
import { ScoreFreshness } from "./ScoreFreshness";
import { ScoresEmptyState, useCompScores } from "./CompScoresSection";
import type { CompScores } from "../loaders";

export function CompScoresSummary({
  compId,
  compName = null,
  timezone,
  initialScores,
  initialScoresEtag,
  isAdmin = false,
}: {
  /** As it goes in URLs: a hidden comp's share key rides along. */
  compId: string;
  /** For canonical links; they work from the id alone while it loads. */
  compName?: string | null;
  timezone: string | null;
  /** SSR-seeded scores so the summary is in the first paint (server HTML). */
  initialScores?: CompScores;
  initialScoresEtag?: string | null;
  /** Admins get an actionable empty state (false during SSR/first paint). */
  isAdmin?: boolean;
}) {
  const { state } = useCompScores(compId, initialScores, initialScoresEtag);
  const scoresHref = compScoresPath(compId, compName);

  return (
    <Card id="scores" className="scroll-mt-24">
      <SectionHeader
        title="Scores"
        action={
          state.kind === "ready" && state.scores.class_scores.length > 0 ? (
            <LinkButton variant="outline" size="sm" href={scoresHref}>
              Full scores
            </LinkButton>
          ) : null
        }
      />
      {state.kind === "loading" ? (
        <p className="mt-2 text-muted-foreground">Loading scores…</p>
      ) : state.kind === "unavailable" || state.scores.class_scores.length === 0 ? (
        <ScoresEmptyState isAdmin={isAdmin} />
      ) : (
        <>
          <ScoreFreshness
            computedAt={state.scores.computed_at}
            stale={state.scores.stale}
            timezone={timezone}
            etag={state.etag}
            pollUrl={`/api/comp/${encodeURIComponent(compId)}/scores`}
          />
          <div className="mt-2 grid gap-x-6 gap-y-4 sm:grid-cols-2">
            {state.scores.class_scores.map((cls, i) => {
              const top = cls.pilots.slice(0, 3);
              const more = cls.pilots.length - top.length;
              // The first class is the standings' default; another is named.
              const classHref = i === 0 ? scoresHref : `${scoresHref}?class=${encodeURIComponent(cls.pilot_class)}`;
              return (
                <div key={cls.pilot_class} className="min-w-0">
                  {state.scores.class_scores.length > 1 ? (
                    <h3 className="mb-1.5 font-semibold">{cls.pilot_class}</h3>
                  ) : null}
                  <ScoreList label={`Top 3 — ${cls.pilot_class}`}>
                    {top.map((p) => (
                      <ScoreLinkRow
                        key={p.comp_pilot_id}
                        href={compPilotScoresPath(compId, compName, p.comp_pilot_id, p.pilot_name)}
                        rank={ordinal(p.rank)}
                        title={p.pilot_name}
                        figure={<Points value={p.total_score} />}
                      />
                    ))}
                    {more > 0 ? (
                      <li>
                        <AriaLink href={classHref} className={navRowClass}>
                          <span className="min-w-0 flex-1 pl-13 text-muted-foreground">
                            + {more} more pilot{more === 1 ? "" : "s"}
                          </span>
                          <ChevronRightIcon
                            aria-hidden="true"
                            className="size-4 shrink-0 text-muted-foreground"
                          />
                        </AriaLink>
                      </li>
                    ) : null}
                  </ScoreList>
                </div>
              );
            })}
          </div>
        </>
      )}
    </Card>
  );
}
