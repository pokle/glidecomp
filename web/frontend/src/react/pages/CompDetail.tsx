/**
 * Competition detail page — the comp "hub" (IA v2 #277): a pilot bookmarks
 * this one URL and every job is served here or one click away. Tasks (as a
 * date → class tree), inline competition scores, pilots, activity, admins.
 * It changes nothing itself: creating a task, the one mutation it used to
 * host in a dialog, is a page of its own (pages/CompNewTaskPage.tsx).
 *
 * Built on the RAC kit (src/react/rac/) like the task detail page.
 */
import { Fragment, useEffect } from "react";
import { useLocation, useParams } from "react-router-dom";
import {
  CloudUploadIcon,
  CopyIcon,
  EyeOffIcon,
  FileTextIcon,
  PlusIcon,
  SettingsIcon,
} from "lucide-react";
import { NotFound } from "@/react/components/NotFound";
import { LinkButton } from "@/react/rac/button";
import { Card } from "@/react/rac/card";
import { cn } from "@/react/lib/utils";
import { Loading } from "@/react/rac/progress";
import { api } from "../../comp/api";
import { useAdminView } from "../lib/user";
import { isSuperAdminEmail } from "../lib/super-admin";
import {
  categoryLabel,
  formatTaskDate,
  formatTaskDateRange,
  scoringFormatLabel,
  todayInZone,
} from "../lib/format";
import { Disclosure } from "@/react/rac/disclosure";
import { NavList, NavRow } from "@/react/rac/nav-list";
import { Page, PageBar, type BarAction } from "@/react/rac/page-bar";
import { COMP_ANALYSIS_LABEL, compCrumbs, compPages } from "../lib/crumbs";
import {
  compUrlId,
  idFromSegment,
  compAnalysisPath,
  compCopyPath,
  compNewTaskPath,
  compPath,
  compPilotsPath,
  compScoresPath,
  compScoresPdfPath,
  compSettingsPath,
  compWaypointsPath,
  submitTrackPath,
  taskPath,
} from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { useSeededResource } from "../lib/use-seeded-resource";
import { SectionHeader } from "../components/SectionHeader";
import { ActivitySection } from "../comp/ActivitySection";
import { CompScoresSummary } from "../comp/CompScoresSummary";
import { CompSetupProgress } from "../comp/CompSetupProgress";
import { CompWrapUp } from "../comp/CompWrapUp";
import { TaskDiagram } from "../comp/TaskDiagram";
import {
  isPastCloseDate,
  type CompDetailData,
  type TaskSummary,
} from "../comp/types";
import { useInitialData } from "../lib/initial-data";
import { useMounted } from "../lib/use-mounted";
import type { CompDetailLoaderData, CompScores } from "../loaders";
import { LinkifiedText } from "../components/LinkifiedText";

