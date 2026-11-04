/**
 * Admin task management list — "Manage pilots & tracks" (issues #306, then
 * split from the public scores surface). One row per pilot with their
 * outcome on the task: ranked scorers first, then a per-class "did not
 * score" tail (present-not-flown / DNF / absent). Each row: rank · pilot ·
 * points, then outcome (badge + evidence) · distance, then the actions.
 *
 * A LIST at every width, built for a phone (#848): it was a six-column table
 * that scrolled sideways there, and the actions were the columns off-screen.
 *
 * This is the management tool, admin-only by design: opening a pilot's score
 * card, statuses, uploads on behalf, manual flights and restores. The PUBLIC
 * scores live in
 * TaskScoresPublic (top 3 + link to the comp scores page) — this grid is never
 * server-rendered and mounts only after the admin check resolves.
 *
 * Built on the RAC kit (src/react/rac/) — see
 * docs/2026-07-18-rac-adoption-guide.md. The rows are a kit GridList (arrow
 * keys between rows, Tab through a row's actions), and the per-row admin
 * controls use RAC Select / FileTrigger / Tooltip.
 *
 * Staleness: a status/track/manual change is a whole-task rescore (launch
 * validity ripples to everyone). Score figures grey out while stale; the fresh
 * outcome overrides the stale blob for ranked-vs-tail placement (a just-DNF'd
 * pilot leaves the ranked section immediately); ScoreFreshness surfaces a
 * Reload when the rescore lands — no silent resettle.
 */
import { useCallback, useEffect, useState } from "react";
import { FileTrigger, Link as AriaLink } from "react-aria-components";
import type { XCTask } from "@glidecomp/engine";
import { Button, LinkButton } from "@/react/rac/button";
import { Card } from "@/react/rac/card";
import { ActionErrorBanner, useAction } from "@/react/rac/form";
import { SimpleSelect } from "@/react/rac/select";
import { GridList, GridListItem } from "@/react/rac/grid-list";
import { cn } from "@/react/lib/utils";
import { Tooltip, TooltipTrigger } from "@/react/rac/tooltip";
import { api } from "../../comp/api";
import { formatDistance, useUnits } from "../lib/units";
import { toast } from "../lib/toast";
import { manualFlightPath, pilotPath } from "../lib/slug";
import { formatRankedScore } from "../lib/format";
import { useCompName } from "./comp-name-context";
import { ScoreFreshness } from "./ScoreFreshness";
import { compressIgc } from "./types";
import {
  NOT_AN_IGC_MESSAGE,
  UNREADABLE_FILE_MESSAGE,
  describeUploadOutcome,
  tooLargeReason,
  type TrackQualityWire,
} from "./submit-track";
import type {
  ClassScore,
  ManualFlightEntry,
  PilotListEntry,
  PilotScoreEntry,
  PilotStatusEntry,
  TaskScoreData,
  TrackInfo,
} from "./types";

type Outcome = "present" | "absent" | "dnf" | "landed";

const OUTCOME_LABEL: Record<Outcome, string> = {
  present: "Present",
  absent: "Absent",
  dnf: "Did Not Fly",
  landed: "Landed",
};

/** Tail ordering: present-not-flown first, then DNF, then absent. */
const TAIL_ORDER: Record<Exclude<Outcome, "landed">, number> = {
  present: 0,
  dnf: 1,
  absent: 2,
};

interface RowPilot {
  compPilotId: string;
  name: string;
  pilotClass: string;
  outcome: Outcome;
  evidence: "track" | "manual" | null;
  score: PilotScoreEntry | null;
  supersededTrack: boolean;
  supersededManual: boolean;
  /** The pilot's active manual flight, for prefilling an edit. */
  activeManual: ManualFlightEntry | null;
}

