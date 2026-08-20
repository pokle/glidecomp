/**
 * Task detail page — React port of the task view in comp-detail.ts.
 *
 * Built on the RAC kit (src/react/rac/) — see
 * docs/2026-07-18-rac-adoption-guide.md. This page (and everything it opens)
 * is built entirely from react-aria-components primitives: visuals match the
 * rest of the app, and the interaction layer (dialogs, tables, fields, menus)
 * is RAC.
 *
 * Everyone sees a read-only "Route" section (summary, diagram and turnpoint
 * listing); admins additionally get the route editor dialog
 * (comp/RouteEditorDialog) covering turnpoints, start gates, goal, and
 * .xctsk / XContest import-export (#270).
 */
import { lazy, Suspense, useEffect, useId, useMemo, useState } from "react";
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
import { CheckboxField } from "../comp/fields";
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
import { SectionHeader } from "../components/SectionHeader";
import { MasterDetail } from "../components/MasterDetail";
import { WeatherSection } from "../weather/WeatherSection";
import { useTaskWeather } from "../weather/use-task-weather";
import { taskWindFromWeather, type TaskWind } from "../comp/task-wind";
import { TaskExportButtons } from "../comp/TaskExportButtons";
import { TaskScoresPublic } from "../comp/TaskScoresPublic";
import { CompNameProvider } from "../comp/comp-name-context";
import { TaskScoresAdmin } from "../comp/TaskScoresAdmin";
import { TurnpointsTable } from "../comp/TurnpointsTable";
import { TaskDiagram } from "../comp/TaskDiagram";
import { gateToHHMM, startConfigSummary } from "../comp/route-editor";
import { SubmitTrackDialog, useCanUploadOnBehalf } from "../comp/SubmitTrackDialog";
// Comp admins only, so its code has no business in every pilot's bundle.
const ForgeIgcDialog = lazy(() => import("../comp/ForgeIgcDialog"));
import {
  isPastCloseDate,
  type CompDetailData,
  type TaskDetailData,
} from "../comp/types";
import { useInitialData } from "../lib/initial-data";
import { useMounted } from "../lib/use-mounted";
import type { TaskDetailLoaderData } from "../loaders";
import { underComp } from "../lib/crumbs";
import {
  idFromSegment,
  compPath,
  taskPath,
  taskAnalysisPath,
  taskSettingsPath,
  taskRoutePath,
  taskWeatherPath,
} from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { useSeededResource } from "../lib/use-seeded-resource";
import { cn } from "../lib/utils";
import { Card } from "@/react/rac/card";

