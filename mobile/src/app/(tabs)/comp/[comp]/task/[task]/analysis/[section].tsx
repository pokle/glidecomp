/**
 * One section of a task's analysis, on its own screen (stage 8) — the
 * website's TaskAnalysisSection, as grouped rows. One report behind every
 * section (`useAnalysis`), so no screen can disagree with another about the
 * class it shows. Tables are the exact reading; the day's charts sit above
 * theirs on one shared time axis.
 */
import { metricsByFamily, rankMetrics, rhoText, winningLabel } from '@glidecomp/client/analysis';
import { directionWords, unitWords, verdictWords } from '@glidecomp/client/analysis-units';
import { findTaskAnalysisSection } from '@glidecomp/client/analysis-sections';
import { formatTimeRange } from '@glidecomp/client/time';
import {
  FAMILY_LABELS,
  FAMILY_ORDER,
  MIN_CORRELATION_N,
  formatAltitude,
  formatMetricValue,
  type MetricReport,
  type TaskAnalysisReport,
} from '@glidecomp/engine';
import { router, useLocalSearchParams } from 'expo-router';
import type { ReactElement } from 'react';

import { AnalysisFrame } from '@/analysis/AnalysisFrame';
import { tableGroup } from '@/analysis/table-group';
import { useAnalysis, type AnalysisView } from '@/analysis/use-analysis';
import { DayProfileChart } from '@/charts/DayProfileChart';
import { useUnits } from '@/settings/units';
import { Embedded, Group, Note, Row } from '@/ui/grouped-list';
import type { UnitPreferences } from '@glidecomp/engine';

export default function AnalysisSectionScreen() {
  const { section: slug } = useLocalSearchParams<{ section: string }>();
  const section = findTaskAnalysisSection(slug);
  const view = useAnalysis();
  const prefs = useUnits();
  return (
    <AnalysisFrame view={view} title={section?.label ?? 'Task analysis'} testID={`analysis-${slug}`}>
      {({ report, active }) => {
        if (!section) return [<Group key="none"><Note>There’s no such section of the analysis.</Note></Group>];
        const lede = <Group key="lede"><Note>{section.lede}</Note></Group>;
        switch (section.slug) {
          case 'strategies':
            return [lede, ...strategies(report, view)];
          case 'weather':
            return [lede, ...weather(view, prefs)];
          case 'thermals':
            return [lede, ...thermals(report, view, prefs)];
          case 'metrics':
            return [lede, ...metrics(report, view)];
          case 'style':
            return [lede, ...style(view)];
          case 'method':
            return [lede, ...method(report, active.excluded)];
          default:
            return [lede];
        }
      }}
    </AnalysisFrame>
  );
}

const metricRow = (view: AnalysisView, m: MetricReport, title: string, detail?: string) => (
  <Row
    key={m.id}
    testID={`analysis-metric-${m.id}`}
    title={title}
    detail={detail}
    value={m.correlation ? rhoText(m.correlation.rho) : undefined}
    onPress={() => router.push(view.href(`/metric/${encodeURIComponent(m.id)}`) as never)}
  />
);

/** Which behaviours went with better ranks; outcome checks kept apart. */
function strategies(report: TaskAnalysisReport, view: AnalysisView): ReactElement[] {
  const ranked = rankMetrics(report.metrics);
  const outcomes = report.metrics.filter((m) => m.outcome && m.correlation);
  return [
    <Group key="ranked" title="Which behaviours went with better ranks">
      {ranked.length === 0 ? <Note>Too few pilots with comparable readings to rank any behaviour.</Note> : null}
      {ranked.map(({ metric, correlation }) =>
        metricRow(
          view,
          metric,
          winningLabel(metric, correlation.rho),
          `${verdictWords(correlation.verdict)} · ${correlation.n} pilots`,
        ),
      )}
    </Group>,
    <Group key="caveat">
      <Note>
        {`Rank ${ranked.length} behaviours against one day’s ranks and a few will look strong on luck alone — the ones worth believing are those that repeat across tasks in the competition-level analysis.`}
      </Note>
    </Group>,
    ...(outcomes.length > 0
      ? [
          <Group key="outcomes" title="Checks on the scoring">
            <Note>They are here as a check on the analysis. A weak pattern means that something is wrong in the numbers, and not in the flying of any pilot.</Note>
            {outcomes.map((m) => metricRow(view, m, m.label, m.correlation ? verdictWords(m.correlation.verdict) : undefined))}
          </Group>,
        ]
      : []),
  ];
}

