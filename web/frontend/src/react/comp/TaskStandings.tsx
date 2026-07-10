/**
 * Unified per-pilot task standings (issue #306).
 *
 * Merges the old Scores + Pilot Status + Tracks sections into one table — the
 * three were three views of one object: a pilot's outcome on a task. Ranked
 * scorers first, then a per-class "did not score" tail (present-not-flown /
 * DNF / absent). Columns: rank · pilot · outcome (badge + evidence) · distance
 * · points · Manage (admins).
 *
 * SSR-safety: the server renders ONLY the control-less scored table from the
 * SSR score seed. The tail and every admin control mount on hydration (`mounted`
 * gate), so the first client render matches the server markup exactly. The
 * roster / status / track / manual-flight data is client-fetched after
 * hydration, exactly as tracks/status already were.
 *
 * Staleness: a status/track/manual change is a whole-task rescore (launch
 * validity ripples to everyone). Score columns grey out while stale; the fresh
 * outcome overrides the stale blob for ranked-vs-tail placement (a just-DNF'd
 * pilot leaves the ranked section immediately); ScoreFreshness surfaces a
 * Reload when the rescore lands — no silent resettle.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { XCTask } from "@glidecomp/engine";
import { Button } from "@/react/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/react/ui/table";
import { api } from "../../comp/api";
import { toast } from "../lib/toast";
import { SimpleSelect } from "./fields";
import { ScoreFreshness } from "./ScoreFreshness";
import { SubmitTrackDialog } from "./SubmitTrackDialog";
import { ManualFlightDialog } from "./ManualFlightDialog";
import { compressIgc } from "./types";
import type {
  ClassScore,
  DistanceOriginValue,
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

export function TaskStandings({
  compId,
  taskId,
  isAdmin,
  isAuthenticated,
  isClosed,
  canUploadOnBehalf,
  scoringFormat,
  distanceOrigin,
  timezone,
  taskXctsk,
  refresh,
  onReplayAvailable,
  initialScore,
}: {
  compId: string;
  taskId: string;
  isAdmin: boolean;
  isAuthenticated: boolean;
  isClosed: boolean;
  canUploadOnBehalf: boolean;
  scoringFormat: "gap" | "open_distance";
  distanceOrigin: DistanceOriginValue;
  timezone: string | null;
  /** Task route — drives the ManualFlightDialog. Null when no route yet. */
  taskXctsk: XCTask | null;
  /** Parent bump to refetch scores (route edits). */
  refresh: number;
  onReplayAvailable: (available: boolean) => void;
  /** SSR-seeded score so the ranked table is in the first paint. */
  initialScore?: TaskScoreData;
}) {
  const [uploadOpen, setUploadOpen] = useState(false);
  // Hydration gate: the server and the first client render show only the
  // control-less scored table. Everything below (tail, controls) mounts after.
  const [mounted, setMounted] = useState(false);

  const [score, setScore] = useState<TaskScoreData | null>(initialScore ?? null);
  const [scoreState, setScoreState] = useState<"loading" | "no-route" | "unavailable" | "ok">(
    initialScore ? "ok" : "loading"
  );
  const [etag, setEtag] = useState<string | null>(null);

  const [roster, setRoster] = useState<PilotListEntry[]>([]);
  const [statuses, setStatuses] = useState<Map<string, PilotStatusEntry>>(new Map());
  const [tracks, setTracks] = useState<TrackInfo[]>([]);
  const [manualFlights, setManualFlights] = useState<ManualFlightEntry[]>([]);
  // Optimistic "scores are stale" the instant an admin mutates, before the
  // refetched score row reports stale itself.
  const [localDirty, setLocalDirty] = useState(false);

  const seededRef = useRef(initialScore != null);

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
      onReplayAvailable(data.classes.some((c) => c.pilots.length > 0));
      // A fresh (non-stale) score means the rescore we were waiting on landed.
      if (!data.stale) setLocalDirty(false);
    } catch {
      setScoreState("unavailable");
    }
    // onReplayAvailable is a stable parent setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Scores: seeded from SSR on first paint; otherwise fetch. Refetch on parent
  // `refresh` (route edits).
  useEffect(() => {
    if (seededRef.current && refresh === 0) {
      seededRef.current = false;
      onReplayAvailable(initialScore!.classes.some((c) => c.pilots.length > 0));
      return;
    }
    void fetchScore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  }, [fetchAux, fetchScore]);

  if (scoreState === "loading") {
    return <p className="mt-8 text-muted-foreground">Loading standings…</p>;
  }
  if (scoreState === "no-route") {
    return <p className="mt-8 text-muted-foreground">No scores yet — task route not defined</p>;
  }
  if (scoreState === "unavailable" || !score) {
    return <p className="mt-8 text-muted-foreground">Standings not available</p>;
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
    <section>
      <div className="mt-8 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-lg font-bold">
          Standings{" "}
          <Link
            className="text-sm font-normal underline underline-offset-4"
            to={`/comp/${encodeURIComponent(compId)}#scores`}
          >
            Full competition scores →
          </Link>
        </h2>
        {/* Self-service upload entry point (replaces the old Tracks section
            button). A control, so it mounts on hydration. */}
        {mounted && isAuthenticated && !isClosed ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setUploadOpen(true)}>
            Submit track
          </Button>
        ) : null}
      </div>

      {uploadOpen ? (
        <SubmitTrackDialog
          compId={compId}
          taskId={taskId}
          canUploadOnBehalf={canUploadOnBehalf}
          onClose={() => setUploadOpen(false)}
          onUploaded={() => {
            setUploadOpen(false);
            afterMutation();
          }}
        />
      ) : null}

      <ScoreFreshness
        computedAt={score.computed_at}
        stale={score.stale || localDirty}
        timezone={timezone}
        etag={etag}
        pollUrl={`/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/score`}
      />

      {score.classes.map((cls) => (
        <ClassStandings
          key={cls.pilot_class}
          compId={compId}
          taskId={taskId}
          cls={cls}
          showClassName={score.classes.length > 1}
          isOpenDistance={isOpenDistance}
          greyed={greyed}
          mounted={mounted}
          isAdmin={isAdmin}
          isClosed={isClosed}
          distanceOrigin={distanceOrigin}
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

      {score.classes.some((c) => c.pilots.length > 0) ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Click a scored pilot's row for the full breakdown — every start,
          turnpoint and point calculation, shown on the map.
        </p>
      ) : null}
    </section>
  );
}

