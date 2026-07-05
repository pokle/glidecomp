/**
 * Competition detail page — React port of the comp view in comp-detail.ts.
 * Mutations that used to window.location.reload() instead bump a refresh
 * counter that re-runs the comp fetch.
 */
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import { Input } from "@base-ui/react/input";
import { api } from "../../comp/api";
import { toast } from "../lib/toast";
import { useUser } from "../lib/user";
import { categoryLabel, formatTaskDate } from "../lib/format";
import { ActivitySection } from "../comp/ActivitySection";
import { PilotsSection } from "../comp/PilotsSection";
import { SettingsDialog } from "../comp/SettingsDialog";
import { CheckboxField } from "../comp/fields";
import {
  compressIgc,
  fetchWithRetry,
  isPastCloseDate,
  type CompDetailData,
  type TaskSummary,
} from "../comp/types";

export function CompDetail() {
  const { compId } = useParams<{ compId: string }>();
  const { user } = useUser();
  const [comp, setComp] = useState<CompDetailData | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    if (!compId) {
      setNotFound(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithRetry(() =>
          api.api.comp[":comp_id"].$get({ param: { comp_id: compId } })
        );
        if (cancelled) return;
        if (!res.ok) {
          setNotFound(true);
          return;
        }
        const data = (await res.json()) as unknown as CompDetailData;
        if (cancelled) return;
        setComp(data);
        document.title = `GlideComp - ${data.name}`;
      } catch {
        if (!cancelled) setNotFound(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compId, refresh]);

  if (notFound || !compId) {
    return (
      <div>
        <p>Competition not found</p>
        <Link to="/comp">Back to Competitions</Link>
      </div>
    );
  }

  if (!comp) {
    return (
      <p role="status" aria-label="Loading competition">
        Loading competition…
      </p>
    );
  }

  const isAdmin = user != null && comp.admins.some((a) => a.email === user.email);
  const compClosed = isPastCloseDate(comp.close_date);
  const canSubmitTrack = user != null && !compClosed;

  return (
    <div>
      <nav>
        <Link to="/comp">All Competitions</Link>
      </nav>

      <h1>{comp.name}</h1>
      <p>
        <span>{categoryLabel(comp.category)}</span>
        {comp.test ? <span> Test</span> : null} <span>{comp.pilot_classes.join(", ")}</span>
      </p>
      {comp.tasks.some((t) => t.has_xctsk) ? (
        <p>
          <Link to={`/scores?comp_id=${encodeURIComponent(compId)}`}>View scores →</Link>
        </p>
      ) : null}
      {isAdmin ? (
        <button type="button" onClick={() => setSettingsOpen(true)}>
          Settings
        </button>
      ) : null}

      <ClassWarnings warnings={comp.class_coverage_warnings} />

      <section>
        <h2>
          Tasks
          {isAdmin ? (
            <>
              {" "}
              <button type="button" onClick={() => setCreateOpen(true)}>
                New Task
              </button>
            </>
          ) : null}
        </h2>
        <TasksList tasks={comp.tasks} compId={compId} canSubmitTrack={canSubmitTrack} />
      </section>

      <PilotsSection
        compId={compId}
        compName={comp.name}
        compClasses={comp.pilot_classes}
        isAdmin={isAdmin}
      />

      <ActivitySection compId={compId} />

      <section>
        <h2>Admins</h2>
        <ul>
          {comp.admins.map((admin) => (
            <li key={admin.email}>
              {admin.name} ({admin.email})
            </li>
          ))}
        </ul>
      </section>

      {isAdmin && createOpen ? (
        <CreateTaskDialog
          compId={compId}
          pilotClasses={comp.pilot_classes}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            setRefresh((n) => n + 1);
          }}
        />
      ) : null}

      {isAdmin && settingsOpen ? (
        <SettingsDialog
          compId={compId}
          comp={comp}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            setSettingsOpen(false);
            setRefresh((n) => n + 1);
          }}
        />
      ) : null}
    </div>
  );
}

