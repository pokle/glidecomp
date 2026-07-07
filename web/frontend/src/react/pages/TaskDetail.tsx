/**
 * Task detail page — React port of the task view in comp-detail.ts.
 *
 * Deliberate deviation from the vanilla page: the interactive task-route
 * editor (analysis/task-editor) is not embedded. Instead a read-only
 * Turnpoints listing is shown, with a link to the vanilla task page for
 * route editing.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  calculateOptimizedTaskDistance,
  isValidTask,
  parseXCTaskAsync,
  type SSSConfig,
  type XCTask,
} from "@glidecomp/engine";
import { Button } from "@/react/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/react/ui/dialog";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/react/ui/field";
import { Input } from "@/react/ui/input";
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
import { useConfirm } from "../lib/confirm";
import { useUser } from "../lib/user";
import { formatTaskDate } from "../lib/format";
import { CheckboxField, SimpleSelect } from "../comp/fields";
import { PilotStatusSection } from "../comp/PilotStatusSection";
import { ScoresSection } from "../comp/ScoresSection";
import { TrackSection } from "../comp/TrackSection";
import {
  fetchWithRetry,
  isPastCloseDate,
  type CompDetailData,
  type PilotListEntry,
  type TaskDetailData,
} from "../comp/types";

export function TaskDetail() {
  const { compId, taskId } = useParams<{ compId: string; taskId: string }>();
  const { user } = useUser();
  const [task, setTask] = useState<TaskDetailData | null>(null);
  const [comp, setComp] = useState<CompDetailData | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [scoresRefresh, setScoresRefresh] = useState(0);
  const [replayAvailable, setReplayAvailable] = useState(false);
  const [canUploadOnBehalf, setCanUploadOnBehalf] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [gatesOpen, setGatesOpen] = useState(false);

  useEffect(() => {
    if (!compId || !taskId) {
      setNotFound(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // Fetch task first — this is the primary data we need
        const taskRes = await fetchWithRetry(() =>
          api.api.comp[":comp_id"].task[":task_id"].$get({
            param: { comp_id: compId, task_id: taskId },
          })
        );
        if (cancelled) return;
        if (!taskRes.ok) {
          setNotFound(true);
          return;
        }
        const taskData = (await taskRes.json()) as unknown as TaskDetailData;
        if (cancelled) return;
        setTask(taskData);
        document.title = `GlideComp - ${taskData.name}`;

        // Fetch comp for admin check + comp name (non-critical)
        try {
          const compRes = await api.api.comp[":comp_id"].$get({
            param: { comp_id: compId },
          });
          if (compRes.ok) {
            const compData = (await compRes.json()) as unknown as CompDetailData;
            if (!cancelled) setComp(compData);
          }
        } catch {
          // Comp fetch failed — degrade gracefully (no admin features)
        }
      } catch {
        if (!cancelled) setNotFound(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compId, taskId, refresh]);

  const isAdmin = user != null && comp != null && comp.admins.some((a) => a.email === user.email);

  // Determine if the current user can upload on behalf. Admins always can;
  // registered pilots can when comp.open_igc_upload is enabled. Registration
  // is checked by matching the user's email against a comp_pilot's
  // linked_email.
  useEffect(() => {
    if (isAdmin) {
      setCanUploadOnBehalf(true);
      return;
    }
    if (!user || !comp?.open_igc_upload || !compId) {
      setCanUploadOnBehalf(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const pilotsRes = await api.api.comp[":comp_id"].pilot.$get({
          param: { comp_id: compId },
        });
        if (!pilotsRes.ok || cancelled) return;
        const pilotsData = (await pilotsRes.json()) as { pilots: PilotListEntry[] };
        if (!cancelled) {
          setCanUploadOnBehalf(pilotsData.pilots.some((p) => p.linked_email === user.email));
        }
      } catch {
        // Non-critical — default to admin-only
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, comp, isAdmin, compId]);

  if (notFound || !compId || !taskId) {
    return (
      <div>
        <p>Competition not found</p>
        <Link className="underline underline-offset-4" to="/comp">
          Back to Competitions
        </Link>
      </div>
    );
  }

  if (!task) {
    return (
      <p role="status" aria-label="Loading task" className="text-muted-foreground">
        Loading task…
      </p>
    );
  }

  const isClosed = isPastCloseDate(comp?.close_date ?? null);

  return (
    <div>
      <nav className="text-sm">
        <Link className="underline underline-offset-4" to="/comp">
          Competitions
        </Link>{" "}
        ›{" "}
        <Link className="underline underline-offset-4" to={`/comp/${compId}`}>
          {comp?.name ?? "Back to competition"}
        </Link>
      </nav>

      <h1 className="mt-2 text-2xl font-bold">{task.name}</h1>
      <p className="text-sm text-muted-foreground">
        <span>
          {formatTaskDate(task.task_date, {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
          })}
        </span>{" "}
        <span>{task.xctsk ? "Task defined" : "No task defined"}</span>
      </p>
      <ul className="mt-1 text-sm text-muted-foreground">
        {task.pilot_classes.map((cls) => (
          <li key={cls}>{cls}</li>
        ))}
      </ul>
      {replayAvailable ? (
        <p className="mt-2 text-sm">
          <a
            className="underline underline-offset-4"
            href={`/replay?comp=${encodeURIComponent(compId)}&task=${encodeURIComponent(taskId)}`}
            title="Open the 3D flight replay for this task"
          >
            3D replay
          </a>
        </p>
      ) : null}
      {isAdmin && comp ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={() => setEditOpen(true)}
        >
          Settings
        </Button>
      ) : null}

      <TurnpointsSection
        compId={compId}
        taskId={taskId}
        xctsk={task.xctsk}
        isAdmin={isAdmin}
        onEditStartGates={() => setGatesOpen(true)}
        onRouteChanged={() => {
          setRefresh((n) => n + 1);
          setScoresRefresh((n) => n + 1);
        }}
      />

      <TrackSection
        compId={compId}
        taskId={taskId}
        isAuthenticated={user != null}
        isAdmin={isAdmin}
        isClosed={isClosed}
        canUploadOnBehalf={canUploadOnBehalf}
        onTracksChanged={() => setScoresRefresh((n) => n + 1)}
      />

      {/* Pilot status (safety roll call) — skipped when comp data failed to
          load because we have no status config. */}
      {comp ? (
        <PilotStatusSection
          compId={compId}
          taskId={taskId}
          statusConfig={comp.pilot_statuses ?? []}
          user={user}
          isAdmin={isAdmin}
          openIgcUpload={comp.open_igc_upload}
        />
      ) : null}

      <ScoresSection
        compId={compId}
        taskId={taskId}
        refresh={scoresRefresh}
        onReplayAvailable={setReplayAvailable}
      />

      {isAdmin && comp && editOpen ? (
        <EditTaskDialog
          compId={compId}
          taskId={taskId}
          task={task}
          compPilotClasses={comp.pilot_classes}
          onClose={() => setEditOpen(false)}
          onSaved={() => {
            setEditOpen(false);
            setRefresh((n) => n + 1);
          }}
        />
      ) : null}

      {isAdmin && gatesOpen && task.xctsk ? (
        <StartGatesDialog
          compId={compId}
          taskId={taskId}
          xctsk={task.xctsk}
          taskDate={task.task_date}
          onClose={() => setGatesOpen(false)}
          onSaved={() => {
            setGatesOpen(false);
            setRefresh((n) => n + 1);
            setScoresRefresh((n) => n + 1);
          }}
        />
      ) : null}
    </div>
  );
}

