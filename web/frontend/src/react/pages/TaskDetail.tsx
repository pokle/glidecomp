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
 * listing); admins additionally get the route editor (pages/TaskRoutePage)
 * covering turnpoints, start gates, goal, and .xctsk / XContest
 * import-export (#270).
 *
 * The page is for information, and every action is in the bar (issue #863):
 * the task's name is the bar's title, the competition's other tasks are in
 * the title's menu (where "← Task 2" links were), and ⋯ holds "Submit your
 * track" first, then sharing and the other views of the task, then the
 * organisers' tools. Nothing on the page itself is a manage button.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { NotFound } from "@/react/components/NotFound";
import { Form } from "react-aria-components";
import { type XCTask } from "@glidecomp/engine";
import { Badge } from "@/react/rac/badge";
import { Loading } from "@/react/rac/progress";
import { Page, PageBar, type BarAction } from "@/react/rac/page-bar";
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
  zonedDateTimeLocalToUtcISO,
  zoneLabel,
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
import { ShareTaskDialog } from "../comp/TaskExportButtons";
import { TaskScoresPublic } from "../comp/TaskScoresPublic";
import { CompNameProvider } from "../comp/comp-name-context";
import { TaskScoresAdmin } from "../comp/TaskScoresAdmin";
import { TurnpointsTable } from "../comp/TurnpointsTable";
import { TaskDiagram } from "../comp/TaskDiagram";
import { goalSummary, startConfigSummary } from "../comp/route";
import {
  isPastCloseDate,
  type CompDetailData,
  type TaskDetailData,
} from "../comp/types";
import { useInitialData } from "../lib/initial-data";
import { useMounted } from "../lib/use-mounted";
import type { TaskDetailLoaderData } from "../loaders";
import {
  ChartColumnIcon,
  CloudUploadIcon,
  FlaskConicalIcon,
  MapIcon,
  NotebookPenIcon,
  QrCodeIcon,
  RouteIcon,
  SettingsIcon,
  ShareIcon,
} from "lucide-react";
import { underComp, taskSiblings, TASK_ANALYSIS_LABEL } from "../lib/crumbs";
import { compUrlId, idFromSegment, compPath, submitTrackPath, taskPath, taskAnalysisPath, taskQrPath, taskSettingsPath, taskRoutePath, taskTestIgcPath, taskWeatherPath } from "../lib/slug";
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
  // The comp id `comp` was loaded for — see the canonical path below.
  const [compLoadedFor, setCompLoadedFor] = useState<string | null>(
    initial?.comp ? compId : null
  );

  const [refresh, setRefresh] = useState(0);
  // The task is the page. A dead task id is a dead URL; the comp above is
  // supporting detail the page degrades without.
  const { data: task, notFound, current: taskCurrent } = useSeededResource<TaskDetailData>({
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
  // wait for it rather than 301-ing to a bare comp segment), and only from
  // what was loaded for THIS URL: while the ids in the path change, both still
  // hold the previous URL's, and a path built from them would undo the
  // navigation.
  useCanonicalPath(
    comp && task && taskCurrent && compLoadedFor === compId
      ? taskPath(compUrlId(comp, compId), comp.name, taskId, task.name)
      : null
  );

  const [scoresRefresh, setScoresRefresh] = useState(0);
  // Bumped when the admin manage grid mutates, so the public results (a
  // separate component with its own score fetch) pick up the change too.
  const [resultsRefresh, setResultsRefresh] = useState(0);
  const [replayAvailable, setReplayAvailable] = useState(false);

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
          const body = (await res.json()) as unknown as CompDetailData;
          if (cancelled) return;
          setComp(body);
          setCompLoadedFor(compId);
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

  const isAdmin = useAdminView(!!comp?.is_admin);

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

  // Submitting is a page of its own (/submit), not a dialog over this one:
  // see the overlays rule in docs/interaction-guide.md. The comp and task go in the URL — a
  // hidden comp's share key with the comp — so a reload or a shared link
  // lands on the same form, and Back comes back here.
  const submitHref = submitTrackPath(compUrlId(comp, compId), taskId);

  // Fetched ONCE here and handed down, rather than in each consumer: the
  // weather section and the route views both want it, and the endpoint can
  // schedule a background provider fetch, so asking twice is not free.
  const weather = useTaskWeather(compId || null, taskId || null);
  const wind = useMemo(
    () => taskWindFromWeather(weather.data?.weather ?? null),
    [weather.data]
  );

  const [shareOpen, setShareOpen] = useState(false);

  if (notFound || !compId || !taskId) {
    return <NotFound title="Task not found" />;
  }

  const isClosed = isPastCloseDate(comp?.close_date ?? null);
  const hasRoute = !!task?.xctsk && task.xctsk.turnpoints.length > 0;

  // Every action of the page, in the bar's ⋯ (issue #863: the page is for
  // information). Three groups, with a rule between them: submitting, the
  // ways to take the task away or look at it elsewhere, and the organisers'
  // tools.
  const actions: BarAction[] = [];
  if (task) {
    // "Submit your track" leads: the one thing a pilot comes to this page to
    // DO. Mount-gated: whether it shows depends on who is asking (an organiser
    // keeps it on a closed or hidden task) and on today's date, and the
    // server renders this page for anyone, so the markup must settle after
    // hydration rather than before. It does not depend on a session —
    // submitting is open to anyone the comp's roster knows.
    //
    // A hidden comp's share link is for READING a draft: every write route
    // refuses anyone but its admins, so no visitor is offered a row that can
    // only fail.
    if (
      mounted &&
      !isClosed &&
      (!task.submissions_closed || isAdmin) &&
      (!comp?.test || isAdmin)
    ) {
      actions.push({
        id: "submit",
        icon: CloudUploadIcon,
        label: "Submit your track",
        to: submitHref,
      });
    }

    const share: BarAction[] = [];
    if (task.xctsk) {
      share.push(
        { id: "share", label: "Share task", icon: ShareIcon, onAction: () => setShareOpen(true) },
        {
          id: "qr",
          label: "QR code",
          icon: QrCodeIcon,
          to: taskQrPath(compUrlId(comp, compId), comp?.name, taskId, task.name),
        },
        // The analysis page and the replay are separate entries, not SPA
        // routes: the router bridge loads them for real (rac/router.tsx).
        {
          id: "map",
          label: "All tracks",
          icon: MapIcon,
          to: `/analysis.html?compId=${encodeURIComponent(compId)}&taskId=${encodeURIComponent(taskId)}`,
        }
      );
    }
    if (replayAvailable) {
      share.push({
        id: "replay",
        label: "Replay the task in 3D",
        icon: MapIcon,
        to: `/replay?comp=${encodeURIComponent(compId)}&task=${encodeURIComponent(taskId)}`,
      });
    }
    // Task analysis: meaningless without a route or on an open-distance task
    // (which has no legs or speed section to measure against). Requires comp
    // to be LOADED — `comp?.scoring_format !== …` would fail open to a
    // dead-end refusal page whenever the non-critical comp fetch degrades.
    //
    // The task analysis is a page of its own under this task; the comp
    // analysis collects every task's, and is a sibling link from there.
    if (task.xctsk && comp && comp.scoring_format !== "open_distance") {
      share.push({
        id: "analysis",
        label: TASK_ANALYSIS_LABEL,
        icon: ChartColumnIcon,
        to: taskAnalysisPath(compId, comp.name, taskId, task.name),
      });
    }

    // The organisers' tools. `useAdminView` is the right check precisely
    // because it also takes them away while a super admin previews as a
    // pilot. Each is a routed page (#637, #822), so each is a link.
    const manage: BarAction[] = [];
    if (isAdmin && comp) {
      manage.push(
        {
          id: "route",
          icon: RouteIcon,
          label: hasRoute ? "Edit route" : "Create route",
          to: taskRoutePath(compId, comp.name, taskId, task.name),
        },
        {
          id: "settings",
          icon: SettingsIcon,
          label: "Task settings",
          to: taskSettingsPath(compId, comp.name, taskId, task.name),
        },
        {
          id: "notes",
          icon: NotebookPenIcon,
          label: task.weather_notes.trim().length > 0 ? "Edit notes" : "Add notes",
          to: taskWeatherPath(compId, comp.name, taskId, task.name),
        }
      );
      // A file to test submission and scoring with. Nothing here reaches the
      // server — the page makes a file and offers it as a download. A route
      // is required because there is nothing to fly without one.
      if (task.xctsk) {
        manage.push({
          id: "igc",
          icon: FlaskConicalIcon,
          label: "Create test IGC",
          to: taskTestIgcPath(compUrlId(comp, compId), comp.name, taskId, task.name),
        });
      }
    }
    for (const group of [share, manage]) {
      if (group.length > 0) actions.push({ ...group[0], group: true }, ...group.slice(1));
    }
  }

  // The bar is there before the task is, under the trail's fallback names, so
  // the page does not jump when the task arrives. The other tasks are in the
  // title's menu: the way from one task to the next.
  const bar = (
    <PageBar
      title={task?.name ?? "Task"}
      trail={underComp(compId, comp?.name)}
      related={taskSiblings(compId, comp?.name, comp?.tasks, taskId)}
      actions={actions}
    />
  );

  if (!task) {
    return (
      <Page width="wide" bar={bar}>
        <Loading>Loading task…</Loading>
      </Page>
    );
  }

  return (
    <Page width="wide" bar={bar}>
      {/* What the task is: its day, its state, its classes. The name is the
          bar's title. */}
      <div>
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
              <Badge>Closed for track submissions</Badge>
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
        {/* A sentence, not a disabled row in ⋯: a greyed-out control invites
            tapping and explains nothing. Admins see it AND keep "Submit your
            track", because the flag stops pilots, not the scorekeeper. */}
        {mounted && !isClosed && task.submissions_closed ? (
          <p className="mt-2 text-sm text-muted-foreground">
            This task is closed for track submissions.
            {isAdmin ? " You can still upload as an organiser." : ""}
          </p>
        ) : null}
      </div>

      {task.xctsk ? (
        <ShareTaskDialog
          compId={compId}
          taskId={taskId}
          taskName={task.name}
          isOpen={shareOpen}
          onOpenChange={setShareOpen}
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
      />

      {/* The day's weather — the organizer's notes plus the modelled
          conditions (the same charts the task-analysis report leads with).
          Sits directly under the route, above the results: the conditions
          are context for reading everything below them. */}
      <WeatherSection
        weather={weather}
        notes={task.weather_notes}
        isAdmin={isAdmin}
        compTimezone={comp?.timezone ?? null}
      />

      {/* Public results: top-3 podium per class + the link to the comp's
          scores page (the canonical scores surface), plus the signed-in
          pilot's own your-submission line. Submitting is in the bar's ⋯. The
          management grid below is admin-only. */}
      <CompNameProvider value={comp?.name ?? null}>
        <TaskScoresPublic
          compId={compId}
          taskId={taskId}
          taskName={task.name}
          timezone={comp?.timezone ?? null}
          isOpenDistance={comp?.scoring_format === "open_distance"}
          isAuthenticated={user != null}
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
          scoringFormat={comp.scoring_format === "open_distance" ? "open_distance" : "gap"}
          timezone={comp.timezone ?? null}
          submissionsClosed={task.submissions_closed}
          refresh={scoresRefresh}
          onMutated={() => setResultsRefresh((n) => n + 1)}
        />
        </CompNameProvider>
      ) : null}
      </div>
    </Page>
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
            {goalSummary(goal, { timeZone: timezone, taskDate })}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

/**
 * The task's route — headed "Route", because it is the start/goal summary and
 * the diagram as well as the turnpoint listing (the component keeps its older
 * name). Read-only for everyone; organisers reach the route editor
 * (turnpoints, start gates, goal, .xctsk / XContest import-export) from
 * "Edit route" in the bar's ⋯.
 */
function TurnpointsSection({
  xctsk,
  taskDate,
  timezone,
  wind,
  isAdmin,
}: {
  xctsk: XCTask | null;
  taskDate: string;
  /** Comp-local IANA zone; gate times in the summary show comp-local when set. */
  timezone: string | null;
  /** The day's modelled wind, once the weather lands. Null until then. */
  wind: TaskWind | null;
  /** An organiser sees the section before there is a route to show. */
  isAdmin: boolean;
}) {
  // Which turnpoint the reader is pointing at, shared by the diagram and the
  // table so the shape and the numbers stay tied together — either one can
  // set it, and both show it. Client-only state, so it does not affect the
  // server-rendered markup.
  const [focused, setFocused] = useState<number | null>(null);

  if (!xctsk && !isAdmin) return null;
  return (
    <Card>
      {/* No button here: "Edit route" is in the bar's ⋯ (#863). */}
      <SectionHeader title="Route" />
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
