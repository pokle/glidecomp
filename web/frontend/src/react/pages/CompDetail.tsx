/**
 * Competition detail page — the comp "hub" (IA v2 #277): a pilot bookmarks
 * this one URL and every job is served here or one click away. Tasks (as a
 * date → class tree), inline competition scores, pilots, activity, admins.
 * Mutations that used to window.location.reload() instead bump a refresh
 * counter that re-runs the comp fetch.
 *
 * Built on the RAC kit (src/react/rac/) like the task detail page — the
 * pilots editor keeps its Tabulator grid (see PilotsSection).
 */
import { Fragment, useEffect, useId, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { NotFound } from "@/react/components/NotFound";
import { Form } from "react-aria-components";
import { Button, LinkButton } from "@/react/rac/button";
import { Card } from "@/react/rac/card";
import { Loading } from "@/react/rac/progress";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Modal,
} from "@/react/rac/dialog";
import { TextField, Label } from "@/react/rac/field";
import { Checkbox, CheckboxGroup } from "@/react/rac/checkbox";
import { DatePicker } from "@/react/rac/date-picker";
import { api } from "../../comp/api";
import { toast } from "../lib/toast";
import { useAdminView, useUser } from "../lib/user";
import {
  categoryLabel,
  formatTaskDate,
  formatTaskDateRange,
  scoringFormatLabel,
  todayInZone,
} from "../lib/format";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { PriorityNav, type PriorityNavItem } from "@/react/rac/priority-nav";
import { Disclosure } from "@/react/rac/disclosure";
import { compCrumbs } from "../lib/crumbs";
import {
  idFromSegment,
  compPath,
  compScoresPath,
  compSettingsPath,
  compWaypointsPath,
  compAnalysisPath,
  taskPath,
} from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { useSeededResource } from "../lib/use-seeded-resource";
import { SectionHeader } from "../components/SectionHeader";
import { ActivitySection } from "../comp/ActivitySection";
import { CompScoresSummary } from "../comp/CompScoresSummary";
import { CompSetupProgress } from "../comp/CompSetupProgress";
import { TaskDiagramOverlay } from "../comp/TaskDiagramOverlay";
import {
  isPastCloseDate,
  type CompDetailData,
  type TaskSummary,
} from "../comp/types";
import { useInitialData } from "../lib/initial-data";
import { useMounted } from "../lib/use-mounted";
import type { CompDetailLoaderData, CompScores } from "../loaders";

const sectionLinkClass = "hover:text-foreground hover:underline underline-offset-4";

/**
 * The section bar's in-page entries, for when they have folded into the
 * overflow menu. In the row they are plain `#id` anchors and the browser does
 * this itself; from a menu item the jump has to be made by hand — and NOT as a
 * routed href, because react-router would push a history entry and
 * lib/scroll-restoration.ts would start it at the top, which is the one thing
 * an in-page anchor must not do. `scroll-mt-24` on the section keeps the
 * landing clear of the sticky bars.
 */
const scrollToSection = (id: string) => () => {
  document.getElementById(id)?.scrollIntoView();
};

