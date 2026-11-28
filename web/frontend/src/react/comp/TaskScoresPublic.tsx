/**
 * Public per-task scores: the top 3 of each class as rows, plus the link to
 * the competition's full scores page (/comp/:id/scores?task=:id), which is the
 * canonical public scores surface.
 *
 * This deliberately is NOT the management grid — statuses, uploads on behalf
 * and manual flights live in TaskScoresAdmin, which the task page renders for
 * admins only ("Manage pilots & tracks"). What stays here for signed-in
 * pilots is a one-line "your submission" status; submitting is "Submit your
 * track" in the task page's ⋯ (#863).
 *
 * SSR-safety: the server renders the control-less podium from the SSR score
 * seed; the your-submission line mounts after hydration (`mounted` gate),
 * exactly like the old scores table did.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link as AriaLink } from "react-aria-components";
import { LinkButton } from "@/react/rac/button";
import { Loading } from "@/react/rac/progress";
import { api } from "../../comp/api";
import { useUser } from "../lib/user";
import { formatInstant } from "../lib/time";
import { useMounted } from "../lib/use-mounted";
import { formatDistance, useUnits } from "../lib/units";
import { ordinal } from "../lib/format";
import { ChevronRightIcon } from "lucide-react";
import { navRowClass } from "@/react/rac/nav-list";
import { Points, ScoreLinkRow, ScoreList } from "./score-rows";
import { pilotPath } from "../lib/slug";
import { useCompName } from "./comp-name-context";
import { HistoricalRulesNotice, RulesEditionBadge } from "./RulesEdition";
import { SectionHeader } from "../components/SectionHeader";
import { ScoreFreshness } from "./ScoreFreshness";
import { Card } from "@/react/rac/card";
import type {
  ClassScore,
  PilotListEntry,
  TaskScoreData,
  TrackInfo,
} from "./types";

/**
 * Task-level stopped notice (FAI S7F §13.4): shown above the scores when the
 * task was scored as stopped — the scored-back stop time, and (when the stop
 * came before the minimum scoring time) why every pilot reads 0. The comp
 * zone (or UTC) keeps the SSR markup deterministic.
 */
function StoppedTaskNotice({
  score,
  timezone,
}: {
  score: TaskScoreData;
  timezone: string | null;
}) {
  // Offset-only zone label until mounted so this SSR-rendered notice hydrates
  // cleanly regardless of the comp zone (see useMounted / formatInstant).
  const mounted = useMounted();
  const stopped = score.class_scores.find((c) => c.stopped)?.stopped;
  if (!stopped) return null;
  return (
    <p className="mt-2 text-sm">
      <span className="font-medium text-danger">Task stopped</span>{" "}
      <span className="text-muted-foreground">
        — flights scored up to{" "}
        {formatInstant(new Date(stopped.stop_time_ms), timezone ?? "UTC", mounted)} (the
        stop announcement, scored back per FAI S7F §13.4.1).{" "}
        {stopped.requirement_met
          ? "Pilots still flying at the stop keep an altitude bonus for height above goal; a stopped-task validity factor applies."
          : "The task was stopped before running the minimum scoring time (FAI S7F §13.4.2), so it cannot be scored — every pilot reads 0."}
      </span>
    </p>
  );
}

/** The signed-in user's own submission state for this task (client-only). */
type MySubmission =
  | { registered: false }
  | { registered: true; hasTrack: boolean; uploadedAt: string | null };

