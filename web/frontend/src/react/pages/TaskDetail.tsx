/**
 * Task detail page — React port of the task view in comp-detail.ts.
 *
 * Deliberate deviation from the vanilla page: the interactive task-route
 * editor (analysis/task-editor) is not embedded. Instead a read-only
 * Turnpoints listing is shown, with a link to the vanilla task page for
 * route editing.
 */
import { useEffect, useId, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { XCTask } from "@glidecomp/engine";
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
import { CheckboxField } from "../comp/fields";
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

      <TurnpointsSection compId={compId} taskId={taskId} xctsk={task.xctsk} isAdmin={isAdmin} />

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
    </div>
  );
}

/**
 * Read-only turnpoint listing. The interactive route editor is only on the
 * vanilla task page — deliberate omission in the React port.
 */
function TurnpointsSection({
  compId,
  taskId,
  xctsk,
  isAdmin,
}: {
  compId: string;
  taskId: string;
  xctsk: XCTask | null;
  isAdmin: boolean;
}) {
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
      <p className="mt-2 text-sm text-muted-foreground">
        Route editing is available on the{" "}
        <a
          className="underline underline-offset-4"
          href={`/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}`}
        >
          vanilla task page
        </a>
        .
      </p>
    </section>
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
