/**
 * Breadcrumb trails, built in one place.
 *
 * Every page under /comp shares the same ancestors, so hand-rolling the arrays
 * at each call site let the labels drift (three different fallbacks for an
 * unloaded competition, two for an unloaded task). These builders return the
 * ANCESTORS of a page; the page itself passes its own name as `current` to
 * `rac/breadcrumbs`, which renders it as the final aria-current crumb.
 *
 * Names arrive late on most of these pages (the comp/task fetches are
 * non-critical and may never resolve), so every builder takes a nullable name
 * and falls back to a generic label — the link works either way.
 */
import {
  compPath,
  taskPath,
  taskAnalysisPath,
  compSettingsPath,
  compPilotsPath,
  pilotPath,
  compWaypointsPath,
  compScoresPath,
  compAnalysisPath,
  compAltitudeReviewPath,
  taskRoutePath,
} from "./slug";

export type Crumb = { label: string; to: string };

/**
 * The two analysis pages are two different things and are named apart.
 *
 * COMP analysis is the whole competition read across its tasks, and hangs off
 * the competition. TASK analysis is one task's field read against itself, and
 * hangs off that task. Both used to be called "Task analysis", which said
 * neither, so a reader could not tell from a crumb, a heading or a tab title
 * which of the two they had open.
 *
 * Each label is used as that page's heading AND as its ancestor crumb, so the
 * trail and the H1 can never disagree.
 */
export const COMP_ANALYSIS_LABEL = "Comp analysis";
export const TASK_ANALYSIS_LABEL = "Task analysis";

const COMPETITIONS: Crumb = { label: "Competitions", to: "/comp" };

// The compId passed in is the BARE sqid (pages extract it from the possibly
// slugged route param via idFromSegment); pairing it with the name here yields
// the canonical `${slug}-${id}` link.

/** Ancestors of /comp/:compId — the competition list alone. */
export function compCrumbs(): Crumb[] {
  return [COMPETITIONS];
}

/**
 * Ancestors of a page under the account's settings: one of its groups
 * (/settings/:group), and the site admin pages its index links to.
 */
export function underSettings(): Crumb[] {
  return [{ label: "Settings", to: "/settings" }];
}

/** Ancestors of a page directly under a competition (waypoints, tasks, analysis). */
export function underComp(compId: string | undefined, compName: string | null | undefined): Crumb[] {
  return [
    COMPETITIONS,
    { label: compName || "Competition", to: compId ? compPath(compId, compName) : "/comp" },
  ];
}

/** Ancestors of one behaviour's page: the competition, then its analysis. */
export function underCompAnalysis(compId: string | undefined, compName: string | null | undefined): Crumb[] {
  return [
    ...underComp(compId, compName),
    { label: COMP_ANALYSIS_LABEL, to: compId ? compAnalysisPath(compId, compName) : "/comp" },
  ];
}

/** Ancestors of one pilot's editor: the competition, then its roster. */
export function underCompPilots(compId: string | undefined, compName: string | null | undefined): Crumb[] {
  return [
    ...underComp(compId, compName),
    { label: "Pilots", to: compId ? compPilotsPath(compId, compName) : "/comp" },
  ];
}

/** Ancestors of one pilot's scores: the competition, then its scores. */
export function underCompScores(compId: string | undefined, compName: string | null | undefined): Crumb[] {
  return [
    ...underComp(compId, compName),
    { label: "Scores", to: compId ? compScoresPath(compId, compName) : "/comp" },
  ];
}

/**
 * Ancestors of the waypoints editor's pages (one waypoint, Add, the map, the
 * altitude review): the competition, then its waypoints.
 */
export function underCompWaypoints(
  compId: string | undefined,
  compName: string | null | undefined
): Crumb[] {
  return [
    ...underComp(compId, compName),
    { label: "Waypoints", to: compId ? compWaypointsPath(compId, compName) : "/comp" },
  ];
}

/** Ancestors of one waypoint of the altitude review: the review itself. */
export function underAltitudeReview(
  compId: string | undefined,
  compName: string | null | undefined
): Crumb[] {
  return [
    ...underCompWaypoints(compId, compName),
    { label: "Check altitudes", to: compId ? compAltitudeReviewPath(compId, compName) : "/comp" },
  ];
}

/** Ancestors of a competition settings sub-page (general, scoring, …). */
export function underCompSettings(
  compId: string | undefined,
  compName: string | null | undefined
): Crumb[] {
  return [
    ...underComp(compId, compName),
    {
      label: "Settings",
      to: compId ? compSettingsPath(compId, compName) : "/comp",
    },
  ];
}

/** Ancestors of a page directly under a task (pilot score detail). */
export function underTask(
  compId: string | undefined,
  compName: string | null | undefined,
  taskId: string | undefined,
  taskName: string | null | undefined
): Crumb[] {
  return [
    ...underComp(compId, compName),
    {
      label: taskName || "Task",
      to: compId && taskId ? taskPath(compId, compName, taskId, taskName) : "/comp",
    },
  ];
}

