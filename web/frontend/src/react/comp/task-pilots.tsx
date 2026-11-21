/**
 * One task's pilots as an organiser manages them: who scored, who did not,
 * and what evidence each has.
 *
 * Two surfaces read it, so they cannot disagree: the list on the task page
 * ("Manage pilots & tracks", comp/TaskScoresAdmin.tsx) and the page a row of
 * it opens, one pilot on one task (pages/TaskPilotPage.tsx). Each fetches for
 * itself: nothing is handed over in memory from the page underneath, which a
 * reload or a shared link would not have.
 *
 * Staleness: a status, track or manual-flight change is a whole-task rescore
 * (launch validity ripples to everyone). Score figures grey out while stale;
 * the fresh outcome overrides the stale blob for ranked-or-tail placement (a
 * just-DNF'd pilot leaves the ranked section at once); ScoreFreshness
 * surfaces a Reload when the rescore lands. No silent resettle.
 */
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/react/lib/utils";
import { api } from "../../comp/api";
import { formatRankedScore } from "../lib/format";
import { formatDistance, useUnits } from "../lib/units";
import type {
  ClassScore,
  ManualFlightEntry,
  PilotListEntry,
  PilotScoreEntry,
  PilotStatusEntry,
  TaskScoreData,
  TrackInfo,
} from "./types";

export type Outcome = "present" | "absent" | "dnf" | "landed";

export const OUTCOME_LABEL: Record<Outcome, string> = {
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

export interface RowPilot {
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

/** One class of the task: its pilots in the order the list shows them. */
export interface ClassRows {
  pilotClass: string;
  rows: RowPilot[];
}

export function useTaskPilots({
  compId,
  taskId,
  refresh = 0,
  onMutated,
}: {
  compId: string;
  taskId: string;
  /** Parent bump to refetch scores (route edits). */
  refresh?: number;
  /** Told when a mutation happened, so the public scores refetch too. */
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


  if (scoreState !== "ok" || !score) {
    return {
      state: scoreState === "ok" ? ("unavailable" as const) : scoreState,
      score: null,
      etag,
      greyed: false,
      classes: [] as ClassRows[],
      statuses,
      afterMutation,
    };
  }

  const greyed = score.stale || localDirty;

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


  const classes: ClassRows[] = score.class_scores.map((cls) => ({
    pilotClass: cls.pilot_class,
    rows: classRows(cls),
  }));

  function classRows(cls: ClassScore): RowPilot[] {
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

    return [...ranked, ...tail];
  }

  return { state: "ok" as const, score, etag, greyed, classes, statuses, afterMutation };
}

/** The pilot's outcome on the task, and the evidence behind a landing. */
export function OutcomeBadge({ outcome, evidence }: { outcome: Outcome; evidence: RowPilot["evidence"] }) {
  const tone: Record<Outcome, string> = {
    landed: "bg-primary/10 text-link",
    present: "bg-muted text-muted-foreground",
    dnf: "bg-warning/15 text-caution",
    absent: "bg-destructive/10 text-danger",
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
 * One pilot's facts, the same two lines on the list and on their page: rank,
 * name and points; then outcome, evidence and distance. A pilot with no score
 * yet has no rank, distance or points to show, so the lines say nothing about
 * them, and print no dashes.
 */
export function PilotFacts({
  row,
  isOpenDistance,
  greyed,
}: {
  row: RowPilot;
  isOpenDistance: boolean;
  /** The score is being recomputed: its figures are greyed. */
  greyed: boolean;
}) {
  const units = useUnits();
  const figure = cn("tabular-nums", greyed && "opacity-40");
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex items-baseline gap-3">
        {row.score ? (
          <span className={cn(figure, "shrink-0 text-muted-foreground")} aria-busy={greyed || undefined}>
            #{row.score.rank}
          </span>
        ) : null}
        {/* Wraps, never cut short: a name is how the organiser finds the row. */}
        <span className="min-w-0 flex-1 break-words font-medium">{row.name}</span>
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
  );
}