function ClassWarnings({
  warnings,
}: {
  warnings: CompDetailData["class_coverage_warnings"];
}) {
  if (warnings.length === 0) return null;
  return (
    <section>
      <h2>Task Coverage Issues</h2>
      <ul>
        {warnings.map((w) => {
          const parts: string[] = [];
          if (w.missing_classes && w.missing_classes.length > 0) {
            parts.push(`missing classes: ${w.missing_classes.join(", ")}`);
          }
          if (w.inconsistent_groupings) {
            parts.push("inconsistent task-class groupings");
          }
          return (
            <li key={w.date}>
              <strong>{formatTaskDate(w.date, { month: "short", day: "numeric" })}</strong> —{" "}
              {parts.join("; ")}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function TasksList({
  tasks,
  compId,
  canSubmitTrack,
}: {
  tasks: TaskSummary[];
  compId: string;
  canSubmitTrack: boolean;
}) {
  if (tasks.length === 0) {
    return <p>No tasks yet</p>;
  }

  // Group tasks by date (insertion order preserved, as in the vanilla page)
  const byDate = new Map<string, TaskSummary[]>();
  for (const task of tasks) {
    const list = byDate.get(task.task_date) ?? [];
    list.push(task);
    byDate.set(task.task_date, list);
  }

  return (
    <div>
      {[...byDate.entries()].map(([date, dateTasks]) => (
        <div key={date}>
          <h3>{formatTaskDate(date)}</h3>
          <ul>
            {dateTasks.map((task) => (
              <li key={task.task_id}>
                <Link to={`/comp/${compId}/task/${task.task_id}`}>
                  <strong>{task.name}</strong>{" "}
                  <span>{task.has_xctsk ? "Task set" : "No task"}</span>{" "}
                  <span>{task.pilot_classes.join(", ")}</span>
                </Link>{" "}
                {canSubmitTrack ? (
                  <SubmitTrackButton compId={compId} taskId={task.task_id} />
                ) : null}{" "}
                <a
                  href={`/replay?comp=${encodeURIComponent(compId)}&task=${encodeURIComponent(task.task_id)}`}
                  title="Open the 3D flight replay for this task"
                >
                  3D replay
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * Task-list "Submit track" button — same job as the task page's dialog: lets
 * a signed-in user upload their own IGC for this task, straight from a file
 * picker.
 */
function SubmitTrackButton({ compId, taskId }: { compId: string; taskId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function handleFile(input: HTMLInputElement) {
    const file = input.files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith(".igc")) {
      toast.error("Please select an IGC file");
      input.value = "";
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("File too large (max 5MB)");
      input.value = "";
      return;
    }

    setUploading(true);
    try {
      const compressed = await compressIgc(file);
      const res = await fetch(
        `/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/igc`,
        { method: "POST", credentials: "include", body: compressed }
      );

      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        toast.error(err.error || "Upload failed");
        return;
      }

      const data = (await res.json()) as { replaced: boolean };
      toast.success(data.replaced ? "Track replaced" : "Track uploaded");
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setUploading(false);
      input.value = "";
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".igc"
        hidden
        onChange={(e) => void handleFile(e.currentTarget)}
      />
      <button
        type="button"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
      >
        {uploading ? "Uploading..." : "Submit track"}
      </button>
    </>
  );
}

function CreateTaskDialog({
  compId,
  pilotClasses,
  onClose,
  onCreated,
}: {
  compId: string;
  pilotClasses: string[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [taskDate, setTaskDate] = useState(new Date().toISOString().split("T")[0]);
  // All classes checked by default, matching the vanilla dialog.
  const [selectedClasses, setSelectedClasses] = useState<string[]>(pilotClasses);
  const [submitting, setSubmitting] = useState(false);

  function toggleClass(cls: string, checked: boolean) {
    setSelectedClasses((prev) =>
      checked ? [...prev.filter((c) => c !== cls), cls] : prev.filter((c) => c !== cls)
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();

    if (selectedClasses.length === 0) {
      toast.warning("Select at least one pilot class");
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.api.comp[":comp_id"].task.$post({
        param: { comp_id: compId },
        json: { name: name.trim(), task_date: taskDate, pilot_classes: selectedClasses },
      });

      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        toast.error(err.error || "Failed to create task");
        return;
      }

      onCreated();
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setSubmitting(false);
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
        <Dialog.Backdrop />
        <Dialog.Popup>
          <Dialog.Title>Create Task</Dialog.Title>
          <form onSubmit={(e) => void submit(e)}>
            <Field.Root>
              <Field.Label>Name</Field.Label>
              <Input
                required
                maxLength={128}
                autoFocus
                placeholder="e.g. Day 1 - Ridge Run"
                value={name}
                onValueChange={(v) => setName(v)}
              />
            </Field.Root>
            <Field.Root>
              <Field.Label>Date</Field.Label>
              <Input
                type="date"
                required
                value={taskDate}
                onValueChange={(v) => setTaskDate(v)}
              />
            </Field.Root>
            <fieldset>
              <legend>Pilot Classes</legend>
              {pilotClasses.map((cls) => (
                <CheckboxField
                  key={cls}
                  checked={selectedClasses.includes(cls)}
                  onChange={(checked) => toggleClass(cls, checked)}
                  label={cls}
                />
              ))}
            </fieldset>
            <Dialog.Close>Cancel</Dialog.Close>{" "}
            <button type="submit" disabled={submitting}>
              {submitting ? "Creating..." : "Create"}
            </button>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