/** "HH:MM:SSZ" / "HH:MM" (the xctsk gate format) → "HH:MM", or null. */
function gateToHHMM(value: string): string | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?Z?$/.exec(value.trim());
  if (!m) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

/** The task's real gates as "HH:MM" — drops the lone 00:00 placeholder. */
function editableGates(sss: SSSConfig | undefined): string[] {
  const gates = (sss?.timeGates ?? [])
    .map(gateToHHMM)
    .filter((g): g is string => g !== null);
  // toXctskJSON writes a lone 00:00:00Z to satisfy the format's
  // non-empty-gates rule; scoring ignores it, so the editor does too.
  if (gates.length === 1 && gates[0] === "00:00") return [];
  return gates;
}

/** One-line human summary of the start configuration. */
function startConfigSummary(sss: SSSConfig): string {
  const kind = sss.type === "ELAPSED-TIME" ? "Elapsed time" : "Race to goal";
  const dir = sss.direction === "ENTER" ? "enter" : "exit";
  const gates = editableGates(sss);
  const gateStr =
    sss.type === "ELAPSED-TIME"
      ? gates.length > 0
        ? ` · start opens ${gates[0]} UTC`
        : ""
      : gates.length > 0
        ? ` · ${gates.length} start gate${gates.length === 1 ? "" : "s"}: ${gates.join(", ")} UTC`
        : " · no start gates (pilots timed from their crossing)";
  return `${kind} · ${dir} start${gateStr}`;
}