/**
 * Ancestors of the route editor's pages (one turnpoint, Quick entry, Load from
 * XContest, Add waypoint): the task, then its route.
 */
export function underTaskRoute(
  compId: string | undefined,
  compName: string | null | undefined,
  taskId: string | undefined,
  taskName: string | null | undefined
): Crumb[] {
  return [
    ...underTask(compId, compName, taskId, taskName),
    {
      label: "Route",
      to: compId && taskId ? taskRoutePath(compId, compName, taskId, taskName) : "/comp",
    },
  ];
}

/**
 * Ancestors of a page under a task analysis — today the
 * pilot-similarity page.
 *
 * The chapter itself is one crumb shorter: it calls {@link underTask} and
 * passes {@link TASK_ANALYSIS_LABEL} as its own `current`, so the two trails
 * agree crumb for crumb.
 *
 * Both parent on the TASK, which is what the URL says too
 * (/comp/:c/task/:t/analysis). A reader arrives here from the task page, and a
 * trail that dropped the task in favour of a report they have never opened
 * read as a different branch of the site. The whole-comp report collects these
 * chapters, and is a sibling link on each one.
 */
export function underTaskAnalysis(
  compId: string | undefined,
  compName: string | null | undefined,
  taskId: string | undefined,
  taskName: string | null | undefined
): Crumb[] {
  return [
    ...underTask(compId, compName, taskId, taskName),
    {
      label: TASK_ANALYSIS_LABEL,
      to:
        compId && taskId
          ? taskAnalysisPath(compId, compName, taskId, taskName)
          : "/comp",
    },
  ];
}

/**
 * Ancestors of a page under one pilot's report card (recording a manual
 * flight). The pilot's own name is the last ancestor: the page is about them.
 */
export function underPilot(
  compId: string | undefined,
  compName: string | null | undefined,
  taskId: string | undefined,
  taskName: string | null | undefined,
  pilotId: string | undefined,
  pilotName: string | null | undefined
): Crumb[] {
  return [
    ...underTask(compId, compName, taskId, taskName),
    {
      label: pilotName || "Pilot",
      to:
        compId && taskId && pilotId
          ? pilotPath(compId, compName, taskId, taskName, pilotId, pilotName)
          : "/comp",
    },
  ];
}

/** A level of the bar's title menu: the pages beside a page, or under it. */
export type RelatedPages = {
  as: "siblings" | "children";
  items: Array<Crumb & { current?: boolean }>;
};

/** The pages under a competition, by the name each has in the title's menu. */
export type CompPage = "Scores" | "Waypoints" | "Pilots" | typeof COMP_ANALYSIS_LABEL | "Settings";

/**
 * The pages under a competition, for the bar's title menu (issue #863,
 * decision 4: the strip of section links went into this menu).
 *
 * With `current`, they are drawn BESIDE the page that is open, which is
 * ticked; without it, UNDER the competition's own page. Pilots and Settings
 * are organisers' pages, and an open-distance competition has no analysis.
 *
 * `comp` may still be loading: the links work from the id alone.
 */
export function compPages(
  compId: string | undefined,
  comp: { name: string; scoring_format?: string | null } | null | undefined,
  isAdmin: boolean,
  current?: CompPage
): RelatedPages | undefined {
  if (!compId) return undefined;
  const name = comp?.name;
  const items: Array<Crumb & { current?: boolean }> = [
    { label: "Scores", to: compScoresPath(compId, name) },
    { label: "Waypoints", to: compWaypointsPath(compId, name) },
  ];
  if (isAdmin) items.push({ label: "Pilots", to: compPilotsPath(compId, name) });
  if (comp?.scoring_format !== "open_distance") {
    items.push({ label: COMP_ANALYSIS_LABEL, to: compAnalysisPath(compId, name) });
  }
  if (isAdmin) items.push({ label: "Settings", to: compSettingsPath(compId, name) });
  return {
    as: current ? "siblings" : "children",
    items: items.map((it) => ({ ...it, current: it.label === current })),
  };
}

/**
 * A competition's tasks, beside the one that is open, for the bar's title
 * menu on a task page: the way from one task to the next.
 */
export function taskSiblings(
  compId: string | undefined,
  compName: string | null | undefined,
  tasks: Array<{ task_id: string; name: string }> | null | undefined,
  currentTaskId: string | undefined
): RelatedPages | undefined {
  if (!compId || !tasks || tasks.length < 2) return undefined;
  return {
    as: "siblings",
    items: tasks.map((t) => ({
      label: t.name,
      to: taskPath(compId, compName, t.task_id, t.name),
      current: t.task_id === currentTaskId,
    })),
  };
}