export function CompDetail() {
  const { compId: compParam } = useParams<{ compId: string }>();
  // The route param may be a `${slug}-${id}` — the id is what the API needs.
  const compId = idFromSegment(compParam ?? "");
  const location = useLocation();
  // SSR seed: the server ran loadCompDetail for this URL, so render the comp in
  // the first paint and hydrate the same markup. Null on client boot / SPA nav.
  const initial = useInitialData<CompDetailLoaderData>();
  const { data: comp, notFound, current } = useSeededResource<CompDetailData>({
    ids: [compId],
    seed: initial?.comp ?? null,
    load: ([comp_id]) => api.api.comp[":comp_id"].$get({ param: { comp_id } }),
    title: (c) => `GlideComp - ${c.name}`,
  });

  // Settle the address bar on the canonical `${slug}-${id}` once the name loads
  // (for THIS id, not the one the page was on before).
  useCanonicalPath(comp && current ? compPath(compUrlId(comp, compId), comp.name) : null);

  // Deep links like /comp/:id#scores (the old /scores page redirects there):
  // scroll once the sections exist.
  useEffect(() => {
    if (!comp || !location.hash) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, [comp, location.hash]);

  const isAdmin = useAdminView(!!comp?.is_admin);
  // This page is server-rendered, so anything clock-dependent has to settle
  // after hydration rather than differ from the server's markup.
  const mounted = useMounted();

  if (notFound || !compId) {
    return <NotFound title="Competition not found" />;
  }

  // The SSR seed ("today" + scores), when the server rendered this URL.
  const seeded = initial;
  // As it goes in URLs: a hidden comp's share key rides along.
  const urlId = compUrlId(comp, compId);

  // The bar is there before the competition is, under a stand-in name, so
  // the page does not jump when it arrives — and the bar is never remounted,
  // which would drop the focus the router put on its <h1>.
  return (
    <Page
      width="wide"
      bar={
        <PageBar
          title={comp?.name ?? "Competition"}
          trail={compCrumbs()}
          related={compPages(urlId, comp, isAdmin)}
          actions={comp ? compActions(urlId, comp, isAdmin, mounted) : []}
        />
      }
    >
      {comp ? (
        <CompDetailView
          compId={compId}
          comp={comp}
          isAdmin={isAdmin}
          today={seeded?.today}
          initialScores={seeded?.scores ?? undefined}
          initialScoresEtag={seeded?.scoresEtag ?? undefined}
        />
      ) : (
        <Loading>Loading competition…</Loading>
      )}
    </Page>
  );
}

/**
 * The competition page's actions, under ⋯ (issue #863): the page is for
 * information, and every action goes in the bar.
 */
function compActions(
  urlId: string,
  comp: CompDetailData,
  isAdmin: boolean,
  mounted: boolean
): BarAction[] {
  const actions: BarAction[] = [];
  // Submitting is the one thing a pilot comes to a live comp to DO, so it
  // leads. It goes to /submit with the comp prefilled: from the comp page the
  // task is still an open question, and that page is where it is answered.
  // Mount-gated because the close date is read against the visitor's clock
  // and this page is server-rendered. Not for a hidden comp's link visitors:
  // the link is for reading a draft, and every write route refuses anyone but
  // its admins.
  if (mounted && !isPastCloseDate(comp.close_date) && (!comp.test || isAdmin)) {
    actions.push({
      id: "submit",
      icon: CloudUploadIcon,
      label: "Submit your track",
      to: submitTrackPath(urlId),
    });
  }
  // The results record is every task's scores: with no task there is nothing
  // to keep.
  if (comp.tasks.length > 0) {
    actions.push({
      id: "record",
      icon: FileTextIcon,
      label: "Download the results record (PDF)",
      to: compScoresPdfPath(urlId, comp.name),
      download: true,
      group: true,
    });
  }
  if (isAdmin) {
    actions.push(
      {
        id: "new-task",
        icon: PlusIcon,
        label: "New task",
        to: compNewTaskPath(urlId, comp.name),
        group: true,
      },
      {
        id: "copy",
        icon: CopyIcon,
        label: "Copy to a new competition…",
        to: compCopyPath(urlId, comp.name),
      },
      {
        id: "settings",
        icon: SettingsIcon,
        label: "Settings",
        to: compSettingsPath(urlId, comp.name),
      }
    );
  }
  return actions;
}

function CompDetailView({
  compId,
  comp,
  isAdmin,
  today,
  initialScores,
  initialScoresEtag,
}: {
  compId: string;
  comp: CompDetailData;
  isAdmin: boolean;
  /** SSR-computed "today" (comp tz) so the section order matches across
   *  hydration. Omitted on client navigations. */
  today?: string;
  /** SSR-seeded whole-comp scores + ETag (first render only). */
  initialScores?: CompScores;
  initialScoresEtag?: string | null;
}) {
  // As it goes in URLs: a hidden comp's share key rides along.
  const urlId = compUrlId(comp, compId);
  // Creating a task is a page of its own (#819), not a dialog over this one.
  const newTaskHref = compNewTaskPath(urlId, comp.name);

  // Credit the people who run THIS competition — real `comp_admin` rows,
  // never the site super admin (who can administer without organising).
  const organisers = comp.admins.filter((a) => !isSuperAdminEmail(a.email));

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
      {/* "New task" is in the bar's ⋯, with the page's other actions. */}
      <SectionHeader title="Tasks" />
      {/* Above the list so the row badges' "see Task warnings above" holds. */}
      <ClassWarnings warnings={comp.class_coverage_warnings} tasks={comp.tasks} />
      <TasksList
        tasks={comp.tasks}
        pilotClasses={comp.pilot_classes}
        compId={compId}
        compName={comp.name}
        isAdmin={isAdmin}
        newTaskHref={newTaskHref}
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

  return (
    <div>
      {/* The name is the bar's <h1>; what kind of competition it is leads
          the page. */}
      <div>
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{facts.join(" · ")}</p>
          {/* A hidden comp says so, and says who can see it. Its URL carries
              the share key (lib/slug.ts compUrlId), so the organiser's own
              address bar is the link to send; a visitor is told why they can
              see a competition nobody can find — and that it is not yet
              published, so a draft is never taken for official results. */}
          {comp.test ? (
            <p className="mt-1 flex items-start gap-1.5 text-sm text-muted-foreground">
              <EyeOffIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                {isAdmin
                  ? "Hidden. Anyone you send this page’s link to can see it."
                  : "Not yet published. You can see this competition because someone shared its link with you."}
              </span>
            </p>
          ) : null}
          {/* Organiser credit sits with the facts: who runs the day is a
              companion to what kind of day it is. The scores page's "Ask the
              comp admins" links to #admins here. Names are the mailto — no
              separate address, so the line stays one compact sentence. */}
          {organisers.length > 0 ? (
            <p id="admins" className="scroll-mt-24 text-sm text-muted-foreground">
              Organised by{" "}
              {organisers.map((admin, i) => (
                <Fragment key={admin.email}>
                  {i > 0
                    ? i === organisers.length - 1
                      ? " and "
                      : ", "
                    : null}
                  <a
                    className="text-foreground underline underline-offset-4"
                    href={`mailto:${admin.email}`}
                  >
                    {admin.name}
                  </a>
                </Fragment>
              ))}
            </p>
          ) : null}
          {/* The organiser's standing notes (migration 0037), edited in
              Settings → General. Plain text; line breaks kept. Absent on a
              payload cached before the column existed. */}
          {comp.organiser_notes?.trim() ? (
            <p
              className="mt-2 max-w-prose whitespace-pre-line text-sm"
              data-testid="organiser-notes"
            >
              <LinkifiedText text={comp.organiser_notes.trim()} />
            </p>
          ) : null}
        </div>
      </div>

      {/* The pages under this competition, as rows: the strip of section
          links that stuck under the old header is gone (issue #863, decision
          4), and its links are here and in the menu under the bar's title.
          Tasks and Activity are sections of this page, below. Real links, so
          they are in the server's HTML. Pilots is an organiser's page and
          appears once the user resolves; an open-distance competition has no
          legs to analyse. */}
      <nav aria-label="This competition" className="mt-4">
        <NavList label="This competition">
          <NavRow to={compScoresPath(urlId, comp.name)} label="Scores" />
          <NavRow
            to={compWaypointsPath(urlId, comp.name)}
            label="Waypoints"
            value={comp.waypoint_count}
          />
          {isAdmin ? (
            <NavRow
              to={compPilotsPath(urlId, comp.name)}
              label="Pilots"
              value={comp.pilot_count}
            />
          ) : null}
          {comp.scoring_format !== "open_distance" ? (
            <NavRow to={compAnalysisPath(urlId, comp.name)} label={COMP_ANALYSIS_LABEL} />
          ) : null}
        </NavList>
      </nav>

      {/* Admin-only, so absent from SSR markup and the first client paint —
          it pops in after auth resolves, like the organiser's rows of ⋯. */}
      {isAdmin ? (
        <CompSetupProgress
          compId={compId}
          comp={comp}
          newTaskHref={newTaskHref}
        />
      ) : null}
      {/* The other end of the same idea: after the close date, the next job
          is keeping the results record. Admin-only and client-only too. */}
      {isAdmin ? <CompWrapUp compId={compId} comp={comp} /> : null}

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
        <span className="text-caution">
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
          <li key={w.name} className="text-caution">
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
 * Each day is the kit's NavList — the grouped list a phone uses for its
 * settings, and the shape the comp settings index already has: the date is
 * the group's heading and every task under it is ONE row that is the link,
 * edge to edge and at least 44px tall. The rows used to be text links 32px
 * tall in a row twice that height, with the route glyph as a second target
 * beside them and the day's fold chevron as a third; on a phone a reader had
 * to aim at the words.
 *
 * It is NOT a RAC Tree, which was the first cut and fit badly: a `treegrid`
 * is one tab stop, so Tab skipped every task on the page, and its rows read
 * as data cells rather than as navigation. These are links with headings over
 * them, so each is in the tab order where a reader expects to find it. And a
 * day does not fold: every day was open anyway, and a control that hides two
 * rows costs more than scrolling past them.
 *
 * The route glyph is the row's picture, not a link of its own — enough to
 * tell one day's task from another's at a glance. The readable route is on
 * the task page the row opens, with every other action (submit, share,
 * replay, map).
 */
function TasksList({
  tasks,
  pilotClasses,
  compId,
  compName,
  isAdmin,
  newTaskHref,
}: {
  tasks: TaskSummary[];
  /** The comp's declared classes, in the order the organizers listed them —
   *  used to order the class rows within a day. */
  pilotClasses: string[];
  compId: string;
  compName: string;
  isAdmin: boolean;
  /** Where "New task" goes: the page that creates one. */
  newTaskHref: string;
}) {
  if (tasks.length === 0) {
    // Role-aware empty state: visitors get an explanation, admins also get
    // the section's CTA in the body (not just the header corner).
    return (
      <div className="mt-2 text-muted-foreground">
        <p>The organisers haven't published any tasks yet.</p>
        {isAdmin ? (
          <LinkButton variant="outline" size="sm" className="mt-3" href={newTaskHref}>
            New task
          </LinkButton>
        ) : null}
      </div>
    );
  }

  const days = groupTasksByDateAndClass(tasks, pilotClasses);
  // The glyph column is reserved only when some task has a route to draw. A
  // task without one then keeps an empty frame, so the names still line up;
  // a comp with no routes at all (or a comp-api that predates the `route`
  // field) gets no column, which would otherwise be dead space on every row.
  const showGlyphs = tasks.some((task) => task.route);

  return (
    <div className="flex flex-col gap-5">
      {days.map((day) => (
        <NavList key={day.date} label={formatTaskDate(day.date)} labelAs="h3">
          {day.rows.map((row) => (
            <NavRow
              key={row.key}
              to={taskPath(compId, compName, row.task.task_id, row.task.name)}
              label={row.task.name}
              icon={showGlyphs ? <TaskGlyph task={row.task} /> : undefined}
              description={taskRowFacts(row)}
            />
          ))}
        </NavList>
      ))}
    </div>
  );
}

/**
 * The route, as the row's picture. Decorative: the row's link already names
 * the task, and at this size the shape is all the drawing can carry.
 */
function TaskGlyph({ task }: { task: TaskSummary }) {
  return (
    // `text-foreground`: the row's icon slot is muted, which suits an icon and
    // would grey out a drawing whose lines are already hairlines.
    <span className="flex h-11 w-14 items-center justify-center text-foreground">
      {task.route ? (
        <TaskDiagram task={task.route} size="xs" label={null} className="h-auto w-full" />
      ) : (
        <span className="size-full rounded-md border border-dashed" />
      )}
    </span>
  );
}

const taskBadgeClass =
  "ml-1.5 inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium";

/** The row's second line: the class, then anything the task's setup lacks. */
function taskRowFacts(row: TaskClassRow) {
  const { task, pilotClass } = row;
  const facts = [pilotClass, task.has_xctsk ? null : "Route not set yet"].filter(
    (fact): fact is string => fact != null
  );
  const badged = task.missing_sss || task.missing_ess || task.line_goal;
  if (facts.length === 0 && !badged) return null;
  return (
    <>
      {facts.join(" · ")}
      {task.missing_sss ? (
        <span
          className={cn(taskBadgeClass, "bg-warning/10 text-caution")}
          title="Scoring falls back — see Task warnings above"
        >
          No SSS
        </span>
      ) : null}
      {task.missing_ess ? (
        <span
          className={cn(taskBadgeClass, "bg-warning/10 text-caution")}
          title="Scoring falls back — see Task warnings above"
        >
          No ESS
        </span>
      ) : null}
      {task.line_goal ? (
        <span
          className={cn(taskBadgeClass, "bg-primary/10 text-link")}
          title="This task ends at a goal line perpendicular to the final leg"
        >
          Goal line
        </span>
      ) : null}
    </>
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
