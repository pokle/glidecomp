/**
 * Task analysis — the behavioural metrics for one task's field, and
 * which of them actually separated the leaderboard.
 *
 * PUBLIC (admin-only only for a hidden `test` comp — see canViewAnalysis
 * in the worker's routes/analysis.ts; the API 404s a hidden comp for
 * non-admins, and this page reflects that rather than second-guessing it).
 *
 * Its own page rather than a section on the task page: it is a long,
 * exploratory read that shouldn't compete with the official scores.
 *
 * Lives at /comp/:compId/task/:taskId/analysis — this task's chapter of the
 * comp analysis. Both the URL and the breadcrumb parent on the TASK,
 * so the H1 is "Task analysis" and the task's name sits in the subtitle. The
 * whole-comp report, which collects every chapter, is a sibling link in the
 * header.
 *
 * This page is a CONTENTS LIST, not the report. It was the whole report until
 * August 2026 — basis, debrief, weather, thermals, ranking, heatmap, clusters,
 * every per-family table and every footnote, in one scroll with a table of
 * contents to survive it. What it is now is one box per section: its name, and
 * one line of what this task has in it. Nothing else. A box is something to
 * choose between, so it carries no explanation — whatever needs explaining is
 * on the other side of the box, on the section's own page
 * (pages/TaskAnalysisSection.tsx, analysis/sections.ts).
 *
 * The fact lines are the old basis box, redistributed: its four tiles said
 * pilots, airtime, thermals and working band with nothing to say which
 * section each belonged to, and each now sits on the box for the section it
 * describes (analysis/basis-facts.ts). What was left over — the airtime
 * split, and the count of pilots the scores hold that this could not measure —
 * belongs to no section and stays in AnalysisBasis above the boxes.
 *
 * Presentation order still leads with the behaviours that separated the field:
 * which metrics have explanatory power is the finding, and the per-pilot
 * numbers are the evidence for it.
 *
 * SSR'd via loadTaskAnalysis + functions/comp/[[path]].ts: the server
 * seeds the most-recently-cached report from `useInitialData()`, or a pending
 * placeholder while the first compute runs; the client hydrates from the same
 * data and takes over polling.
 */
