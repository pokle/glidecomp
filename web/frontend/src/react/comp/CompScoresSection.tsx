/**
 * Whole-competition scores machinery, shared by the dedicated scores page
 * (pages/CompScoresPage — the canonical scores surface) and the comp hub's
 * compact scores summary (CompScoresSummary): the SSR-seedable fetch +
 * rescore state machine (useCompScores) and the score views (per-class
 * scores, top-3, teams, scores-by-task: useScoresViews). View transforms (class rollups,
 * top-3, teams) come from the shared scores-views module; the "Scores by
 * task" tab reuses the task page's ScoresSection one task at a time. Built on
 * the RAC kit: the view tabs are ARIA tabs, and each view is a LIST whose
 * whole rows are the links (comp/score-rows.tsx) — never a table of small
 * links that scrolls sideways on a phone.
 */
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import type { Key } from "react-aria-components";
import { Select, SelectItem } from "@/react/rac/select";
import { TabList, Tab, TabPanel } from "@/react/rac/tabs";
import { Explain } from "@/react/rac/explain";
import { cn } from "@/react/lib/utils";
import {
  aggregateTeams,
  buildClassGroups,
  computeTop3Rows,
  type CompClassScore,
  type CompTeamScore,
  type TaskInfo,
} from "../../scores-views";
import { ScoresSection } from "./ScoresSection";
import { ClassPicker } from "../analysis/ClassPicker";
import { toast } from "../lib/toast";
import { useAction, type ActionState } from "@/react/rac/form";
import { formatTaskDate, ordinal } from "../lib/format";
import { compPilotScoresPath, pilotPath } from "../lib/slug";
import { CompNameProvider } from "./comp-name-context";
import {
  Points,
  ScoreLinkRow,
  ScoreList,
  ScoreStaticRow,
  TaskColumn,
  TaskColumnsHeader,
  columnsShownClass,
  detailHiddenClass,
  taskColumnsAt,
} from "./score-rows";
import type { TaskSummary } from "./types";
// Single source of truth for the /scores response shape, shared with the loader.
import type { CompScores } from "../loaders";

export type CompScoresState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "ready"; scores: CompScores; etag: string | null };

/**
 * Whole-comp scores state machine: one fetch per compId (skipped when seeded
 * from SSR), plus the admin "Recompute scores" action. Shared by the dedicated
 * scores page (pages/CompScores) and the comp page's scores summary.
 */
