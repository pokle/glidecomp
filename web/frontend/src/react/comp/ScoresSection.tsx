/**
 * Task scores section — React port of setupScoreSection()/renderScoreClass().
 * Columns are conditional exactly as in the vanilla renderer; open distance
 * omits goal, distance-points and validity (the score is metres flown).
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/react/ui/table";
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
      <h2 className="mt-8 text-lg font-bold">
        Scores
        {state.kind === "loaded" ? (
          <>
            {" "}
            <Link
              className="text-sm font-normal underline underline-offset-4"
              to={`/scores?comp_id=${encodeURIComponent(compId)}`}
            >
              Full competition scores →
            </Link>
          </>
        ) : null}
      </h2>
      {state.kind === "loading" ? (
        <p className="mt-2 text-muted-foreground">Loading scores...</p>
      ) : null}
      {state.kind === "no-route" ? (
        <p className="mt-2 text-muted-foreground">No scores yet — task route not defined</p>
      ) : null}
      {state.kind === "unavailable" ? (
        <p className="mt-2 text-muted-foreground">Scores not available</p>
      ) : null}
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
    <div className="mt-2">
      {showClassName ? <h3 className="mt-4 font-semibold">{cls.pilot_class}</h3> : null}
      <Table>
        <TableHeader>
          {/* Open distance has no goal, speed section, or GAP point split —
              the score is simply the distance flown — so those columns are
              omitted. */}
          <TableRow>
            <TableHead>#</TableHead>
            <TableHead>Pilot</TableHead>
            {!isOpenDistance ? <TableHead>Goal</TableHead> : null}
            <TableHead>Distance</TableHead>
            {hasSpeed ? <TableHead>Speed</TableHead> : null}
            {!isOpenDistance ? <TableHead>Dist Pts</TableHead> : null}
            {hasTimePoints ? <TableHead>Time Pts</TableHead> : null}
            {hasLeadPoints ? <TableHead>Lead Pts</TableHead> : null}
            {hasPenalties ? <TableHead>Penalty</TableHead> : null}
            <TableHead>Total</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {cls.pilots.map((p) => {
            const diffPts = p.distance_difficulty_points ?? 0;
            return (
              <TableRow key={p.comp_pilot_id}>
                <TableCell>{p.rank}</TableCell>
                <TableCell>{p.pilot_name}</TableCell>
                {!isOpenDistance ? <TableCell>{p.made_goal ? "✓" : "—"}</TableCell> : null}
                <TableCell>{(p.flown_distance / 1000).toFixed(1)} km</TableCell>
                {hasSpeed ? (
                  <TableCell>
                    {p.speed_section_time !== null
                      ? formatDuration(p.speed_section_time)
                      : "—"}
                  </TableCell>
                ) : null}
                {!isOpenDistance ? (
                  <TableCell>
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
                  </TableCell>
                ) : null}
                {hasTimePoints ? <TableCell>{Math.round(p.time_points)}</TableCell> : null}
                {hasLeadPoints ? (
                  <TableCell>{Math.round(p.leading_points)}</TableCell>
                ) : null}
                {hasPenalties ? (
                  <TableCell>
                    {p.penalty_points !== 0 ? (
                      <span className="text-destructive">
                        {p.penalty_points < 0
                          ? `+${Math.abs(p.penalty_points)}`
                          : `-${p.penalty_points}`}
                        {p.penalty_reason ? <span> {p.penalty_reason}</span> : null}
                      </span>
                    ) : null}
                  </TableCell>
                ) : null}
                <TableCell>{Math.round(p.total_score)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {isOpenDistance ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Open distance — score is metres flown from the take-off exit to the furthest point
          reached.
        </p>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          Task validity: {(v.task * 100).toFixed(0)}% · Available: {Math.round(ap.total)} pts
          (dist {Math.round(ap.distance)}, time {Math.round(ap.time)}, lead{" "}
          {Math.round(ap.leading)})
        </p>
      )}
    </div>
  );
}
