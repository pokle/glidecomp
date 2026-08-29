/**
 * The task field analysis, as a set of pages rather than one long scroll.
 *
 * The chapter page (/comp/:c/task/:t/analysis) is a contents list: a box per
 * section, naming it and stating what this task has in it. Everything a box
 * stands for lives on its own page, /analysis/<slug>, which shows that one
 * thing and nothing else. A box carries no explanation — it is there to be
 * chosen between, and whatever needs explaining is on the other side of it.
 *
 * This module is the single list both ends read: the summary page builds its
 * boxes from it, the section page resolves :section against it, and the SSR
 * Function's route pattern is built from the same slugs. A section added in
 * one place and forgotten in the others would be a 404 nobody notices.
 *
 * Order is the page's order, and it is deliberate: the basis first (what was
 * measured, and not a section — it IS the summary), then which behaviours
 * separated the field, then the day that shaped it, then where each pilot sat
 * in it. Method last: it is consulted once.
 *
 * The pilot-similarity sheet sits in the same list of boxes on the summary but
 * is NOT here: it predates these pages, has its own route, and is a tool
 * rather than a section of the report. The summary places it beside the flying
 * style it extends, which is to say ahead of the method note.
 */

export type TaskAnalysisSectionSlug =
  | "strategies"
  | "weather"
  | "thermals"
  | "metrics"
  | "style"
  | "method";

export interface TaskAnalysisSectionDef {
  slug: TaskAnalysisSectionSlug;
  /** Heading of the section's own page, and the box that leads to it. */
  label: string;
  /** The section page's standfirst, under its heading. Not shown on the box. */
  lede: string;
}

export const TASK_ANALYSIS_SECTIONS: TaskAnalysisSectionDef[] = [
  {
    slug: "strategies",
    label: "Winning strategies",
    lede: "Which behaviours went with better ranks on this task.",
  },
  {
    slug: "weather",
    label: "Weather",
    lede: "The organiser's account of the day, and the day's own profile.",
  },
  {
    slug: "thermals",
    label: "Thermals",
    lede: "The thermals the field shared, and how each of them leaned.",
  },
  {
    slug: "metrics",
    label: "Metric details",
    lede: "Every pilot's reading on every behaviour, family by family.",
  },
  {
    slug: "style",
    label: "Flying style",
    lede: "Pilots grouped by how alike their flying was.",
  },
  {
    slug: "method",
    label: "How this was measured",
    lede: "Who could not be analysed, how the field is compared, and what each metric means.",
  },
];

export function findTaskAnalysisSection(
  slug: string | undefined
): TaskAnalysisSectionDef | undefined {
  return TASK_ANALYSIS_SECTIONS.find((s) => s.slug === slug);
}