import { Link, useSearchParams } from "react-router-dom";
import { Card } from "@/react/rac/card";
import { Badge } from "@/react/rac/badge";
import { taskAnalysisPath, taskAnalysisSectionPath, taskSimilarityPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { AnalysisBasis } from "../analysis/AnalysisBasis";
import { TaskAnalysisFrame } from "../analysis/TaskAnalysisFrame";
import { useTaskAnalysis } from "../analysis/use-task-report";
import {
  TASK_ANALYSIS_SECTIONS,
  type TaskAnalysisSectionSlug,
} from "../analysis/sections";
import { rankMetrics } from "../analysis/SeparationRanking";
import { EXCLUDED_PILOTS_ID } from "../analysis/Footnotes";
import { fieldFact, thermalsFact, windFact } from "../analysis/basis-facts";
import { useUnits } from "../lib/units";
import type { MetricReport } from "../analysis/types";

/** How many behaviours the strategies box names. The same top-3 the metric
 *  families use for what to open by default. */
const STRATEGY_COUNT = 3;

/**
 * Verdicts loud enough to name on the contents page: weak and above. Below
 * that the box would be claiming a strategy the section itself un-says.
 */
const STRATEGY_VERDICTS = new Set(["strong", "moderate", "weak"]);

/**
 * The behaviour written as the thing that WON.
 *
 * The ranking orders by |ρ| and the verdict is computed from |ρ| and n, so
 * neither says which WAY a behaviour won — and a neutral label under the words
 * "winning strategies" can assert the exact opposite of the finding. ρ < 0
 * means larger values went with better ranks. Falls back to the neutral label
 * when a metric has no honest wording for that side, and on any report stored
 * before the field existed (served while it revalidates).
 */
function winningLabel(
  metric: Pick<MetricReport, "label" | "winning">,
  rho: number
): string {
  return (rho < 0 ? metric.winning?.more : metric.winning?.less) ?? metric.label;
}

export function TaskAnalysis() {
  const bundle = useTaskAnalysis();
  const { compId, taskId, comp, task, styleClusters } = bundle;
  // The box facts are altitudes and wind speeds, so they convert at the edge
  // like every other reading (the metric values in `report` already have).
  const units = useUnits();

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
  const query = search ? `?${search}` : "";
  const hrefFor = (slug: TaskAnalysisSectionSlug) =>
    taskAnalysisSectionPath(compId, comp?.name, taskId, task?.name, slug) + query;

  return (
    <TaskAnalysisFrame bundle={bundle}>
      {({ active, report }) => {
        const strategies = rankMetrics(report.metrics)
          .filter((r) => STRATEGY_VERDICTS.has(r.correlation.verdict))
          .slice(0, STRATEGY_COUNT);
        // Null when no circle produced an estimate: a task nobody thermalled
        // has no wind to report, and saying nothing beats reporting the
        // absence of a measurement as a calm day.
        const weather = windFact(bundle.dayMetrics, units);

        /** The one line of this-task fact each box carries under its name. */
        const facts: Partial<Record<TaskAnalysisSectionSlug, React.ReactNode>> = {
          strategies: (
            <>
              {strategies.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {strategies.map(({ metric, correlation }) => (
                    <Badge key={metric.id} variant="secondary">
                      {winningLabel(metric, correlation.rho)}
                    </Badge>
                  ))}
                </div>
              ) : (
                // "No clear pattern" is itself the day's finding — a lottery
                // day — and a box that vanished on those days would quietly
                // overclaim on all the rest.
                <Facts>No clear pattern</Facts>
              )}
              {/* What the correlations rest on, beside the correlations: a
                  thin day is exactly when a reader should distrust them. */}
              <Facts>{fieldFact(report.basis, comp?.timezone ?? undefined)}</Facts>
            </>
          ),
          weather: weather ? (
            <Facts>{weather}</Facts>
          ) : bundle.weatherNotes.trim().length > 0 ? (
            // No wind estimate, but the organiser wrote the day up. Saying so
            // is the fact: it is what is behind the box.
            <Facts>Notes from the organiser</Facts>
          ) : null,
          thermals: <Facts>{thermalsFact(report.basis, units)}</Facts>,
          // Not the pilot count too: it is already on the strategies box, and
          // the same number twice in a list of seven is noise.
          metrics: <Facts>{report.metrics.length} behaviours</Facts>,
          style: styleClusters ? <Facts>{styleClusters.k} groups</Facts> : null,
        };

        // A section with nothing in it gets no box: an empty promise is worse
        // than a missing one, and the reader cannot tell which until they have
        // paid a page load to find out.
        const empty = (slug: TaskAnalysisSectionSlug) =>
          (slug === "style" && !styleClusters) ||
          (slug === "weather" && !bundle.hasWeatherSection) ||
          (slug === "thermals" && !bundle.hasThermalsSection);

        // The similarity sheet is not a section of the report — its own route,
        // its own controls, a tool rather than a reading — but it belongs in
        // the same list, because that is where a reader looks for it: one flat
        // set of places to go, rather than a door hidden inside another page.
        // It sits beside the flying style it extends, and ahead of the method
        // note, which stays last because it is consulted once. Positioned
        // against `method` rather than by index so it stays there whatever
        // else the day left out.
        const boxes: {
          key: string;
          href: string;
          label: string;
          facts?: React.ReactNode;
        }[] = TASK_ANALYSIS_SECTIONS.filter((s) => !empty(s.slug)).map((section) => ({
          key: section.slug,
          href: hrefFor(section.slug),
          label: section.label,
          facts: facts[section.slug],
        }));
        const method = boxes.findIndex((b) => b.key === "method");
        boxes.splice(method === -1 ? boxes.length : method, 0, {
          key: "similar",
          href: taskSimilarityPath(compId, comp?.name, taskId, task?.name) + query,
          label: "Similar pilots",
        });

        return (
          <>
            {/* The two facts that belong to no one section: how the airtime
                divided, and how many pilots the scores hold that this could
                not measure. Everything else the basis used to state now sits
                on the box for the section it describes. */}
            <AnalysisBasis
              basis={report.basis}
              excluded={active.excluded}
              excludedHref={`${hrefFor("method")}#${EXCLUDED_PILOTS_ID}`}
            />

            {boxes.map((box) => (
              <SectionBox
                key={box.key}
                href={box.href}
                label={box.label}
                facts={box.facts}
              />
            ))}
          </>
        );
      }}
    </TaskAnalysisFrame>
  );
}

/**
 * One box: a section's name, and what this task has in it.
 *
 * The whole card is the link, not the heading inside it — the box exists to be
 * chosen, so the whole of it should be hittable, and on a phone a heading-sized
 * target in a card-sized box is a miss waiting to happen. The heading stays a
 * heading inside the link, so heading navigation still lists the sections.
 */
function SectionBox({
  href,
  label,
  facts,
}: {
  href: string;
  label: string;
  facts?: React.ReactNode;
}) {
  return (
    <Link
      to={href}
      className="rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <Card className="gap-2 transition-colors hover:bg-accent/40">
        <h2 className="text-lg font-semibold">{label}</h2>
        {facts}
      </Card>
    </Link>
  );
}

/** A box's one line of this-task fact, under its name. */
function Facts({ children }: { children: React.ReactNode }) {
  return <p className="text-sm tabular-nums text-muted-foreground">{children}</p>;
}