export function TaskScoresAdmin({
  compId,
  taskId,
  taskName = null,
  isAdmin,
  isClosed,
  scoringFormat,
  timezone,
  taskXctsk,
  submissionsClosed = false,
  refresh,
  onMutated,
}: {
  compId: string;
  taskId: string;
  /** Task name, for canonical pilot links. */
  taskName?: string | null;
  isAdmin: boolean;
  isClosed: boolean;
  scoringFormat: "gap" | "open_distance";
  timezone: string | null;
  /** Task route — drives the ManualFlightDialog. Null when no route yet. */
  taskXctsk: XCTask | null;
  /** The organiser closed this task for submissions (migration 0028). Shown,
   * not enforced: these are the organiser tools that deliberately still work. */
  submissionsClosed?: boolean;
  /** Parent bump to refetch scores (route edits). */
  refresh: number;
  /** Notify the parent a mutation happened, so the public scores refetch too. */
  onMutated?: () => void;
}) {
  // Client-data gate (this grid is never server-rendered, but the roster /
  // status / track fetches still wait for mount like they always did).
  const [mounted, setMounted] = useState(false);

  const [score, setScore] = useState<TaskScoreData | null>(null);
  const [scoreState, setScoreState] = useState<"loading" | "no-route" | "unavailable" | "ok">(
    "loading"
  );
  const [etag, setEtag] = useState<string | null>(null);

  const [roster, setRoster] = useState<PilotListEntry[]>([]);
  const [statuses, setStatuses] = useState<Map<string, PilotStatusEntry>>(new Map());
  const [tracks, setTracks] = useState<TrackInfo[]>([]);
  const [manualFlights, setManualFlights] = useState<ManualFlightEntry[]>([]);
  // Optimistic "scores are stale" the instant an admin mutates, before the
  // refetched score row reports stale itself.
  const [localDirty, setLocalDirty] = useState(false);

  useEffect(() => setMounted(true), []);

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
      // A fresh (non-stale) score means the rescore we were waiting on landed.
      if (!data.stale) setLocalDirty(false);
    } catch {
      setScoreState("unavailable");
    }
  }, [compId, taskId]);

  const fetchAux = useCallback(async () => {
    try {
      const [rosterRes, statusRes, trackRes, manualRes] = await Promise.all([
        api.api.comp[":comp_id"].pilot.$get({ param: { comp_id: compId } }),
        api.api.comp[":comp_id"].task[":task_id"]["pilot-status"].$get({
          param: { comp_id: compId, task_id: taskId },
        }),
        api.api.comp[":comp_id"].task[":task_id"].igc.$get({
          param: { comp_id: compId, task_id: taskId },
        }),
        api.api.comp[":comp_id"].task[":task_id"]["manual-flight"].$get({
          param: { comp_id: compId, task_id: taskId },
        }),
      ]);
      if (rosterRes.ok) {
        setRoster((((await rosterRes.json()) as { pilots: PilotListEntry[] }).pilots) ?? []);
      }
      if (statusRes.ok) {
        const s = (await statusRes.json()) as { statuses: PilotStatusEntry[] };
        setStatuses(new Map(s.statuses.map((e) => [e.comp_pilot_id, e])));
      }
      if (trackRes.ok) {
        setTracks((((await trackRes.json()) as { tracks: TrackInfo[] }).tracks) ?? []);
      }
      if (manualRes.ok) {
        setManualFlights(
          (((await manualRes.json()) as { manual_flights: ManualFlightEntry[] }).manual_flights) ?? []
        );
      }
    } catch {
      // Non-critical — the scored table still renders from `score`.
    }
  }, [compId, taskId]);

  // Refetch on parent `refresh` (route edits).
  useEffect(() => {
    void fetchScore();
  }, [fetchScore, refresh]);

  // Roster / status / track / manual — client-only, after hydration.
  useEffect(() => {
    if (mounted) void fetchAux();
  }, [mounted, fetchAux, refresh]);

  /** After a mutation: mark scores stale locally (grey the columns), then
   * reconcile outcomes (aux) and pick up the stale flag (score). No silent
   * resettle — ScoreFreshness surfaces the Reload when the rescore lands. */
  const afterMutation = useCallback(() => {
    setLocalDirty(true);
    void fetchAux();
    void fetchScore();
    onMutated?.();
    // onMutated is a stable parent callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchAux, fetchScore]);

  if (scoreState === "loading") {
    return <p className="mt-8 text-muted-foreground">Loading pilots…</p>;
  }
  if (scoreState === "no-route") {
    return (
      <Card>
        <h2 className="text-lg font-bold">Manage pilots &amp; tracks</h2>
        <p className="mt-2 text-muted-foreground">
          Set the route first, then you can manage pilots and tracks.
        </p>
      </Card>
    );
  }
  if (scoreState === "unavailable" || !score) {
    return <p className="mt-8 text-muted-foreground">Pilot management not available</p>;
  }

  const greyed = score.stale || localDirty;
  const isOpenDistance = scoringFormat === "open_distance";

  // Fresh evidence sets, from the client-fetched aux data.
  const activeTrackIds = new Set(tracks.filter((t) => t.active).map((t) => t.comp_pilot_id));
  const activeManualIds = new Set(
    manualFlights.filter((m) => m.active).map((m) => m.comp_pilot_id)
  );
  const supersededTrackIds = new Set(
    tracks.filter((t) => !t.active).map((t) => t.comp_pilot_id)
  );
  const supersededManualIds = new Set(
    manualFlights.filter((m) => !m.active).map((m) => m.comp_pilot_id)
  );

  const outcomeFor = (compPilotId: string, scored: boolean): Outcome => {
    const key = statuses.get(compPilotId)?.status_key;
    if (key === "absent") return "absent";
    if (key === "dnf") return "dnf";
    if (scored || activeTrackIds.has(compPilotId) || activeManualIds.has(compPilotId)) {
      return "landed";
    }
    return "present";
  };
  const evidenceFor = (compPilotId: string): RowPilot["evidence"] =>
    activeManualIds.has(compPilotId) ? "manual" : activeTrackIds.has(compPilotId) ? "track" : null;
  const activeManualByPilot = new Map(
    manualFlights.filter((m) => m.active).map((m) => [m.comp_pilot_id, m])
  );
  const manualEntryFor = (compPilotId: string): ManualFlightEntry | null =>
    activeManualByPilot.get(compPilotId) ?? null;

  return (
    <Card>
      <h2 className="text-lg font-bold">Manage pilots &amp; tracks</h2>
      {/* The list of what the tools are went: they are the buttons directly
          beneath. The consequence stays — it is the one thing the controls
          themselves do not say. */}
      <p className="mt-1 text-sm text-muted-foreground">
        Every change here recomputes the task&rsquo;s scores.
      </p>
      {submissionsClosed ? (
        // Otherwise an organiser who has just closed the task is left
        // wondering why their own upload buttons still work.
        <p className="mt-1 text-sm text-muted-foreground">
          Closed for submissions. Pilots can&rsquo;t send tracks; you still can.
        </p>
      ) : null}

      <ScoreFreshness
        computedAt={score.computed_at}
        stale={score.stale || localDirty}
        timezone={timezone}
        etag={etag}
        pollUrl={`/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/score`}
      />

      {score.class_scores.map((cls) => (
        <ClassScoresRows
          key={cls.pilot_class}
          compId={compId}
          taskId={taskId}
          taskName={taskName}
          cls={cls}
          showClassName={score.class_scores.length > 1}
          isOpenDistance={isOpenDistance}
          greyed={greyed}
          mounted={mounted}
          isAdmin={isAdmin}
          isClosed={isClosed}
          taskXctsk={taskXctsk}
          roster={roster}
          statuses={statuses}
          supersededTrackIds={supersededTrackIds}
          supersededManualIds={supersededManualIds}
          outcomeFor={outcomeFor}
          evidenceFor={evidenceFor}
          manualEntryFor={manualEntryFor}
          onMutated={afterMutation}
        />
      ))}
    </Card>
  );
}

function ClassScoresRows({
  compId,
  taskId,
  taskName,
  cls,
  showClassName,
  isOpenDistance,
  greyed,
  mounted,
  isAdmin,
  isClosed,
  taskXctsk,
  roster,
  statuses,
  supersededTrackIds,
  supersededManualIds,
  outcomeFor,
  evidenceFor,
  manualEntryFor,
  onMutated,
}: {
  compId: string;
  taskId: string;
  taskName: string | null;
  cls: ClassScore;
  showClassName: boolean;
  isOpenDistance: boolean;
  greyed: boolean;
  mounted: boolean;
  isAdmin: boolean;
  isClosed: boolean;
  taskXctsk: XCTask | null;
  roster: PilotListEntry[];
  statuses: Map<string, PilotStatusEntry>;
  supersededTrackIds: Set<string>;
  supersededManualIds: Set<string>;
  outcomeFor: (id: string, scored: boolean) => Outcome;
  evidenceFor: (id: string) => RowPilot["evidence"];
  manualEntryFor: (id: string) => ManualFlightEntry | null;
  onMutated: () => void;
}) {
  const compName = useCompName();

  const scoredIds = new Set(cls.pilots.map((p) => p.comp_pilot_id));

  // Ranked = scored pilots whose FRESH outcome is still Landed (a just-DNF'd
  // pilot's fresh outcome overrides the stale blob and drops them to the tail).
  const ranked: RowPilot[] = [];
  const tail: RowPilot[] = [];

  for (const p of cls.pilots) {
    const outcome = outcomeFor(p.comp_pilot_id, true);
    const row: RowPilot = {
      compPilotId: p.comp_pilot_id,
      name: p.pilot_name,
      pilotClass: cls.pilot_class,
      outcome,
      evidence: evidenceFor(p.comp_pilot_id),
      score: p,
      supersededTrack: supersededTrackIds.has(p.comp_pilot_id),
      supersededManual: supersededManualIds.has(p.comp_pilot_id),
      activeManual: manualEntryFor(p.comp_pilot_id),
    };
    if (outcome === "landed") ranked.push(row);
    else tail.push(row);
  }

  // Tail also gathers roster pilots in this class who never scored. Only after
  // hydration (roster is client-fetched), keeping SSR control-less.
  if (mounted) {
    for (const rp of roster) {
      if (rp.pilot_class !== cls.pilot_class) continue;
      if (scoredIds.has(rp.comp_pilot_id)) continue; // already ranked or tailed above
      tail.push({
        compPilotId: rp.comp_pilot_id,
        name: rp.name,
        pilotClass: cls.pilot_class,
        outcome: outcomeFor(rp.comp_pilot_id, false),
        evidence: evidenceFor(rp.comp_pilot_id),
        score: null,
        supersededTrack: supersededTrackIds.has(rp.comp_pilot_id),
        supersededManual: supersededManualIds.has(rp.comp_pilot_id),
        activeManual: manualEntryFor(rp.comp_pilot_id),
      });
    }
  }

  tail.sort((a, b) => {
    const ao = TAIL_ORDER[a.outcome as Exclude<Outcome, "landed">] ?? 0;
    const bo = TAIL_ORDER[b.outcome as Exclude<Outcome, "landed">] ?? 0;
    if (ao !== bo) return ao - bo;
    return a.name.localeCompare(b.name);
  });

  const showManage = mounted && isAdmin;
  const rows = [...ranked, ...tail];

  const detailHref = (row: RowPilot) =>
    pilotPath(compId, compName, taskId, taskName, row.compPilotId, row.name);
  const manualHref = (row: RowPilot) =>
    manualFlightPath(compId, compName, taskId, taskName, row.compPilotId, row.name);

  return (
    <div className="mt-4">
      {showClassName ? <h3 className="mt-4 font-semibold">{cls.pilot_class}</h3> : null}
      {/* A list of pilots, one card each, at every width — not a table. The
          six-column table it replaced scrolled sideways on a phone, with the
          status select, Upload track and Add manual flight off to the right
          where an organiser on a hill could not find them. On a wide screen
          the facts and the actions sit side by side; it is the same row. */}
      <GridList
        // NOT `Scores — ${class}`: ScoresSection's public grid already owns
        // that name, and on the task page an admin has BOTH mounted at once —
        // two grids with one accessible name is unusable with a screen reader
        // (and ambiguous to a Playwright locator). This one is the management
        // surface, and the card heading above it says so.
        aria-label={`Manage pilots & tracks — ${cls.pilot_class}`}
        className="mt-2"
      >
        {rows.map((row) => (
          <ScoresRow
            key={row.compPilotId}
            row={row}
            compId={compId}
            taskId={taskId}
            isOpenDistance={isOpenDistance}
            greyed={greyed}
            showManage={showManage}
            isClosed={isClosed}
            taskXctsk={taskXctsk}
            statuses={statuses}
            detailHref={row.outcome === "landed" && row.score ? detailHref(row) : null}
            manualHref={manualHref(row)}
            onMutated={onMutated}
          />
        ))}
      </GridList>

      {rows.length === 0 ? (
        <p className="mt-2 text-muted-foreground">No pilots yet</p>
      ) : null}
    </div>
  );
}

function OutcomeBadge({ outcome, evidence }: { outcome: Outcome; evidence: RowPilot["evidence"] }) {
  const tone: Record<Outcome, string> = {
    landed: "bg-primary/10 text-primary",
    present: "bg-muted text-muted-foreground",
    dnf: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    absent: "bg-destructive/10 text-destructive",
  };
  return (
    <span className="inline-flex items-center gap-2">
      {/* The column header it used to sit under, for a screen reader. */}
      <span className="sr-only">Outcome</span>
      <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${tone[outcome]}`}>
        {OUTCOME_LABEL[outcome]}
      </span>
      {outcome === "landed" && evidence ? (
        <span className="text-xs text-muted-foreground">
          {evidence === "manual" ? "Manual flight" : "Track"}
        </span>
      ) : null}
    </span>
  );
}

/**
 * One pilot: rank, name and points on the first line; outcome and distance
 * on the second; then the row's actions, wrapping, every one a full-size tap
 * target. A pilot with no score yet has no rank, distance or points to show,
 * so the row says nothing about them rather than printing dashes.
 *
 * The row itself does nothing when pressed. As a table row it opened the
 * score card, which on a card full of buttons would make every near-miss of
 * one of them a trip off the page; the name and View score card both go
 * there already.
 */
function ScoresRow({
  row,
  compId,
  taskId,
  isOpenDistance,
  greyed,
  showManage,
  isClosed,
  taskXctsk,
  statuses,
  detailHref,
  manualHref,
  onMutated,
}: {
  row: RowPilot;
  compId: string;
  taskId: string;
  isOpenDistance: boolean;
  greyed: boolean;
  showManage: boolean;
  isClosed: boolean;
  taskXctsk: XCTask | null;
  statuses: Map<string, PilotStatusEntry>;
  detailHref: string | null;
  /** Where this pilot's manual flight is recorded — a routed page (#637). */
  manualHref: string;
  onMutated: () => void;
}) {
  const units = useUnits();
  // The score's figures grey out while it is being recomputed.
  const figure = cn("tabular-nums", greyed && "opacity-40");

  return (
    <GridListItem
      id={row.compPilotId}
      textValue={row.name}
      className="flex flex-col gap-3 p-3 md:flex-row md:items-center md:gap-4"
    >
      <div className="flex min-w-0 flex-col gap-1 md:flex-1">
        <div className="flex items-baseline gap-3">
          {row.score ? (
            <span className={cn(figure, "shrink-0 text-muted-foreground")} aria-busy={greyed || undefined}>
              #{row.score.rank}
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate font-medium">
            {detailHref ? (
              // A real anchor (crawlable, middle-clickable) to the score card.
              <AriaLink
                href={detailHref}
                className="underline decoration-muted-foreground/40 underline-offset-4 outline-none data-hovered:decoration-current data-focus-visible:ring-2 data-focus-visible:ring-ring/50"
              >
                {row.name}
              </AriaLink>
            ) : (
              row.name
            )}
          </span>
          {!isOpenDistance && row.score ? (
            <span className={cn(figure, "shrink-0 font-medium")} aria-busy={greyed || undefined}>
              <span className="sr-only">Points </span>
              {formatRankedScore(row.score.total_score)}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <OutcomeBadge outcome={row.outcome} evidence={row.evidence} />
          {row.score ? (
            <span className={cn(figure, "text-muted-foreground")} aria-busy={greyed || undefined}>
              <span className="sr-only">Distance </span>
              {formatDistance(row.score.flown_distance, { decimals: 1, prefs: units }).withUnit}
            </span>
          ) : null}
        </div>
      </div>
      {showManage ? (
        <RowManage
          row={row}
          compId={compId}
          taskId={taskId}
          isClosed={isClosed}
          isOpenDistance={isOpenDistance}
          taskXctsk={taskXctsk}
          statuses={statuses}
          detailHref={detailHref}
          manualHref={manualHref}
          onMutated={onMutated}
        />
      ) : null}
    </GridListItem>
  );
}

/** Admin per-row actions: open the score card, set status, upload a track,
 * record a manual flight, and restore superseded evidence. */
function RowManage({
  row,
  compId,
  taskId,
  isClosed,
  isOpenDistance,
  taskXctsk,
  statuses,
  detailHref,
  manualHref,
  onMutated,
}: {
  row: RowPilot;
  compId: string;
  taskId: string;
  isClosed: boolean;
  isOpenDistance: boolean;
  taskXctsk: XCTask | null;
  statuses: Map<string, PilotStatusEntry>;
  /** The pilot's score card, when the row has one. Null for the tail. */
  detailHref: string | null;
  /** Where this pilot's manual flight is recorded — a routed page (#637). */
  manualHref: string;
  onMutated: () => void;
}) {
  // Every action on the row shares one: one press at a time, and a refusal
  // shown under the row's buttons — where the organiser just pressed — not in
  // a toast that is gone before it is read (rac/form.tsx, `useAction`).
  const action = useAction();
  const busy = action.pending;

  // The pilot is already known from the row, so the Track button skips the
  // pilot-picker dialog and uploads straight to this pilot's IGC endpoint.
  // RAC FileTrigger replaces the old hidden-<input> + ref dance.
  async function uploadTrackFile(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".igc")) {
      action.refuse(NOT_AN_IGC_MESSAGE);
      return;
    }
    let compressed: ArrayBuffer;
    try {
      compressed = await compressIgc(file);
    } catch {
      // Nothing was sent: the file could not be read, which is not a
      // dropped connection.
      action.refuse(UNREADABLE_FILE_MESSAGE);
      return;
    }
    // The size rule is the server's, both halves of it. This used to be an
    // invented 5 MB check on the raw file, which matched neither.
    const tooLarge = tooLargeReason(file.size, compressed.byteLength);
    if (tooLarge) {
      action.refuse(tooLarge);
      return;
    }
    const res = await action.run(() =>
      fetch(
        `/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/igc/${encodeURIComponent(row.compPilotId)}`,
        { method: "POST", credentials: "include", body: compressed }
      ),
      { key: "upload" }
    );
    if (!res) return;
    const data = (await res.json().catch(() => ({}))) as {
      replaced?: boolean;
      track_quality?: TrackQualityWire | null;
    };
    // A withheld track must not be announced as a plain success — the pilot
    // it belongs to is not here to notice, so the admin is the only one who
    // can act on it. The upload itself succeeded, so this stays a toast.
    const outcome = describeUploadOutcome(row.name, !!data.replaced, data.track_quality);
    toast[outcome.tone](outcome.message);
    onMutated();
  }

  // The status the admin controls directly: Present (clear) / Absent / DNF.
  // Landed is derived from evidence and never hand-set. A refused change
  // leaves the select showing the stored status, with the reason beneath.
  const statusKey = statuses.get(row.compPilotId)?.status_key ?? "";
  const statusValue = statusKey === "absent" || statusKey === "dnf" ? statusKey : "";

  async function setStatus(next: string) {
    const param = { comp_id: compId, task_id: taskId, comp_pilot_id: row.compPilotId };
    const endpoint =
      api.api.comp[":comp_id"].task[":task_id"]["pilot-status"][":comp_pilot_id"];
    const res = await action.run(() =>
      next === ""
        ? endpoint.$delete({ param })
        : endpoint.$put({
            param,
            json: { status_key: next as "absent" | "dnf", note: null },
          })
    );
    if (res) onMutated();
  }

  async function restoreTrack() {
    const res = await action.run(() =>
      fetch(
        `/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/igc/${encodeURIComponent(row.compPilotId)}/restore`,
        { method: "POST", credentials: "include" }
      ),
      { key: "restore" }
    );
    if (res) onMutated();
  }

  // A manual flight needs a route to measure against (GAP course or take-off
  // cylinder). Both formats define at least one turnpoint.
  const hasRoute = taskXctsk && taskXctsk.turnpoints.length > 0;

  // Every action is a full-size tap target (44 px, `h-11`), wrapping onto as
  // many lines as the screen needs: on a phone they are the row's third line,
  // on a wide screen they sit to the right of the pilot's facts.
  const tap = "h-11";

  return (
    <div className="flex flex-wrap items-center gap-2 md:max-w-[60%] md:justify-end">
      {/* What changes the pilot's outcome first; reading their score card,
          which changes nothing, last. */}
      {/* A row action, not a form field: a list in flow would blow the row
          apart. Deliberately still a popover — see rac/select.tsx on #638,
          and e2e/popover-position.spec.ts, which pins its geometry. */}
      <SimpleSelect
        value={statusValue}
        onChange={(v) => void setStatus(v)}
        options={[
          { value: "", label: "Present" },
          { value: "absent", label: "Absent" },
          { value: "dnf", label: "Did Not Fly" },
        ]}
        disabled={busy || isClosed}
        ariaLabel={`Status for ${row.name}`}
        triggerClassName={cn(tap, "text-base")}
      />
      {!isClosed ? (
        <TooltipTrigger>
          <FileTrigger
            acceptedFileTypes={[".igc"]}
            onSelect={(files) => void uploadTrackFile(files)}
          >
            <Button
              variant="outline"
              // Busy while its own upload is in flight; another of the row's
              // actions in flight leaves it unavailable meanwhile.
              isPending={action.pendingKey === "upload"}
              pendingLabel={`Uploading ${row.name}'s track`}
              isDisabled={busy && action.pendingKey !== "upload"}
              className={tap}
            >
              {row.evidence === "track" ? "Replace track" : "Upload track"}
            </Button>
          </FileTrigger>
          <Tooltip>Upload {row.name}'s GPS track (IGC file)</Tooltip>
        </TooltipTrigger>
      ) : null}
      {!isClosed && hasRoute ? (
        <TooltipTrigger>
          {/* A link, not a dialog trigger: recording a manual flight is a
              routed page since #637. */}
          <LinkButton variant="outline" href={manualHref} className={tap}>
            {row.evidence === "manual" ? "Edit manual flight" : "Add manual flight"}
          </LinkButton>
          <Tooltip>
            Record a manual flight for {row.name} — for a pilot with no tracklog
          </Tooltip>
        </TooltipTrigger>
      ) : null}
      {row.supersededTrack && row.evidence !== "track" && !isClosed ? (
        <TooltipTrigger>
          <Button
            variant="outline"
            isPending={action.pendingKey === "restore"}
            pendingLabel={`Restoring ${row.name}'s track`}
            isDisabled={busy && action.pendingKey !== "restore"}
            onPress={() => void restoreTrack()}
            className={tap}
          >
            Restore track
          </Button>
          <Tooltip>Restore this pilot's superseded track</Tooltip>
        </TooltipTrigger>
      ) : null}
      {detailHref ? (
        // The name links there too, but nothing says so — this names the
        // destination. A real anchor, so middle-click and "open in new tab"
        // work.
        <TooltipTrigger>
          <LinkButton variant="outline" href={detailHref} className={tap}>
            View score card
          </LinkButton>
          <Tooltip>
            Open {row.name}&rsquo;s score card
          </Tooltip>
        </TooltipTrigger>
      ) : null}
      {/* On a line of its own under the buttons. The wrapper keeps the list
          out of it: a GridList answers focus arriving inside a row by taking
          it for the row — away from the refusal, which is where the kit puts
          it so that it is read out. */}
      <div className="basis-full empty:hidden" onFocus={(e) => e.stopPropagation()}>
        <ActionErrorBanner action={action} />
      </div>
    </div>
  );
}
