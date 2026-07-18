/**
 * Task detail page — React port of the task view in comp-detail.ts.
 *
 * RAC EXPLORATION: this page (and everything it opens) is built entirely from
 * react-aria-components primitives (src/react/rac/) instead of the shadcn /
 * Base UI kit, to evaluate RAC as the app-wide foundation. Visuals match the
 * rest of the app; the interaction layer (dialogs, tables, fields, menus) is
 * RAC. See the PR/issue discussion before extending the pattern elsewhere.
 *
 * Everyone sees a read-only Turnpoints listing; admins additionally get the
 * route editor dialog (comp/RouteEditorDialog) covering turnpoints, start
 * gates, goal, and .xctsk / XContest import-export (#270).
 */
import { useEffect, useId, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { Form } from "react-aria-components";
import { computeTurnpointDirections, xctaskTurnpointsToRecords, type XCTask } from "@glidecomp/engine";
import { Badge } from "@/react/rac/badge";
import { Button, buttonVariants } from "@/react/rac/button";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Modal,
} from "@/react/rac/dialog";
import { TextField, Label, Description } from "@/react/rac/field";
import { Checkbox, CheckboxGroup } from "@/react/rac/checkbox";
import { Table, TableHeader, TableBody, Column, Row, Cell } from "@/react/rac/table";
import { Tag, TagGroup } from "@/react/rac/tag-group";
import { RacRouterProvider } from "@/react/rac/router";
import { RacConfirmProvider } from "@/react/rac/confirm";
import { DatePicker, TimePicker } from "@/react/ui/date-picker";
import { api } from "../../comp/api";
import {
  formatInstant,
  utcISOToZonedDateTimeLocal,
  zonedDateTimeLocalToUtcISO,
  zoneLabel,
} from "../lib/time";
import { toast } from "../lib/toast";
import { useConfirm } from "../lib/confirm";
import { useAdminView, useUser } from "../lib/user";
import { formatTaskDate } from "../lib/format";
import { SectionHeader } from "../components/SectionHeader";
import { TaskExportButtons } from "../comp/TaskExportButtons";
import { TaskStandings } from "../comp/TaskStandings";
import { RouteEditorDialog } from "../comp/RouteEditorDialog";
import { startConfigSummary } from "../comp/route-editor";
import { useCanUploadOnBehalf } from "../comp/SubmitTrackDialog";
import {
  fetchWithRetry,
  isPastCloseDate,
  type CompDetailData,
  type TaskDetailData,
} from "../comp/types";
import { useInitialData } from "../lib/initial-data";
import type { TaskDetailLoaderData } from "../loaders";
import { cn } from "../lib/utils";

export function TaskDetail() {
  return (
    <RacRouterProvider>
      <RacConfirmProvider>
        <TaskDetailContent />
      </RacConfirmProvider>
    </RacRouterProvider>
  );
}