/** The organiser's account first, then the day the tracks describe. */
function weather(view: AnalysisView, prefs: UnitPreferences): ReactElement[] {
  if (!view.hasWeatherSection) {
    return [
      <Group key="none">
        <Note>Nothing is known about this day’s weather: no notes from the organiser, and no modelled conditions.</Note>
      </Group>,
    ];
  }
  const series = view.dayMetrics.flatMap((m) => m.extraSeries ?? []);
  const tables = view.dayMetrics.flatMap((m) => (m.extraTables ?? []).map((t, i) => ({ t, key: `${m.id}-${i}` })));
  return [
    <Group key="notes" title="The organiser’s notes">
      <Note>{view.weatherNotes.trim() || 'No notes from the organisers for this day.'}</Note>
    </Group>,
    ...(series.length > 0
      ? [
          <Group key="chart" title="What the tracks say the day did">
            <Embedded testID="day-profile-host">
              <DayProfileChart series={series} timeZone={view.timeZone} prefs={prefs} />
            </Embedded>
          </Group>,
        ]
      : []),
    ...tables.map(({ t, key }) => tableGroup(t, view.timeZone, key)),
    <Group key="forecast">
      <Row
        title="The modelled weather"
        detail="The forecast or reanalysis for this task, on the Weather screen"
        onPress={() => router.push(`/comp/${view.compId}/task/${view.taskId}/weather` as never)}
      />
    </Group>,
  ];
}

