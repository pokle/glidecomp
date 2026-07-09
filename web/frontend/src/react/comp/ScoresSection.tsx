/**
 * Task scores section — React port of setupScoreSection()/renderScoreClass().
 * Columns are conditional exactly as in the vanilla renderer; open distance
 * omits goal, distance-points and validity (the score is metres flown).
 */
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
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
import { ScoreFreshness } from "./ScoreFreshness";
import type { ClassScore, ScoringFormat, TaskScoreData } from "./types";

type ScoresState =
  | { kind: "loading" }
  | { kind: "no-route" }
  | { kind: "unavailable" }
  | { kind: "loaded"; data: TaskScoreData; etag: string | null };

export function ScoresSection({
  compId,
  taskId,
  refresh,
  timezone,
  onReplayAvailable,
  embedded = false,
  initialScore,
}: {
  compId: string;
  taskId: string;
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
      onReplayAvailable(initialScore!.classes.some((cls) => cls.pilots.length > 0));
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
        <p className="mt-2 text-muted-foreground">Loading scores...</p>
      ) : null}
      {state.kind === "no-route" ? (
        <p className="mt-2 text-muted-foreground">No scores yet — task route not defined</p>
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
        ? state.data.classes.map((cls) => (
            <ScoreClassTable
              key={cls.pilot_class}
              compId={compId}
              taskId={taskId}
              cls={cls}
              showClassName={state.data.classes.length > 1}
              format={state.data.scoring_format === "open_distance" ? "open_distance" : "gap"}
            />
          ))
        : null}
      {state.kind === "loaded" &&
      state.data.classes.some((cls) => cls.pilots.length > 0) ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Click a pilot's row for the full score breakdown — every start,
          turnpoint and point calculation, shown on the map.
        </p>
      ) : null}
    </section>
  );
}

function ScoreClassTable({
  compId,
  taskId,
  cls,
  showClassName,
  format,
}: {
  compId: string;
  taskId: string;
  cls: ClassScore;
  showClassName: boolean;
  format: ScoringFormat;
}) {
  const navigate = useNavigate();
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
            const detailHref = `/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/pilot/${encodeURIComponent(p.comp_pilot_id)}`;
            return (
              <TableRow
                key={p.comp_pilot_id}
                className="cursor-pointer"
                title={`How ${p.pilot_name}'s score was calculated`}
                onClick={() => navigate(detailHref)}
              >
                <TableCell>{p.rank}</TableCell>
                <TableCell>
                  {/* Real link inside the clickable row for middle-click /
                      keyboard access. */}
                  <Link
                    to={detailHref}
                    className="underline decoration-muted-foreground/40 underline-offset-4 hover:decoration-current"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {p.pilot_name}
                  </Link>
                </TableCell>
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