function TaskDetailContent() {
  const { compId, taskId } = useParams<{ compId: string; taskId: string }>();
  const { user } = useUser();
  const location = useLocation();
  const navigate = useNavigate();
  // SSR seed for the public half of the page (header, route, scores). Null on
  // client boot / SPA navigations, where the effect below fetches instead.
  const initial = useInitialData<TaskDetailLoaderData>();
  const [task, setTask] = useState<TaskDetailData | null>(initial?.task ?? null);
  const [comp, setComp] = useState<CompDetailData | null>(initial?.comp ?? null);
  const [notFound, setNotFound] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [scoresRefresh, setScoresRefresh] = useState(0);
  const [replayAvailable, setReplayAvailable] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [routeOpen, setRouteOpen] = useState(false);

  useEffect(() => {
    if (!compId || !taskId) {
      setNotFound(true);
      return;
    }
    // Seeded from SSR on the first render — set the title, skip the fetch.
    if (initial && refresh === 0) {
      document.title = `GlideComp - ${initial.task.name}`;
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

  const isAdmin = useAdminView(
    user != null && comp != null && comp.admins.some((a) => a.email === user.email)
  );

  // Deep link from the comp hero's "Edit route…" button: open the route
  // editor once the task has loaded and the admin check has resolved.
  useEffect(() => {
    if (location.hash === "#edit-route" && isAdmin && task) setRouteOpen(true);
  }, [location.hash, isAdmin, task]);

  // Closing the editor drops the #edit-route hash so a reload doesn't reopen it.
  const closeRouteEditor = () => {
    setRouteOpen(false);
    if (location.hash === "#edit-route") {
      navigate(location.pathname + location.search, { replace: true });
    }
  };

  const canUploadOnBehalf = useCanUploadOnBehalf(
    compId ?? "",
    Boolean(comp?.open_igc_upload),
    isAdmin
  );

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
      <Breadcrumbs
        items={[
          { label: "Competitions", to: "/comp" },
          { label: comp?.name ?? "Competition", to: `/comp/${compId}` },
        ]}
        current={task.name}
      />

      {/* Header row mirrors CompDetail: title/meta left, admin Settings top right. */}
      <div className="mt-2 flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold">{task.name}</h1>
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
          {task.stop_announcement_time ? (
            // Stopped task (FAI S7F §12.3): surface the stop prominently —
            // it reshapes every score. Comp-zone (or UTC) rendering keeps
            // the SSR markup deterministic.
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="destructive">Task stopped</Badge>
              <span className="text-muted-foreground">
                Stop announced{" "}
                {formatInstant(
                  new Date(task.stop_announcement_time),
                  comp?.timezone ?? "UTC"
                )}{" "}
                — scored as a stopped task (FAI S7F §12.3)
              </span>
            </p>
          ) : null}
          <TagGroup label="Pilot classes" className="mt-1.5">
            {task.pilot_classes.map((cls) => (
              <Tag key={cls} id={cls}>
                {cls}
              </Tag>
            ))}
          </TagGroup>
        </div>
        {isAdmin && comp ? (
          <Button variant="outline" size="sm" onPress={() => setEditOpen(true)}>
            Settings
          </Button>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {task.xctsk ? (
          <TaskExportButtons
            compId={compId}
            taskId={taskId}
            taskName={task.name}
            records={xctaskTurnpointsToRecords(task.xctsk.turnpoints)}
          />
        ) : null}
        {/* Plain anchors (not RAC Links): these leave the SPA for the vanilla
            analysis / replay entries, so client routing must not intercept. */}
        {task.xctsk ? (
          <a
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
            href={`/analysis.html?compId=${encodeURIComponent(compId)}&taskId=${encodeURIComponent(taskId)}`}
            title="Open this task on the analysis map"
          >
            View on map
          </a>
        ) : null}
        {replayAvailable ? (
          <a
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
            href={`/replay?comp=${encodeURIComponent(compId)}&task=${encodeURIComponent(taskId)}`}
            title="Open the 3D flight replay for this task"
          >
            3D replay
          </a>
        ) : null}
      </div>

      <TurnpointsSection
        xctsk={task.xctsk}
        taskDate={task.task_date}
        timezone={comp?.timezone ?? null}
        isAdmin={isAdmin}
        onEditRoute={() => setRouteOpen(true)}
      />

      {/* Unified standings: ranked scorers + per-class did-not-score tail,
          with per-pilot admin actions (track upload, manual flight, status,
          restore). Replaces the old Scores + Pilot Status + Tracks sections
          (issue #306). */}
      <TaskStandings
        compId={compId}
        taskId={taskId}
        isAdmin={isAdmin}
        isAuthenticated={user != null}
        isClosed={isClosed}
        canUploadOnBehalf={canUploadOnBehalf}
        scoringFormat={comp?.scoring_format === "open_distance" ? "open_distance" : "gap"}
        distanceOrigin={comp?.gap_params?.distanceOrigin ?? "takeoff"}
        timezone={comp?.timezone ?? null}
        taskXctsk={task.xctsk}
        refresh={scoresRefresh}
        onReplayAvailable={setReplayAvailable}
        initialScore={initial && refresh === 0 ? (initial.score ?? undefined) : undefined}
      />

      {isAdmin && comp && editOpen ? (
        <EditTaskDialog
          compId={compId}
          taskId={taskId}
          task={task}
          compPilotClasses={comp.pilot_classes}
          timezone={comp.timezone ?? null}
          onClose={() => setEditOpen(false)}
          onSaved={() => {
            setEditOpen(false);
            setRefresh((n) => n + 1);
            setScoresRefresh((n) => n + 1);
          }}
        />
      ) : null}

      {isAdmin && comp && routeOpen ? (
        <RouteEditorDialog
          compId={compId}
          taskId={taskId}
          taskName={task.name}
          taskDate={task.task_date}
          xctsk={task.xctsk}
          openDistance={comp.scoring_format === "open_distance"}
          timezone={comp.timezone ?? null}
          onClose={closeRouteEditor}
          onSaved={() => {
            closeRouteEditor();
            setRefresh((n) => n + 1);
            setScoresRefresh((n) => n + 1);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The read-only turnpoint table, with each cylinder's crossing direction.
 * Directions are derived from the route geometry by the engine — the same
 * inference the scorer uses — so what pilots read here can never disagree
 * with how the task is scored. Exit is the unusual case (a cylinder the
 * route reaches from inside, crossed flying out), so it gets a badge.
 */
function TurnpointsTable({ xctsk }: { xctsk: XCTask }) {
  const directions = useMemo(() => computeTurnpointDirections(xctsk), [xctsk]);
  return (
    <Table aria-label="Turnpoints" className="mt-2">
      <TableHeader>
        <Column isRowHeader={false}>#</Column>
        <Column isRowHeader>Name</Column>
        <Column>Radius</Column>
        <Column>Type</Column>
        <Column>Direction</Column>
      </TableHeader>
      <TableBody>
        {xctsk.turnpoints.map((tp, i) => (
          <Row key={i}>
            <Cell>{i + 1}</Cell>
            <Cell>{tp.waypoint.name}</Cell>
            <Cell>{tp.radius} m</Cell>
            <Cell>{tp.type ?? "—"}</Cell>
            <Cell>
              {tp.type === "TAKEOFF" ? (
                <span className="text-muted-foreground">—</span>
              ) : directions[i] === "exit" ? (
                <Badge variant="outline">Exit</Badge>
              ) : (
                <span className="text-muted-foreground">Enter</span>
              )}
            </Cell>
          </Row>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * Turnpoint listing. Read-only for everyone; admins get an Edit route
 * button that opens the full route editor dialog (turnpoints, start
 * gates, goal, .xctsk / XContest import-export).
 */
function TurnpointsSection({
  xctsk,
  taskDate,
  timezone,
  isAdmin,
  onEditRoute,
}: {
  xctsk: XCTask | null;
  taskDate: string;
  /** Comp-local IANA zone; gate times in the summary show comp-local when set. */
  timezone: string | null;
  isAdmin: boolean;
  onEditRoute: () => void;
}) {
  if (!xctsk && !isAdmin) return null;
  return (
    <section>
      <SectionHeader
        title="Turnpoints"
        action={
          isAdmin ? (
            <Button variant="outline" size="sm" onPress={onEditRoute}>
              {xctsk && xctsk.turnpoints.length > 0 ? "Edit route…" : "Create route…"}
            </Button>
          ) : null
        }
      />
      {xctsk && xctsk.turnpoints.length > 0 ? (
        <TurnpointsTable xctsk={xctsk} />
      ) : (
        <p className="mt-2 text-muted-foreground">No route defined yet</p>
      )}
      {xctsk?.sss ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {startConfigSummary(xctsk.sss, { timeZone: timezone, taskDate })}
        </p>
      ) : null}
    </section>
  );
}

function EditTaskDialog({
  compId,
  taskId,
  task,
  compPilotClasses,
  timezone,
  onClose,
  onSaved,
}: {
  compId: string;
  taskId: string;
  task: TaskDetailData;
  compPilotClasses: string[];
  /** Comp-local IANA zone; the stop time is entered comp-local when set. */
  timezone: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const dateId = useId();
  const stopId = useId();
  const [name, setName] = useState(task.name);
  const [taskDate, setTaskDate] = useState(task.task_date);
  const [selectedClasses, setSelectedClasses] = useState<string[]>(
    compPilotClasses.filter((cls) => task.pilot_classes.includes(cls))
  );
  // Stopped task (S7F §12.3): the stop time, edited as a comp-local wall-clock
  // time of day ("" = task not stopped) — the stop is always on the task date,
  // so only the time is editable. Recombined with taskDate on save and stored/
  // scored as a UTC instant.
  const [stopTime, setStopTime] = useState(
    task.stop_announcement_time
      ? (utcISOToZonedDateTimeLocal(task.stop_announcement_time, timezone)?.slice(
          11,
          16
        ) ?? "")
      : ""
  );
  const [saving, setSaving] = useState(false);

  async function save() {
    if (selectedClasses.length === 0) {
      toast.warning("Select at least one pilot class");
      return;
    }

    // The stop is on the task date; combine it with the comp-local stop time.
    const stopIso =
      stopTime && taskDate
        ? zonedDateTimeLocalToUtcISO(`${taskDate}T${stopTime}`, timezone)
        : null;
    if (stopTime && !stopIso) {
      toast.warning("Enter a valid stop time");
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
          stop_announcement_time: stopIso,
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
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className="sm:max-w-lg"
    >
      <Dialog>
        <DialogHeader>
          <DialogTitle>Task Settings</DialogTitle>
        </DialogHeader>
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          className="flex flex-col gap-4"
        >
          <TextField
            label="Name"
            isRequired
            maxLength={128}
            value={name}
            onChange={setName}
            errorMessage="Enter a task name"
          />
          <div className="flex flex-col gap-2">
            <Label id={dateId}>Date</Label>
            <DatePicker
              required
              aria-labelledby={dateId}
              value={taskDate}
              onChange={setTaskDate}
            />
          </div>
          <CheckboxGroup
            label="Pilot Classes"
            value={selectedClasses}
            onChange={setSelectedClasses}
          >
            {compPilotClasses.map((cls) => (
              <Checkbox key={cls} value={cls}>
                {cls}
              </Checkbox>
            ))}
          </CheckboxGroup>
          <div className="flex flex-col gap-2">
            <Label id={stopId}>
              Task stop (
              {zoneLabel(new Date(`${taskDate}T12:00:00Z`), timezone ?? "UTC")})
            </Label>
            <TimePicker
              clearable
              aria-labelledby={stopId}
              value={stopTime}
              onChange={setStopTime}
            />
            <Description>
              Set only when the task was stopped mid-flight (weather calldown).
              Scores are recomputed under the stopped-task rules (FAI S7F
              §12.3): a scored-back stop time, a clipped scoring window, and an
              altitude bonus for pilots still flying. Leave empty for a task
              that ran to completion.
            </Description>
          </div>
          <DialogFooter>
            <Button
              variant="destructive"
              className="sm:mr-auto"
              onPress={() => void deleteTask()}
            >
              Delete task
            </Button>
            <Button slot="close" variant="outline">
              Cancel
            </Button>
            <Button type="submit" isDisabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </Form>
      </Dialog>
    </Modal>
  );
}
