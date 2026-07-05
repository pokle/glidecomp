/**
 * Task detail page — React port of the task view in comp-detail.ts.
 *
 * Deliberate deviation from the vanilla page: the interactive task-route
 * editor (analysis/task-editor) is not embedded. Instead a read-only
 * Turnpoints listing is shown, with a link to the vanilla task page for
 * route editing.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import { Input } from "@base-ui/react/input";
import type { XCTask } from "@glidecomp/engine";
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
        <Link to="/comp">Back to Competitions</Link>
      </div>
    );
  }

  if (!task) {
    return (
      <p role="status" aria-label="Loading task">
        Loading task…
      </p>
    );
  }

  const isClosed = isPastCloseDate(comp?.close_date ?? null);

  return (
    <div>
      <nav>
        <Link to="/comp">Competitions</Link> ›{" "}
        <Link to={`/comp/${compId}`}>{comp?.name ?? "Back to competition"}</Link>
      </nav>

      <h1>{task.name}</h1>
      <p>
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
      <ul>
        {task.pilot_classes.map((cls) => (
          <li key={cls}>{cls}</li>
        ))}
      </ul>
      {replayAvailable ? (
        <p>
          <a
            href={`/replay?comp=${encodeURIComponent(compId)}&task=${encodeURIComponent(taskId)}`}
            title="Open the 3D flight replay for this task"
          >
            3D replay
          </a>
        </p>
      ) : null}
      {isAdmin && comp ? (
        <button type="button" onClick={() => setEditOpen(true)}>
          Settings
        </button>
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
      <h2>Turnpoints</h2>
      {xctsk && xctsk.turnpoints.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Name</th>
              <th>Radius</th>
              <th>Type</th>
            </tr>
          </thead>
          <tbody>
            {xctsk.turnpoints.map((tp, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>{tp.waypoint.name}</td>
                <td>{tp.radius} m</td>
                <td>{tp.type ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>No route defined yet</p>
      )}
      <p>
        Route editing is available on the{" "}
        <a href={`/comp/${compId}/task/${taskId}`}>vanilla task page</a>.
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
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="Dialog-backdrop" />
        <Dialog.Popup className="Dialog-popup">
          <Dialog.Title className="Dialog-title">Task Settings</Dialog.Title>
          <form onSubmit={(e) => void save(e)}>
            <Field.Root className="Field">
              <Field.Label className="Field-label">Name</Field.Label>
              <Input
                required
                maxLength={128}
                value={name}
                onValueChange={(v) => setName(v)}
              />
            </Field.Root>
            <Field.Root className="Field">
              <Field.Label className="Field-label">Date</Field.Label>
              <Input
                type="date"
                required
                value={taskDate}
                onValueChange={(v) => setTaskDate(v)}
              />
            </Field.Root>
            <fieldset>
              <legend>Pilot Classes</legend>
              {compPilotClasses.map((cls) => (
                <CheckboxField
                  key={cls}
                  checked={selectedClasses.includes(cls)}
                  onChange={(checked) => toggleClass(cls, checked)}
                  label={cls}
                />
              ))}
            </fieldset>
            <button type="button" onClick={() => void deleteTask()}>
              Delete task
            </button>{" "}
            <Dialog.Close>Cancel</Dialog.Close>{" "}
            <button type="submit" disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </button>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
