/**
 * Task scores section — React port of setupScoreSection()/renderScoreClass().
 * Columns are conditional exactly as in the vanilla renderer; open distance
 * omits goal, distance-points and validity (the score is metres flown).
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../comp/api";
import { formatDuration } from "../lib/format";
import type { ClassScore, ScoringFormat, TaskScoreData } from "./types";

type ScoresState =
  | { kind: "loading" }
  | { kind: "no-route" }
  | { kind: "unavailable" }
  | { kind: "loaded"; data: TaskScoreData };

export function ScoresSection({
  compId,
  taskId,
  refresh,
  onReplayAvailable,
}: {
  compId: string;
  taskId: string;
  /** Bump to re-fetch scores (after uploads / penalties / deletes). */
  refresh: number;
  /** Reports whether the task has scored tracks (reveals the 3D replay link). */
  onReplayAvailable: (available: boolean) => void;
}) {
  const [state, setState] = useState<ScoresState>({ kind: "loading" });

  useEffect(() => {
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
        setState({ kind: "loaded", data });
        // Reveal the 3D replay link once the task has tracks to show (the
        // bundle endpoint needs an xctsk + at least one track, both implied
        // by a scored pilot).
        onReplayAvailable(data.classes.some((cls) => cls.pilots.length > 0));
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
      <h2>
        Scores
        {state.kind === "loaded" ? (
          <>
            {" "}
            <Link to={`/scores?comp_id=${encodeURIComponent(compId)}`}>
              Full competition scores →
            </Link>
          </>
        ) : null}
      </h2>
      {state.kind === "loading" ? <p>Loading scores...</p> : null}
      {state.kind === "no-route" ? <p>No scores yet — task route not defined</p> : null}
      {state.kind === "unavailable" ? <p>Scores not available</p> : null}
      {state.kind === "loaded"
        ? state.data.classes.map((cls) => (
            <ScoreClassTable
              key={cls.pilot_class}
              cls={cls}
              showClassName={state.data.classes.length > 1}
              format={state.data.scoring_format === "open_distance" ? "open_distance" : "gap"}
            />
          ))
        : null}
    </section>
  );
}

function ScoreClassTable({
  cls,
  showClassName,
  format,
}: {
  cls: ClassScore;
  showClassName: boolean;
  format: ScoringFormat;
}) {
  const isOpenDistance = format === "open_distance";
  const hasSpeed = cls.pilots.some((p) => p.speed_section_time !== null);
  const hasTimePoints = cls.pilots.some((p) => p.time_points !== 0);
  const hasLeadPoints = cls.pilots.some((p) => p.leading_points !== 0);
  const hasPenalties = cls.pilots.some((p) => p.penalty_points !== 0);

  const v = cls.task_validity;
  const ap = cls.available_points;

  return (
    <div>
      {showClassName ? <h3>{cls.pilot_class}</h3> : null}
      <table>
        <thead>
          {/* Open distance has no goal, speed section, or GAP point split —
              the score is simply the distance flown — so those columns are
              omitted. */}
          <tr>
            <th>#</th>
            <th>Pilot</th>
            {!isOpenDistance ? <th>Goal</th> : null}
            <th>Distance</th>
            {hasSpeed ? <th>Speed</th> : null}
            {!isOpenDistance ? <th>Dist Pts</th> : null}
            {hasTimePoints ? <th>Time Pts</th> : null}
            {hasLeadPoints ? <th>Lead Pts</th> : null}
            {hasPenalties ? <th>Penalty</th> : null}
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {cls.pilots.map((p) => {
            const diffPts = p.distance_difficulty_points ?? 0;
            return (
              <tr key={p.comp_pilot_id}>
                <td>{p.rank}</td>
                <td>{p.pilot_name}</td>
                {!isOpenDistance ? <td>{p.made_goal ? "✓" : "—"}</td> : null}
                <td>{(p.flown_distance / 1000).toFixed(1)} km</td>
                {hasSpeed ? (
                  <td>
                    {p.speed_section_time !== null
                      ? formatDuration(p.speed_section_time)
                      : "—"}
                  </td>
                ) : null}
                {!isOpenDistance ? (
                  <td>
                    {/* Show the linear/difficulty split as a tooltip when HG
                        difficulty applies. */}
                    {diffPts > 0 ? (
                      <span
                        title={`${Math.round(p.distance_linear_points)} linear + ${Math.round(diffPts)} difficulty`}
                      >
                        {Math.round(p.distance_points)}
                      </span>
                    ) : (
                      Math.round(p.distance_points)
                    )}
                  </td>
                ) : null}
                {hasTimePoints ? <td>{Math.round(p.time_points)}</td> : null}
                {hasLeadPoints ? <td>{Math.round(p.leading_points)}</td> : null}
                {hasPenalties ? (
                  <td>
                    {p.penalty_points !== 0 ? (
                      <span>
                        {p.penalty_points < 0
                          ? `+${Math.abs(p.penalty_points)}`
                          : `-${p.penalty_points}`}
                        {p.penalty_reason ? <span> {p.penalty_reason}</span> : null}
                      </span>
                    ) : null}
                  </td>
                ) : null}
                <td>{Math.round(p.total_score)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {isOpenDistance ? (
        <p>
          Open distance — score is metres flown from the take-off exit to the furthest point
          reached.
        </p>
      ) : (
        <p>
          Task validity: {(v.task * 100).toFixed(0)}% · Available: {Math.round(ap.total)} pts
          (dist {Math.round(ap.distance)}, time {Math.round(ap.time)}, lead{" "}
          {Math.round(ap.leading)})
        </p>
      )}
    </div>
  );
}
