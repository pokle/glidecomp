/**
 * Task field analysis — the behavioural metrics for one task's field, and
 * which of them actually separated the leaderboard.
 *
 * PUBLIC (admin-only only for a hidden `test` comp — see canViewFieldAnalysis
 * in the worker's routes/field-analysis.ts; the API 404s a hidden comp for
 * non-admins, and this page reflects that rather than second-guessing it).
 *
 * Its own page rather than a section on the task page: it is a long,
 * exploratory read that shouldn't compete with the official scores.
 *
 * Lives at /comp/:compId/task/:taskId/analysis — this task's chapter of the
 * comp's field analysis. Both the URL and the breadcrumb parent on the TASK,
 * so the H1 is "Field analysis" and the task's name sits in the subtitle. The
 * whole-comp report, which collects every chapter, is a sibling link in the
 * header.
 *
 * This page is a SUMMARY, not the report. It was the whole report until
 * August 2026 — basis, debrief, weather, thermals, ranking, heatmap, clusters,
 * every per-family table and every footnote, in one scroll with a table of
 * contents to survive it. What it is now is the basis box, which is the
 * four-second answer to "what was measured", and a box per section saying what
 * is behind it. Each section is its own page (pages/TaskAnalysisSection.tsx,
 * field-analysis/sections.ts) showing that one thing.
 *
 * Presentation order still puts the separation ranking first: which metrics
 * have explanatory power is the finding, and the per-pilot numbers are the
 * evidence for it.
 *
 * SSR'd via loadTaskFieldAnalysis + functions/comp/[[path]].ts: the server
 * seeds the most-recently-cached report from `useInitialData()`, or a pending
 * placeholder while the first compute runs; the client hydrates from the same
 * data and takes over polling.
 */
import { Link, useSearchParams } from "react-router-dom";
import { Card } from "@/react/rac/card";
import { taskAnalysisPath, taskAnalysisSectionPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { AnalysisBasis } from "../field-analysis/AnalysisBasis";
import { TaskAnalysisFrame } from "../field-analysis/TaskAnalysisFrame";
import { useTaskFieldAnalysis } from "../field-analysis/use-task-report";
import {
  TASK_ANALYSIS_SECTIONS,
  type TaskAnalysisSectionSlug,
} from "../field-analysis/sections";
import { rankMetrics } from "../field-analysis/SeparationRanking";
import { EXCLUDED_PILOTS_ID } from "../field-analysis/Footnotes";

export function TaskFieldAnalysis() {
  const bundle = useTaskFieldAnalysis();
  const { compId, taskId, comp, task, styleClusters } = bundle;

  // Settle the address bar on the canonical `${slug}-${id}` once both names
  // load (the analysis body carries neither, so wait for the name fetches).
  useCanonicalPath(
    comp && task ? taskAnalysisPath(compId, comp.name, taskId, task.name) : null
  );

  // Every link out of here carries the report's view state — the class being
  // read, and the pilot pinned into the highlight context. Both live in the
  // URL precisely so they survive a walk between pages, and a box that
  // dropped them would silently answer a different question to the one the
  // reader is looking at.
  const [searchParams] = useSearchParams();
  const search = searchParams.toString();
  const hrefFor = (slug: TaskAnalysisSectionSlug) =>
    taskAnalysisSectionPath(compId, comp?.name, taskId, task?.name, slug) +
    (search ? `?${search}` : "");

  return (
    <TaskAnalysisFrame bundle={bundle}>
      {({ active, report }) => {
        const ranked = rankMetrics(report.metrics);
        const facts: Partial<Record<TaskAnalysisSectionSlug, React.ReactNode>> = {
          separation:
            ranked.length > 0 ? (
              <>
                Strongest:{" "}
                {ranked
                  .slice(0, 3)
                  .map((r) => r.metric.label)
                  .join(", ")}
              </>
            ) : null,
          day: [
            bundle.weatherNotes.trim().length > 0 ? "Organiser's notes" : null,
            bundle.hasWeatherSection ? "The day's profile" : null,
            bundle.hasThermalsSection
              ? `${report.thermals?.shapes.length ?? 0} reconstructed thermals`
              : null,
          ]
            .filter(Boolean)
            .join(" · "),
          pilots: `${report.pilots.length} pilots · ${report.metrics.length} behaviours`,
          styles: styleClusters
            ? `${styleClusters.k} groups over ${styleClusters.pilotCount} pilots`
            : null,
        };

        // A section with nothing in it gets no box: an empty promise is worse
        // than a missing one, and the reader cannot tell which until they have
        // paid a page load to find out.
        const empty = (slug: TaskAnalysisSectionSlug) =>
          (slug === "styles" && !styleClusters) ||
          (slug === "separation" && ranked.length === 0) ||
          (slug === "day" && !bundle.hasWeatherSection && !bundle.hasThermalsSection);

        return (
          <>
            {/* What the numbers were computed from. The one box that is not a
                door: it IS the summary, and there is nothing deeper behind it.
                Its facts are doors, though — the airtime and working band open
                the day, the thermal count the thermals, and the excluded count
                the method page's list. */}
            <AnalysisBasis
              basis={report.basis}
              excluded={active.excluded}
              timeZone={comp?.timezone ?? undefined}
              weatherHref={
                bundle.hasWeatherSection
                  ? `${hrefFor("day")}#weather-heading`
                  : undefined
              }
              thermalsHref={
                bundle.hasThermalsSection
                  ? `${hrefFor("day")}#thermals-heading`
                  : undefined
              }
              excludedHref={`${hrefFor("method")}#${EXCLUDED_PILOTS_ID}`}
            />

            {TASK_ANALYSIS_SECTIONS.filter((s) => !empty(s.slug)).map((section) => (
              <SummaryBox
                key={section.slug}
                href={hrefFor(section.slug)}
                label={section.label}
                lede={section.lede}
                facts={facts[section.slug]}
              />
            ))}
          </>
        );
      }}
    </TaskAnalysisFrame>
  );
}

/**
 * One section's box: its name as the way in, what it holds, and a line of what
 * is actually in there for this task.
 *
 * The heading is the link rather than a "Read more" beneath it — the section's
 * name is what the reader is choosing between, so it is what they should be
 * able to hit, and it keeps each box to three short lines.
 */
function SummaryBox({
  href,
  label,
  lede,
  facts,
}: {
  href: string;
  label: string;
  lede: string;
  facts?: React.ReactNode;
}) {
  return (
    <Card className="gap-1">
      <h2 className="text-lg font-semibold">
        <Link
          to={href}
          className="underline-offset-4 hover:underline focus-visible:underline"
        >
          {label}
        </Link>
      </h2>
      <p className="text-sm text-muted-foreground">{lede}</p>
      {facts ? <p className="text-sm tabular-nums">{facts}</p> : null}
    </Card>
  );
}
