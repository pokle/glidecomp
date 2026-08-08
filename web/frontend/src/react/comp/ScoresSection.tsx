/**
 * Task scores section — React port of setupScoreSection()/renderScoreClass().
 * Columns are conditional exactly as in the vanilla renderer; open distance
 * omits goal, distance-points and validity (the score is metres flown).
 * Tables are RAC ARIA grids: whole-row activation (click/Enter) opens the
 * pilot's score breakdown, with a real link on the pilot name.
 */
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Link as AriaLink } from "react-aria-components";
import { Table, TableHeader, TableBody, Column, Row, Cell } from "@/react/rac/table";
import { Badge } from "@/react/rac/badge";
import { api } from "../../comp/api";
import { formatDuration } from "../lib/format";
import { formatTimeInZone } from "../lib/time";
import { formatDistance, useUnits } from "../lib/units";
import { ScoreFreshness } from "./ScoreFreshness";
import { pilotPath } from "../lib/slug";
import { useCompName } from "./comp-name-context";
import type { ClassScore, ScoringFormat, TaskScoreData } from "./types";

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
        ? state.data.class_scores.map((cls) => (
            <ScoreClassTable
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
          Click a row for the full breakdown.
        </p>
      ) : null}
    </section>
  );
}

function ScoreClassTable({
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
  const navigate = useNavigate();
  const compName = useCompName();
  const units = useUnits();
  const isOpenDistance = format === "open_distance";
  const hasSpeed = cls.pilots.some((p) => p.speed_section_time !== null);
  const hasTimePoints = cls.pilots.some((p) => p.time_points !== 0);
  const hasLeadPoints = cls.pilots.some((p) => p.leading_points !== 0);
  // Arrival points had no column at all: on an HG comp with arrival on they
  // were folded silently into Total, so a pilot could not see the component
  // and the columns visibly failed to add up.
  const hasArrivalPoints = cls.pilots.some((p) => p.arrival_points !== 0);
  // The ESS arrival order — the sole input to those points, and the whole
  // field's copy of it. This table IS the full-field view, so the order
  // belongs here rather than duplicated into every pilot's report card.
  const hasArrivalOrder = cls.pilots.some((p) => p.arrival_position != null);
  // The divisor the arrival formula used — prefer the published count over
  // counting rows, so the tooltip's "N of M" matches the scorer's own M.
  const essFieldSize =
    cls.validity_inputs?.num_reached_ess ??
    cls.pilots.filter((p) => p.reached_ess).length;
  const hasPenalties = cls.pilots.some((p) => p.penalty_points !== 0);

  const v = cls.task_validity;
  const ap = cls.available_points;

  const detailHref = (compPilotId: string, pilotName?: string | null) =>
    pilotPath(compId, compName, taskId, taskName, compPilotId, pilotName);

  return (
    <div className="mt-2">
      {showClassName ? <h3 className="mt-4 font-semibold">{cls.pilot_class}</h3> : null}
      <Table
        aria-label={`Scores — ${cls.pilot_class}`}
        // Whole-row activation (click or Enter) opens the score breakdown; the
        // pilot-name link stays a real anchor for middle-click / crawlers.
        onRowAction={(key) => {
          const pilot = cls.pilots.find((p) => p.comp_pilot_id === String(key));
          void navigate(detailHref(String(key), pilot?.pilot_name));
        }}
      >
        <TableHeader>
          {/* Open distance has no goal, speed section, or GAP point split —
              the score is simply the distance flown — so those columns are
              omitted. */}
          {/* Quantities are right-aligned + tabular so digits line up column-wise
              and scores can be compared down the page. Penalty stays left: its
              cell may carry a reason after the number, so right-aligning would
              push the numbers out of line rather than into it. */}
          <Column className="text-right">#</Column>
          <Column isRowHeader>Pilot</Column>
          {!isOpenDistance ? <Column>Goal</Column> : null}
          <Column className="text-right">Distance</Column>
          {hasSpeed ? <Column className="text-right">Speed</Column> : null}
          {hasArrivalOrder ? <Column className="text-right">ESS</Column> : null}
          {!isOpenDistance ? <Column className="text-right">Dist Pts</Column> : null}
          {hasTimePoints ? <Column className="text-right">Time Pts</Column> : null}
          {hasLeadPoints ? <Column className="text-right">Lead Pts</Column> : null}
          {hasArrivalPoints ? <Column className="text-right">Arr Pts</Column> : null}
          {hasPenalties ? <Column>Penalty</Column> : null}
          <Column className="text-right">Total</Column>
        </TableHeader>
        <TableBody>
          {cls.pilots.map((p) => {
            const diffPts = p.distance_difficulty_points ?? 0;
            return (
              <Row key={p.comp_pilot_id} id={p.comp_pilot_id} className="cursor-pointer">
                <Cell className="text-right tabular-nums">{p.rank}</Cell>
                <Cell>
                  <AriaLink
                    href={detailHref(p.comp_pilot_id, p.pilot_name)}
                    aria-label={`How ${p.pilot_name}'s score was calculated`}
                    className="underline decoration-muted-foreground/40 underline-offset-4 outline-none data-hovered:decoration-current data-focus-visible:ring-2 data-focus-visible:ring-ring/50"
                  >
                    {p.pilot_name}
                  </AriaLink>
                  {/* Without this, a 0 km / 0 pts row reads as a scoring bug
                      rather than a withheld tracklog. The row already links
                      to the explanation, so this is a signpost, not a
                      dead end. */}
                  {p.track_excluded ? (
                    <Badge
                      variant="destructive"
                      className="ml-2 align-middle"
                      title={p.track_excluded.reasons.join("; ")}
                    >
                      Excluded
                    </Badge>
                  ) : null}
                </Cell>
                {!isOpenDistance ? <Cell>{p.made_goal ? "✓" : "—"}</Cell> : null}
                <Cell className="text-right tabular-nums">
                  {formatDistance(p.flown_distance, { decimals: 1, prefs: units }).withUnit}
                </Cell>
                {hasSpeed ? (
                  <Cell className="text-right tabular-nums">
                    {p.speed_section_time !== null
                      ? formatDuration(p.speed_section_time)
                      : "—"}
                  </Cell>
                ) : null}
                {hasArrivalOrder ? (
                  // The arrival order, in the one place that shows the whole
                  // field at once. Position and clock time together, because
                  // the order is BY the clock — an earlier start gate can put
                  // a slower pilot ahead of a faster one, and the two columns
                  // side by side are what make that visible.
                  <Cell className="text-right tabular-nums">
                    {p.arrival_position != null ? (
                      // Time first — it is the fact — with the position it
                      // produced in parentheses. A bare margin between the two
                      // looked fine but ran together in text extraction and
                      // copy-paste ("317:07:55"), so the separator is real
                      // characters, not spacing.
                      <span
                        title={`Reached the end of the speed section ${p.arrival_position} of ${essFieldSize}`}
                      >
                        {p.ess_time_ms != null
                          ? formatTimeInZone(
                              new Date(p.ess_time_ms),
                              timezone ?? undefined
                            )
                          : ""}
                        <span className="ml-1 text-muted-foreground">
                          (#{p.arrival_position})
                        </span>
                      </span>
                    ) : (
                      "—"
                    )}
                  </Cell>
                ) : null}
                {!isOpenDistance ? (
                  <Cell className="text-right tabular-nums">
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
                  </Cell>
                ) : null}
                {hasTimePoints ? (
                  <Cell className="text-right tabular-nums">
                    {Math.round(p.time_points)}
                  </Cell>
                ) : null}
                {hasLeadPoints ? (
                  <Cell className="text-right tabular-nums">
                    {Math.round(p.leading_points)}
                  </Cell>
                ) : null}
                {hasArrivalPoints ? (
                  <Cell className="text-right tabular-nums">
                    {Math.round(p.arrival_points)}
                  </Cell>
                ) : null}
                {hasPenalties ? (
                  <Cell>
                    {p.penalty_points !== 0 ? (
                      <span className="text-destructive">
                        {p.penalty_points < 0
                          ? `+${Math.abs(p.penalty_points)}`
                          : `-${p.penalty_points}`}
                        {p.penalty_reason ? <span> {p.penalty_reason}</span> : null}
                      </span>
                    ) : null}
                  </Cell>
                ) : null}
                <Cell className="text-right tabular-nums">
                  {Math.round(p.total_score)}
                </Cell>
              </Row>
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
          {/* Two decimals (trimmed) so a 99.93% day doesn't read as a
              contradictory "100% · 999 pts". */}
          Task validity: {Number((v.task * 100).toFixed(2))}%
          {/* Stopped tasks (S7F §12.3.3): surface the fourth factor. */}
          {v.stopped !== undefined
            ? ` (task stopped — stopped validity ${Number((v.stopped * 100).toFixed(2))}%)`
            : ""}{" "}
          · Available: {Number(ap.total.toFixed(1))} pts
          (dist {Math.round(ap.distance)}, time {Math.round(ap.time)}, lead{" "}
          {Math.round(ap.leading)})
        </p>
      )}
    </div>
  );
}