/** The thermals the field shared, and how each leaned. */
function thermals(report: TaskAnalysisReport, view: AnalysisView, prefs: UnitPreferences): ReactElement[] {
  const shapes = report.thermals?.shapes ?? [];
  if (shapes.length === 0) {
    return [
      <Group key="none">
        <Note>No thermal on this task was shared by two pilots, so there is nothing to reconstruct: a thermal’s shape comes from the tracks that circled it together.</Note>
      </Group>,
    ];
  }
  const zone = view.timeZone ?? undefined;
  return [
    <Group key="shapes" title={`${shapes.length} of ${report.thermals!.totalShapeCount} shared thermals`}>
      {shapes.map((s) => {
        const bottom = s.bands[0]?.altMin;
        const top = s.bands[s.bands.length - 1]?.altMax;
        const best = Math.max(...s.bands.map((b) => b.meanVario));
        return (
          <Row
            key={s.id}
            testID={`thermal-${s.id}`}
            title={formatTimeRange(new Date(s.startMs).toISOString(), new Date(s.endMs).toISOString(), zone)}
            value={`${s.pilotCount} pilots`}
            detail={[
              bottom !== undefined && top !== undefined
                ? `${formatAltitude(bottom, { prefs }).formatted}–${formatAltitude(top, { prefs }).withUnit}`
                : null,
              Number.isFinite(best) ? `best band ${best.toFixed(1)} m/s` : null,
              s.lean && !s.lean.confounded ? `leans ${Math.round(s.lean.tiltDeg)}° toward ${Math.round(s.lean.bearing)}°` : null,
              s.strongestSide ? `strongest side ${Math.round(s.strongestSide.bearing)}°` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          />
        );
      })}
    </Group>,
  ];
}

/** Every behaviour, family by family; each opens its per-pilot readings. */
function metrics(report: TaskAnalysisReport, view: AnalysisView): ReactElement[] {
  const grouped = metricsByFamily(report.metrics);
  return FAMILY_ORDER.filter((f) => (grouped.get(f) ?? []).length > 0).map((family) => (
    <Group key={family} title={FAMILY_LABELS[family]}>
      {(grouped.get(family) ?? []).map((m) =>
        metricRow(view, m, m.label, m.error ? `Couldn’t be measured: ${m.error}` : m.correlation ? verdictWords(m.correlation.verdict) : 'No correlation'),
      )}
    </Group>
  ));
}

/** Pilots grouped by how alike they flew. */
function style(view: AnalysisView): ReactElement[] {
  const sc = view.styleClusters;
  if (!sc) return [<Group key="none"><Note>Too few pilots have enough comparable readings to group, so this field has no style groups.</Note></Group>];
  return [
    <Group key="about">
      <Note>{sc.explanation}</Note>
      <Note>{`${sc.k} groups of ${sc.pilotCount} pilots, over ${sc.metricCount} behaviours. Silhouette ${sc.meanSilhouette.toFixed(2)}: near 0 the boundaries are arbitrary, near 1 the groups are tight.`}</Note>
    </Group>,
    ...sc.clusters.map((c) => (
      <Group key={c.id} title={`Group ${c.id} — ${c.label}`}>
        <Note>{`${c.members.length} pilots · ranks ${c.rankBest}–${c.rankWorst} · median ${Math.round(c.rankMedian)}`}</Note>
        {c.signatures.length === 0 ? <Note>Near field-typical on every metric — no strong signature.</Note> : null}
        {c.signatures.map((s) => (
          <Row
            key={s.metricId}
            title={`${s.deviation > 0 ? 'High' : 'Low'} — ${s.label}`}
            detail={`group median P${Math.round(s.medianPercentile)} in this field (${formatMetricValue(s.unit, s.medianValue)} ${unitWords(s.unit)})${s.hint === 'strength' ? ' · usually a strength' : s.hint === 'cost' ? ' · usually costly' : ''}`}
          />
        ))}
        <Note>{c.members.map((m) => (m.trackFile === c.exemplarTrackFile ? `${m.pilotName} ★` : m.pilotName)).join(', ')}</Note>
      </Group>
    )),
  ];
}

/** Who could not be analysed, how the field is compared, and what each metric means. */
function method(report: TaskAnalysisReport, excluded: { pilot_name: string; reason: string }[]): ReactElement[] {
  return [
    ...(excluded.length > 0
      ? [
          <Group key="excluded" title={`${excluded.length} ${excluded.length === 1 ? 'pilot' : 'pilots'} in the scores but not in this analysis`} testID="analysis-excluded-list">
            {excluded.map((e, i) => (
              <Row key={i} title={e.pilot_name} detail={e.reason} />
            ))}
            <Note>The correlations are measured against the published ranks, and those ranks include these pilots. Their behaviour cannot be measured without a tracklog.</Note>
          </Group>,
        ]
      : []),
    <Group key="compare" title="How the field is compared">
      <Note>
        {`Everything that compares pilots to each other uses one shared clock. GlideComp resamples every track onto a common ${report.basis.gridStepSeconds}-second grid, so two pilots are always compared at the same instant, whatever rate their instruments logged at.`}
      </Note>
    </Group>,
    <Group key="read" title="How to read this">
      <Note>Spearman’s rank correlation, ρ, between the behaviour and the published ranks. A bigger ρ means the behaviour tracked the ranks more closely on this task.</Note>
      <Note>Rank 1 is the best rank, so a behaviour where more is better shows a negative ρ.</Note>
      <Note>{`A clear pattern is |ρ| ≥ 0.5, some pattern ≥ 0.3 and faint pattern below — each only once the coefficient is bigger than chance alone produces at that many pilots (its noise floor). Could be chance (in the statistics: within noise) means shuffling the ranks produces a coefficient that size more than 5% of the time. Too few pilots is fewer than ${MIN_CORRELATION_N} pilots with a value — not enough to tell either way.`}</Note>
    </Group>,
    <Group key="glossary" title="What each metric means">
      {report.metrics.map((m) => (
        <Row key={m.id} title={m.label} detail={`${m.explanation} (${directionWords(m.direction)})`} />
      ))}
    </Group>,
  ];
}