export function CompDetail() {
  const { compId: compParam } = useParams<{ compId: string }>();
  // The route param may be a `${slug}-${id}` — the id is what the API needs.
  const compId = idFromSegment(compParam ?? "");
  const { user } = useUser();
  const location = useLocation();
  // SSR seed: the server ran loadCompDetail for this URL, so render the comp in
  // the first paint and hydrate the same markup. Null on client boot / SPA nav.
  const initial = useInitialData<CompDetailLoaderData>();
  const [refresh, setRefresh] = useState(0);
  const { data: comp, notFound } = useSeededResource<CompDetailData>({
    ids: [compId],
    seed: initial?.comp ?? null,
    load: ([comp_id]) => api.api.comp[":comp_id"].$get({ param: { comp_id } }),
    title: (c) => `GlideComp - ${c.name}`,
    refresh,
  });
  const [createOpen, setCreateOpen] = useState(false);

  // Settle the address bar on the canonical `${slug}-${id}` once the name loads.
  useCanonicalPath(comp ? compPath(compId, comp.name) : null);

  // Deep links like /comp/:id#scores (the old /scores page redirects there):
  // scroll once the sections exist.
  useEffect(() => {
    if (!comp || !location.hash) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, [comp, location.hash]);

  if (notFound || !compId) {
    return <NotFound title="Competition not found" />;
  }

  if (!comp) {
    return (
      <Loading>Loading competition…</Loading>
    );
  }

  // The SSR seed ("today" + scores) applies only to the first, un-mutated
  // render; after a refresh the sections fetch fresh data themselves.
  const seeded = initial && refresh === 0 ? initial : null;

  return (
    <CompDetailView
      compId={compId}
      comp={comp}
      user={user}
      createOpen={createOpen}
      setCreateOpen={setCreateOpen}
      setRefresh={setRefresh}
      today={seeded?.today}
      initialScores={seeded?.scores ?? undefined}
      initialScoresEtag={seeded?.scoresEtag ?? undefined}
    />
  );
}

function CompDetailView({
  compId,
  comp,
  user,
  createOpen,
  setCreateOpen,
  setRefresh,
  today,
  initialScores,
  initialScoresEtag,
}: {
  compId: string;
  comp: CompDetailData;
  user: ReturnType<typeof useUser>["user"];
  createOpen: boolean;
  setCreateOpen: (open: boolean) => void;
  setRefresh: React.Dispatch<React.SetStateAction<number>>;
  /** SSR-computed "today" (comp tz) so the section order matches across
   *  hydration. Omitted on client navigations. */
  today?: string;
  /** SSR-seeded whole-comp scores + ETag (first render only). */
  initialScores?: CompScores;
  initialScoresEtag?: string | null;
}) {
  const isAdmin = useAdminView(
    user != null && comp.admins.some((a) => a.email === user.email)
  );
  // This page is server-rendered, so anything clock-dependent has to settle
  // after hydration rather than differ from the server's markup.
  const mounted = useMounted();
  const isClosed = isPastCloseDate(comp.close_date);

  const facts = [
    categoryLabel(comp.category),
    scoringFormatLabel(comp.scoring_format),
    comp.pilot_classes.join(", "),
  ];
  const taskDates = comp.tasks.map((t) => t.task_date).sort();
  if (taskDates.length > 0) {
    facts.push(formatTaskDateRange(taskDates[0], taskDates[taskDates.length - 1]));
  }

  // Once the last task date is behind us the visitor's job flips from "what
  // am I flying today?" to "who won?" — scores lead, tasks follow.
  // Derived from the loader-injected "today", so SSR and hydration agree.
  const finished = isCompFinished(comp.tasks, comp.timezone, today);

  const tasksSection = (
    // break-before-page: when printing, each major section starts a fresh page.
    <Card id="tasks" className="scroll-mt-24 break-before-page">
      <SectionHeader
        title="Tasks"
        action={
          isAdmin ? (
            <Button variant="outline" size="sm" onPress={() => setCreateOpen(true)}>
              New Task
            </Button>
          ) : null
        }
      />
      {/* Above the list so the row badges' "see Task Warnings above" holds. */}
      <ClassWarnings warnings={comp.class_coverage_warnings} tasks={comp.tasks} />
      <TasksList
        tasks={comp.tasks}
        pilotClasses={comp.pilot_classes}
        compId={compId}
        compName={comp.name}
        isAdmin={isAdmin}
        onCreateTask={() => setCreateOpen(true)}
      />
    </Card>
  );

  const scoresSection = (
    <CompScoresSummary
      compId={compId}
      timezone={comp.timezone}
      initialScores={initialScores}
      initialScoresEtag={initialScoresEtag}
      isAdmin={isAdmin}
    />
  );

  // The section bar's links. Each is written twice on purpose: once as the
  // element the row renders (a Link, or a plain `#id` anchor), and once as the
  // plain label and destination the overflow menu needs — a RAC MenuItem is
  // the item, so it cannot wrap the row's own element.
  const sectionLinks: PriorityNavItem[] = [
    {
      id: "tasks",
      label: `Tasks (${comp.tasks.length})`,
      onAction: scrollToSection("tasks"),
      children: (
        <a href="#tasks" className={sectionLinkClass}>
          Tasks ({comp.tasks.length})
        </a>
      ),
    },
    {
      id: "scores",
      label: "Scores",
      href: compScoresPath(compId, comp.name),
      children: (
        <Link to={compScoresPath(compId, comp.name)} className={sectionLinkClass}>
          Scores
        </Link>
      ),
    },
    {
      id: "waypoints",
      label: `Waypoints (${comp.waypoint_count})`,
      href: compWaypointsPath(compId, comp.name),
      children: (
        <Link to={compWaypointsPath(compId, comp.name)} className={sectionLinkClass}>
          Waypoints ({comp.waypoint_count})
        </Link>
      ),
    },
    // Pilot management moved to its own admin page — visitors find every pilot
    // in the scores, so the roster link is admin-only.
    ...(isAdmin
      ? [
          {
            id: "pilots",
            label: `Pilots (${comp.pilot_count})`,
            href: `${compPath(compId, comp.name)}/pilots`,
            children: (
              <Link
                to={`${compPath(compId, comp.name)}/pilots`}
                className={sectionLinkClass}
              >
                Pilots ({comp.pilot_count})
              </Link>
            ),
          },
        ]
      : []),
    // Field analysis has nothing to measure on an open-distance comp (no legs,
    // no speed section), so it's hidden there. Its own page — it's a long
    // exploratory read.
    ...(comp.scoring_format !== "open_distance"
      ? [
          {
            id: "analysis",
            label: "Field analysis",
            href: compAnalysisPath(compId, comp.name),
            children: (
              <Link
                to={compAnalysisPath(compId, comp.name)}
                className={sectionLinkClass}
              >
                Field analysis
              </Link>
            ),
          },
        ]
      : []),
    {
      id: "activity",
      label: "Activity",
      onAction: scrollToSection("activity"),
      children: (
        <a href="#activity" className={sectionLinkClass}>
          Activity
        </a>
      ),
    },
  ];

  return (
    <div>
      <Breadcrumbs items={compCrumbs()} current={comp.name} />

      <div className="mt-2 flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold">{comp.name}</h1>
          <p className="text-sm text-muted-foreground">
            {facts.join(" · ")}
            {comp.test ? " · Hidden" : null}
          </p>
        </div>
        {/* Submitting is the one thing a pilot comes to a live comp to DO, so
            it leads. It goes to /submit with the comp prefilled rather than
            opening the dialog here: from the comp page the task is still an
            open question, and the page is where that question is answered.
            Mount-gated for the same reason as the task page's button — this
            page is server-rendered. */}
        {mounted && !isClosed ? (
          <LinkButton size="sm" href={`/submit?comp=${encodeURIComponent(compId)}`}>
            Submit track
          </LinkButton>
        ) : null}
        {isAdmin ? (
          <LinkButton
            variant="outline"
            size="sm"
            href={compSettingsPath(compId, comp.name)}
          >
            Settings
          </LinkButton>
        ) : null}
      </div>

      {/* Counts double as honest signage: "Tasks (0)" says don't bother
          scrolling; on a populated comp they're at-a-glance facts. Sticky so
          the page's map survives scrolling into the long sections; sits under
          the (sticky) app header on sm+, at the very top where the header is
          static (phones, short landscape). */}
      <nav
        aria-label="Sections"
        className="sticky top-0 z-30 -mx-4 mt-3 border-b bg-background/90 px-4 py-2 text-sm text-muted-foreground backdrop-blur-sm sm:top-[61px] [@media(max-height:500px)]:static print:hidden"
      >
        {/* Six links wrapped onto three lines on a phone, which is most of a
            sticky bar and none of the page. They stay on one line now and fold
            into "More" from the right (issue #639). */}
        <PriorityNav
          items={sectionLinks}
          className="gap-x-4"
          menuLabel="More sections"
        />
      </nav>

      {/* Admin-only, so absent from SSR markup and the first client paint —
          it pops in after auth resolves, like the Settings button. */}
      {isAdmin ? (
        <CompSetupProgress
          compId={compId}
          comp={comp}
          onCreateTask={() => setCreateOpen(true)}
        />
      ) : null}

      {/* The card stack owns the rhythm between sections, which is why
          SectionHeader no longer carries a margin of its own. */}
      <div className="mt-6 flex flex-col gap-6">
        {finished ? (
          <>
            {scoresSection}
            {tasksSection}
          </>
        ) : (
          <>
            {tasksSection}
            {scoresSection}
          </>
        )}

        <Card id="activity" className="scroll-mt-24 break-before-page">
          <ActivitySection compId={compId} collapsible />
        </Card>
      </div>

      {/* Organizer credit + contact — a footnote, not a section. The scores
          page's "Ask the comp admins" links to #admins here. */}
      <p id="admins" className="mt-10 scroll-mt-24 text-sm text-muted-foreground">
        Organized by{" "}
        {comp.admins.map((admin, i) => (
          <Fragment key={admin.email}>
            {i > 0 ? (i === comp.admins.length - 1 ? " and " : ", ") : null}
            <span className="text-foreground">{admin.name}</span>{" "}
            (
            <a className="underline underline-offset-4" href={`mailto:${admin.email}`}>
              {admin.email}
            </a>
            )
          </Fragment>
        ))}
        .
      </p>

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

    </div>
  );
}

/**
 * True once every task date is behind us in the comp's own timezone — the
 * comp has finished flying, so the page leads with the scores.
 *
 * The task list itself makes nothing of the calendar: every task is presented
 * alike, whether it flew last year or flies tomorrow.
 */
function isCompFinished(
  tasks: TaskSummary[],
  timezone: string | null,
  /** SSR-computed "today" (comp tz); pass through so the verdict is identical
   *  server- and client-side on hydration. Omitted on client navigations. */
  injectedToday?: string
): boolean {
  if (tasks.length === 0) return false;
  let today: string;
  if (injectedToday) {
    today = injectedToday;
  } else {
    // A comp carrying a timezone the runtime doesn't know would throw — fall
    // back to the visitor's own zone rather than blanking the page.
    try {
      today = todayInZone(timezone);
    } catch {
      today = todayInZone(null);
    }
  }
  return tasks.every((t) => t.task_date < today);
}

function ClassWarnings({
  warnings,
  tasks,
}: {
  warnings: CompDetailData["class_coverage_warnings"];
  tasks: TaskSummary[];
}) {
  // Task-setup warnings: GAP tasks defined without SSS/ESS turnpoint types
  // still score via engine fallbacks, but it's almost always a mistake.
  // (LINE goals are scored natively against the goal line, so they get an
  // informational badge on the task list rather than a warning here.)
  const setupWarnings = tasks
    .map((t) => {
      const parts: string[] = [];
      if (t.missing_sss) {
        parts.push("no Start (SSS) turnpoint — scoring treats the first turnpoint as the start");
      }
      if (t.missing_ess) {
        parts.push("no ESS turnpoint — the speed section ends at goal");
      }
      return parts.length > 0 ? { name: t.name, text: parts.join("; ") } : null;
    })
    .filter((w): w is { name: string; text: string } => w !== null);

  if (warnings.length === 0 && setupWarnings.length === 0) return null;
  const count = warnings.length + setupWarnings.length;
  return (
    // Collapsed by default inside the Tasks section: the count in the trigger
    // is the signage; the detail is a drawer, not a section competing with the
    // task list. (Print expands it — the Disclosure component handles that.)
    <Disclosure
      className="mt-3 border-t-0 pt-0"
      title={
        <span className="text-amber-600 dark:text-amber-400">
          Task warnings ({count})
        </span>
      }
    >
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
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
        {setupWarnings.map((w) => (
          <li key={w.name} className="text-amber-500/80">
            <strong>{w.name}</strong> — {w.text}
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

/**
 * The tasks of a competition, grouped two levels deep: the flying day, and
 * under it one link per pilot class flying that day. Every task is presented
 * alike — whichever one is today's is not singled out, because on a hub a
 * pilot bookmarks and returns to, "which day am I looking at?" is the question
 * the page should answer, not "which day does the page think I want?".
 *
 * Class is the second level because it is what a pilot filters on: two classes
 * routinely fly different tasks on the same day (an imported AirScore comp
 * scores them as separate comps entirely — see the Corryong sample). A task
 * flown by several classes appears under each of them; the row's link is the
 * task, so the same destination is reachable from whichever class the reader
 * came looking for.
 *
 * A day is a Disclosure over a plain list of links, NOT a RAC Tree. The tree
 * was the first cut and it fit badly: a `treegrid` is one tab stop, so Tab
 * skipped every task on the page and reaching one meant knowing to press Down
 * then Right; its rows read as data cells rather than as navigation; and focus
 * returning from a dialog landed on the row instead of the control that opened
 * it. Those are all correct treegrid behaviours — the pattern is for
 * hierarchical DATA GRIDS and for selection, and this is neither. It is six
 * links with headings over them, so it is a list, and the links are in the tab
 * order where a reader expects to find them.
 *
 * Rows carry only the link, the setup badges and the route glyph; every action
 * (submit, share, replay, map) lives on the task page one tap away.
 */
function TasksList({
  tasks,
  pilotClasses,
  compId,
  compName,
  isAdmin,
  onCreateTask,
}: {
  tasks: TaskSummary[];
  /** The comp's declared classes, in the order the organizers listed them —
   *  used to order the class rows within a day. */
  pilotClasses: string[];
  compId: string;
  compName: string;
  isAdmin: boolean;
  onCreateTask: () => void;
}) {
  if (tasks.length === 0) {
    // Role-aware empty state: visitors get an explanation, admins also get
    // the section's CTA in the body (not just the header corner).
    return (
      <div className="mt-2 text-muted-foreground">
        <p>The organizers haven't published any tasks yet.</p>
        {isAdmin ? (
          <Button variant="outline" size="sm" className="mt-3" onPress={onCreateTask}>
            New Task
          </Button>
        ) : null}
      </div>
    );
  }

  const days = groupTasksByDateAndClass(tasks, pilotClasses);

  return (
    <div className="divide-y rounded-lg border">
      {days.map((day) => (
        <Disclosure
          key={day.date}
          // Open by default: the grouping is here to make a long list of days
          // scannable, not to hide any of them — and a day folded away takes
          // its task links out of the printed page. (Print re-expands them
          // anyway; see the kit's Disclosure.)
          defaultExpanded
          title={formatTaskDate(day.date)}
          badge={
            <span className="text-sm text-muted-foreground">
              {day.taskCount} {day.taskCount === 1 ? "task" : "tasks"}
            </span>
          }
          // The container draws the dividers, so each day drops its own top
          // border; px/py put the trigger and its panel on one inset.
          className="border-t-0 px-3 py-2.5"
        >
          <ul className="mt-1 space-y-0.5 text-sm">
            {day.rows.map((row) => (
              <li key={row.key} className="flex items-center gap-4">
                <Link
                  className="group/task min-w-0 flex-1 py-1"
                  to={taskPath(compId, compName, row.task.task_id, row.task.name)}
                >
                  {row.pilotClass ? (
                    <>
                      <strong>{row.pilotClass}</strong>{" "}
                      <span className="text-muted-foreground">·</span>{" "}
                    </>
                  ) : null}
                  {/* The task name is underlined AT REST, not just on hover:
                      hover-only underlining says nothing at all on a phone,
                      where there is no hover, and this list is the page's main
                      way into a task. The class prefix and the badges stay
                      unmarked so one thing per row looks like the link, though
                      the whole row-width anchor is the target. */}
                  <span className="font-medium underline decoration-muted-foreground/40 underline-offset-4 group-hover/task:decoration-current">
                    {row.task.name}
                  </span>{" "}
                  {!row.task.has_xctsk ? (
                    <span className="text-muted-foreground">Route not set yet</span>
                  ) : null}{" "}
                  {row.task.missing_sss ? (
                    <span
                      className="inline-flex items-center rounded-md bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-500"
                      title="Scoring falls back — see Task Warnings above"
                    >
                      No SSS
                    </span>
                  ) : null}{" "}
                  {row.task.missing_ess ? (
                    <span
                      className="inline-flex items-center rounded-md bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-500"
                      title="Scoring falls back — see Task Warnings above"
                    >
                      No ESS
                    </span>
                  ) : null}{" "}
                  {row.task.line_goal ? (
                    <span
                      className="inline-flex items-center rounded-md bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary"
                      title="This task ends at a goal line perpendicular to the final leg"
                    >
                      Goal line
                    </span>
                  ) : null}
                </Link>
                {/* Tiny route glyph: enough to tell one day's task from
                    another's at a glance, and tappable for the readable
                    version — at this size the shape is all it can carry, so
                    "which turnpoints is that?" is one press away instead of
                    a page load. Nothing is reserved when a task has no
                    route: the glyphs are right-aligned, so an empty box
                    buys no alignment and only pads the row — which on a
                    phone (or against a comp-api that predates the `route`
                    field) turns the whole list into dead space. */}
                {row.task.route ? (
                  <TaskDiagramOverlay task={row.task.route} taskName={row.task.name} />
                ) : null}
              </li>
            ))}
          </ul>
        </Disclosure>
      ))}
    </div>
  );
}

interface TaskClassRow {
  /** Unique across the whole tree — RAC keys every row by it. */
  key: string;
  /** Null for a task registered against no class at all (see below). */
  pilotClass: string | null;
  task: TaskSummary;
  /** What typeahead and screen readers get for the row. */
  textValue: string;
}

interface TaskDay {
  date: string;
  rows: TaskClassRow[];
  /** Distinct tasks, which is smaller than `rows` when one task serves
   *  several classes — the count a reader means by "tasks". */
  taskCount: number;
}

/**
 * Newest day first — the current one is what a returning visitor came for, so
 * it lands at the top without being dressed up differently from the rest.
 * Within a day, classes run in the order the comp declares them (an
 * organizer's order carries meaning that alphabetical doesn't); a class the
 * comp no longer lists still shows, sorted after the ones it does.
 */
function groupTasksByDateAndClass(
  tasks: TaskSummary[],
  pilotClasses: string[]
): TaskDay[] {
  const classOrder = new Map(pilotClasses.map((c, i) => [c, i]));
  const rank = (cls: string) => classOrder.get(cls) ?? pilotClasses.length;

  const byDate = new Map<string, TaskSummary[]>();
  for (const task of tasks) {
    const list = byDate.get(task.task_date) ?? [];
    list.push(task);
    byDate.set(task.task_date, list);
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([date, dayTasks]) => {
      const rows = dayTasks
        .flatMap((task) =>
          // A task with no classes at all still gets a row: an odd record is a
          // reason to show a task plainly, never to drop it off the page.
          (task.pilot_classes.length > 0 ? task.pilot_classes : [null]).map(
            (pilotClass): TaskClassRow => ({
              key: `${task.task_id}:${pilotClass ?? ""}`,
              pilotClass,
              task,
              textValue: pilotClass ? `${pilotClass} · ${task.name}` : task.name,
            })
          )
        )
        .sort((a, b) => {
          if (a.pilotClass === b.pilotClass) return 0;
          if (a.pilotClass === null) return 1;
          if (b.pilotClass === null) return -1;
          return (
            rank(a.pilotClass) - rank(b.pilotClass) ||
            a.pilotClass.localeCompare(b.pilotClass)
          );
        });
      return { date, rows, taskCount: dayTasks.length };
    });
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
  const dateId = useId();
  const [name, setName] = useState("");
  const [taskDate, setTaskDate] = useState(new Date().toISOString().split("T")[0]);
  // All classes checked by default, matching the vanilla dialog.
  const [selectedClasses, setSelectedClasses] = useState<string[]>(pilotClasses);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
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
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className="sm:max-w-lg"
    >
      <Dialog>
        <DialogHeader>
          <DialogTitle>Create Task</DialogTitle>
        </DialogHeader>
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="flex flex-col gap-4"
        >
          <TextField
            label="Name"
            isRequired
            maxLength={128}
            autoFocus
            placeholder="e.g. Day 1 - Ridge Run"
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
            {pilotClasses.map((cls) => (
              <Checkbox key={cls} value={cls}>
                {cls}
              </Checkbox>
            ))}
          </CheckboxGroup>
          <DialogFooter>
            <Button slot="close" variant="outline">
              Cancel
            </Button>
            <Button type="submit" isDisabled={submitting}>
              {submitting ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </Form>
      </Dialog>
    </Modal>
  );
}