function ClassStandings({
  compId,
  taskId,
  cls,
  showClassName,
  isOpenDistance,
  greyed,
  mounted,
  isAdmin,
  isClosed,
  distanceOrigin,
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
  cls: ClassScore;
  showClassName: boolean;
  isOpenDistance: boolean;
  greyed: boolean;
  mounted: boolean;
  isAdmin: boolean;
  isClosed: boolean;
  distanceOrigin: DistanceOriginValue;
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
  const navigate = useNavigate();

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

  const hasSpeed = cls.pilots.some((p) => p.speed_section_time !== null);
  const showManage = mounted && isAdmin;

  return (
    <div className="mt-4">
      {showClassName ? <h3 className="mt-4 font-semibold">{cls.pilot_class}</h3> : null}
      <Table className="mt-2">
        <TableHeader>
          <TableRow>
            <TableHead>#</TableHead>
            <TableHead>Pilot</TableHead>
            <TableHead>Outcome</TableHead>
            <TableHead>Distance</TableHead>
            {!isOpenDistance ? <TableHead>Points</TableHead> : null}
            {showManage ? <TableHead className="text-right">Manage</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {ranked.map((row) => (
            <StandingsRow
              key={row.compPilotId}
              row={row}
              compId={compId}
              taskId={taskId}
              isOpenDistance={isOpenDistance}
              greyed={greyed}
              showManage={showManage}
              isClosed={isClosed}
              distanceOrigin={distanceOrigin}
              taskXctsk={taskXctsk}
              statuses={statuses}
              onOpenDetail={() =>
                navigate(
                  `/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/pilot/${encodeURIComponent(row.compPilotId)}`
                )
              }
              onMutated={onMutated}
            />
          ))}
          {tail.map((row) => (
            <StandingsRow
              key={row.compPilotId}
              row={row}
              compId={compId}
              taskId={taskId}
              isOpenDistance={isOpenDistance}
              greyed={greyed}
              showManage={showManage}
              isClosed={isClosed}
              distanceOrigin={distanceOrigin}
              taskXctsk={taskXctsk}
              statuses={statuses}
              onOpenDetail={null}
              onMutated={onMutated}
            />
          ))}
        </TableBody>
      </Table>

      {ranked.length === 0 && tail.length === 0 ? (
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
    <span className="inline-flex flex-col gap-0.5">
      <span
        className={`inline-block w-fit rounded px-1.5 py-0.5 text-xs font-medium ${tone[outcome]}`}
      >
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

function StandingsRow({
  row,
  compId,
  taskId,
  isOpenDistance,
  greyed,
  showManage,
  isClosed,
  distanceOrigin,
  taskXctsk,
  statuses,
  onOpenDetail,
  onMutated,
}: {
  row: RowPilot;
  compId: string;
  taskId: string;
  isOpenDistance: boolean;
  greyed: boolean;
  showManage: boolean;
  isClosed: boolean;
  distanceOrigin: DistanceOriginValue;
  taskXctsk: XCTask | null;
  statuses: Map<string, PilotStatusEntry>;
  onOpenDetail: (() => void) | null;
  onMutated: () => void;
}) {
  const detailHref = onOpenDetail
    ? `/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/pilot/${encodeURIComponent(row.compPilotId)}`
    : null;

  const scoreCell = (content: React.ReactNode) => (
    <TableCell
      className={greyed ? "opacity-40" : undefined}
      aria-busy={greyed || undefined}
      title={greyed ? "Scores are being recomputed" : undefined}
    >
      {content}
    </TableCell>
  );

  return (
    <TableRow className={detailHref ? "cursor-pointer" : undefined} onClick={onOpenDetail ?? undefined}>
      {scoreCell(row.score ? row.score.rank : "—")}
      <TableCell>
        {detailHref ? (
          <Link
            to={detailHref}
            className="underline decoration-muted-foreground/40 underline-offset-4 hover:decoration-current"
            onClick={(e) => e.stopPropagation()}
          >
            {row.name}
          </Link>
        ) : (
          row.name
        )}
      </TableCell>
      <TableCell>
        <OutcomeBadge outcome={row.outcome} evidence={row.evidence} />
      </TableCell>
      {scoreCell(row.score ? `${(row.score.flown_distance / 1000).toFixed(1)} km` : "—")}
      {!isOpenDistance ? scoreCell(row.score ? Math.round(row.score.total_score) : "—") : null}
      {showManage ? (
        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
          <RowManage
            row={row}
            compId={compId}
            taskId={taskId}
            isClosed={isClosed}
            isOpenDistance={isOpenDistance}
            distanceOrigin={distanceOrigin}
            taskXctsk={taskXctsk}
            statuses={statuses}
            onMutated={onMutated}
          />
        </TableCell>
      ) : null}
    </TableRow>
  );
}

/** Admin per-row actions: set status, upload a track, record a manual flight,
 * and restore superseded evidence. */
function RowManage({
  row,
  compId,
  taskId,
  isClosed,
  isOpenDistance,
  distanceOrigin,
  taskXctsk,
  statuses,
  onMutated,
}: {
  row: RowPilot;
  compId: string;
  taskId: string;
  isClosed: boolean;
  isOpenDistance: boolean;
  distanceOrigin: DistanceOriginValue;
  taskXctsk: XCTask | null;
  statuses: Map<string, PilotStatusEntry>;
  onMutated: () => void;
}) {
  const [recordOpen, setRecordOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The pilot is already known from the row, so the Track button skips the
  // pilot-picker dialog and uploads straight to this pilot's IGC endpoint.
  async function uploadTrackFile() {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".igc")) {
      toast.error("Please choose an IGC file");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("File too large (max 5MB)");
      return;
    }
    setBusy(true);
    try {
      const compressed = await compressIgc(file);
      const res = await fetch(
        `/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/igc/${encodeURIComponent(row.compPilotId)}`,
        { method: "POST", credentials: "include", body: compressed }
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(err.error || "Upload failed");
        return;
      }
      const data = (await res.json()) as { replaced?: boolean };
      toast.success(
        data.replaced ? `Track replaced for ${row.name}` : `Track uploaded for ${row.name}`
      );
      onMutated();
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // The status the admin controls directly: Present (clear) / Absent / DNF.
  // Landed is derived from evidence and never hand-set.
  const statusKey = statuses.get(row.compPilotId)?.status_key ?? "";
  const statusValue = statusKey === "absent" || statusKey === "dnf" ? statusKey : "";

  async function setStatus(next: string) {
    setBusy(true);
    try {
      if (next === "") {
        const res = await api.api.comp[":comp_id"].task[":task_id"]["pilot-status"][
          ":comp_pilot_id"
        ].$delete({
          param: { comp_id: compId, task_id: taskId, comp_pilot_id: row.compPilotId },
        });
        if (!res.ok) throw new Error();
      } else {
        const res = await api.api.comp[":comp_id"].task[":task_id"]["pilot-status"][
          ":comp_pilot_id"
        ].$put({
          param: { comp_id: compId, task_id: taskId, comp_pilot_id: row.compPilotId },
          json: { status_key: next as "absent" | "dnf", note: null },
        });
        if (!res.ok) throw new Error();
      }
      onMutated();
    } catch {
      toast.error("Failed to update status");
    } finally {
      setBusy(false);
    }
  }

  async function restoreTrack() {
    setBusy(true);
    try {
      const res = await fetch(
        `/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/igc/${encodeURIComponent(row.compPilotId)}/restore`,
        { method: "POST", credentials: "include" }
      );
      if (!res.ok) throw new Error();
      onMutated();
    } catch {
      toast.error("Failed to restore track");
    } finally {
      setBusy(false);
    }
  }

  // A manual flight needs a route to measure against (GAP course or take-off
  // cylinder). Both formats define at least one turnpoint.
  const hasRoute = taskXctsk && taskXctsk.turnpoints.length > 0;

  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
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
      />
      {!isClosed ? (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept=".igc"
            className="hidden"
            onChange={() => void uploadTrackFile()}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
            title={`Upload ${row.name}'s GPS track (IGC file)`}
          >
            {row.evidence === "track" ? "Replace track" : "Upload track"}
          </Button>
        </>
      ) : null}
      {!isClosed && hasRoute ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setRecordOpen(true)}
          title={`Record a manual flight for ${row.name} — for a pilot with no tracklog`}
        >
          {row.evidence === "manual" ? "Edit manual flight" : "Add manual flight"}
        </Button>
      ) : null}
      {row.supersededTrack && row.evidence !== "track" && !isClosed ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void restoreTrack()}
          title="Restore this pilot's superseded track"
        >
          Restore track
        </Button>
      ) : null}

      {recordOpen && taskXctsk ? (
        <ManualFlightDialog
          compId={compId}
          taskId={taskId}
          compPilotId={row.compPilotId}
          pilotName={row.name}
          task={taskXctsk}
          distanceOrigin={distanceOrigin}
          openDistance={isOpenDistance}
          existing={row.activeManual}
          onClose={() => setRecordOpen(false)}
          onSaved={() => {
            setRecordOpen(false);
            onMutated();
          }}
        />
      ) : null}
    </div>
  );
}
