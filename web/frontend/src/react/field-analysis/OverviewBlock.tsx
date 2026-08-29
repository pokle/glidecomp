/**
 * OverviewBlock — the task field-analysis summary and navigation block at the
 * top of /comp/:id/analysis/task/:id (issue #673).
 *
 * Two jobs, in this order:
 *  1. Overview: a reader who spends four seconds at scroll 0 knows what this
 *     report contains and what the day was.
 *  2. Navigation: single-tap / click jump to any section of the report, moving
 *     keyboard focus to the section heading (WCAG 2.4.11).
 *
 * Replaces and absorbs the standalone FindingsDigest card, which becomes the
 * full-size centrepiece of "What separated the field".
 *
 * Semantics: a <nav aria-label="Report contents"> landmark containing four
 * labelled stages of anchor links.
 *
 * SSR-safe: deterministic time formatting via comp timezone, no window/document
 * at module scope, safe useUnits fallback on the server.
 */
import type { Key } from "react-aria-components";
import { Badge } from "@/react/rac/badge";
import { CardTitle, cardSurface } from "@/react/rac/card";
import { scrollToSection } from "@/react/lib/scroll-to-section";
import { formatTimeRange } from "@/react/lib/time";
import { useUnits } from "@/react/lib/units";
import { cn } from "@/react/lib/utils";
import { FindingsDigest } from "./FindingsDigest";
import { rankMetrics } from "./SeparationRanking";
import { windLabel } from "./charts/day-profile/shared";
import { unitDisplay } from "./units";
import {
  FAMILY_ORDER,
  combineWindEstimates,
  formatMetricValue,
  type ClimbHourlySeries,
  type FieldAnalysisReport,
  type MetricFamily,
  type MetricReport,
  type StyleClusterReport,
  type WindHourlySeries,
} from "./types";
import type { TaskWeather } from "@/react/weather/types";

export interface OverviewBlockProps {
  report: FieldAnalysisReport;
  excluded: { pilot_name: string; reason: string }[];
  grouped: Map<MetricFamily, MetricReport[]>;
  dayMetrics: MetricReport[];
  weather?: TaskWeather | null;
  weatherPending?: boolean;
  compTimezone?: string | null;
  hasWeatherSection: boolean;
  hasThermalsSection: boolean;
  hasDebrief: boolean;
  styleClusters?: StyleClusterReport | null;
  onPickMetric?: (id: Key) => void;
}

interface OverviewNodeProps {
  href: string;
  label: string;
  state: string;
  tag?: string;
  className?: string;
  onBeforeScroll?: () => void;
}

