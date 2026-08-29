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
  pilotPath,
} from "./slug";

export type Crumb = { label: string; to: string };

/** The label the field-analysis pages use, as heading and as ancestor crumb. */
export const FIELD_ANALYSIS_LABEL = "Field analysis";

const COMPETITIONS: Crumb = { label: "Competitions", to: "/comp" };

// The compId passed in is the BARE sqid (pages extract it from the possibly
// slugged route param via idFromSegment); pairing it with the name here yields
// the canonical `${slug}-${id}` link.

/** Ancestors of /comp/:compId — the competition list alone. */
export function compCrumbs(): Crumb[] {
  return [COMPETITIONS];
}

/** Ancestors of a page directly under a competition (waypoints, tasks, analysis). */
export function underComp(compId: string | undefined, compName: string | null | undefined): Crumb[] {
  return [
    COMPETITIONS,
    { label: compName || "Competition", to: compId ? compPath(compId, compName) : "/comp" },
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
 * Ancestors of a page under a per-task field-analysis chapter — today the
 * pilot-similarity sheet.
 *
 * The chapter itself is one crumb shorter: it calls {@link underTask} and
 * passes {@link FIELD_ANALYSIS_LABEL} as its own `current`, so the two trails
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
      label: FIELD_ANALYSIS_LABEL,
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
