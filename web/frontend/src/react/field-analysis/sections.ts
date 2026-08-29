/**
 * The task field analysis, as a set of pages rather than one long scroll.
 *
 * The chapter page (/comp/:c/task/:t/analysis) is now a summary: a box per
 * section, each stating what is behind it and linking to it. Everything a box
 * summarises lives on its own page, /analysis/<slug>, which shows that one
 * thing and nothing else.
 *
 * This module is the single list both ends read: the summary page builds its
 * boxes from it, the section page resolves :section against it, and the SSR
 * Function's route pattern is built from the same slugs. A section added in
 * one place and forgotten in the others would be a 404 nobody notices.
 *
 * Order is the page's order, and it is deliberate: the basis first (what was
 * measured), then which behaviours separated the field — the finding — then
 * the day that shaped it, then where each pilot sat in it. Method last: it is
 * consulted once.
 */

export type TaskAnalysisSectionSlug =
  | "separation"
  | "day"
  | "pilots"
  | "styles"
  | "method";

export interface TaskAnalysisSectionDef {
  slug: TaskAnalysisSectionSlug;
  /** Heading of the section's own page, and of its box on the summary. */
  label: string;
  /** The section page's standfirst, under its heading. */
  lede: string;
}

export const TASK_ANALYSIS_SECTIONS: TaskAnalysisSectionDef[] = [
  {
    slug: "separation",
    label: "What separated the field",
    lede: "Which behaviours went with better ranks on this task.",
  },
  {
    slug: "day",
    label: "The day they flew",
    lede: "The organiser's notes, the day's profile, and the thermals the field shared.",
  },
  {
    slug: "pilots",
    label: "Where each pilot sat",
    lede: "Every pilot's standing on every behaviour, and the numbers behind it.",
  },
  {
    slug: "styles",
    label: "Pilot style clusters",
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