function OverviewNode({
  href,
  label,
  state,
  tag,
  className,
  onBeforeScroll,
}: OverviewNodeProps) {
  const targetId = href.replace(/^#/, "");
  return (
    <a
      href={href}
      onClick={(e) => {
        if (
          e.defaultPrevented ||
          e.button !== 0 ||
          e.metaKey ||
          e.ctrlKey ||
          e.altKey ||
          e.shiftKey
        ) {
          return;
        }
        e.preventDefault();
        scrollToSection(targetId, onBeforeScroll);
      }}
      className={cn(
        cardSurface,
        "group flex min-h-11 flex-col justify-between gap-1 p-3 text-left transition-colors outline-none",
        "hover:bg-muted/40",
        "focus-visible:ring-2 focus-visible:ring-ring/50",
        className
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-semibold text-foreground group-hover:underline">
          {label}
        </span>
        {tag ? (
          <Badge variant="secondary" className="shrink-0 text-[11px] font-normal">
            {tag}
          </Badge>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{state}</p>
    </a>
  );
}

export function OverviewBlock({
  report,
  excluded,
  grouped,
  dayMetrics,
  weather = null,
  compTimezone = null,
  hasWeatherSection,
  hasThermalsSection,
  hasDebrief,
  styleClusters = null,
  onPickMetric,
}: OverviewBlockProps) {
  const units = useUnits();

  // ── Stage 1: The day they flew ───────────────────────────────────────────
  // 1. Analysis basis
  const pilotCount = report.basis.pilotCount;
  const basisState = report.basis.analysisWindow
    ? `${pilotCount} pilot${pilotCount === 1 ? "" : "s"} · ${formatTimeRange(
        report.basis.analysisWindow.from,
        report.basis.analysisWindow.to,
        compTimezone ?? undefined
      )}`
    : `${pilotCount} pilot${pilotCount === 1 ? "" : "s"} analysed`;

  // 2. What the weather did (§5.1)
  const windSeries = dayMetrics
    .flatMap((m) => m.extraSeries ?? [])
    .find((s) => s.kind === "wind-hourly") as WindHourlySeries | undefined;
  const climbSeries = dayMetrics
    .flatMap((m) => m.extraSeries ?? [])
    .find((s) => s.kind === "climb-hourly") as ClimbHourlySeries | undefined;

  let trackWindPart: string | null = null;
  if (
    windSeries?.wholeTask &&
    windSeries.wholeTask.speedKmh != null &&
    windSeries.wholeTask.directionDeg != null
  ) {
    const speedConv = unitDisplay("km/h", units);
    const speed = windSeries.wholeTask.speedKmh * speedConv.factor;
    trackWindPart = windLabel(speed, speedConv.unit, windSeries.wholeTask.directionDeg);
  }

  let trackClimbPart: string | null = null;
  if (
    climbSeries?.wholeTask?.median != null &&
    Number.isFinite(climbSeries.wholeTask.median)
  ) {
    const climbConv = unitDisplay("m/s", units);
    const climbVal = climbSeries.wholeTask.median * climbConv.factor;
    trackClimbPart = `climbs ${formatMetricValue(climbConv.unit, climbVal)} ${climbConv.unit}`;
  }

  let weatherState = "How the wind, climbs and cloudbase moved through the day";
  let weatherTag: string | undefined;

  if (trackWindPart || trackClimbPart) {
    // Case 1: From the pilots' tracks
    weatherState = [trackWindPart, trackClimbPart].filter(Boolean).join(" · ");
    weatherTag = "From the pilots' tracks";
  } else if (weather?.hours && weather.hours.length > 0) {
    // Case 2: From the weather model (when tracks have no wholeTask circling wind/climb)
    const validHours = weather.hours.filter(
      (h) => h.surface.windSpeedKmh != null && h.surface.windDirectionDeg != null
    );
    if (validHours.length > 0) {
      const samples = validHours.map((h) => ({
        speed: h.surface.windSpeedKmh!,
        direction: h.surface.windDirectionDeg!,
      }));
      const combined = combineWindEstimates(samples);
      if (combined) {
        const speedConv = unitDisplay("km/h", units);
        const speed = combined.speed * speedConv.factor;
        weatherState = windLabel(speed, speedConv.unit, combined.direction);
        weatherTag = "From the weather model";
      }
    }
  }

  // 3. The day's thermals
  const thermalCount = report.basis.multiPilotThermalCount;
  const thermalsState = `${thermalCount} thermal${
    thermalCount === 1 ? "" : "s"
  } shared by two or more pilots`;

  // ── Stage 2: What separated the field ────────────────────────────────────
  const rankedBehaviorsCount = rankMetrics(report.metrics).length;
  const rankingState =
    rankedBehaviorsCount > 0
      ? `All ${rankedBehaviorsCount} behaviours, strongest correlation first`
      : "All behaviours, strongest correlation first";

  // ── Stage 3: Where each pilot sat ────────────────────────────────────────
  const clusters = styleClusters?.clusters ?? [];
  const styleClustersState =
    clusters.length > 0
      ? `${clusters.length} group${clusters.length === 1 ? "" : "s"} — ${clusters
          .map((c) => c.label)
          .join(", ")}`
      : "Too few pilots to group by style";

  // ── Stage 4: How it was measured ─────────────────────────────────────────
  const activeFamiliesCount = FAMILY_ORDER.filter(
    (f) => (grouped.get(f) ?? []).length > 0
  ).length;
  const totalMetricsCount = report.metrics.length;
  const metricsDetailState = `${activeFamiliesCount} ${
    activeFamiliesCount === 1 ? "family" : "families"
  } · ${totalMetricsCount} metric${totalMetricsCount === 1 ? "" : "s"}, with their charts`;

  const excludedCount = excluded.length;
  const footnotesState =
    excludedCount > 0
      ? `${excludedCount} pilot${excludedCount === 1 ? "" : "s"} not analysed · ${totalMetricsCount} metric definition${
          totalMetricsCount === 1 ? "" : "s"
        }`
      : "How the field is compared, and every metric defined";

  return (
    <nav aria-label="Report contents" className="my-4 space-y-4">
      {/* ── STAGE 1: THE DAY THEY FLEW ─────────────────────────────────────── */}
      <section aria-labelledby="stage-day-heading" className="space-y-2">
        <CardTitle as="h2" id="stage-day-heading">
          The day they flew
        </CardTitle>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <OverviewNode
            href="#analysis-basis"
            label="Analysis basis"
            state={basisState}
          />
          {hasWeatherSection ? (
            <OverviewNode
              href="#weather-heading"
              label="What the weather did"
              state={weatherState}
              tag={weatherTag}
            />
          ) : null}
          {hasThermalsSection ? (
            <OverviewNode
              href="#thermals-heading"
              label="The day's thermals"
              state={thermalsState}
              className={!hasWeatherSection ? "sm:col-span-1" : "sm:col-span-2 lg:col-span-1"}
            />
          ) : null}
        </div>
      </section>

      {/* ── STAGE 2: WHAT SEPARATED THE FIELD ───────────────────────────────── */}
      <section aria-labelledby="stage-separation-heading" className="space-y-2">
        <CardTitle as="h2" id="stage-separation-heading">
          What separated the field
        </CardTitle>
        <div className={cn(cardSurface, "space-y-3 p-4")}>
          <FindingsDigest
            metrics={report.metrics}
            onPickMetric={onPickMetric}
            nested
          />
          <div className="grid grid-cols-1 gap-2 border-t pt-3 sm:grid-cols-2">
            {hasDebrief ? (
              <OverviewNode
                href="#debrief-heading"
                label="Task debrief"
                state="What this task did differently from the rest of the comp"
              />
            ) : null}
            <OverviewNode
              href="#separation-heading"
              label="Behaviour ranking"
              state={rankingState}
              className={!hasDebrief ? "sm:col-span-2" : undefined}
            />
          </div>
        </div>
      </section>

      {/* ── STAGES 3 & 4: WHERE EACH PILOT SAT & HOW IT WAS MEASURED ────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Stage 3 */}
        <section aria-labelledby="stage-pilots-heading" className="space-y-2">
          <CardTitle as="h2" id="stage-pilots-heading">
            Where each pilot sat
          </CardTitle>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <OverviewNode
              href="#heatmap-heading"
              label="Field at a glance"
              state="Every pilot against every behaviour, as percentiles"
            />
            <OverviewNode
              href="#clusters-heading"
              label="Style clusters"
              state={styleClustersState}
            />
          </div>
        </section>

        {/* Stage 4 */}
        <section aria-labelledby="stage-method-heading" className="space-y-2">
          <CardTitle as="h2" id="stage-method-heading">
            How it was measured
          </CardTitle>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <OverviewNode
              href="#families-heading"
              label="The metrics in detail"
              state={metricsDetailState}
            />
            <OverviewNode
              href="#footnotes-heading"
              label="Footnotes"
              state={footnotesState}
            />
          </div>
        </section>
      </div>
    </nav>
  );
}
