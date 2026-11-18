/**
 * One task's scores, a list per class: a row per pilot with their rank, what
 * they did (goal and time, or the distance flown) and their points. The whole
 * row is a link to the pilot's report card, which explains every point; open
 * distance has no goal, so its rows give the distance alone.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/react/rac/badge";
import { api } from "../../comp/api";
import { formatDuration } from "../lib/format";
import { formatTimeInZone } from "../lib/time";
import { formatDistance, useUnits } from "../lib/units";
import { ScoreFreshness } from "./ScoreFreshness";
import { pilotPath } from "../lib/slug";
import { useCompName } from "./comp-name-context";
import { Points, ScoreLinkRow, ScoreList } from "./score-rows";
import type {
  ClassScore,
  ScoringFormat,
  TaskScoreData,
} from "./types";

type ScoresState =
  | { kind: "loading" }
  | { kind: "no-route" }
  | { kind: "unavailable" }
  | { kind: "loaded"; data: TaskScoreData; etag: string | null };

export function ScoresSection({
  compId,
  taskId,
  taskName = null,
  refresh,
  timezone,
  onReplayAvailable,
  embedded = false,
  initialScore,
}: {
  compId: string;
  taskId: string;
  /** Task name, for canonical pilot links (falls back to a bare task segment). */
  taskName?: string | null;
  /** Bump to re-fetch scores (after uploads / penalties / deletes). */
  refresh: number;
  /** Comp-local IANA zone for the computed-at timestamp. */
  timezone: string | null;
  /** Reports whether the task has scored tracks (reveals the 3D replay link). */
  onReplayAvailable: (available: boolean) => void;
  /** Rendered inside the comp page's Scores tabs — skip the section heading. */
  embedded?: boolean;
  /** SSR-seeded task score so the table is in the first paint (task page). */
  initialScore?: TaskScoreData;
}) {
  const [state, setState] = useState<ScoresState>(
    initialScore ? { kind: "loaded", data: initialScore, etag: null } : { kind: "loading" }
  );
  const seededRef = useRef(initialScore != null);

  useEffect(() => {
    // Seeded from SSR — surface the replay link from the seed, skip the fetch.
    if (seededRef.current) {
      seededRef.current = false;
      onReplayAvailable(initialScore!.class_scores.some((cls) => cls.pilots.length > 0));
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await api.api.comp[":comp_id"].task[":task_id"].score.$get({
          param: { comp_id: compId, task_id: taskId },
        });
        if (cancelled) return;
        if (res.status === 422) {
          setState({ kind: "no-route" });
          return;
        }
        if (!res.ok) {
          setState({ kind: "unavailable" });
          return;
        }
        const data = (await res.json()) as unknown as TaskScoreData;
        if (cancelled) return;
        setState({ kind: "loaded", data, etag: res.headers.get("ETag") });
        // Reveal the 3D replay link once the task has tracks to show (the
        // bundle endpoint needs an xctsk + at least one track, both implied
        // by a scored pilot).
        onReplayAvailable(data.class_scores.some((cls) => cls.pilots.length > 0));
      } catch {
        if (!cancelled) setState({ kind: "unavailable" });
      }
    })();
    return () => {
      cancelled = true;
    };
    // onReplayAvailable is a state setter from the parent — stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compId, taskId, refresh]);

  return (
    <section>
      {!embedded ? (
        <h2 className="mt-8 text-lg font-bold">
          Scores
          {state.kind === "loaded" ? (
            <>
              {" "}
              <Link
                className="text-sm font-normal underline underline-offset-4"
                to={`/comp/${encodeURIComponent(compId)}#scores`}
              >
                Full competition scores →
              </Link>
            </>
          ) : null}
        </h2>
      ) : null}
      {state.kind === "loading" ? (
        <p className="mt-2 text-muted-foreground">Loading scores…</p>
      ) : null}
      {state.kind === "no-route" ? (
        <p className="mt-2 text-muted-foreground">No scores yet — no route set.</p>
      ) : null}
      {state.kind === "unavailable" ? (
        <p className="mt-2 text-muted-foreground">Scores not available</p>
      ) : null}
      {state.kind === "loaded" ? (
        <ScoreFreshness
          computedAt={state.data.computed_at}
          stale={state.data.stale}
          timezone={timezone}
          etag={state.etag}
          pollUrl={`/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/score`}
        />
      ) : null}
      {state.kind === "loaded"
        ? state.data.class_scores.map((cls) => (
            <ScoreClassList
              key={cls.pilot_class}
              compId={compId}
              taskId={taskId}
              taskName={taskName}
              cls={cls}
              timezone={timezone}
              showClassName={state.data.class_scores.length > 1}
              format={state.data.scoring_format === "open_distance" ? "open_distance" : "gap"}
            />
          ))
        : null}
      {state.kind === "loaded" &&
      state.data.class_scores.some((cls) => cls.pilots.length > 0) ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Tap a row for the full breakdown.
        </p>
      ) : null}
    </section>
  );
}

