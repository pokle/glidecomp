/**
 * One section of a task's analysis, on its own page.
 *
 * /comp/:compId/task/:taskId/analysis/:section — five sections, one route, one
 * component. They are five views of ONE report (see analysis/sections.ts
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
import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Card } from "@/react/rac/card";
import { Explain } from "@/react/rac/explain";
import { NotFound } from "../components/NotFound";
import { idFromSegment, taskAnalysisSectionPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { TaskAnalysisFrame } from "../analysis/TaskAnalysisFrame";
import { useTaskAnalysis } from "../analysis/use-task-report";
import { findTaskAnalysisSection } from "../analysis/sections";
import { SeparationRanking, rankMetrics } from "../analysis/SeparationRanking";
import { HowToReadFootnote, OneDayCaveatNote } from "../analysis/ReadingNotes";
import {
  MetricFamilySection,
  metricsByFamily,
} from "../analysis/MetricFamilySection";
import { TaskDebrief } from "../analysis/TaskDebrief";
import { MetricGlossary } from "../analysis/MetricGlossary";
import { ExcludedPilots, MethodNote } from "../analysis/Footnotes";
import { StyleClusters } from "../analysis/StyleClusters";
import { ThermalsPanel } from "../analysis/thermals/ThermalsPanel";
import { DayProfilePanel } from "../analysis/charts/day-profile/DayProfilePanel";
import { WeatherNotesBlock } from "../weather/WeatherNotesBlock";
import {
  FAMILY_ORDER,
  FAMILY_LABELS,
  type MetricReport,
} from "../analysis/types";

export function TaskAnalysisSection() {
  const { section: sectionParam } = useParams<{ section: string }>();
  const section = findTaskAnalysisSection(sectionParam);
  const bundle = useTaskAnalysis();
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
  if (!section) return <NotFound title="Task analysis section not found" />;

  return (
    <TaskAnalysisFrame
      bundle={bundle}
      section={section}
      // Only the pages with per-pilot rows or dots to tint.
      pilotPicker={["strategies", "metrics", "style"].includes(section.slug)}
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
  bundle: ReturnType<typeof useTaskAnalysis>;
  active: FrameCtx["active"];
  report: FrameCtx["report"];
}) {
  switch (slug) {
    case "strategies":
      return <StrategiesSection bundle={bundle} active={active} report={report} />;
    case "weather":
      return <WeatherSection bundle={bundle} />;
    case "thermals":
      return <ThermalsSection bundle={bundle} report={report} />;
    case "metrics":
      return <MetricsSection bundle={bundle} report={report} />;
    case "style":
      return <StyleSection bundle={bundle} report={report} />;
    case "method":
      return <MethodSection active={active} report={report} />;
    default:
      return null;
  }
}

/** Which behaviours went with better ranks, and where this task disagreed
 *  with the rest of the competition. */
function StrategiesSection({
  bundle,
  active,
  report,
}: {
  bundle: ReturnType<typeof useTaskAnalysis>;
  active: FrameCtx["active"];
  report: FrameCtx["report"];
}) {
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
        <SeparationRanking metrics={report.metrics} report={report} />
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

/** The organiser's account of the day, and the day's own profile. */
function WeatherSection({ bundle }: { bundle: ReturnType<typeof useTaskAnalysis> }) {
  const { comp, dayMetrics, weather, weatherNotes, weatherPending } = bundle;

  if (!bundle.hasWeatherSection) {
    return (
      <Card>
        <p className="text-sm text-muted-foreground">
          Nothing is known about this day's weather: no notes from the
          organiser, and no modelled conditions.
        </p>
      </Card>
    );
  }

  return (
    <Card aria-labelledby="weather-heading" className="gap-3">
      <h2 id="weather-heading" className="scroll-mt-20 text-lg font-semibold">
        What the weather did
      </h2>
      {/* The organizer's own account first — a human who was there outranks a
          grid cell. */}
      <WeatherNotesBlock notes={weatherNotes} />
      {/* One shared time axis, so the predicted day can be read against the
          day the field actually flew. */}
      <DayProfilePanel
        metrics={dayMetrics}
        compTimezone={comp?.timezone ?? null}
        weather={weather.data?.weather ?? null}
        weatherPending={weatherPending}
      />
    </Card>
  );
}

/** The day reconstructed from the tracks: where the lift sat, which way it
 *  leaned, which side worked. */
function ThermalsSection({
  bundle,
  report,
}: {
  bundle: ReturnType<typeof useTaskAnalysis>;
  report: FrameCtx["report"];
}) {
  const { comp, compId, taskId, weather, weatherPending } = bundle;

  if (!bundle.hasThermalsSection || !report.thermals) {
    return (
      <Card>
        <p className="text-sm text-muted-foreground">
          No thermal on this task was shared by two pilots, so there is nothing
          to reconstruct: a thermal's shape comes from the tracks that circled
          it together.
        </p>
      </Card>
    );
  }

  return (
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
  );
}

/** Every pilot's reading on every behaviour, family by family. */
function MetricsSection({
  bundle,
  report,
}: {
  bundle: ReturnType<typeof useTaskAnalysis>;
  report: FrameCtx["report"];
}) {
  const grouped = useMemo(() => metricsByFamily(report.metrics), [report]);

  // Families containing a top-3 metric open by default — the strategies page
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

  // No heading of its own: the page's h1 already says what this is, and the
  // families below carry their own.
  return (
    <Card className="gap-2">
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
          headingLevel={2}
          isExpanded={expanded.has(family)}
          onExpandedChange={(isExpanded) => expandFamily(family, isExpanded)}
        />
      ))}
    </Card>
  );
}

/** Pilots grouped by how alike they flew. */
function StyleSection({
  bundle,
  report,
}: {
  bundle: ReturnType<typeof useTaskAnalysis>;
  report: FrameCtx["report"];
}) {
  // No heading of its own: the page's h1 already says "Flying style", and
  // repeating it as an h2 would be the same words twice. The similarity sheet
  // is a box of its own on the summary rather than a door out of this page —
  // it is a sibling tool, not a detail of the clusters.
  return (
    <Card className="gap-3">
      <StyleClusters report={report} clusters={bundle.styleClusters} headingLevel={2} />
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