export function TaskScoresPublic({
  compId,
  taskId,
  taskName = null,
  timezone,
  isOpenDistance,
  isAuthenticated,
  submitHref,
  refresh,
  onReplayAvailable,
  initialScore,
  taskDate = null,
}: {
  compId: string;
  taskId: string;
  /** Task name, for canonical pilot links. */
  taskName?: string | null;
  timezone: string | null;
  isOpenDistance: boolean;
  isAuthenticated: boolean;
  /** The /submit form for this task, while this reader may submit to it. */
  submitHref?: string;
  /** Parent bump to refetch scores (route edits, admin mutations). */
  refresh: number;
  onReplayAvailable: (available: boolean) => void;
  /** SSR-seeded score so the podium is in the first paint. */
  initialScore?: TaskScoreData;
  /** The task's ISO date — drives the pre-2026-rules indicative notice. */
  taskDate?: string | null;
}) {
  const { user } = useUser();
  const mounted = useMounted();

  const [score, setScore] = useState<TaskScoreData | null>(initialScore ?? null);
  const [scoreState, setScoreState] = useState<
    "loading" | "no-route" | "unavailable" | "ok"
  >(initialScore ? "ok" : "loading");
  const [etag, setEtag] = useState<string | null>(null);
  const [mySubmission, setMySubmission] = useState<MySubmission | null>(null);

  const seededRef = useRef(initialScore != null);

  const fetchScore = useCallback(async () => {
    try {
      const res = await api.api.comp[":comp_id"].task[":task_id"].score.$get({
        param: { comp_id: compId, task_id: taskId },
      });
      if (res.status === 422) {
        setScoreState("no-route");
        return;
      }
      if (!res.ok) {
        setScoreState("unavailable");
        return;
      }
      const data = (await res.json()) as unknown as TaskScoreData;
      setScore(data);
      setEtag(res.headers.get("ETag"));
      setScoreState("ok");
      onReplayAvailable(data.class_scores.some((c) => c.pilots.length > 0));
    } catch {
      setScoreState("unavailable");
    }
    // onReplayAvailable is a stable parent setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compId, taskId]);

  // Scores: seeded from SSR on first paint; otherwise fetch. Refetch on parent
  // `refresh` (route edits / admin mutations in the manage section).
  useEffect(() => {
    if (seededRef.current && refresh === 0) {
      seededRef.current = false;
      onReplayAvailable(initialScore!.class_scores.some((c) => c.pilots.length > 0));
      return;
    }
    void fetchScore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchScore, refresh]);

  // "Your submission" line: match the signed-in user to a registered pilot by
  // linked_email, then look for their active track. Client-only, non-critical.
  useEffect(() => {
    if (!mounted || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const [rosterRes, trackRes] = await Promise.all([
          api.api.comp[":comp_id"].pilot.$get({ param: { comp_id: compId } }),
          api.api.comp[":comp_id"].task[":task_id"].igc.$get({
            param: { comp_id: compId, task_id: taskId },
          }),
        ]);
        if (cancelled || !rosterRes.ok) return;
        const roster = ((await rosterRes.json()) as { pilots: PilotListEntry[] })
          .pilots;
        const me = roster.find((p) => p.linked_email === user.email);
        if (!me) {
          if (!cancelled) setMySubmission({ registered: false });
          return;
        }
        let myTrack: TrackInfo | undefined;
        if (trackRes.ok) {
          const tracks = ((await trackRes.json()) as { tracks: TrackInfo[] })
            .tracks;
          myTrack = tracks.find((t) => t.comp_pilot_id === me.comp_pilot_id && t.active);
        }
        if (!cancelled) {
          setMySubmission({
            registered: true,
            hasTrack: myTrack != null,
            uploadedAt: myTrack?.uploaded_at ?? null,
          });
        }
      } catch {
        // Non-critical — the line just doesn't render.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mounted, user, compId, taskId, refresh]);

  const scoresHref = `/comp/${encodeURIComponent(compId)}/scores?task=${encodeURIComponent(taskId)}`;

  return (
    <Card id="scores" className="scroll-mt-20">
      {/* No Submit button here: "Submit your track" is the bar's button. The
          sentence below that says a track is missing carries the link to the
          same form, because that is where a pilot reads that it is. */}
      <SectionHeader title="Scores" />

      {mounted && mySubmission?.registered ? (
        <p className="mt-2 text-sm text-muted-foreground" role="status">
          {mySubmission.hasTrack ? (
            <>
              Your track for this task is in
              {mySubmission.uploadedAt
                ? ` — uploaded ${formatInstant(new Date(mySubmission.uploadedAt), timezone ?? "UTC")}`
                : null}
              .
            </>
          ) : (
            <>
              You haven't submitted a track for this task yet.
              {submitHref ? (
                <>
                  {" "}
                  <AriaLink
                    href={submitHref}
                    className="text-foreground underline underline-offset-4 pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
                  >
                    Submit your track
                  </AriaLink>
                </>
              ) : null}
            </>
          )}
        </p>
      ) : null}

      {scoreState === "loading" ? (
        <Loading className="mt-2">Loading scores…</Loading>
      ) : scoreState === "no-route" ? (
        <p className="mt-2 text-muted-foreground">
          No scores yet — no route set.
        </p>
      ) : scoreState === "unavailable" || !score ? (
        <p className="mt-2 text-muted-foreground">Scores not available</p>
      ) : (
        <>
          <ScoreFreshness
            computedAt={score.computed_at}
            stale={score.stale}
            timezone={timezone}
            etag={etag}
            pollUrl={`/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/score`}
          />
          {!isOpenDistance ? (
            <p className="mt-1">
              <RulesEditionBadge
                edition={
                  score.class_scores.find((c) => c.rules_edition)?.rules_edition
                }
              />
            </p>
          ) : null}
          <div className="mt-2 empty:hidden">
            <HistoricalRulesNotice
              edition={
                score.class_scores.find((c) => c.rules_edition)?.rules_edition
              }
              taskDate={taskDate}
              officialUrl={score.official_results?.task_url ?? null}
            />
          </div>
          <StoppedTaskNotice score={score} timezone={timezone} />
          {score.class_scores.every((c) => c.pilots.length === 0) ? (
            <p className="mt-2 text-muted-foreground">
              No scored pilots yet — scores appear once tracks are submitted.
            </p>
          ) : (
            <>
              {score.class_scores.map((cls, i) => (
                <ClassPodium
                  key={cls.pilot_class}
                  // The first class is the scores page's default; another is named.
                  moreHref={
                    i === 0
                      ? scoresHref
                      : `${scoresHref}&class=${encodeURIComponent(cls.pilot_class)}`
                  }
                  compId={compId}
                  taskId={taskId}
                  taskName={taskName}
                  cls={cls}
                  showClassName={score.class_scores.length > 1}
                  isOpenDistance={isOpenDistance}
                />
              ))}
            </>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
            <LinkButton variant="outline" size="sm" href={scoresHref}>
              Full scores
            </LinkButton>
            {/* Static Astro page — a plain anchor leaves the SPA. */}
            <a
              href="/scoring"
              className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
            >
              How scoring works
            </a>
          </div>
        </>
      )}
    </Card>
  );
}

/**
 * Top 3 of one class, as rows a finger can hit. The full list of the class is
 * on the scores page, which the last row opens; each pilot's row opens their
 * step-by-step score explanation.
 *
 * The rows are the scores pages' own (`score-rows.tsx`), as the comp page's
 * podium is. Until issue #860 a pilot here was a line of text with the name
 * underlined: a link 22 px tall, where every other list of pilots had become
 * rows (#885).
 */
function ClassPodium({
  compId,
  taskId,
  taskName,
  cls,
  showClassName,
  isOpenDistance,
  moreHref,
}: {
  compId: string;
  taskId: string;
  taskName: string | null;
  cls: ClassScore;
  showClassName: boolean;
  isOpenDistance: boolean;
  /** This class's full list on the scores page. */
  moreHref: string;
}) {
  const units = useUnits();
  const compName = useCompName();
  if (cls.pilots.length === 0) return null;
  const top = cls.pilots.slice(0, 3);
  const more = cls.pilots.length - top.length;
  const distance = (m: number) => formatDistance(m, { decimals: 1, prefs: units }).withUnit;

  return (
    <div className="mt-3 min-w-0">
      {showClassName ? <h3 className="mb-1.5 font-semibold">{cls.pilot_class}</h3> : null}
      <ScoreList label={`Top 3 — ${cls.pilot_class}`}>
        {top.map((p) => (
          <ScoreLinkRow
            key={p.comp_pilot_id}
            href={pilotPath(compId, compName, taskId, taskName, p.comp_pilot_id, p.pilot_name)}
            rank={ordinal(p.rank)}
            title={p.pilot_name}
            // Open distance is ranked by the distance itself, so it is the
            // row's figure; under GAP it is the row's second line.
            detail={isOpenDistance ? undefined : distance(p.flown_distance)}
            figure={
              isOpenDistance ? (
                <span className="shrink-0 text-right font-semibold tabular-nums">
                  {distance(p.flown_distance)}
                </span>
              ) : (
                <Points value={p.total_score} />
              )
            }
          />
        ))}
        {more > 0 ? (
          <li>
            <AriaLink href={moreHref} className={navRowClass}>
              <span className="min-w-0 flex-1 pl-13 text-muted-foreground">
                + {more} more pilot{more === 1 ? "" : "s"}
              </span>
              <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            </AriaLink>
          </li>
        ) : null}
      </ScoreList>
    </div>
  );
}
