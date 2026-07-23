/**
 * Competition detail page — the comp "hub" (IA v2 #277): a pilot bookmarks
 * this one URL and every job is served here or one click away. Today's-task
 * hero first, then tasks, inline competition scores, pilots, activity,
 * admins. Mutations that used to window.location.reload() instead bump a
 * refresh counter that re-runs the comp fetch.
 *
 * Built on the RAC kit (src/react/rac/) like the task detail page — the
 * pilots editor keeps its Tabulator grid (see PilotsSection).
 */
import { Fragment, useEffect, useId, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { Form } from "react-aria-components";
import { Button, LinkButton } from "@/react/rac/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Modal,
} from "@/react/rac/dialog";
import { TextField, Label } from "@/react/rac/field";
import { Checkbox, CheckboxGroup } from "@/react/rac/checkbox";
import { RacConfirmProvider } from "@/react/rac/confirm";
import { DatePicker } from "@/react/ui/date-picker";
import { api } from "../../comp/api";
import { toast } from "../lib/toast";
import { goToSignIn, useAdminView, useUser } from "../lib/user";
import {
  categoryLabel,
  formatTaskDate,
  formatTaskDateRange,
  scoringFormatLabel,
} from "../lib/format";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Disclosure } from "@/react/rac/disclosure";
import { compCrumbs } from "../lib/crumbs";
import { SectionHeader } from "../components/SectionHeader";
import { ActivitySection } from "../comp/ActivitySection";
import { CompScoresSummary } from "../comp/CompScoresSummary";
import { CompSetupProgress } from "../comp/CompSetupProgress";
import { SettingsDialog } from "../comp/SettingsDialog";
import { TaskExportButtons } from "../comp/TaskExportButtons";
import { SubmitTrackDialog, useCanUploadOnBehalf } from "../comp/SubmitTrackDialog";
import {
  fetchWithRetry,
  isPastCloseDate,
  type CompDetailData,
  type TaskSummary,
} from "../comp/types";
import { useInitialData } from "../lib/initial-data";
import type { CompDetailLoaderData, CompScores } from "../loaders";

export function CompDetail() {
  return (
    <RacConfirmProvider>
      <CompDetailContent />
    </RacConfirmProvider>
  );
}

