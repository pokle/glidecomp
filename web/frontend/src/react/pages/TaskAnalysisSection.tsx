/**
 * One section of a task's field analysis, on its own page.
 *
 * /comp/:compId/task/:taskId/analysis/:section — five sections, one route, one
 * component. They are five views of ONE report (see field-analysis/sections.ts
 * and use-task-report.ts), so five page components would have been five copies
 * of the same fetch, the same class select and the same freshness poll; what
 * actually differs between them is the body, which is the switch below.
 *
 * PUBLIC and SSR'd, like the chapter that summarises them: each has a ROUTES
 * entry in functions/comp/[[path]].ts through the same loader. The similarity
 * sheet is the exception and stays client-only — it is an interactive tool
 * rather than a document, and it has its own page.
 *
 * Nothing here is print-specific. The old one-page report carried page-break
 * hints and printed twins of its ⓘ popovers so a whole task could be put on
 * paper in one go; that is no longer a goal, and each page prints as itself.
 */
import { useEffect, useMemo, useState } from "react";
import type { Key } from "react-aria-components";
import { useParams } from "react-router-dom";
import { Card } from "@/react/rac/card";
import { LinkButton } from "@/react/rac/button";
import { Explain } from "@/react/rac/explain";
import { NotFound } from "../components/NotFound";
import { idFromSegment, taskAnalysisSectionPath, taskSimilarityPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { TaskAnalysisFrame } from "../field-analysis/TaskAnalysisFrame";
import { useTaskFieldAnalysis } from "../field-analysis/use-task-report";
import { findTaskAnalysisSection } from "../field-analysis/sections";
import { SeparationRanking, rankMetrics } from "../field-analysis/SeparationRanking";
import { HowToReadFootnote, OneDayCaveatNote } from "../field-analysis/ReadingNotes";
import {
  MetricFamilySection,
  metricsByFamily,
} from "../field-analysis/MetricFamilySection";
import { TaskDebrief } from "../field-analysis/TaskDebrief";
import { MetricGlossary } from "../field-analysis/MetricGlossary";
import { ExcludedPilots, MethodNote } from "../field-analysis/Footnotes";
import { PercentileHeatmap } from "../field-analysis/charts/PercentileHeatmap";
import { StyleClusters } from "../field-analysis/StyleClusters";
import { ThermalsPanel } from "../field-analysis/thermals/ThermalsPanel";
import { DayProfilePanel } from "../field-analysis/charts/day-profile/DayProfilePanel";
import { WeatherNotesBlock } from "../weather/WeatherNotesBlock";
import {
  FAMILY_ORDER,
  FAMILY_LABELS,
  type MetricReport,
} from "../field-analysis/types";

export function TaskAnalysisSection() {
  const { section: sectionParam } = useParams<{ section: string }>();
  const section = findTaskAnalysisSection(sectionParam);
  const bundle = useTaskFieldAnalysis();
  const { compId, taskId, comp, task } = bundle;

  // Settle the address bar on the canonical `${slug}-${id}` once both names
  // load (the analysis body carries neither, so wait for the name fetches).
  useCanonicalPath(
    comp && task && section
      ? taskAnalysisSectionPath(compId, comp.name, taskId, task.name, section.slug)
      : null
  );

  // An unknown slug is a dead URL, not an empty section. The SSR Function's
  // route pattern lists the five, so this is reachable only by a client-side
  // navigation to a typo'd path.
  if (!section) return <NotFound title="Field analysis section not found" />;

  return (
    <TaskAnalysisFrame
      bundle={bundle}
      section={section}
      // Every section but the method note has per-pilot rows or dots to tint.
      pilotPicker={section.slug !== "method"}
    >
      {({ active, report }) => (
        <SectionBody
          slug={section.slug}
          bundle={bundle}
          active={active}
          report={report}
        />
      )}
    </TaskAnalysisFrame>
  );
}

type FrameCtx = Parameters<
  Parameters<typeof TaskAnalysisFrame>[0]["children"]
>[0];

function SectionBody({
  slug,
  bundle,
  active,
  report,
}: {
  slug: string;
  bundle: ReturnType<typeof useTaskFieldAnalysis>;
  active: FrameCtx["active"];
  report: FrameCtx["report"];
}) {
  switch (slug) {
    case "separation":
      return <SeparationSection bundle={bundle} active={active} report={report} />;
    case "day":
      return <DaySection bundle={bundle} report={report} />;
    case "pilots":
      return <PilotsSection bundle={bundle} report={report} />;
    case "styles":
      return <StylesSection bundle={bundle} report={report} />;
    case "method":
      return <MethodSection active={active} report={report} />;
    default:
      return null;
  }
}

/** Which behaviours went with better ranks, and where this task disagreed
 *  with the rest of the competition. */
function SeparationSection({
  bundle,
  active,
  report,
}: {
  bundle: ReturnType<typeof useTaskFieldAnalysis>;
  active: FrameCtx["active"];
  report: FrameCtx["report"];
}) {
  // The ranking's selection lives here rather than inside it so a class switch
  // resets it, instead of carrying a stale metric id across metric sets.
  const [selected, setSelected] = useState<Key | null>(null);
  useEffect(() => setSelected(null), [active.pilot_class]);

  return (
    <>
      <Card aria-labelledby="separation-heading" className="gap-3">
        <h2
          id="separation-heading"
          className="flex items-center gap-1 scroll-mt-20 text-lg font-semibold"
        >
          Which behaviours went with better ranks
          {/* Why a strong-looking coefficient on ONE task is not yet a
              finding — a caveat about the whole section, so it hangs off the
              section's heading rather than a column. */}
          <Explain label="One task is not a finding">
            <OneDayCaveatNote behaviourCount={rankMetrics(report.metrics).length} />
          </Explain>
        </h2>
        <SeparationRanking
          metrics={report.metrics}
          report={report}
          selectedMetricId={selected}
          onSelectedMetricIdChange={setSelected}
        />
      </Card>

      {/* Renders nothing unless this task actually ran against the consensus
          the comp's other tasks formed — a debrief that only speaks when it
          has evidence. It belongs here because that IS a finding about what
          separated the field, just one measured across tasks. */}
      {bundle.compId && bundle.taskId ? (
        <TaskDebrief
          compId={bundle.compId}
          taskId={bundle.taskId}
          pilotClass={active.pilot_class}
        />
      ) : null}
    </>
  );
}

/** The conditions the field flew in: the organiser's account, the day's own
 *  profile, and the thermals it shared. */
function DaySection({
  bundle,
  report,
}: {
  bundle: ReturnType<typeof useTaskFieldAnalysis>;
  report: FrameCtx["report"];
}) {
  const { comp, compId, taskId, dayMetrics, weather, weatherNotes, weatherPending } =
    bundle;
  const nothing = !bundle.hasWeatherSection && !bundle.hasThermalsSection;

  if (nothing) {
    return (
      <Card>
        <p className="text-sm text-muted-foreground">
          Nothing is known about this day: no weather notes, no modelled
          conditions, and no thermal shared by two pilots.
        </p>
      </Card>
    );
  }

  return (
    <>
      {bundle.hasWeatherSection ? (
        <Card aria-labelledby="weather-heading" className="gap-3">
          <h2 id="weather-heading" className="scroll-mt-20 text-lg font-semibold">
            What the weather did
          </h2>
          {/* The organizer's own account first — a human who was there
              outranks a grid cell. */}
          <WeatherNotesBlock notes={weatherNotes} />
          {/* One shared time axis, so the predicted day can be read against
              the day the field actually flew. */}
          <DayProfilePanel
            metrics={dayMetrics}
            compTimezone={comp?.timezone ?? null}
            weather={weather.data?.weather ?? null}
            weatherPending={weatherPending}
          />
        </Card>
      ) : null}

      {bundle.hasThermalsSection && report.thermals ? (
        <Card aria-labelledby="thermals-heading" className="gap-3">
          <h2 id="thermals-heading" className="scroll-mt-20 text-lg font-semibold">
            The day's thermals
          </h2>
          <ThermalsPanel
            thermals={report.thermals}
            compTimezone={comp?.timezone ?? null}
            weather={weather.data?.weather ?? null}
            weatherPending={weatherPending}
            replayHrefFor={(thermalId) =>
              compId && taskId
                ? `/replay?comp=${encodeURIComponent(compId)}&task=${encodeURIComponent(taskId)}&thermal=${thermalId}`
                : null
            }
          />
        </Card>
      ) : null}
    </>
  );
}

/** Every pilot against every behaviour: the heatmap, then the numbers. */
function PilotsSection({
  bundle,
  report,
}: {
  bundle: ReturnType<typeof useTaskFieldAnalysis>;
  report: FrameCtx["report"];
}) {
  const grouped = useMemo(() => metricsByFamily(report.metrics), [report]);

  // Families containing a top-3 metric open by default — the separation page
  // has already told the reader those are the ones worth opening.
  const topFamilies = useMemo(
    () =>
      new Set(
        rankMetrics(report.metrics)
          .slice(0, 3)
          .map((r) => r.metric.family)
      ),
    [report]
  );
  const [expandedOverride, setExpandedOverride] = useState<Set<string> | null>(null);
  const expanded = expandedOverride ?? topFamilies;
  const expandFamily = (family: string, isExpanded: boolean) =>
    setExpandedOverride((prev) => {
      const next = new Set(prev ?? topFamilies);
      if (isExpanded) next.add(family);
      else next.delete(family);
      return next;
    });

  return (
    <>
      <Card aria-labelledby="heatmap-heading" className="gap-3">
        <h2 id="heatmap-heading" className="scroll-mt-20 text-lg font-semibold">
          The whole field at a glance
        </h2>
        <PercentileHeatmap report={report} />
      </Card>

      <Card aria-labelledby="families-heading" className="gap-2">
        <h2 id="families-heading" className="scroll-mt-20 text-lg font-semibold">
          The metrics in detail
        </h2>
        {FAMILY_ORDER.filter(
          (family) => ((grouped.get(family) ?? []) as MetricReport[]).length > 0
        ).map((family) => (
          <MetricFamilySection
            key={family}
            family={family}
            familyLabel={FAMILY_LABELS[family]}
            metrics={grouped.get(family) ?? []}
            report={report}
            compTimezone={bundle.comp?.timezone ?? null}
            isExpanded={expanded.has(family)}
            onExpandedChange={(isExpanded) => expandFamily(family, isExpanded)}
          />
        ))}
      </Card>
    </>
  );
}

/** Pilots grouped by how alike they flew, and the way in to comparing one
 *  pilot against the rest. */
function StylesSection({
  bundle,
  report,
}: {
  bundle: ReturnType<typeof useTaskFieldAnalysis>;
  report: FrameCtx["report"];
}) {
  const { compId, taskId, comp, task, styleClusters } = bundle;
  return (
    // No heading of its own: the page's h1 already says "Pilot style clusters",
    // and repeating it as an h2 would be the same words twice.
    <Card className="gap-3">
      <StyleClusters report={report} clusters={styleClusters} headingLevel={2} />
      {/* Its own page rather than a section: it is an interactive sheet with
          its own controls, and the reader picks a pilot and a behaviour set
          rather than reading. */}
      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        <LinkButton
          href={taskSimilarityPath(compId, comp?.name, taskId, task?.name)}
          variant="outline"
          size="sm"
        >
          Who flew like me?
        </LinkButton>
        <span className="text-sm text-muted-foreground">
          Pick a pilot and a set of behaviours, and see which other pilots flew
          most like them.
        </span>
      </div>
    </Card>
  );
}

/** The reference material: consulted once, and never in the reading flow. */
function MethodSection({
  active,
  report,
}: {
  active: FrameCtx["active"];
  report: FrameCtx["report"];
}) {
  return (
    // Each note is one of this page's own sections, so they are h2s — an h3
    // straight under the h1 would skip a level. They share one card: they are
    // four readings of the same subject, not four chapters.
    <Card className="gap-6">
      {active.excluded.length > 0 ? (
        <ExcludedPilots excluded={active.excluded} level={2} />
      ) : null}
      {/* Visible here, unlike under the comp report's table: explaining the
          reading IS this page. */}
      <HowToReadFootnote
        page="task"
        level={2}
        printOnly={false}
        behaviourCount={rankMetrics(report.metrics).length}
      />
      <MethodNote gridStepSeconds={report.basis.gridStepSeconds} level={2} />
      <MetricGlossary entries={report.metrics} nested headingLevel={2} />
    </Card>
  );
}
