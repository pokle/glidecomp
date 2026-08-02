/**
 * Task detail page — React port of the task view in comp-detail.ts.
 *
 * RAC EXPLORATION: this page (and everything it opens) is built entirely from
 * react-aria-components primitives (src/react/rac/) instead of the shadcn /
 * Base UI kit, to evaluate RAC as the app-wide foundation. Visuals match the
 * rest of the app; the interaction layer (dialogs, tables, fields, menus) is
 * RAC. See the PR/issue discussion before extending the pattern elsewhere.
 *
 * Everyone sees a read-only "Route" section (summary, diagram and turnpoint
 * listing); admins additionally get the route editor dialog
 * (comp/RouteEditorDialog) covering turnpoints, start gates, goal, and
 * .xctsk / XContest import-export (#270).
 */
import { useEffect, useId, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { NotFound } from "@/react/components/NotFound";
import { Form } from "react-aria-components";
import { xctaskTurnpointsToRecords, type XCTask } from "@glidecomp/engine";
import { Badge } from "@/react/rac/badge";
import { Loading } from "@/react/rac/progress";
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
import { Tag, TagGroup } from "@/react/rac/tag-group";
import { DatePicker, TimePicker } from "@/react/rac/date-picker";
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
import { useAdminView, useGoToSignIn, useUser } from "../lib/user";
import { formatTaskDate } from "../lib/format";
import { SectionHeader } from "../components/SectionHeader";
import { WeatherSection } from "../weather/WeatherSection";
import { useTaskWeather } from "../weather/use-task-weather";
import { taskWindFromWeather, type TaskWind } from "../comp/task-wind";
import { TaskExportButtons } from "../comp/TaskExportButtons";
import { TaskResults } from "../comp/TaskResults";
import { CompNameProvider } from "../comp/comp-name-context";
import { TaskStandings } from "../comp/TaskStandings";
import { RouteEditorDialog } from "../comp/RouteEditorDialog";
import { TurnpointsTable } from "../comp/TurnpointsTable";
import { TaskDiagram } from "../comp/TaskDiagram";
import { gateToHHMM, startConfigSummary } from "../comp/route-editor";
import { SubmitTrackDialog, useCanUploadOnBehalf } from "../comp/SubmitTrackDialog";
import {
  fetchWithRetry,
  isPastCloseDate,
  type CompDetailData,
  type TaskDetailData,
} from "../comp/types";
import { useInitialData } from "../lib/initial-data";
import { useMounted } from "../lib/use-mounted";
import type { TaskDetailLoaderData } from "../loaders";
import { underComp } from "../lib/crumbs";
import { idFromSegment, compPath, taskPath, taskAnalysisPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { cn } from "../lib/utils";

export function TaskDetail() {
  const { compId: compParam, taskId: taskParam } = useParams<{ compId: string; taskId: string }>();
  const compId = idFromSegment(compParam ?? "");
  const taskId = idFromSegment(taskParam ?? "");
  const { user } = useUser();
  const location = useLocation();
  const navigate = useNavigate();
  const goToSignIn = useGoToSignIn();
  // Gate the ICU zone abbreviation in SSR-rendered instants (the stop notice
  // below) until mounted, so the server markup and first client render agree.
  const mounted = useMounted();
  // SSR seed for the public half of the page (header, route, scores). Null on
  // client boot / SPA navigations, where the effect below fetches instead.
  const initial = useInitialData<TaskDetailLoaderData>();
  const [task, setTask] = useState<TaskDetailData | null>(initial?.task ?? null);
  const [comp, setComp] = useState<CompDetailData | null>(initial?.comp ?? null);

  // Canonicalise once both names are known (comp is a non-critical fetch, so
  // wait for it rather than 301-ing to a bare comp segment).
  useCanonicalPath(
    comp && task ? taskPath(compId, comp.name, taskId, task.name) : null
  );
  const [notFound, setNotFound] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [scoresRefresh, setScoresRefresh] = useState(0);
  // Bumped when the admin manage grid mutates, so the public results (a
  // separate component with its own score fetch) pick up the change too.
  const [resultsRefresh, setResultsRefresh] = useState(0);
  const [replayAvailable, setReplayAvailable] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [routeOpen, setRouteOpen] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);

  useEffect(() => {
    // Clear any previous verdict first. react-router keeps this component
    // mounted when only the id in the path changes, so a "not found" left over
    // from the old id would mask whatever the new one loads. That is not
    // hypothetical: the 404 page's own "did you mean" links point back at this
    // very route, so clicking one changed the URL and nothing else.
    setNotFound(false);
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

  // `#edit-route` deep link (the comp page's featured-task card used to point
  // here; a bookmarked or shared link still can): open the route editor once
  // the task has loaded and the admin check has resolved.
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

  // Fetched ONCE here and handed down, rather than in each consumer: the
  // weather section and the route views both want it, and the endpoint can
  // schedule a background provider fetch, so asking twice is not free.
  const weather = useTaskWeather(compId || null, taskId || null);
  const wind = useMemo(
    () => taskWindFromWeather(weather.data?.weather ?? null),
    [weather.data]
  );

  if (notFound || !compId || !taskId) {
    return <NotFound title="Task not found" />;
  }

  if (!task) {
    return (
      <Loading>Loading task…</Loading>
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
                  comp?.timezone ?? "UTC",
                  mounted
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
      {/* The task's action row. It leads with Submit track — the one thing a
          pilot comes to this page to DO, and previously reachable only from
          the Results section header, which on a task with a route and weather
          is a scroll away. It stays there too, since that is where a section's
          own manage action belongs. Editing the route deliberately is NOT
          here: it is a section-scoped action and the Route header carrying it
          is the very next thing on the page.

          Submit track is the page's ONE filled button; everything after it —
          share, map, replay, analysis — is a uniform outline cluster, because
          those are places to go rather than things to do. */}
      <div className="mt-3 flex flex-wrap gap-2">
        {/* Auth-dependent, so mount-gated: the server renders this page for
            anyone, and a button that depends on who is asking would not match
            the server's markup on hydration (same rule as TaskResults). */}
        {mounted && user && !isClosed ? (
          <Button size="sm" onPress={() => setSubmitOpen(true)}>
            Submit track
          </Button>
        ) : null}
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
        {/* Field analysis: meaningless without a route or on an open-distance
            task (which has no legs or speed section to measure against).
            Requires comp to be LOADED — `comp?.scoring_format !== …` would
            fail open to a dead-end refusal page whenever the non-critical comp
            fetch degrades. Unlike the two anchors above this is an SPA route,
            so it uses a RAC LinkButton through the RouterProvider.

            Cross-links into the comp's field analysis subtree (the per-task
            report is a chapter of that report, not of this page), so from
            there "up" goes to the comp report, not back here. */}
        {task.xctsk && comp && comp.scoring_format !== "open_distance" ? (
          <LinkButton
            variant="outline"
            size="sm"
            href={taskAnalysisPath(compId, comp?.name, taskId, task.name)}
          >
            Field analysis
          </LinkButton>
        ) : null}
        {/* Last, and deliberately not the primary: a signed-out visitor came to
            READ the task, and the page they want is the one they are on. */}
        {mounted && !user && !isClosed ? (
          <Button
            variant="outline"
            size="sm"
            onPress={() => goToSignIn(window.location.pathname)}
          >
            Sign in to submit your track
          </Button>
        ) : null}
      </div>

      {submitOpen ? (
        <SubmitTrackDialog
          compId={compId}
          taskId={taskId}
          canUploadOnBehalf={canUploadOnBehalf}
          onClose={() => setSubmitOpen(false)}
          onUploaded={() => {
            setSubmitOpen(false);
            // The podium and the "your track is in" line below are a separate
            // fetch — tell them something changed, or the pilot's own upload
            // is the one thing the page fails to show them.
            setResultsRefresh((n) => n + 1);
          }}
        />
      ) : null}

      <TurnpointsSection
        xctsk={task.xctsk}
        taskDate={task.task_date}
        timezone={comp?.timezone ?? null}
        wind={wind}
        isAdmin={isAdmin}
        onEditRoute={() => setRouteOpen(true)}
      />

      {/* The day's weather — the organizer's notes plus the modelled
          conditions (the same charts the field-analysis report leads with).
          Sits directly under the route, above the results: the conditions
          are context for reading everything below them. */}
      <WeatherSection
        compId={compId}
        taskId={taskId}
        weather={weather}
        notes={task.weather_notes}
        isAdmin={isAdmin}
        compTimezone={comp?.timezone ?? null}
        onSaved={(weather_notes) =>
          setTask((prev) => (prev ? { ...prev, weather_notes } : prev))
        }
      />

      {/* Public results: top-3 podium per class + the link to the comp's
          scores page (the canonical results surface), plus pilot self-service
          (Submit track, your-submission line). The management grid below is
          admin-only. */}
      <CompNameProvider value={comp?.name ?? null}>
        <TaskResults
          compId={compId}
          taskId={taskId}
          taskName={task.name}
          timezone={comp?.timezone ?? null}
          isOpenDistance={comp?.scoring_format === "open_distance"}
          isAuthenticated={user != null}
          isClosed={isClosed}
          canUploadOnBehalf={canUploadOnBehalf}
          refresh={scoresRefresh + resultsRefresh}
          onReplayAvailable={setReplayAvailable}
          initialScore={initial && refresh === 0 ? (initial.score ?? undefined) : undefined}
        />
      </CompNameProvider>

      {/* Admin management grid (statuses, uploads on behalf, manual flights,
          restores) — the tool the old public "standings" table was secretly
          doubling as. Admin-only and never server-rendered. */}
      {isAdmin && comp ? (
        <CompNameProvider value={comp.name}>
        <TaskStandings
          compId={compId}
          taskId={taskId}
          taskName={task.name}
          isAdmin={isAdmin}
          isClosed={isClosed}
          scoringFormat={comp.scoring_format === "open_distance" ? "open_distance" : "gap"}
          distanceOrigin={comp.gap_params?.distanceOrigin ?? "takeoff"}
          timezone={comp.timezone ?? null}
          taskXctsk={task.xctsk}
          refresh={scoresRefresh}
          onMutated={() => setResultsRefresh((n) => n + 1)}
        />
        </CompNameProvider>
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
          href={taskPath(compId, comp?.name, prev.task_id, prev.name)}
          aria-label={`Previous task: ${prev.name}`}
        >
          ← {prev.name}
        </LinkButton>
      ) : null}
      {next ? (
        <LinkButton
          variant="ghost"
          size="sm"
          href={taskPath(compId, comp?.name, next.task_id, next.name)}
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
 * The task's route — headed "Route", because it is the start/goal summary and
 * the diagram as well as the turnpoint listing (the component keeps its older
 * name). Read-only for everyone; admins get an Edit route button that opens
 * the full route editor dialog (turnpoints, start gates, goal, .xctsk /
 * XContest import-export).
 */
function TurnpointsSection({
  xctsk,
  taskDate,
  timezone,
  wind,
  isAdmin,
  onEditRoute,
}: {
  xctsk: XCTask | null;
  taskDate: string;
  /** Comp-local IANA zone; gate times in the summary show comp-local when set. */
  timezone: string | null;
  /** The day's modelled wind, once the weather lands. Null until then. */
  wind: TaskWind | null;
  isAdmin: boolean;
  onEditRoute: () => void;
}) {
  // Which turnpoint the reader is pointing at, shared by the diagram and the
  // table so the shape and the numbers stay tied together — either one can
  // set it, and both show it. Client-only state, so it does not affect the
  // server-rendered markup.
  const [focused, setFocused] = useState<number | null>(null);

  if (!xctsk && !isAdmin) return null;
  return (
    <section>
      <SectionHeader
        title="Route"
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
          {/* Two views of one route, paired: the diagram is the shape on the
              ground (drawn from the same optimised line the table measures and
              the scorer uses — not a map, "View on map" above is for that),
              the table is the numbers and the accessible reading of it.

              The diagram leads in the DOM because it is the at-a-glance read,
              which is also the stacked order on a phone. Wide enough for two
              columns, the row reverses so the numbers sit left and the shape
              right, beside them rather than a scroll above them. */}
          <div className="mt-3 flex flex-col gap-4 lg:flex-row-reverse lg:items-start">
            <div className="flex justify-center rounded-lg border bg-muted/20 p-2 lg:shrink-0">
              <TaskDiagram
                task={xctsk}
                size="md"
                // Scales down rather than scrolling sideways: on a phone the
                // diagram now leads the section, and the `md` preset is a few
                // pixels wider than the content column. The viewBox keeps the
                // drawing intact at any width.
                className="h-auto max-w-full"
                onTurnpointHover={(tp) => setFocused(tp?.index ?? null)}
                onTurnpointSelect={(tp) => setFocused(tp.index)}
                highlightIndex={focused}
                wind={wind}
              />
            </div>
            <div className="min-w-0 flex-1">
              <TurnpointsTable
                xctsk={xctsk}
                wind={wind}
                highlightIndex={focused}
                onTurnpointHover={setFocused}
                onTurnpointSelect={setFocused}
              />
            </div>
          </div>
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

      // No comp name in this sub-component's scope; the comp page canonicalises
      // the URL on arrival.
      navigate(compPath(compId));
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
            <Button type="submit" isPending={saving} pendingLabel="Saving">
              Save
            </Button>
          </DialogFooter>
        </Form>
      </Dialog>
    </Modal>
  );
}