/**
 * Turnpoint listing with admin route management. The interactive route
 * *editor* is not ported to React (see #270 — the vanilla one was removed
 * with the SPA migration); admins set a route by uploading a .xctsk file
 * (built in XCTrack or the analysis page) and configure start gates via a
 * dialog.
 */
function TurnpointsSection({
  compId,
  taskId,
  xctsk,
  isAdmin,
  onEditStartGates,
  onRouteChanged,
}: {
  compId: string;
  taskId: string;
  xctsk: XCTask | null;
  isAdmin: boolean;
  onEditStartGates: () => void;
  onRouteChanged: () => void;
}) {
  const confirm = useConfirm();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function handleFile(input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;

    let parsed: XCTask;
    try {
      parsed = await parseXCTaskAsync(await file.text());
    } catch {
      toast.error(`Could not read ${file.name} — is it a valid .xctsk task file?`);
      return;
    }
    if (!isValidTask(parsed)) {
      toast.error(`${file.name} has no valid turnpoints`);
      return;
    }

    const km = (calculateOptimizedTaskDistance(parsed) / 1000).toFixed(1);
    if (xctsk && xctsk.turnpoints.length > 0) {
      const ok = await confirm({
        title: "Replace the current route?",
        message: `The uploaded task has ${parsed.turnpoints.length} turnpoints (${km} km optimized). This replaces the existing route and scores will be recomputed against it.`,
        confirmLabel: "Replace route",
        destructive: true,
      });
      if (!ok) return;
    }

    setUploading(true);
    try {
      const res = await api.api.comp[":comp_id"].task[":task_id"].$patch({
        param: { comp_id: compId, task_id: taskId },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        json: { xctsk: xctskForPatch(parsed) as any },
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        toast.error(err.error || "Failed to save the route");
        return;
      }
      toast.success(`Route set: ${parsed.turnpoints.length} turnpoints, ${km} km`);
      onRouteChanged();
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  if (!xctsk && !isAdmin) return null;
  return (
    <section>
      <h2 className="mt-8 text-lg font-bold">Turnpoints</h2>
      {xctsk && xctsk.turnpoints.length > 0 ? (
        <Table className="mt-2">
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Radius</TableHead>
              <TableHead>Type</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {xctsk.turnpoints.map((tp, i) => (
              <TableRow key={i}>
                <TableCell>{i + 1}</TableCell>
                <TableCell>{tp.waypoint.name}</TableCell>
                <TableCell>{tp.radius} m</TableCell>
                <TableCell>{tp.type ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="mt-2 text-muted-foreground">No route defined yet</p>
      )}
      {xctsk?.sss ? (
        <p className="mt-2 text-sm text-muted-foreground">{startConfigSummary(xctsk.sss)}</p>
      ) : null}
      {isAdmin ? (
        <>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".xctsk"
              hidden
              onChange={(e) => void handleFile(e.currentTarget)}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
            >
              {uploading
                ? "Uploading…"
                : xctsk && xctsk.turnpoints.length > 0
                  ? "Replace route (.xctsk)…"
                  : "Upload route (.xctsk)…"}
            </Button>
            {xctsk ? (
              <Button type="button" variant="outline" size="sm" onClick={onEditStartGates}>
                Start gates…
              </Button>
            ) : null}
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Build a route in XCTrack or the{" "}
            <a className="underline underline-offset-4" href="/analysis.html">
              analysis page
            </a>
            , save it as .xctsk, and upload it here.
          </p>
        </>
      ) : null}
    </section>
  );
}

/**
 * Serialize a parsed XCTask to the strict shape the API's xctsk validator
 * accepts. Picks only known fields so stray keys (e.g. from tasks stored
 * by the seed script, or spec extensions in uploaded files) can't fail
 * the strict schema.
 */
function xctskForPatch(task: XCTask): Record<string, unknown> {
  const takeoff = {
    ...(task.takeoff?.timeOpen !== undefined ? { timeOpen: task.takeoff.timeOpen } : {}),
    ...(task.takeoff?.timeClose !== undefined ? { timeClose: task.takeoff.timeClose } : {}),
  };
  return {
    taskType: task.taskType || "CLASSIC",
    version: task.version ?? 1,
    ...(task.earthModel ? { earthModel: task.earthModel } : {}),
    turnpoints: task.turnpoints.map((tp) => ({
      ...(tp.type ? { type: tp.type } : {}),
      radius: tp.radius,
      waypoint: {
        name: tp.waypoint.name,
        ...(tp.waypoint.description !== undefined
          ? { description: tp.waypoint.description }
          : {}),
        lat: tp.waypoint.lat,
        lon: tp.waypoint.lon,
        ...(tp.waypoint.altSmoothed !== undefined
          ? { altSmoothed: tp.waypoint.altSmoothed }
          : {}),
      },
    })),
    ...(Object.keys(takeoff).length > 0 ? { takeoff } : {}),
    ...(task.sss
      ? {
          sss: {
            type: task.sss.type,
            direction: task.sss.direction,
            ...(task.sss.timeGates && task.sss.timeGates.length > 0
              ? { timeGates: task.sss.timeGates }
              : {}),
          },
        }
      : {}),
    ...(task.goal
      ? {
          goal: {
            type: task.goal.type ?? "CYLINDER",
            ...(task.goal.deadline !== undefined ? { deadline: task.goal.deadline } : {}),
            ...(task.goal.finishAltitude !== undefined
              ? { finishAltitude: task.goal.finishAltitude }
              : {}),
          },
        }
      : {}),
    ...(task.cylinderTolerance !== undefined
      ? { cylinderTolerance: task.cylinderTolerance }
      : {}),
  };
}

/** Add minutes to an "HH:MM" time of day, wrapping at midnight. */
function addMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const total = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Start-gate configuration dialog (S7F §6.3.3). Edits the task's SSS block —
 * race vs elapsed time, start direction, and the list of gate times —
 * and PATCHes the full xctsk back (the server audit-logs gate changes).
 */
function StartGatesDialog({
  compId,
  taskId,
  xctsk,
  taskDate,
  onClose,
  onSaved,
}: {
  compId: string;
  taskId: string;
  xctsk: XCTask;
  taskDate: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [sssType, setSssType] = useState<SSSConfig["type"]>(xctsk.sss?.type ?? "RACE");
  const [direction, setDirection] = useState<SSSConfig["direction"]>(
    xctsk.sss?.direction ?? "EXIT"
  );
  const [gates, setGates] = useState<string[]>(() => editableGates(xctsk.sss));
  const [genCount, setGenCount] = useState("4");
  const [genInterval, setGenInterval] = useState("15");
  const [saving, setSaving] = useState(false);

  const hasSSSTurnpoint = xctsk.turnpoints.some((tp) => tp.type === "SSS");
  const isRace = sssType === "RACE";

  /** The viewer's local wall-clock for a UTC gate on the task date. */
  function localPreview(hhmm: string): string | null {
    const d = new Date(`${taskDate}T${hhmm}:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function updateGate(index: number, value: string) {
    setGates((prev) => prev.map((g, i) => (i === index ? value : g)));
  }

  function removeGate(index: number) {
    setGates((prev) => prev.filter((_, i) => i !== index));
  }

  function addGate() {
    setGates((prev) => {
      const last = prev[prev.length - 1];
      const interval = parseInt(genInterval, 10) || 15;
      return [...prev, last ? addMinutes(last, interval) : "12:00"];
    });
  }

  function generateSeries() {
    const count = Math.min(Math.max(parseInt(genCount, 10) || 0, 1), 100);
    const interval = parseInt(genInterval, 10) || 15;
    setGates((prev) => {
      const first = prev[0] ?? "12:00";
      return Array.from({ length: count }, (_, i) => addMinutes(first, i * interval));
    });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();

    const cleaned = gates.map((g) => gateToHHMM(g)).filter((g): g is string => g !== null);
    if (cleaned.length !== gates.length) {
      toast.warning("Every gate needs a valid time");
      return;
    }
    const sorted = [...new Set(cleaned)].sort();
    const sss: SSSConfig = {
      type: sssType,
      direction,
      ...(sorted.length > 0 ? { timeGates: sorted.map((g) => `${g}:00Z`) } : {}),
    };

    setSaving(true);
    try {
      const res = await api.api.comp[":comp_id"].task[":task_id"].$patch({
        param: { comp_id: compId, task_id: taskId },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        json: { xctsk: xctskForPatch({ ...xctsk, sss }) as any },
      });

      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        toast.error(err.error || "Failed to update start gates");
        return;
      }

      onSaved();
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Start Gates</DialogTitle>
        </DialogHeader>
        <form onSubmit={(e) => void save(e)} className="flex flex-col gap-4">
          {!hasSSSTurnpoint ? (
            <p className="text-sm text-amber-500">
              ⚠ This task has no Start (SSS) turnpoint — set one in the route editor,
              otherwise gates have no cylinder to apply to.
            </p>
          ) : null}

          <div>
            <h3 className="mb-1.5 text-sm font-medium">Start type</h3>
            <SimpleSelect
              value={sssType}
              onChange={(v) => setSssType(v as SSSConfig["type"])}
              options={[
                { value: "RACE", label: "Race to goal — timed from a start gate" },
                { value: "ELAPSED-TIME", label: "Elapsed time — timed from each pilot's crossing" },
              ]}
              ariaLabel="Start type"
            />
          </div>

          <div>
            <h3 className="mb-1.5 text-sm font-medium">Start direction</h3>
            <SimpleSelect
              value={direction}
              onChange={(v) => setDirection(v as SSSConfig["direction"])}
              options={[
                { value: "EXIT", label: "Exit — cross outward (start cylinder around launch)" },
                { value: "ENTER", label: "Enter — cross inward (start cylinder away from launch)" },
              ]}
              ariaLabel="Start direction"
            />
          </div>

          <div>
            <h3 className="text-sm font-medium">
              {isRace ? "Start gates (UTC)" : "Start open (UTC)"}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {isRace
                ? "A pilot's start time is the last gate at or before their start crossing (FAI S7F §8.3.1). Starting before the first gate is an early start."
                : "Elapsed-time pilots are timed from their actual start crossing; a gate only sets when the start opens."}
            </p>
            <ul className="mt-2 flex flex-col gap-2">
              {gates.map((g, i) => (
                <li key={i} className="flex items-center gap-2">
                  <Input
                    type="time"
                    className="w-32"
                    required
                    aria-label={`Gate ${i + 1} time (UTC)`}
                    value={g}
                    onChange={(e) => updateGate(i, e.target.value)}
                  />
                  <span className="text-xs text-muted-foreground">
                    {localPreview(g) ? `≈ ${localPreview(g)} your time` : ""}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="ml-auto"
                    onClick={() => removeGate(i)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
            {isRace && gates.length === 0 ? (
              <p className="mt-2 text-sm text-amber-500">
                ⚠ No start gates — every pilot will be timed from their actual start
                crossing, like an elapsed-time task.
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={addGate}>
                + Add gate
              </Button>
              {isRace ? (
                <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    className="w-16"
                    aria-label="Number of gates"
                    value={genCount}
                    onChange={(e) => setGenCount(e.target.value)}
                  />
                  gates every
                  <Input
                    type="number"
                    min={1}
                    max={720}
                    className="w-16"
                    aria-label="Gate interval (minutes)"
                    value={genInterval}
                    onChange={(e) => setGenInterval(e.target.value)}
                  />
                  min
                  <Button type="button" variant="outline" size="sm" onClick={generateSeries}>
                    Generate from first gate
                  </Button>
                </span>
              ) : null}
            </div>
          </div>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditTaskDialog({
  compId,
  taskId,
  task,
  compPilotClasses,
  onClose,
  onSaved,
}: {
  compId: string;
  taskId: string;
  task: TaskDetailData;
  compPilotClasses: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const nameId = useId();
  const dateId = useId();
  const [name, setName] = useState(task.name);
  const [taskDate, setTaskDate] = useState(task.task_date);
  const [selectedClasses, setSelectedClasses] = useState<string[]>(
    compPilotClasses.filter((cls) => task.pilot_classes.includes(cls))
  );
  const [saving, setSaving] = useState(false);

  function toggleClass(cls: string, checked: boolean) {
    setSelectedClasses((prev) =>
      checked ? [...prev.filter((c) => c !== cls), cls] : prev.filter((c) => c !== cls)
    );
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();

    if (selectedClasses.length === 0) {
      toast.warning("Select at least one pilot class");
      return;
    }

    setSaving(true);
    try {
      const res = await api.api.comp[":comp_id"].task[":task_id"].$patch({
        param: { comp_id: compId, task_id: taskId },
        json: {
          name: name.trim(),
          task_date: taskDate,
          pilot_classes: selectedClasses,
        },
      });

      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        toast.error(err.error || "Failed to update task");
        return;
      }

      onSaved();
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteTask() {
    const confirmed = await confirm({
      title: "Delete this task?",
      message: "This cannot be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!confirmed) return;

    try {
      const res = await api.api.comp[":comp_id"].task[":task_id"].$delete({
        param: { comp_id: compId, task_id: taskId },
      });

      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        toast.error(err.error || "Failed to delete task");
        return;
      }

      navigate(`/comp/${compId}`);
    } catch {
      toast.error("Network error. Please try again.");
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Task Settings</DialogTitle>
        </DialogHeader>
        <form onSubmit={(e) => void save(e)} className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor={nameId}>Name</FieldLabel>
            <Input
              id={nameId}
              required
              maxLength={128}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={dateId}>Date</FieldLabel>
            <Input
              id={dateId}
              type="date"
              required
              value={taskDate}
              onChange={(e) => setTaskDate(e.target.value)}
            />
          </Field>
          <FieldSet>
            <FieldLegend variant="label">Pilot Classes</FieldLegend>
            {compPilotClasses.map((cls) => (
              <CheckboxField
                key={cls}
                checked={selectedClasses.includes(cls)}
                onChange={(checked) => toggleClass(cls, checked)}
                label={cls}
              />
            ))}
          </FieldSet>
          <DialogFooter>
            <Button
              type="button"
              variant="destructive"
              className="sm:mr-auto"
              onClick={() => void deleteTask()}
            >
              Delete task
            </Button>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
