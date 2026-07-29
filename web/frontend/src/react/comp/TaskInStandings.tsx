/**
 * What this task did to the pilot's competition standing.
 *
 * The report card ends at the task total, which leaves the reader's last
 * question unanswered: so where does that put me? On an FTV comp the answer
 * can even be "nowhere" — a task can be discarded entirely — and a pilot who
 * has just read a full accounting of 579.5 points deserves to know that
 * before they go looking for them in the standings.
 *
 * Fetched CLIENT-SIDE ONLY, deliberately, and absent from the SSR loader.
 * `/api/comp/:id/scores` is the whole comp: every pilot × every task. Adding
 * it to the report card's server render would multiply that page's payload
 * for one closing paragraph, on the page that is the site's SEO centrepiece.
 * It is supplementary — the score is fully explained without it — so it
 * arrives after hydration and simply does not appear if the request fails.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { FtvTaskStatus } from "@glidecomp/engine";
import type { CompScores } from "../loaders";
import { formatScore, ordinal } from "../lib/format";
import { compPath } from "../lib/slug";

interface Standing {
  /** Where the pilot sits in their class overall. */
  rank: number;
  fieldSize: number;
  compTotal: number;
  /** What this task contributed to that total. */
  taskScore: number;
  seriesScoring: "total" | "ftv";
  /** FTV comps only: how this task counted toward the pilot's total
   * (engine FtvTaskStatus — 'full' | 'partial' | 'discarded'). */
  ftvStatus?: FtvTaskStatus;
  ftvCountedScore?: number;
}

function findStanding(
  scores: CompScores,
  taskId: string,
  compPilotId: string
): Standing | null {
  for (const cls of scores.standings) {
    const idx = cls.pilots.findIndex((p) => p.comp_pilot_id === compPilotId);
    if (idx < 0) continue;
    const pilot = cls.pilots[idx];
    const task = pilot.tasks.find((t) => t.task_id === taskId);
    if (!task) return null;
    return {
      rank: pilot.rank,
      fieldSize: cls.pilots.length,
      compTotal: pilot.total_score,
      taskScore: task.score,
      seriesScoring: scores.series_scoring,
      ftvStatus: task.ftv_status,
      ftvCountedScore: task.ftv_counted_score,
    };
  }
  return null;
}

export function TaskInStandings({
  compId,
  compName,
  taskId,
  compPilotId,
}: {
  compId: string;
  compName: string | null;
  taskId: string;
  compPilotId: string;
}) {
  const [standing, setStanding] = useState<Standing | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStanding(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/comp/${encodeURIComponent(compId)}/scores`,
          { credentials: "include" }
        );
        if (!res.ok) return;
        const scores = (await res.json()) as CompScores;
        if (!cancelled) setStanding(findStanding(scores, taskId, compPilotId));
      } catch {
        // Supplementary: a failure here leaves the section out, and the score
        // above it is explained in full regardless.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compId, taskId, compPilotId]);

  if (!standing) return null;

  const scoresHref = `${compPath(compId, compName)}/scores`;
  const discarded = standing.ftvStatus === "discarded";
  const partial = standing.ftvStatus === "partial";

  return (
    <section className="rounded-lg border p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-semibold">This task in the competition</h2>
        <span className="shrink-0 font-semibold tabular-nums">
          {ordinal(standing.rank)} of {standing.fieldSize}
        </span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {/* The FTV cases first: "your 579.5 points did not count" is the one
            thing a reader must not have to infer from a total that does not
            add up. */}
        {discarded ? (
          <>
            Under Fixed Total Validity this task was <strong>discarded</strong> —
            it was among your weakest and does not count toward your{" "}
            {formatScore(standing.compTotal)}-point competition total.
          </>
        ) : partial ? (
          <>
            Under Fixed Total Validity this task counted{" "}
            <strong>in part</strong>:{" "}
            {formatScore(standing.ftvCountedScore ?? standing.taskScore)} of its{" "}
            {formatScore(standing.taskScore)} points went into your{" "}
            {formatScore(standing.compTotal)}-point competition total.
          </>
        ) : (
          <>
            These {formatScore(standing.taskScore)} points are part of your{" "}
            {formatScore(standing.compTotal)}-point competition total.
          </>
        )}
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        <Link to={scoresHref} className="underline underline-offset-2">
          Full competition standings
        </Link>
      </p>
    </section>
  );
}
