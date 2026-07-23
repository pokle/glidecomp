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
import {
  computeTurnpointDirections,
  getOptimizedSegmentDistances,
  xctaskTurnpointsToRecords,
  type XCTask,
} from "@glidecomp/engine";
import { Badge } from "@/react/rac/badge";
import { Button, LinkButton, buttonVariants } from "@/react/rac/button";
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
import { RacConfirmProvider } from "@/react/rac/confirm";
import { DatePicker, TimePicker } from "@/react/ui/date-picker";
import { api } from "../../comp/api";
import {
  formatInstant,
  utcISOToZonedDateTimeLocal,
  utcToZonedHHMM,
  zonedDateTimeLocalToUtcISO,
  zoneLabel,
  zoneNameWithOffset,
} from "../lib/time";
import { toast } from "../lib/toast";
import { useConfirm } from "../lib/confirm";
import { useAdminView, useUser } from "../lib/user";
import { formatTaskDate } from "../lib/format";
import { formatAltitude, formatDistance, formatRadius, useUnits } from "../lib/units";
import { SectionHeader } from "../components/SectionHeader";
import { TaskExportButtons } from "../comp/TaskExportButtons";
import { TaskResults } from "../comp/TaskResults";
import { TaskStandings } from "../comp/TaskStandings";
import { RouteEditorDialog } from "../comp/RouteEditorDialog";
import { gateToHHMM, startConfigSummary } from "../comp/route-editor";
import { useCanUploadOnBehalf } from "../comp/SubmitTrackDialog";
import {
  fetchWithRetry,
  isPastCloseDate,
  type CompDetailData,
  type TaskDetailData,
} from "../comp/types";
import { useInitialData } from "../lib/initial-data";
import type { TaskDetailLoaderData } from "../loaders";
import { underComp } from "../lib/crumbs";
import { cn } from "../lib/utils";

