/**
 * Compact whole-comp standings summary for the comp hub: the top 3 of each
 * class (overall totals) and the link to the full scores page — the hub
 * answers "who's winning?" at a glance, /comp/:id/scores holds the full
 * apparatus (all pilots, per-task results, Top 3 per task, Teams).
 *
 * Shares the SSR-seedable useCompScores state machine with the scores page,
 * so the summary is in the server HTML like the old inline section was.
 */
import { Link } from "react-router-dom";
import { LinkButton } from "@/react/rac/button";
import { SectionHeader } from "../components/SectionHeader";
import { formatScore, ordinal } from "../lib/format";
import { ScoreFreshness } from "./ScoreFreshness";
import { ScoresEmptyState, useCompScores } from "./CompScoresSection";
import type { CompScores } from "../loaders";

export function CompScoresSummary({
  compId,
  timezone,
  initialScores,
  initialScoresEtag,
  isAdmin = false,
}: {
  compId: string;
  timezone: string | null;
  /** SSR-seeded scores so the summary is in the first paint (server HTML). */
  initialScores?: CompScores;
  initialScoresEtag?: string | null;
  /** Admins get an actionable empty state (false during SSR/first paint). */
  isAdmin?: boolean;
}) {
  const { state } = useCompScores(compId, initialScores, initialScoresEtag);
  const scoresHref = `/comp/${compId}/scores`;

  return (
    <section id="scores" className="scroll-mt-24 break-before-page">
      <SectionHeader
        title="Standings"
        action={
          state.kind === "ready" && state.scores.standings.length > 0 ? (
            <LinkButton variant="outline" size="sm" href={scoresHref}>
              Full scores
            </LinkButton>
          ) : null
        }
      />
      {state.kind === "loading" ? (
        <p className="mt-2 text-muted-foreground">Loading scores…</p>
      ) : state.kind === "unavailable" || state.scores.standings.length === 0 ? (
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
          <div className="mt-1 flex flex-wrap gap-x-12 gap-y-4">
            {state.scores.standings.map((cls) => {
              const top = cls.pilots.slice(0, 3);
              const more = cls.pilots.length - top.length;
              return (
                <div key={cls.pilot_class} className="min-w-56">
                  {state.scores.standings.length > 1 ? (
                    <h3 className="mt-2 font-semibold">{cls.pilot_class}</h3>
                  ) : null}
                  <ol className="mt-1.5 space-y-1 text-sm">
                    {top.map((p) => (
                      <li
                        key={p.comp_pilot_id}
                        className="flex items-baseline gap-x-2"
                      >
                        <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">
                          {ordinal(p.rank)}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{p.pilot_name}</span>
                        <span className="tabular-nums">
                          <strong>{formatScore(p.total_score)}</strong>{" "}
                          <span className="text-muted-foreground">pts</span>
                        </span>
                      </li>
                    ))}
                  </ol>
                  {more > 0 ? (
                    <p className="mt-1 pl-10 text-sm text-muted-foreground">
                      <Link
                        className="underline underline-offset-4 hover:text-foreground"
                        to={scoresHref}
                      >
                        + {more} more pilot{more === 1 ? "" : "s"}
                      </Link>
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            <Link className="underline underline-offset-4" to={scoresHref}>
              Full scores
            </Link>{" "}
            has every pilot, per-task results, top 3 per task, and team standings.
          </p>
        </>
      )}
    </section>
  );
}
