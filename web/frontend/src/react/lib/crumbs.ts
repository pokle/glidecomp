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
  compAnalysisPath,
  compSettingsPath,
  taskSettingsPath,
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
 * Ancestors of a task settings sub-page (today only the weather notes).
 *
 * The task settings page itself is flat, so this is the only trail that needs
 * "Settings" as an ancestor rather than as the current crumb.
 */
export function underTaskSettings(
  compId: string | undefined,
  compName: string | null | undefined,
  taskId: string | undefined,
  taskName: string | null | undefined
): Crumb[] {
  return [
    ...underTask(compId, compName, taskId, taskName),
    {
      label: "Settings",
      to:
        compId && taskId
          ? taskSettingsPath(compId, compName, taskId, taskName)
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

/**
 * Ancestors of a per-task field analysis chapter.
 *
 * Deliberately NOT `underTask`: the per-task report is a chapter of the
 * competition's field analysis, not a leaf of the task page. Going up from a
 * chapter should land you back in the report (where you can compare it against
 * the other tasks), which is also what the URL says — /comp/:c/analysis/task/:t.
 * The task page is reachable from a sibling link on the chapter instead.
 */
export function underCompAnalysis(
  compId: string | undefined,
  compName: string | null | undefined
): Crumb[] {
  return [
    ...underComp(compId, compName),
    {
      label: FIELD_ANALYSIS_LABEL,
      to: compId ? compAnalysisPath(compId, compName) : "/comp",
    },
  ];
}