export function TaskDetail() {
  return (
    <RacConfirmProvider>
      <TaskDetailContent />
    </RacConfirmProvider>
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
  // Bumped when the admin manage grid mutates, so the public results (a
  // separate component with its own score fetch) pick up the change too.
  const [resultsRefresh, setResultsRefresh] = useState(0);
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
      <Breadcrumbs items={underComp(compId, comp?.name)} current={task.name} />

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
            </span>
            {/* Only the negative case is worth words — a defined route shows
                itself in the turnpoint table below. */}
            {!task.xctsk ? <span> · Route not set yet</span> : null}
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
        <div className="flex flex-wrap items-center gap-2">
          {comp ? <TaskPrevNext comp={comp} compId={compId} task={task} taskId={taskId} /> : null}
          {isAdmin && comp ? (
            <Button variant="outline" size="sm" onPress={() => setEditOpen(true)}>
              Settings
            </Button>
          ) : null}
        </div>
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
        {/* Field analysis: admin-only while the metrics settle, and
            meaningless without a route or on an open-distance task (which has
            no legs or speed section to measure against). Requires comp to be
            LOADED — `comp?.scoring_format !== …` would fail open to a
            dead-end refusal page whenever the non-critical comp fetch
            degrades. Unlike the two anchors above this is an SPA route, so
            it uses a RAC LinkButton through the RouterProvider.

            Cross-links into the comp's field analysis subtree (the per-task
            report is a chapter of that report, not of this page), so from
            there "up" goes to the comp report, not back here. */}
        {isAdmin && task.xctsk && comp && comp.scoring_format !== "open_distance" ? (
          <LinkButton
            variant="outline"
            size="sm"
            href={`/comp/${compId}/analysis/task/${taskId}`}
          >
            Field analysis
          </LinkButton>
        ) : null}
      </div>

      <TurnpointsSection
        xctsk={task.xctsk}
        taskDate={task.task_date}
        timezone={comp?.timezone ?? null}
        isAdmin={isAdmin}
        onEditRoute={() => setRouteOpen(true)}
      />

      {/* Public results: top-3 podium per class + the link to the comp's
          scores page (the canonical results surface), plus pilot self-service
          (Submit track, your-submission line). The management grid below is
          admin-only. */}
      <TaskResults
        compId={compId}
        taskId={taskId}
        timezone={comp?.timezone ?? null}
        isOpenDistance={comp?.scoring_format === "open_distance"}
        isAuthenticated={user != null}
        isClosed={isClosed}
        canUploadOnBehalf={canUploadOnBehalf}
        refresh={scoresRefresh + resultsRefresh}
        onReplayAvailable={setReplayAvailable}
        initialScore={initial && refresh === 0 ? (initial.score ?? undefined) : undefined}
      />

      {/* Admin management grid (statuses, uploads on behalf, manual flights,
          restores) — the tool the old public "standings" table was secretly
          doubling as. Admin-only and never server-rendered. */}
      {isAdmin && comp ? (
        <TaskStandings
          compId={compId}
          taskId={taskId}
          isAdmin={isAdmin}
          isClosed={isClosed}
          scoringFormat={comp.scoring_format === "open_distance" ? "open_distance" : "gap"}
          distanceOrigin={comp.gap_params?.distanceOrigin ?? "takeoff"}
          timezone={comp.timezone ?? null}
          taskXctsk={task.xctsk}
          refresh={scoresRefresh}
          onMutated={() => setResultsRefresh((n) => n + 1)}
        />
      ) : null}

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
 * Prev/next task navigation: walk the comp's tasks that share a pilot class
 * with this one (classes fly different task sequences — jumping from
 * "Task 2 (Open)" to "Task 2 (Floater)" would be disorienting), ordered by
 * date then name. Renders from loader data, so it is in the SSR HTML.
 */
function TaskPrevNext({
  comp,
  compId,
  task,
  taskId,
}: {
  comp: CompDetailData;
  compId: string;
  task: TaskDetailData;
  taskId: string;
}) {
  const classes = new Set(task.pilot_classes);
  const seq = comp.tasks
    .filter(
      (t) => t.task_id === taskId || t.pilot_classes.some((c) => classes.has(c))
    )
    .sort((a, b) =>
      a.task_date === b.task_date
        ? a.name.localeCompare(b.name)
        : a.task_date < b.task_date
          ? -1
          : 1
    );
  const i = seq.findIndex((t) => t.task_id === taskId);
  const prev = i > 0 ? seq[i - 1] : null;
  const next = i >= 0 && i < seq.length - 1 ? seq[i + 1] : null;
  if (!prev && !next) return null;

  return (
    <nav aria-label="Task navigation" className="flex items-center gap-2">
      {prev ? (
        <LinkButton
          variant="ghost"
          size="sm"
          href={`/comp/${compId}/task/${prev.task_id}`}
          aria-label={`Previous task: ${prev.name}`}
        >
          ← {prev.name}
        </LinkButton>
      ) : null}
      {next ? (
        <LinkButton
          variant="ghost"
          size="sm"
          href={`/comp/${compId}/task/${next.task_id}`}
          aria-label={`Next task: ${next.name}`}
        >
          {next.name} →
        </LinkButton>
      ) : null}
    </nav>
  );
}

/**
 * The read-only turnpoint list — an XCTrack-style compact layout that fits a
 * phone on the hill: role (TAKEOFF/SSS/ESS/GOAL) first, then the waypoint with
 * its radius (and altitude) stacked beneath, then the optimized leg distance
 * right-aligned. An optimized-total footer closes it.
 *
 * Both the crossing direction (Exit is the unusual case — a cylinder the route
 * reaches from inside, crossed flying out) and the leg distances are derived
 * from the route geometry by the engine — the same inference the scorer uses —
 * so what pilots read here can never disagree with how the task is scored.
 */
function TurnpointsTable({ xctsk }: { xctsk: XCTask }) {
  const units = useUnits();
  const { directions, legs, totalM } = useMemo(() => {
    const directions = computeTurnpointDirections(xctsk);
    // legs[i] is the optimized segment INTO turnpoint i+1; turnpoint 0
    // (take-off) has no incoming leg. Guard the geometry so a half-defined
    // route (missing coordinates) still renders the identities.
    let legs: number[] = [];
    try {
      if (xctsk.turnpoints.length >= 2) legs = getOptimizedSegmentDistances(xctsk);
    } catch {
      legs = [];
    }
    const totalM = legs.length > 0 ? legs.reduce((sum, d) => sum + d, 0) : null;
    return { directions, legs, totalM };
  }, [xctsk]);

  const lastIndex = xctsk.turnpoints.length - 1;

  return (
    <div className="mt-2">
      <Table aria-label="Turnpoints">
        <TableHeader>
          {/* Empty visible header for the role column; labelled for AT. */}
          <Column isRowHeader={false} aria-label="Type" className="w-16" />
          <Column isRowHeader>Turnpoint</Column>
          <Column className="text-right">Leg</Column>
        </TableHeader>
        <TableBody>
          {xctsk.turnpoints.map((tp, i) => {
            // The last turnpoint is the goal in GAP scoring even when the
            // xctsk leaves its type unset, so label it rather than blank.
            const role = tp.type ?? (i === lastIndex ? "GOAL" : null);
            const isExit = tp.type !== "TAKEOFF" && directions[i] === "exit";
            const legM = i >= 1 ? legs[i - 1] : undefined;
            const radius = formatRadius(tp.radius, { prefs: units }).withUnit;
            const alt = tp.waypoint.altSmoothed
              ? formatAltitude(tp.waypoint.altSmoothed, { prefs: units }).withUnit
              : null;
            return (
              <Row key={i}>
                <Cell className="align-top">
                  <div className="flex flex-col gap-1">
                    {role ? (
                      <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
                        {role}
                      </span>
                    ) : null}
                    {isExit ? (
                      <span title="Crossed flying outward — the route reaches this cylinder from inside, so pilots fly out across it">
                        <Badge variant="outline">Exit</Badge>
                      </span>
                    ) : null}
                  </div>
                </Cell>
                <Cell className="align-top">
                  <div className="flex flex-col leading-tight">
                    <span className="font-medium">{tp.waypoint.name}</span>
                    {/* Radius (always) · altitude (when the xctsk carries one —
                        files without an altitude come through as 0, shown as
                        nothing rather than a misleading sea-level reading). */}
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {radius}
                      {alt ? ` · ${alt}` : ""}
                    </span>
                  </div>
                </Cell>
                <Cell className="text-right align-top tabular-nums">
                  {legM !== undefined ? (
                    formatDistance(legM, { decimals: 1, prefs: units }).withUnit
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </Cell>
              </Row>
            );
          })}
        </TableBody>
      </Table>
      {totalM !== null ? (
        <div className="flex items-center justify-between border-t px-2 py-2 text-sm">
          <span className="text-muted-foreground">Optimized total</span>
          <span className="font-medium tabular-nums">
            {formatDistance(totalM, { decimals: 1, prefs: units }).withUnit}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Compact start/goal summary above the turnpoint list — the XCTrack "FLY tab"
 * header: the speed-section start on the left, the goal on the right, both
 * scannable rather than buried in a sentence. Rendered deterministically
 * (comp-local when a zone is set, UTC otherwise) so the SSR markup matches.
 */
function TaskSummaryHeader({
  xctsk,
  taskDate,
  timezone,
}: {
  xctsk: XCTask;
  taskDate: string;
  timezone: string | null;
}) {
  const goal = xctsk.goal;
  const goalTypeLabel = goal?.type === "LINE" ? "Line" : "Cylinder";
  // Goal deadline: comp-local when a zone is set, else UTC as stored.
  const deadlineHHMM = goal?.deadline ? gateToHHMM(goal.deadline) : null;
  let deadline: string | null = null;
  if (deadlineHHMM) {
    const zoned = timezone
      ? utcToZonedHHMM(taskDate, deadlineHHMM, timezone)
      : deadlineHHMM;
    const zoneLbl = timezone
      ? zoneNameWithOffset(new Date(`${taskDate}T12:00:00Z`), timezone)
      : "UTC";
    deadline = `${zoned ?? deadlineHHMM} ${zoneLbl}`;
  }

  if (!xctsk.sss && !goal) return null;

  return (
    <dl className="mt-2 grid gap-x-6 gap-y-2 rounded-lg border bg-muted/30 p-3 text-sm sm:grid-cols-2">
      {xctsk.sss ? (
        <div>
          <dt className="text-xs text-muted-foreground">Start of speed section</dt>
          <dd className="font-medium">
            {startConfigSummary(xctsk.sss, { timeZone: timezone, taskDate })}
          </dd>
        </div>
      ) : null}
      {goal ? (
        <div>
          <dt className="text-xs text-muted-foreground">Goal</dt>
          <dd className="font-medium">
            {goalTypeLabel}
            {deadline ? ` · deadline ${deadline}` : ""}
          </dd>
        </div>
      ) : null}
    </dl>
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
        <>
          <TaskSummaryHeader
            xctsk={xctsk}
            taskDate={taskDate}
            timezone={timezone}
          />
          <TurnpointsTable xctsk={xctsk} />
        </>
      ) : (
        <p className="mt-2 text-muted-foreground">No route defined yet</p>
      )}
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