function CompDetailContent() {
  const { compId } = useParams<{ compId: string }>();
  const { user, loading } = useUser();
  const location = useLocation();
  // SSR seed: the server ran loadCompDetail for this URL, so render the comp in
  // the first paint and hydrate the same markup. Null on client boot / SPA nav.
  const initial = useInitialData<CompDetailLoaderData>();
  const [comp, setComp] = useState<CompDetailData | null>(initial?.comp ?? null);
  const [notFound, setNotFound] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Deep links like /comp/:id#scores (the old /scores page redirects there):
  // scroll once the sections exist.
  useEffect(() => {
    if (!comp || !location.hash) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, [comp, location.hash]);

  useEffect(() => {
    if (!compId) {
      setNotFound(true);
      return;
    }
    // Seeded from SSR on the first render — set the title and skip the fetch.
    // A mutation bumps `refresh`, which re-runs this and fetches fresh data.
    if (initial && refresh === 0) {
      document.title = `GlideComp - ${initial.comp.name}`;
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
        <Link className="underline underline-offset-4" to="/comp">
          Back to Competitions
        </Link>
      </div>
    );
  }

  if (!comp) {
    return (
      <p role="status" aria-label="Loading competition" className="text-muted-foreground">
        Loading competition…
      </p>
    );
  }

  // The SSR seed (hero "today" + scores) applies only to the first, un-mutated
  // render; after a refresh the sections fetch fresh data themselves.
  const seeded = initial && refresh === 0 ? initial : null;

  return (
    <CompDetailView
      compId={compId}
      comp={comp}
      user={user}
      loading={loading}
      createOpen={createOpen}
      setCreateOpen={setCreateOpen}
      settingsOpen={settingsOpen}
      setSettingsOpen={setSettingsOpen}
      setRefresh={setRefresh}
      heroToday={seeded?.today}
      initialScores={seeded?.scores ?? undefined}
      initialScoresEtag={seeded?.scoresEtag ?? undefined}
    />
  );
}

function CompDetailView({
  compId,
  comp,
  user,
  loading,
  createOpen,
  setCreateOpen,
  settingsOpen,
  setSettingsOpen,
  setRefresh,
  heroToday,
  initialScores,
  initialScoresEtag,
}: {
  compId: string;
  comp: CompDetailData;
  user: ReturnType<typeof useUser>["user"];
  loading: boolean;
  createOpen: boolean;
  setCreateOpen: (open: boolean) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  setRefresh: React.Dispatch<React.SetStateAction<number>>;
  /** SSR-computed "today" (comp tz) so the hero pick matches across hydration. */
  heroToday?: string;
  /** SSR-seeded whole-comp scores + ETag (first render only). */
  initialScores?: CompScores;
  initialScoresEtag?: string | null;
}) {
  const isAdmin = useAdminView(
    user != null && comp.admins.some((a) => a.email === user.email)
  );
  const compClosed = isPastCloseDate(comp.close_date);
  const canSubmitTrack = user != null && !compClosed;
  const canUploadOnBehalf = useCanUploadOnBehalf(compId, comp.open_igc_upload, isAdmin);

  const facts = [
    categoryLabel(comp.category),
    scoringFormatLabel(comp.scoring_format),
    comp.pilot_classes.join(", "),
  ];
  const taskDates = comp.tasks.map((t) => t.task_date).sort();
  if (taskDates.length > 0) {
    facts.push(formatTaskDateRange(taskDates[0], taskDates[taskDates.length - 1]));
  }

  const hero = pickHeroTasks(comp.tasks, comp.timezone, heroToday);
  // Once the last task date is behind us the visitor's job flips from "what
  // am I flying today?" to "who won?" — standings lead, tasks follow.
  // Derived from the loader-injected "today", so SSR and hydration agree.
  const finished = hero?.label === "Latest task";

  const tasksSection = (
    // break-before-page: when printing, each major section starts a fresh page.
    <section id="tasks" className="scroll-mt-24 break-before-page">
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
        hero={hero}
        compId={compId}
        canSubmitTrack={canSubmitTrack}
        canUploadOnBehalf={canUploadOnBehalf}
        signedOut={!user && !loading}
        isAdmin={isAdmin}
        onCreateTask={() => setCreateOpen(true)}
      />
    </section>
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
      <Breadcrumbs items={compCrumbs()} current={comp.name} />

      <div className="mt-2 flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold">{comp.name}</h1>
          <p className="text-sm text-muted-foreground">
            {facts.join(" · ")}
            {comp.test ? " · Hidden" : null}
          </p>
        </div>
        {isAdmin ? (
          <Button variant="outline" size="sm" onPress={() => setSettingsOpen(true)}>
            Settings
          </Button>
        ) : null}
      </div>

      {/* Counts double as honest signage: "Tasks (0)" says don't bother
          scrolling; on a populated comp they're at-a-glance facts. Sticky so
          the page's map survives scrolling into the long sections; sits under
          the (sticky) app header on sm+, at the very top where the header is
          static (phones, short landscape). */}
      <nav
        aria-label="Sections"
        className="sticky top-0 z-30 -mx-4 mt-3 flex flex-wrap gap-x-4 gap-y-1 border-b bg-background/90 px-4 py-2 text-sm text-muted-foreground backdrop-blur-sm sm:top-[61px] [@media(max-height:500px)]:static print:hidden"
      >
        <a href="#tasks" className="hover:text-foreground hover:underline underline-offset-4">Tasks ({comp.tasks.length})</a>
        <Link to={`/comp/${compId}/scores`} className="hover:text-foreground hover:underline underline-offset-4">Scores</Link>
        <Link to={`/comp/${compId}/waypoints`} className="hover:text-foreground hover:underline underline-offset-4">Waypoints ({comp.waypoint_count})</Link>
        {/* Pilot management moved to its own admin page — visitors find every
            pilot in the scores, so the roster link is admin-only. */}
        {isAdmin ? (
          <Link to={`/comp/${compId}/pilots`} className="hover:text-foreground hover:underline underline-offset-4">Pilots ({comp.pilot_count})</Link>
        ) : null}
        {/* Field analysis is admin-only while the metrics are being validated,
            and has nothing to measure on an open-distance comp (no legs, no
            speed section). Its own page — it's a long exploratory read. */}
        {isAdmin && comp.scoring_format !== "open_distance" ? (
          <Link to={`/comp/${compId}/analysis`} className="hover:text-foreground hover:underline underline-offset-4">Field analysis</Link>
        ) : null}
        <a href="#activity" className="hover:text-foreground hover:underline underline-offset-4">Activity</a>
      </nav>

      {/* Admin-only, so absent from SSR markup and the first client paint —
          it pops in after auth resolves, like the Settings button. */}
      {isAdmin ? (
        <CompSetupProgress
          compId={compId}
          comp={comp}
          onOpenSettings={() => setSettingsOpen(true)}
          onCreateTask={() => setCreateOpen(true)}
        />
      ) : null}

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

      <div id="activity" className="scroll-mt-24 break-before-page">
        <ActivitySection compId={compId} collapsible />
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

interface HeroPick {
  label: string;
  date: string;
  tasks: TaskSummary[];
}

/**
 * The hero shows the task a pilot needs *right now*: today's task in the
 * comp's timezone, else the next upcoming one, else the most recent. A day
 * can hold several tasks (classes flying different tasks) — show them all.
 */
function pickHeroTasks(
  tasks: TaskSummary[],
  timezone: string | null,
  /** SSR-computed "today" (comp tz); pass through so the hero pick is identical
   *  server- and client-side on hydration. Omitted on client navigations. */
  injectedToday?: string
): HeroPick | null {
  if (tasks.length === 0) return null;
  // en-CA formats as YYYY-MM-DD, matching task_date.
  let today: string;
  if (injectedToday) {
    today = injectedToday;
  } else {
    try {
      today = new Intl.DateTimeFormat("en-CA", {
        ...(timezone ? { timeZone: timezone } : {}),
      }).format(new Date());
    } catch {
      today = new Intl.DateTimeFormat("en-CA").format(new Date());
    }
  }
  const dates = [...new Set(tasks.map((t) => t.task_date))].sort();
  const date = dates.includes(today)
    ? today
    : (dates.find((d) => d > today) ?? dates[dates.length - 1]);
  const label =
    date === today ? "Today's task" : date > today ? "Next task" : "Latest task";
  return { label, date, tasks: tasks.filter((t) => t.task_date === date) };
}

/**
 * Featured card button order is role-based, with ONE primary action and the
 * share/QR/download cluster folded into a single Share menu:
 *  - Comp/Super Admin: Edit route…, Task details, Submit track, Share ▾
 *  - Pilots (signed in, non-admin): Submit track, Task details, Share ▾
 *  - Unauthenticated / can't submit: Task details, Share ▾, Sign in
 * Whichever button ends up first is the primary (filled) button; a slot that's
 * hidden for this task (e.g. no route set yet) is skipped, promoting the next
 * one. Everything else (3D replay, map, per-pilot actions) lives one click
 * away on the task page — the hub stays scannable.
 */
interface HeroSlot {
  key: string;
  visible: boolean;
  render: (primary: boolean) => React.ReactNode;
}

function FeaturedTaskGroup({
  hero,
  compId,
  canSubmitTrack,
  canUploadOnBehalf,
  signedOut,
  isAdmin,
}: {
  hero: HeroPick;
  compId: string;
  canSubmitTrack: boolean;
  canUploadOnBehalf: boolean;
  signedOut: boolean;
  isAdmin: boolean;
}) {
  return (
    <div className="rounded-xl border bg-gradient-to-br from-muted to-card p-5">
      <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        {hero.label} · {formatTaskDate(hero.date)}
      </p>
      {hero.tasks.map((task) => {
        const taskDetailsSlot: HeroSlot = {
          key: "task-details",
          visible: true,
          render: (primary) => (
            <LinkButton
              variant={primary ? "default" : "outline"}
              size="sm"
              href={`/comp/${compId}/task/${task.task_id}`}
            >
              Task details
            </LinkButton>
          ),
        };
        const editRouteSlot: HeroSlot = {
          key: "edit-route",
          visible: isAdmin,
          render: (primary) => (
            <LinkButton
              variant={primary ? "default" : "ghost"}
              size="sm"
              href={`/comp/${compId}/task/${task.task_id}#edit-route`}
            >
              Edit route…
            </LinkButton>
          ),
        };
        const submitTrackSlot: HeroSlot = {
          key: "submit-track",
          visible: canSubmitTrack,
          render: (primary) => (
            <SubmitTrackButton
              compId={compId}
              taskId={task.task_id}
              canUploadOnBehalf={canUploadOnBehalf}
              primary={primary}
            />
          ),
        };
        const shareSlot: HeroSlot = {
          key: "share",
          visible: task.has_xctsk,
          render: () => (
            <TaskExportButtons
              compId={compId}
              taskId={task.task_id}
              taskName={task.name}
              asMenu
            />
          ),
        };
        const signInSlot: HeroSlot = {
          key: "sign-in",
          visible: signedOut,
          render: () => (
            <Button
              variant="outline"
              size="sm"
              onPress={() => goToSignIn(window.location.pathname)}
            >
              Sign in to submit your track
            </Button>
          ),
        };

        const slots: HeroSlot[] = isAdmin
          ? [editRouteSlot, taskDetailsSlot, submitTrackSlot, shareSlot]
          : canSubmitTrack
            ? [submitTrackSlot, taskDetailsSlot, shareSlot]
            : [taskDetailsSlot, shareSlot, signInSlot];

        let primaryAssigned = false;
        const buttons = slots
          .filter((slot) => slot.visible)
          .map((slot) => {
            const primary = !primaryAssigned;
            primaryAssigned = true;
            return <Fragment key={slot.key}>{slot.render(primary)}</Fragment>;
          });

        return (
          <div key={task.task_id} className="mt-2 first:mt-1">
            <h3 className="text-xl font-bold">
              <Link
                className="underline-offset-4 hover:underline"
                to={`/comp/${compId}/task/${task.task_id}`}
              >
                {task.name}
              </Link>{" "}
              <span className="text-sm font-normal text-muted-foreground">
                {task.pilot_classes.join(", ")}
                {!task.has_xctsk ? " · route not set yet" : null}
              </span>
            </h3>
            <div className="mt-3 flex flex-wrap gap-2">{buttons}</div>
          </div>
        );
      })}
    </div>
  );
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
 * The task list, newest date first, with the hero date's group rendered as
 * the featured card IN PLACE — one list, no duplicate presentation of the
 * same task (the old page showed the hero tasks twice). Compact rows carry
 * only the link, setup badges and classes; every action (submit, share,
 * replay, map) lives on the task page or, for the featured group, on the
 * card itself.
 */
function TasksList({
  tasks,
  hero,
  compId,
  canSubmitTrack,
  canUploadOnBehalf,
  signedOut,
  isAdmin,
  onCreateTask,
}: {
  tasks: TaskSummary[];
  hero: HeroPick | null;
  compId: string;
  canSubmitTrack: boolean;
  canUploadOnBehalf: boolean;
  signedOut: boolean;
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

  const byDate = new Map<string, TaskSummary[]>();
  for (const task of tasks) {
    const list = byDate.get(task.task_date) ?? [];
    list.push(task);
    byDate.set(task.task_date, list);
  }
  // Newest first: the current/latest task is what a visitor came for, and the
  // featured (hero) date lands at or near the top of the list.
  const groups = [...byDate.entries()].sort(([a], [b]) => (a < b ? 1 : -1));

  return (
    <div className="mt-3 space-y-5">
      {groups.map(([date, dateTasks]) =>
        hero && date === hero.date ? (
          <FeaturedTaskGroup
            key={date}
            hero={hero}
            compId={compId}
            canSubmitTrack={canSubmitTrack}
            canUploadOnBehalf={canUploadOnBehalf}
            signedOut={signedOut}
            isAdmin={isAdmin}
          />
        ) : (
          <div key={date}>
            {/* Same label treatment as the featured card: the date is a group
                heading, the indented rows underneath are the tasks. */}
            <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              {formatTaskDate(date)}
            </h3>
            <ul className="mt-1.5 space-y-1.5 pl-4 text-sm">
              {dateTasks.map((task) => (
                <li key={task.task_id} className="flex flex-wrap items-center gap-2">
                  <Link
                    className="underline-offset-4 hover:underline"
                    to={`/comp/${compId}/task/${task.task_id}`}
                  >
                    <strong>{task.name}</strong>{" "}
                    {!task.has_xctsk ? (
                      <span className="text-muted-foreground">Route not set yet</span>
                    ) : null}{" "}
                    {task.missing_sss ? (
                      <span
                        className="inline-flex items-center rounded-md bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-500"
                        title="Scoring falls back — see Task Warnings above"
                      >
                        No SSS
                      </span>
                    ) : null}{" "}
                    {task.missing_ess ? (
                      <span
                        className="inline-flex items-center rounded-md bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-500"
                        title="Scoring falls back — see Task Warnings above"
                      >
                        No ESS
                      </span>
                    ) : null}{" "}
                    {task.line_goal ? (
                      <span
                        className="inline-flex items-center rounded-md bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary"
                        title="This task ends at a goal line perpendicular to the final leg"
                      >
                        Goal line
                      </span>
                    ) : null}{" "}
                    <span className="text-muted-foreground">
                      {task.pilot_classes.join(", ")}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )
      )}
    </div>
  );
}

/**
 * "Submit track" button (hero + task list) — opens the same SubmitTrackDialog
 * the task page uses, so submitting always shows who the track is for.
 */
function SubmitTrackButton({
  compId,
  taskId,
  canUploadOnBehalf,
  primary = false,
}: {
  compId: string;
  taskId: string;
  canUploadOnBehalf: boolean;
  /** Render as the primary action (role-based button order). */
  primary?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant={primary ? "default" : "outline"}
        size="sm"
        onPress={() => setOpen(true)}
      >
        Submit track
      </Button>
      {open ? (
        <SubmitTrackDialog
          compId={compId}
          taskId={taskId}
          canUploadOnBehalf={canUploadOnBehalf}
          onClose={() => setOpen(false)}
          onUploaded={() => {}}
        />
      ) : null}
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