export function TaskDetail() {
  const { compId: compParam, taskId: taskParam } = useParams<{ compId: string; taskId: string }>();
  const compId = idFromSegment(compParam ?? "");
  const taskId = idFromSegment(taskParam ?? "");
  const { user } = useUser();
  const location = useLocation();
  const navigate = useNavigate();
  // Gate the ICU zone abbreviation in SSR-rendered instants (the stop notice
  // below) until mounted, so the server markup and first client render agree.
  const mounted = useMounted();
  // SSR seed for the public half of the page (header, route, scores). Null on
  // client boot / SPA navigations, where the effect below fetches instead.
  const initial = useInitialData<TaskDetailLoaderData>();
  const [comp, setComp] = useState<CompDetailData | null>(initial?.comp ?? null);

  const [refresh, setRefresh] = useState(0);
  // The task is the page. A dead task id is a dead URL; the comp above is
  // supporting detail the page degrades without.
  const { data: task, notFound } = useSeededResource<TaskDetailData>({
    ids: [compId, taskId],
    seed: initial?.task ?? null,
    load: ([comp_id, task_id]) =>
      api.api.comp[":comp_id"].task[":task_id"].$get({
        param: { comp_id, task_id },
      }),
    title: (t) => `GlideComp - ${t.name}`,
    refresh,
  });

  // Canonicalise once both names are known (comp is a non-critical fetch, so
  // wait for it rather than 301-ing to a bare comp segment).
  useCanonicalPath(
    comp && task ? taskPath(compId, comp.name, taskId, task.name) : null
  );

  const [scoresRefresh, setScoresRefresh] = useState(0);
  // Bumped when the admin manage grid mutates, so the public results (a
  // separate component with its own score fetch) pick up the change too.
  const [resultsRefresh, setResultsRefresh] = useState(0);
  const [replayAvailable, setReplayAvailable] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [forgeOpen, setForgeOpen] = useState(false);

  // The comp, for the admin check and the comp name in the trail. Non-critical
  // and deliberately its own request: it used to run only after the task
  // resolved, inside the same async block, so a page that works without it
  // waited for it anyway. A failure here costs the admin controls, not the page.
  useEffect(() => {
    if (!compId) return;
    if (initial?.comp && refresh === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.api.comp[":comp_id"].$get({
          param: { comp_id: compId },
        });
        if (!cancelled && res.ok) {
          setComp((await res.json()) as unknown as CompDetailData);
        }
      } catch {
        // Degrade gracefully — no admin features.
      }
    })();
    return () => {
      cancelled = true;
    };
    // `initial` is stable for the life of the SSR'd URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compId, refresh]);

  const isAdmin = useAdminView(
    user != null && comp != null && comp.admins.some((a) => a.email === user.email)
  );

  // `#edit-route` deep link (the comp page's featured-task card used to point
  // here; a bookmarked or shared link still can). The editor is its own route
  // now, so the hash is a REDIRECT rather than a flag that opens a dialog —
  // which is also what makes it disappear from the address bar on arrival.
  useEffect(() => {
    if (location.hash !== "#edit-route" || !isAdmin || !task || !comp) return;
    navigate(taskRoutePath(compId, comp.name, taskId, task.name), {
      replace: true,
    });
  }, [location.hash, isAdmin, task, comp, compId, taskId, navigate]);

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
          {task.submissions_closed ? (
            // Above the fold, so a pilot learns the task stopped taking files
            // without first choosing one and being refused.
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
              <Badge>Submissions closed</Badge>
              <span className="text-muted-foreground">
                The organisers are no longer accepting tracks for this task.
              </span>
            </p>
          ) : null}
          {task.stop_announcement_time ? (
            // Stopped task (FAI S7F §13.4): surface the stop prominently —
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
                — scored as a stopped task (FAI S7F §13.4)
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
          {/* A link, not a dialog trigger: task settings are a routed page
              (#637), so this is a real destination the back button walks out
              of. */}
          {isAdmin && comp ? (
            <LinkButton
              variant="outline"
              size="sm"
              href={taskSettingsPath(compId, comp.name, taskId, task.name)}
            >
              Settings
            </LinkButton>
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
        {/* Mount-gated: the dialog's contents still depend on who is asking
            (the on-behalf picker), and the server renders this page for
            anyone, so the markup must settle after hydration rather than
            before. The button itself no longer depends on a session —
            submitting is open to anyone the comp's roster knows. */}
        {mounted && !isClosed && (!task.submissions_closed || isAdmin) ? (
          <Button size="sm" onPress={() => setSubmitOpen(true)}>
            Submit track
          </Button>
        ) : null}
        {/* A sentence, not a disabled button: a greyed-out control invites
            tapping and explains nothing. Admins see it AND keep the button,
            because the flag stops pilots, not the scorekeeper. */}
        {mounted && !isClosed && task.submissions_closed ? (
          <p className="self-center text-sm text-muted-foreground">
            Submissions for this task are closed.
            {isAdmin ? " You can still upload as an organiser." : ""}
          </p>
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
        {/* An organiser's tool: the people who need a file to test submission
            and scoring with are the ones running the competition, so it is
            gated like every other manage action on this page. `useAdminView`
            is the right check precisely because it also makes the button
            disappear while a super admin previews as a pilot. Nothing here
            reaches the server — the dialog makes a file and offers it as a
            download — so this widens who SEES it and nothing more. A route is
            required because there is nothing to fly without one. */}
        {isAdmin && comp && task.xctsk ? (
          <Button variant="outline" size="sm" onPress={() => setForgeOpen(true)}>
            Create test IGC
          </Button>
        ) : null}
      </div>

      {forgeOpen && comp && task.xctsk ? (
        <Suspense fallback={null}>
          <ForgeIgcDialog
            open
            onClose={() => setForgeOpen(false)}
            taskName={task.name}
            taskDate={task.task_date}
            compName={comp.name}
            timezone={comp.timezone ?? null}
            category={comp.category === "pg" ? "pg" : "hg"}
            xctsk={task.xctsk}
          />
        </Suspense>
      ) : null}

      {submitOpen ? (
        <SubmitTrackDialog
          compId={compId}
          taskId={taskId}
          compName={comp?.name}
          taskName={task.name}
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

      {/* The sections below are cards; the stack owns the rhythm between them
          (SectionHeader no longer carries a margin of its own). */}
      <div className="mt-6 flex flex-col gap-6">
      <TurnpointsSection
        xctsk={task.xctsk}
        taskDate={task.task_date}
        timezone={comp?.timezone ?? null}
        wind={wind}
        isAdmin={isAdmin}
        routeHref={taskRoutePath(compId, comp?.name, taskId, task.name)}
      />

      {/* The day's weather — the organizer's notes plus the modelled
          conditions (the same charts the field-analysis report leads with).
          Sits directly under the route, above the results: the conditions
          are context for reading everything below them. */}
      <WeatherSection
        weather={weather}
        notes={task.weather_notes}
        isAdmin={isAdmin}
        compTimezone={comp?.timezone ?? null}
        notesHref={taskWeatherPath(compId, comp?.name, taskId, task.name)}
      />

      {/* Public results: top-3 podium per class + the link to the comp's
          scores page (the canonical scores surface), plus pilot self-service
          (Submit track, your-submission line). The management grid below is
          admin-only.

          submissionsClosed is passed `&& !isAdmin` for the same reason the
          page's action row keeps its button for admins: the stop is aimed at
          pilots, and this section renders its OWN Submit action, so gating the
          action row alone would leave a button here the server refuses. */}
      <CompNameProvider value={comp?.name ?? null}>
        <TaskScoresPublic
          compId={compId}
          taskId={taskId}
          taskName={task.name}
          timezone={comp?.timezone ?? null}
          isOpenDistance={comp?.scoring_format === "open_distance"}
          isAuthenticated={user != null}
          isClosed={isClosed}
          submissionsClosed={task.submissions_closed && !isAdmin}
          canUploadOnBehalf={canUploadOnBehalf}
          refresh={scoresRefresh + resultsRefresh}
          onReplayAvailable={setReplayAvailable}
          initialScore={initial && refresh === 0 ? (initial.score ?? undefined) : undefined}
          taskDate={task.task_date}
        />
      </CompNameProvider>

      {/* Admin management grid (statuses, uploads on behalf, manual flights,
          restores) — the tool the old public "scores" table was secretly
          doubling as. Admin-only and never server-rendered. */}
      {isAdmin && comp ? (
        <CompNameProvider value={comp.name}>
        <TaskScoresAdmin
          compId={compId}
          taskId={taskId}
          taskName={task.name}
          isAdmin={isAdmin}
          isClosed={isClosed}
          scoringFormat={comp.scoring_format === "open_distance" ? "open_distance" : "gap"}
          timezone={comp.timezone ?? null}
          taskXctsk={task.xctsk}
          submissionsClosed={task.submissions_closed}
          refresh={scoresRefresh}
          onMutated={() => setResultsRefresh((n) => n + 1)}
        />
        </CompNameProvider>
      ) : null}
      </div>

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
    <dl className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(min(15rem,100%),1fr))] gap-x-6 gap-y-2 rounded-lg border bg-muted/30 p-3 text-sm">
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
  routeHref,
}: {
  xctsk: XCTask | null;
  taskDate: string;
  /** Comp-local IANA zone; gate times in the summary show comp-local when set. */
  timezone: string | null;
  /** The day's modelled wind, once the weather lands. Null until then. */
  wind: TaskWind | null;
  isAdmin: boolean;
  /** The route editor's URL — a page since #637, so this is a link. */
  routeHref: string;
}) {
  // Which turnpoint the reader is pointing at, shared by the diagram and the
  // table so the shape and the numbers stay tied together — either one can
  // set it, and both show it. Client-only state, so it does not affect the
  // server-rendered markup.
  const [focused, setFocused] = useState<number | null>(null);

  if (!xctsk && !isAdmin) return null;
  return (
    <Card>
      <SectionHeader
        title="Route"
        action={
          isAdmin ? (
            <LinkButton variant="outline" size="sm" href={routeHref}>
              {xctsk && xctsk.turnpoints.length > 0 ? "Edit route" : "Create route"}
            </LinkButton>
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
          {/* Two views of one route, paired by the shared MasterDetail: the
              diagram is the shape on the ground (drawn from the same optimised
              line the table measures and the scorer uses — not a map, "View on
              map" above is for that), the table is the numbers and the
              accessible reading of it. On a phone the diagram pins to the top
              while the turnpoint list scrolls under it, so a row you point at
              highlights a shape that is on screen; side by side it is the
              sticky right-hand column. */}
          <div className="mt-3">
            <MasterDetail
              detailLabel="diagram"
              detailAriaLabel="Route diagram"
              wideCols="@5xl:grid-cols-[minmax(0,1fr)_auto]"
              detail={
                <div className="flex justify-center bg-muted/20 p-2">
                  <TaskDiagram
                    task={xctsk}
                    size="md"
                    // Scales down rather than scrolling sideways: the `md`
                    // preset can be wider than a phone's pane. The viewBox
                    // keeps the drawing intact at any width.
                    className="h-auto max-w-full"
                    onTurnpointHover={(tp) => setFocused(tp?.index ?? null)}
                    onTurnpointSelect={(tp) => setFocused(tp.index)}
                    highlightIndex={focused}
                    wind={wind}
                  />
                </div>
              }
              master={
                <TurnpointsTable
                  xctsk={xctsk}
                  wind={wind}
                  highlightIndex={focused}
                  onTurnpointHover={setFocused}
                  onTurnpointSelect={setFocused}
                />
              }
            />
          </div>
        </>
      ) : (
        <p className="mt-2 text-muted-foreground">No route defined yet</p>
      )}
    </Card>
  );
}
