/**
 * Competition detail page — the comp "hub" (IA v2 #277): a pilot bookmarks
 * this one URL and every job is served here or one click away. Today's-task
 * hero first, then tasks, inline competition scores, pilots, activity,
 * admins. Mutations that used to window.location.reload() instead bump a
 * refresh counter that re-runs the comp fetch.
 */
import { Fragment, useEffect, useId, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { Button } from "@/react/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/react/ui/dialog";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/react/ui/field";
import { Input } from "@/react/ui/input";
import { api } from "../../comp/api";
import { toast } from "../lib/toast";
import { signInWithGoogle, useAdminView, useUser } from "../lib/user";
import {
  categoryLabel,
  formatTaskDate,
  formatTaskDateRange,
  scoringFormatLabel,
} from "../lib/format";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { SectionHeader } from "../components/SectionHeader";
import { ActivitySection } from "../comp/ActivitySection";
import { CompScoresSection } from "../comp/CompScoresSection";
import { CompSetupProgress } from "../comp/CompSetupProgress";
import { PilotsSection } from "../comp/PilotsSection";
import { SettingsDialog } from "../comp/SettingsDialog";
import { CheckboxField } from "../comp/fields";
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

  return (
    <div>
      <Breadcrumbs items={[{ label: "Competitions", to: "/comp" }]} />

      <div className="mt-2 flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold">{comp.name}</h1>
          <p className="text-sm text-muted-foreground">
            {facts.join(" · ")}
            {comp.test ? " · Test" : null}
          </p>
        </div>
        {isAdmin ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setSettingsOpen(true)}
          >
            Settings
          </Button>
        ) : null}
      </div>

      {/* Counts double as honest signage: "Tasks (0)" says don't bother
          scrolling; on a populated comp they're at-a-glance facts. Scores and
          Activity stay uncounted (no cheap or meaningful number). */}
      <nav
        aria-label="Sections"
        className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground"
      >
        <a href="#tasks" className="hover:text-foreground hover:underline underline-offset-4">Tasks ({comp.tasks.length})</a>
        <a href="#scores" className="hover:text-foreground hover:underline underline-offset-4">Scores</a>
        <a href="#pilots" className="hover:text-foreground hover:underline underline-offset-4">Pilots ({comp.pilot_count})</a>
        <Link to={`/comp/${compId}/waypoints`} className="hover:text-foreground hover:underline underline-offset-4">Waypoints ({comp.waypoint_count})</Link>
        <a href="#activity" className="hover:text-foreground hover:underline underline-offset-4">Activity</a>
        <a href="#admins" className="hover:text-foreground hover:underline underline-offset-4">Admins ({comp.admins.length})</a>
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

      <ClassWarnings warnings={comp.class_coverage_warnings} tasks={comp.tasks} />

      {hero ? (
        <TaskHero
          hero={hero}
          compId={compId}
          canSubmitTrack={canSubmitTrack}
          canUploadOnBehalf={canUploadOnBehalf}
          signedOut={!user && !loading}
          isAdmin={isAdmin}
        />
      ) : null}

      {/* break-before-page: when printing, each major section starts a fresh page. */}
      <section id="tasks" className="scroll-mt-4 break-before-page">
        <SectionHeader
          title="Tasks"
          action={
            isAdmin ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setCreateOpen(true)}
              >
                New Task
              </Button>
            ) : null
          }
        />
        <TasksList
          tasks={comp.tasks}
          compId={compId}
          canSubmitTrack={canSubmitTrack}
          canUploadOnBehalf={canUploadOnBehalf}
          isAdmin={isAdmin}
          onCreateTask={() => setCreateOpen(true)}
        />
      </section>

      <CompScoresSection
        compId={compId}
        timezone={comp.timezone}
        tasks={comp.tasks}
        defaultTaskId={hero?.tasks.find((t) => t.has_xctsk)?.task_id ?? null}
        initialScores={initialScores}
        initialScoresEtag={initialScoresEtag}
        isAdmin={isAdmin}
      />

      <div id="pilots" className="scroll-mt-4 break-before-page">
        <PilotsSection
          compId={compId}
          compName={comp.name}
          compClasses={comp.pilot_classes}
          isAdmin={isAdmin}
          onPilotsChanged={() => setRefresh((n) => n + 1)}
        />
      </div>

      <div id="activity" className="scroll-mt-4 break-before-page">
        <ActivitySection compId={compId} />
      </div>

      <section id="admins" className="scroll-mt-4 break-before-page">
        <h2 className="mt-8 text-lg font-bold">Admins</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {comp.admins.map((admin) => (
            <li key={admin.email}>
              {admin.name} <span className="text-muted-foreground">({admin.email})</span>
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
 * Hero button order is role-based (issue: task buttons role order):
 *  - Comp/Super Admin: Edit route…, Task details, Submit track, Share task, QR code, 3D replay
 *  - Pilots (signed in, non-admin): QR code, Share task, Submit track, Task details, 3D replay
 *  - Unauthenticated / can't submit: QR code, Share task, Task details, 3D replay
 * Whichever button ends up first is the primary (filled) button; a slot that's
 * hidden for this task (e.g. no route set yet) is skipped, promoting the next one.
 */
interface HeroSlot {
  key: string;
  visible: boolean;
  render: (primary: boolean) => React.ReactNode;
}

function TaskHero({
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
    <div className="mt-6 rounded-xl border bg-gradient-to-br from-muted to-card p-5">
      <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        {hero.label} · {formatTaskDate(hero.date)}
      </p>
      {hero.tasks.map((task) => {
        const taskDetailsSlot: HeroSlot = {
          key: "task-details",
          visible: true,
          render: (primary) => (
            <Button
              nativeButton={false}
              variant={primary ? "default" : "outline"}
              size="sm"
              render={<Link to={`/comp/${compId}/task/${task.task_id}`} />}
            >
              Task details
            </Button>
          ),
        };
        const editRouteSlot: HeroSlot = {
          key: "edit-route",
          visible: isAdmin,
          render: (primary) => (
            <Button
              nativeButton={false}
              variant={primary ? "default" : "ghost"}
              size="sm"
              render={<Link to={`/comp/${compId}/task/${task.task_id}#edit-route`} />}
            >
              Edit route…
            </Button>
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
        const exportSlot = (qrFirst: boolean): HeroSlot => ({
          key: "export",
          visible: task.has_xctsk,
          render: (primary) => (
            <TaskExportButtons
              compId={compId}
              taskId={task.task_id}
              taskName={task.name}
              qrFirst={qrFirst}
              primary={primary ? (qrFirst ? "qr" : "share") : undefined}
            />
          ),
        });
        const replaySlot: HeroSlot = {
          key: "replay",
          visible: true,
          render: (primary) => (
            <Button
              nativeButton={false}
              variant={primary ? "default" : "outline"}
              size="sm"
              render={
                <a
                  href={`/replay?comp=${encodeURIComponent(compId)}&task=${encodeURIComponent(task.task_id)}`}
                  title="Open the 3D flight replay for this task"
                />
              }
            >
              3D replay
            </Button>
          ),
        };
        const signInSlot: HeroSlot = {
          key: "sign-in",
          visible: signedOut,
          render: () => (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void signInWithGoogle()}
            >
              Sign in to submit your track
            </Button>
          ),
        };

        const slots: HeroSlot[] = isAdmin
          ? [editRouteSlot, taskDetailsSlot, submitTrackSlot, exportSlot(false), replaySlot]
          : canSubmitTrack
            ? [exportSlot(true), submitTrackSlot, taskDetailsSlot, replaySlot]
            : [exportSlot(true), taskDetailsSlot, replaySlot, signInSlot];

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
            <h2 className="text-xl font-bold">
              {task.name}{" "}
              <span className="text-sm font-normal text-muted-foreground">
                {task.pilot_classes.join(", ")}
                {!task.has_xctsk ? " · route not set yet" : null}
              </span>
            </h2>
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
  // LINE goals aren't implemented by scoring at all (issue #330) — they
  // silently score as cylinders, so that also warrants a warning.
  const setupWarnings = tasks
    .map((t) => {
      const parts: string[] = [];
      if (t.missing_sss) {
        parts.push("no Start (SSS) turnpoint — scoring treats the first turnpoint as the start");
      }
      if (t.missing_ess) {
        parts.push("no ESS turnpoint — the speed section ends at goal");
      }
      if (t.line_goal) {
        parts.push(
          "goal line is not supported by scoring yet — the goal is scored as a cylinder, so distances and arrival times may be off by up to the goal radius"
        );
      }
      return parts.length > 0 ? { name: t.name, text: parts.join("; ") } : null;
    })
    .filter((w): w is { name: string; text: string } => w !== null);

  if (warnings.length === 0 && setupWarnings.length === 0) return null;
  return (
    <section>
      <h2 className="mt-8 text-lg font-bold">Task Warnings</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
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
    </section>
  );
}

function TasksList({
  tasks,
  compId,
  canSubmitTrack,
  canUploadOnBehalf,
  isAdmin,
  onCreateTask,
}: {
  tasks: TaskSummary[];
  compId: string;
  canSubmitTrack: boolean;
  canUploadOnBehalf: boolean;
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={onCreateTask}
          >
            New Task
          </Button>
        ) : null}
      </div>
    );
  }

  // Group tasks by date (insertion order preserved, as in the vanilla page)
  const byDate = new Map<string, TaskSummary[]>();
  for (const task of tasks) {
    const list = byDate.get(task.task_date) ?? [];
    list.push(task);
    byDate.set(task.task_date, list);
  }

  return (
    <div className="mt-3 space-y-5">
      {[...byDate.entries()].map(([date, dateTasks]) => (
        <div key={date}>
          {/* Same label treatment as the hero: the date is a group heading,
              the indented rows underneath are the tasks. */}
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
                  <span className="text-muted-foreground">
                    {task.has_xctsk ? "Task set" : "No task"}
                  </span>{" "}
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
                      className="inline-flex items-center rounded-md bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-500"
                      title="Goal lines aren't scored yet — see Task Warnings above"
                    >
                      Goal line
                    </span>
                  ) : null}{" "}
                  <span className="text-muted-foreground">
                    {task.pilot_classes.join(", ")}
                  </span>
                </Link>{" "}
                {canSubmitTrack ? (
                  <SubmitTrackButton
                    compId={compId}
                    taskId={task.task_id}
                    canUploadOnBehalf={canUploadOnBehalf}
                  />
                ) : null}{" "}
                <a
                  className="underline underline-offset-4"
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
        type="button"
        variant={primary ? "default" : "outline"}
        size="sm"
        onClick={() => setOpen(true)}
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
  const nameId = useId();
  const dateId = useId();
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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Task</DialogTitle>
        </DialogHeader>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor={nameId}>Name</FieldLabel>
            <Input
              id={nameId}
              required
              maxLength={128}
              autoFocus
              placeholder="e.g. Day 1 - Ridge Run"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={dateId}>Date</FieldLabel>
            <Input
              id={dateId}
              type="date"
              required
              value={taskDate}
              onChange={(e) => setTaskDate(e.target.value)}
            />
          </Field>
          <FieldSet>
            <FieldLegend variant="label">Pilot Classes</FieldLegend>
            {pilotClasses.map((cls) => (
              <CheckboxField
                key={cls}
                checked={selectedClasses.includes(cls)}
                onChange={(checked) => toggleClass(cls, checked)}
                label={cls}
              />
            ))}
          </FieldSet>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
