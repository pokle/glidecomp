/**
 * Public per-task scores: a compact top-3 podium per class plus the link to
 * the competition's full scores page (/comp/:id/scores?task=:id), which is the
 * canonical public scores surface.
 *
 * This deliberately is NOT the management grid — statuses, uploads on behalf
 * and manual flights live in TaskScoresAdmin, which the task page renders for
 * admins only ("Manage pilots & tracks"). What stays here for signed-in
 * pilots is self-service: the Submit track button and a one-line "your
 * submission" status.
 *
 * SSR-safety: the server renders the control-less podium from the SSR score
 * seed; the Submit track button and the your-submission line mount after
 * hydration (`mounted` gate), exactly like the old scores table did.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link as AriaLink } from "react-aria-components";
import { Button, LinkButton } from "@/react/rac/button";
import { Loading } from "@/react/rac/progress";
import { api } from "../../comp/api";
import { useUser } from "../lib/user";
import { formatInstant } from "../lib/time";
import { useMounted } from "../lib/use-mounted";
import { formatDistance, useUnits } from "../lib/units";
import { ordinal } from "../lib/format";
import { pilotPath } from "../lib/slug";
import { useCompName } from "./comp-name-context";
import { SectionHeader } from "../components/SectionHeader";
import { ScoreFreshness } from "./ScoreFreshness";
import { SubmitTrackDialog } from "./SubmitTrackDialog";
import { Card } from "@/react/rac/card";
import type {
  ClassScore,
  PilotListEntry,
  TaskScoreData,
  TrackInfo,
} from "./types";

/**
 * Task-level stopped notice (FAI S7F §12.3): shown above the scores when the
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
      <span className="font-medium text-destructive">Task stopped</span>{" "}
      <span className="text-muted-foreground">
        — flights scored up to{" "}
        {formatInstant(new Date(stopped.stop_time_ms), timezone ?? "UTC", mounted)} (the
        stop announcement, scored back per FAI S7F §12.3.1).{" "}
        {stopped.requirement_met
          ? "Pilots still flying at the stop keep an altitude bonus for height above goal; a stopped-task validity factor applies."
          : "The task was stopped before running the minimum scoring time (FAI S7F §12.3.2), so it cannot be scored — every pilot reads 0."}
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
  isClosed,
  submissionsClosed = false,
  canUploadOnBehalf,
  refresh,
  onReplayAvailable,
  initialScore,
}: {
  compId: string;
  taskId: string;
  /** Task name, for canonical pilot links. */
  taskName?: string | null;
  timezone: string | null;
  isOpenDistance: boolean;
  isAuthenticated: boolean;
  isClosed: boolean;
  /** The organiser closed THIS task (migration 0028). The section's own
   * Submit action has to honour it, or the page offers a button the server
   * will refuse — this component renders its own header action, so gating the
   * page's action row is not enough. */
  submissionsClosed?: boolean;
  canUploadOnBehalf: boolean;
  /** Parent bump to refetch scores (route edits, admin mutations). */
  refresh: number;
  onReplayAvailable: (available: boolean) => void;
  /** SSR-seeded score so the podium is in the first paint. */
  initialScore?: TaskScoreData;
}) {
  const { user } = useUser();
  const mounted = useMounted();
  const [uploadOpen, setUploadOpen] = useState(false);
  // Bumped after this section's own Submit-track dialog uploads, so the
  // "your track is in" line below re-fetches. The parent's `refresh` covers
  // the scores; nothing else covers this.
  const [mineRefresh, setMineRefresh] = useState(0);
  const refreshMine = () => setMineRefresh((n) => n + 1);

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
  }, [mounted, user, compId, taskId, refresh, mineRefresh]);

  const scoresHref = `/comp/${encodeURIComponent(compId)}/scores?task=${encodeURIComponent(taskId)}`;

  return (
    <Card id="scores" className="scroll-mt-4">
      <SectionHeader
        title="Scores"
        action={
          // No longer gated on a session: submitting is open to anyone the
          // comp's roster knows. Still mount-gated, because what the dialog
          // shows inside depends on who is asking.
          mounted && !isClosed && !submissionsClosed ? (
            <Button variant="outline" size="sm" onPress={() => setUploadOpen(true)}>
              Submit track
            </Button>
          ) : null
        }
      />

      {uploadOpen ? (
        <SubmitTrackDialog
          compId={compId}
          taskId={taskId}
          canUploadOnBehalf={canUploadOnBehalf}
          onClose={() => setUploadOpen(false)}
          onUploaded={() => {
            // The "your track is in" line below is this component's own
            // fetch — without this, the one thing the section fails to show
            // is the upload that just happened.
            setUploadOpen(false);
            refreshMine();
          }}
        />
      ) : null}

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
            <>You haven't submitted a track for this task yet.</>
          )}
        </p>
      ) : null}

      {scoreState === "loading" ? (
        <Loading className="mt-2">Loading scores…</Loading>
      ) : scoreState === "no-route" ? (
        <p className="mt-2 text-muted-foreground">
          No scores yet — the task route hasn't been set.
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
          <StoppedTaskNotice score={score} timezone={timezone} />
          {score.class_scores.every((c) => c.pilots.length === 0) ? (
            <p className="mt-2 text-muted-foreground">
              No scored pilots yet — scores appear once tracks are submitted.
            </p>
          ) : (
            <>
              {score.class_scores.map((cls) => (
                <ClassPodium
                  key={cls.pilot_class}
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
              className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
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
 * Top 3 of one class, read-only. The full per-pilot table (and every other
 * pilot) lives on the scores page; each name links to the pilot's
 * step-by-step score explanation.
 */
function ClassPodium({
  compId,
  taskId,
  taskName,
  cls,
  showClassName,
  isOpenDistance,
}: {
  compId: string;
  taskId: string;
  taskName: string | null;
  cls: ClassScore;
  showClassName: boolean;
  isOpenDistance: boolean;
}) {
  const units = useUnits();
  const compName = useCompName();
  if (cls.pilots.length === 0) return null;
  const top = cls.pilots.slice(0, 3);
  const more = cls.pilots.length - top.length;

  return (
    <div className="mt-3">
      {showClassName ? <h3 className="font-semibold">{cls.pilot_class}</h3> : null}
      <ol className="mt-1.5 space-y-1 text-sm">
        {top.map((p) => (
          <li key={p.comp_pilot_id} className="flex flex-wrap items-baseline gap-x-2">
            <span className="w-8 text-right tabular-nums text-muted-foreground">
              {ordinal(p.rank)}
            </span>
            <AriaLink
              href={pilotPath(compId, compName, taskId, taskName, p.comp_pilot_id, p.pilot_name)}
              className="underline decoration-muted-foreground/40 underline-offset-4 outline-none data-hovered:decoration-current data-focus-visible:ring-2 data-focus-visible:ring-ring/50"
            >
              {p.pilot_name}
            </AriaLink>
            <span className="tabular-nums text-muted-foreground">
              {formatDistance(p.flown_distance, { decimals: 1, prefs: units }).withUnit}
              {!isOpenDistance ? (
                <> · <strong className="text-foreground">{Math.round(p.total_score)}</strong> pts</>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
      {more > 0 ? (
        <p className="mt-1 pl-10 text-sm text-muted-foreground">
          + {more} more pilot{more === 1 ? "" : "s"} scored
        </p>
      ) : null}
    </div>
  );
}