export function useCompScores(
  compId: string,
  initialScores?: CompScores,
  initialScoresEtag?: string | null
): {
  state: CompScoresState;
  /** The rescore press: busy, and its refusal for an ActionErrorBanner. */
  rescoring: ActionState;
  rescore: () => Promise<void>;
} {
  const [state, setState] = useState<CompScoresState>(
    initialScores
      ? { kind: "ready", scores: initialScores, etag: initialScoresEtag ?? null }
      : { kind: "loading" }
  );
  // Freshness is handled by ScoreFreshness's polling, so — like before — we
  // fetch once per compId. When seeded from SSR, that first fetch is already
  // satisfied; skip it so the first render stays identical to the server.
  const seededRef = useRef(initialScores != null);
  const rescoring = useAction();

  useEffect(() => {
    if (seededRef.current) {
      seededRef.current = false;
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/comp/${encodeURIComponent(compId)}/scores`, {
          credentials: "include",
        });
        if (cancelled) return;
        if (!res.ok) {
          setState({ kind: "unavailable" });
          return;
        }
        const scores = (await res.json()) as CompScores;
        if (cancelled) return;
        setState({ kind: "ready", scores, etag: res.headers.get("ETag") });
      } catch {
        if (!cancelled) setState({ kind: "unavailable" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compId]);

  /**
   * Admin "Recompute scores" action (issue #343). POSTs the rescore trigger,
   * then re-reads /scores so the now-stale body + ETag flow into
   * ScoreFreshness, which polls and surfaces the "re-scoring… / finished"
   * notice — giving the explicit rescore affordance Tom asked for.
   */
  async function rescore() {
    // The scores are re-read inside the action, so the button stays busy
    // until the now-stale body is showing.
    const res = await rescoring.run(
      async () => {
        const res = await fetch(`/api/comp/${encodeURIComponent(compId)}/rescore`, {
          method: "POST",
          credentials: "include",
        });
        if (!res.ok) return res;
        const refreshed = await fetch(`/api/comp/${encodeURIComponent(compId)}/scores`, {
          credentials: "include",
        });
        if (refreshed.ok) {
          const scores = (await refreshed.json()) as CompScores;
          setState({ kind: "ready", scores, etag: refreshed.headers.get("ETag") });
        }
        return res;
      },
      { fallback: "Couldn't start the re-score. Please try again." }
    );
    if (res) toast.success("Re-scoring started — scores will refresh shortly.");
  }

  return { state, rescoring, rescore };
}

/**
 * Role-aware empty state: visitors learn why there's nothing here; admins
 * are pointed at the action that produces scores. isAdmin resolves after
 * hydration, so SSR always renders the visitor sentence.
 */
export function ScoresEmptyState({
  isAdmin,
  tasksHref = "#tasks",
}: {
  isAdmin: boolean;
  /** Where "task's route" points — the inline section anchors, the page links back. */
  tasksHref?: string;
}) {
  return (
    <div className="mt-2 text-muted-foreground">
      <p>No scores yet — they appear as tracks come in.</p>
      {isAdmin ? (
        <p className="mt-1">
          Set a{" "}
          <a href={tasksHref} className="underline underline-offset-4">
            task's route
          </a>{" "}
          and submit tracks to see scores here.
        </p>
      ) : null}
    </div>
  );
}


/**
 * The tab strip in the bar's second layer is 51 px tall with body-size labels
 * at every pointer, like every control in the bar (issue #863); on the page it
 * was that only for a finger.
 */
const barTabsClass = "h-[3.1875rem]";
const barTabClass = "px-4 text-base";

/** The views, by the key each has in `?view=` and in the tab strip. */
export type ScoresView = "overall" | "bytask" | "top3" | "teams";
const VIEWS: readonly ScoresView[] = ["overall", "bytask", "top3", "teams"];

/** Short dates on the lists: "Mon 5 Jan". The year is the competition's. */
const shortDate = (date: string) =>
  formatTaskDate(date, { weekday: "short", day: "numeric", month: "short" });

/**
 * Which view and class the page shows, read from and written to the URL.
 *
 * In the URL, not in state, because the lists now lead somewhere: a reader
 * opens a pilot, then a report card, and comes Back twice. With the choice in
 * memory they came back to the first class and the first view; with it in the
 * query, Back returns the page as it was left — the rule every list page
 * keeps (CLAUDE.md, the overlays rule). Written with `replace`, so the views
 * do not pile up in the history, and read in the first render, which the
 * server renders with the query too (entry-server.tsx), so a shared link to
 * the Floater top 3 is that view in the server HTML.
 *
 * `?task=` is the older deep link (the task pages link "Scores" here with it):
 * on its own it opens the scores by task on that task.
 */
function useScoresQuery() {
  const [params, setParams] = useSearchParams();
  const rawView = params.get("view");
  const task = params.get("task");
  const view: ScoresView = VIEWS.includes(rawView as ScoresView)
    ? (rawView as ScoresView)
    : task
      ? "bytask"
      : "overall";
  const set = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true, preventScrollReset: true });
  };
  return { view, cls: params.get("class"), task, set };
}

/**
 * The scores page's views: Overall (one class's standings), By task, Top 3
 * and Teams, with the class picked under them where the view has classes.
 *
 * A hook, not a component, because the two halves are drawn in different
 * places (issue #863): `tabList` is the bar's second layer, which sticks with
 * the bar, and `panels` is the page. The page wraps BOTH in one
 * `<Tabs {...tabsProps}>`, around its `<Page>`. Until the scores are ready
 * both halves are null and the Tabs is empty, so the page's tree does not
 * change shape when they arrive.
 *
 * The classes used to be tabs in the same strip as the views, which ran off
 * a phone ("open · floater · Top 3 per task & class · Teams · Scores by
 * task"). They are a segmented control of their own now, under the views —
 * the analysis pages' `ClassPicker` — and only where the view has classes.
 */
export function useScoresViews({
  scores,
  compId,
  compName,
  timezone,
  tasks,
  defaultTaskId,
}: {
  /** Null until the scores are ready, and when no class has any. */
  scores: CompScores | null;
  /** As it goes in URLs: a hidden comp's share key rides along. */
  compId: string;
  /** Comp name, so the lists can build canonical pilot links. */
  compName: string | null;
  timezone: string | null;
  tasks: TaskSummary[];
  defaultTaskId: string | null;
}): {
  tabsProps: { selectedKey: string; onSelectionChange: (key: Key) => void };
  tabList: ReactNode;
  panels: ReactNode;
} {
  const query = useScoresQuery();
  const classScores = scores && scores.class_scores.length > 0 ? scores.class_scores : null;
  const teams = classScores ? aggregateTeams(classScores) : [];
  const groups = classScores ? buildClassGroups(classScores) : [];
  const scorableTasks = tasks.filter((t) => t.has_xctsk);
  const hasScorableTasks = scorableTasks.length > 0;
  const pickedTaskId =
    (query.task && scorableTasks.some((t) => t.task_id === query.task) ? query.task : null) ??
    defaultTaskId ??
    scorableTasks[0]?.task_id ??
    null;

  // A view the comp does not have (Teams without teams, By task before any
  // task has a route) falls back to Overall rather than showing nothing.
  const available = (v: ScoresView) =>
    v === "teams" ? teams.length > 0 : v === "bytask" ? hasScorableTasks : true;
  const view: ScoresView = available(query.view) ? query.view : "overall";

  // Always a string, so the Tabs is controlled from its first render: with
  // no tabs yet, a key that matches none selects nothing.
  const tabsProps = {
    selectedKey: classScores ? view : "",
    onSelectionChange: (key: Key) => {
      const next = String(key) as ScoresView;
      if (next === view) return;
      query.set({ view: next === "overall" ? null : next });
    },
  };

  if (!scores || !classScores) return { tabsProps, tabList: null, panels: null };

  // The class picker's choices are the view's: the classes for the standings,
  // the classes and their roll-ups ("Overall" across every class) for the
  // top 3. A class named in the URL that the view lacks falls back to the
  // first, so one `?class=` serves both views.
  const classNames = classScores.map((c) => c.pilot_class);
  const groupNames = groups.map((g) => g.label);
  const pickerOptions = view === "overall" ? classNames : view === "top3" ? groupNames : [];
  const pickedName =
    query.cls && pickerOptions.includes(query.cls) ? query.cls : (pickerOptions[0] ?? "");

  const tabList = (
    <div className="flex flex-col gap-2">
      <TabList aria-label="Score views" className={barTabsClass}>
        <Tab id="overall" className={barTabClass}>
          Overall
        </Tab>
        {hasScorableTasks ? (
          <Tab id="bytask" className={barTabClass}>
            By task
          </Tab>
        ) : null}
        <Tab id="top3" className={barTabClass}>
          Top 3
        </Tab>
        {teams.length > 0 ? (
          <Tab id="teams" className={barTabClass}>
            Teams
          </Tab>
        ) : null}
      </TabList>
      {pickerOptions.length > 1 ? (
        <ClassPicker
          classes={pickerOptions}
          value={pickedName}
          onChange={(name) => query.set({ class: name === pickerOptions[0] ? null : name })}
        />
      ) : null}
    </div>
  );

  const cls = classScores.find((c) => c.pilot_class === pickedName) ?? classScores[0];
  const group = groups.find((g) => g.label === pickedName) ?? groups[0];

  const panels = (
    <CompNameProvider value={compName}>
      <TabPanel id="overall" className="flex flex-col gap-4">
        <StandingsList scores={scores} cls={cls} compId={compId} compName={compName} />
      </TabPanel>

      {hasScorableTasks && pickedTaskId ? (
        <TabPanel id="bytask" className="flex flex-col gap-4">
          {/* One task at a time — every task's full list at once is too
              heavy for long comps. */}
          <Select
            label="Task"
            className="w-fit max-w-full"
            selectedKey={pickedTaskId}
            onSelectionChange={(key) => {
              if (key != null) query.set({ view: "bytask", task: String(key) });
            }}
          >
            {scorableTasks.map((t) => (
              <SelectItem key={t.task_id} id={t.task_id}>
                {`${t.name} — ${formatTaskDate(t.task_date)}`}
              </SelectItem>
            ))}
          </Select>
          <ScoresSection
            key={pickedTaskId}
            compId={compId}
            taskId={pickedTaskId}
            taskName={scorableTasks.find((t) => t.task_id === pickedTaskId)?.name ?? null}
            refresh={0}
            timezone={timezone}
            onReplayAvailable={() => {}}
            embedded
          />
        </TabPanel>
      ) : null}

      <TabPanel id="top3" className="flex flex-col gap-4">
        {group ? (
          <Top3Lists scores={scores} group={group} compId={compId} compName={compName} />
        ) : null}
      </TabPanel>

      {teams.length > 0 ? (
        <TabPanel id="teams" className="flex flex-col gap-4">
          <TeamsList tasks={scores.tasks} teams={teams} />
        </TabPanel>
      ) : null}
    </CompNameProvider>
  );

  return { tabsProps, tabList, panels };
}

// ── Overall ──────────────────────────────────────────────────────────────────

/**
 * One class's standings: a row per pilot with their rank, their name, their
 * place in each task on the second line, and their total. The row opens the
 * pilot's own scores (`/scores/:pilot`), where each task is a row that opens
 * its report card. A wide screen has room to lay each task's score out in a
 * column inside the row instead, and does.
 */
function StandingsList({
  scores,
  cls,
  compId,
  compName,
}: {
  scores: CompScores;
  cls: CompClassScore;
  compId: string;
  compName: string | null;
}) {
  // Only the tasks this class flew — classes fly different tasks, so mixing
  // them would leave every off-class place blank.
  const classTasks = scores.tasks.filter((t) => t.classes.includes(cls.pilot_class));
  const isFtv = scores.series_scoring === "ftv";
  const at = taskColumnsAt(classTasks.length);

  return (
    <>
      {isFtv ? (
        // The headline fact stays on the page; how to read the struck-through
        // places is method, so it sits behind the ⓘ. Every pilot's own
        // arithmetic is on their page, which is where a reader who wants the
        // detail is going anyway.
        <p className="text-sm text-muted-foreground">
          <strong className="font-medium text-foreground">FTV</strong> — only each
          pilot&rsquo;s best tasks count
          {scores.ftv_factor != null
            ? ` (${Math.round(scores.ftv_factor * 100)}% of validity discarded)`
            : ""}
          .{" "}
          <Explain label="Fixed Total Validity" className="align-middle">
            <p>
              Struck-through places are tasks that are dropped. Open a pilot
              for the arithmetic.
            </p>
          </Explain>
        </p>
      ) : null}
      <div>
        <TaskColumnsHeader
          at={at}
          first="Pilot"
          narrowFirst="Pilot · place in each task"
          tasks={classTasks}
          last="Total"
        />
        <ScoreList label={`Scores — ${cls.pilot_class}`}>
          {cls.pilots.map((p) => {
            const entries = classTasks.map((t) => p.tasks.find((e) => e.task_id === t.task_id) ?? null);
            return (
              <ScoreLinkRow
                key={p.comp_pilot_id}
                href={compPilotScoresPath(compId, compName, p.comp_pilot_id, p.pilot_name)}
                rank={p.rank}
                title={p.pilot_name}
                detailClassName={detailHiddenClass(at)}
                detail={
                  <>
                    <span aria-hidden="true">
                      {entries.map((e, i) => (
                        <Fragment key={classTasks[i].task_id}>
                          {i > 0 ? " · " : ""}
                          <span className={e?.ftv_status === "discarded" ? "line-through" : undefined}>
                            {e ? ordinal(e.rank) : "—"}
                          </span>
                        </Fragment>
                      ))}
                    </span>
                    <span className="sr-only">
                      {classTasks
                        .map((t, i) => {
                          const e = entries[i];
                          if (!e) return `${t.task_name}, no score`;
                          return `${t.task_name}, ${ordinal(e.rank)}${e.ftv_status === "discarded" ? ", dropped" : ""}`;
                        })
                        .join("; ")}
                    </span>
                  </>
                }
                figure={
                  <span className="flex items-center gap-3">
                    <span className={cn(columnsShownClass(at), "items-center gap-3")}>
                      {entries.map((e, i) => (
                        <TaskColumn
                          key={classTasks[i].task_id}
                          score={e ? e.score : null}
                          rank={e?.rank}
                          struck={e?.ftv_status === "discarded"}
                        />
                      ))}
                    </span>
                    <Points value={p.total_score} />
                  </span>
                }
              />
            );
          })}
        </ScoreList>
      </div>
    </>
  );
}

// ── Top 3 ────────────────────────────────────────────────────────────────────

/**
 * The first three on each task the class (or roll-up) flew, then the first
 * three overall. A short list per task; each row opens that task's report
 * card, and the overall rows open the pilot's own scores.
 */
function Top3Lists({
  scores,
  group,
  compId,
  compName,
}: {
  scores: CompScores;
  group: ReturnType<typeof buildClassGroups>[number];
  compId: string;
  compName: string | null;
}) {
  const rows = computeTop3Rows(group, scores.tasks);
  return (
    <>
      {group.classes.length > 1 ? (
        <p className="text-sm text-muted-foreground">Combined: {group.classes.join(", ")}</p>
      ) : null}
      <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => {
          const heading = row.task_id
            ? `${row.label} · ${row.task_date ? shortDate(row.task_date) : ""}`.replace(/ · $/, "")
            : row.label;
          return (
            <section key={row.task_id ?? "total"} className="min-w-0">
              <h3 className="mb-1.5 px-1 text-sm font-medium text-muted-foreground">{heading}</h3>
              {row.entries.length === 0 ? (
                <p className="px-1 text-muted-foreground">—</p>
              ) : (
                <ScoreList label={`Top 3 — ${group.label}, ${row.label}`}>
                  {row.entries.map((entry, i) => (
                    <ScoreLinkRow
                      key={entry.comp_pilot_id}
                      href={
                        row.task_id
                          ? pilotPath(compId, compName, row.task_id, row.label, entry.comp_pilot_id, entry.pilot_name)
                          : compPilotScoresPath(compId, compName, entry.comp_pilot_id, entry.pilot_name)
                      }
                      rank={ordinal(i + 1)}
                      title={entry.pilot_name}
                      figure={<Points value={entry.score} />}
                    />
                  ))}
                </ScoreList>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}

// ── Teams ────────────────────────────────────────────────────────────────────

/**
 * The teams, best first: a row per team with its pilots on the second line.
 * A team has no page, so its row opens nothing and shows no chevron.
 */
function TeamsList({ tasks, teams }: { tasks: TaskInfo[]; teams: CompTeamScore[] }) {
  const at = taskColumnsAt(tasks.length);
  return (
    <div>
      <TaskColumnsHeader at={at} first="Team" narrowFirst="Team · pilots" tasks={tasks} last="Total" />
      <ScoreList label="Team scores">
        {teams.map((team) => (
          <ScoreStaticRow
            key={team.team_name}
            rank={team.rank}
            title={team.team_name}
            detail={team.pilots.join(", ")}
            figure={
              <span className="flex items-center gap-3">
                <span className={cn(columnsShownClass(at), "items-center gap-3")}>
                  {tasks.map((t) => (
                    <TaskColumn key={t.task_id} score={team.task_scores[t.task_id] ?? null} />
                  ))}
                </span>
                <Points value={team.total_score} />
              </span>
            }
          />
        ))}
      </ScoreList>
    </div>
  );
}