function ScoreClassList({
  compId,
  taskId,
  taskName,
  cls,
  timezone,
  showClassName,
  format,
}: {
  compId: string;
  taskId: string;
  taskName: string | null;
  cls: ClassScore;
  /** Comp-local IANA zone. Passed explicitly (never the runtime default) —
   * this page is server-rendered, so an ESS time formatted in the server's
   * zone and then the viewer's would be a hydration mismatch. */
  timezone: string | null;
  showClassName: boolean;
  format: ScoringFormat;
}) {
  const compName = useCompName();
  const units = useUnits();
  const isOpenDistance = format === "open_distance";
  // The ESS arrival order — the sole input to arrival points, and the whole
  // field's copy of it. This list IS the full-field view, so the order
  // belongs here rather than duplicated into every pilot's report card.
  const hasArrivalOrder = cls.pilots.some((p) => p.arrival_position != null);

  const v = cls.task_validity;
  const ap = cls.available_points;
  // The arrival field size, as the scorer counted it.
  const essFieldSize =
    cls.validity_inputs?.num_reached_ess ??
    cls.pilots.filter((p) => p.reached_ess).length;
  // FAI S7F §11 (HG): nobody reached ESS, so the task carried no time and no
  // arrival points. Gated on the published zero as well as the field count, so
  // a pre-rule cached body keeps its old caption rather than being described
  // as something it is not; a whole-day zero is a different finding.
  const noEssOffer =
    cls.gap_params?.scoring === "HG" &&
    ap.total > 0 &&
    ap.time === 0 &&
    essFieldSize === 0;

  return (
    <div className="mt-2">
      {showClassName ? <h3 className="mt-4 mb-2 font-semibold">{cls.pilot_class}</h3> : null}
      {/* The table this replaced had up to thirteen columns, and on a phone
          the total was the ninth of them, off the right-hand edge. A row now
          says what the pilot did and what it scored; the points split
          (distance, time, leading, arrival) is the report card's job, and
          the row opens it. The CSV and the results record keep the grid. */}
      <ScoreList label={`Scores — ${cls.pilot_class}`}>
        {cls.pilots.map((p) => {
          const distance = formatDistance(p.flown_distance, { decimals: 1, prefs: units }).withUnit;
          const result = isOpenDistance
            ? distance
            : p.made_goal
              ? p.speed_section_time !== null
                ? `Goal in ${formatDuration(p.speed_section_time)}`
                : "Goal"
              : distance;
          return (
            <ScoreLinkRow
              key={p.comp_pilot_id}
              href={pilotPath(compId, compName, taskId, taskName, p.comp_pilot_id, p.pilot_name)}
              rank={p.rank}
              title={
                <>
                  {p.pilot_name}
                  {/* Without this, a 0 km / 0 pts row reads as a scoring bug
                      rather than a withheld tracklog. The row already opens
                      the explanation, so this is a signpost, not a dead end. */}
                  {p.track_excluded ? (
                    <Badge
                      variant="destructive"
                      className="ml-2 align-middle"
                      title={p.track_excluded.reasons.join("; ")}
                    >
                      Excluded
                    </Badge>
                  ) : null}
                </>
              }
              detail={
                <>
                  {result}
                  {/* The order is BY the clock, so the clock time and the
                      position it produced go together. */}
                  {p.arrival_position != null && hasArrivalOrder ? (
                    <>
                      {" · ESS "}
                      {p.ess_time_ms != null
                        ? `${formatTimeInZone(new Date(p.ess_time_ms), timezone ?? undefined)} `
                        : ""}
                      (#{p.arrival_position})
                    </>
                  ) : null}
                  {p.penalty_points !== 0 ? (
                    <span className="text-caution">
                      {" · Penalty "}
                      {p.penalty_points < 0 ? "+" : "−"}
                      {Math.abs(p.penalty_points)}
                    </span>
                  ) : null}
                </>
              }
              figure={<Points value={p.total_score} />}
            />
          );
        })}
      </ScoreList>
      {isOpenDistance ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Open distance — score is metres flown from the take-off exit to the furthest point
          reached.
        </p>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          {/* Two decimals (trimmed) so a 99.93% day doesn't read as a
              contradictory "100% · 999 pts". */}
          Task validity: {Number((v.task * 100).toFixed(2))}%
          {/* Stopped tasks (S7F §13.4.3): surface the fourth factor. */}
          {v.stopped !== undefined
            ? ` (task stopped — stopped validity ${Number((v.stopped * 100).toFixed(2))}%)`
            : ""}{" "}
          · Available: {Number(ap.total.toFixed(1))} pts
          (dist {Math.round(ap.distance)}, time {Math.round(ap.time)}, lead{" "}
          {Math.round(ap.leading)})
          {/* FAI S7F §11: nobody reached ESS on an HG task, so the time and
              arrival offers are zero and nothing replaces them — without this
              the split visibly fails to add up to the total. */}
          {noEssOffer ? (
            <>
              {" "}
              — nobody reached ESS, so only distance and leading points (
              {Number((ap.distance + ap.leading).toFixed(1))} pts) were on offer.
            </>
          ) : null}
        </p>
      )}
    </div>
  );
}
