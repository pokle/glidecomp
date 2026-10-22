/**
 * Task analysis (stage 8): a CONTENTS LIST, as on the website — one row per
 * section, each with its one line of this-task fact and no explanation (that
 * is on the other side of the row). Presentation order is fixed and is the
 * finding: the behaviours that separated the field first, then the day, then
 * where each pilot sat. A section with nothing in it gets no row.
 *
 * Above the rows, what belongs to no one section: how many made goal, how
 * the airtime divided, and how many pilots the scores hold that this could
 * not measure.
 */
import { formatAirtimeHours, fieldFact, thermalsFact, windFact } from '@glidecomp/client/analysis-basis';
import { rankMetrics, STRATEGY_VERDICTS, winningLabel } from '@glidecomp/client/analysis';
import { TASK_ANALYSIS_SECTIONS, type TaskAnalysisSectionSlug } from '@glidecomp/client/analysis-sections';
import { router } from 'expo-router';

import { AnalysisFrame } from '@/analysis/AnalysisFrame';
import { splitText } from '@/analysis/split';
import { useAnalysis } from '@/analysis/use-analysis';
import { useUnits } from '@/settings/units';
import { Group, Row } from '@/ui/grouped-list';

export default function TaskAnalysisScreen() {
  const view = useAnalysis();
  const prefs = useUnits();
  return (
    <AnalysisFrame view={view} title="Task analysis" testID="task-analysis">
      {({ report, active }) => {
        const zone = view.timeZone ?? undefined;
        const strategies = rankMetrics(report.metrics)
          .filter((r) => STRATEGY_VERDICTS.has(r.correlation.verdict))
          .slice(0, 3);
        const wind = windFact(view.dayMetrics, prefs);
        const facts: Partial<Record<TaskAnalysisSectionSlug, string>> = {
          strategies: [strategies.length > 0 ? strategies.map((r) => winningLabel(r.metric, r.correlation.rho)).join(' · ') : 'No clear pattern', fieldFact(report.basis, zone)].join('\n'),
          weather: wind ?? (view.weatherNotes.trim() ? 'Notes from the organiser' : undefined),
          thermals: thermalsFact(report.basis, prefs),
          metrics: `${report.metrics.length} behaviours`,
          style: view.styleClusters ? `${view.styleClusters.k} groups` : undefined,
        };
        const empty = (slug: TaskAnalysisSectionSlug) =>
          (slug === 'style' && !view.styleClusters) ||
          (slug === 'weather' && !view.hasWeatherSection) ||
          (slug === 'thermals' && !view.hasThermalsSection);
        const basis = report.basis;
        const goal = basis.goalCount !== undefined && basis.pilotCount > 0 ? basis.goalCount : null;
        const rows = TASK_ANALYSIS_SECTIONS.filter((s) => !empty(s.slug));
        const method = rows.findIndex((s) => s.slug === 'method');
        return [
          <Group key="basis" title="This task" testID="analysis-basis">
            {goal !== null ? (
              <Row title="Made goal" value={`${goal} of ${basis.pilotCount} (${Math.round((100 * goal) / basis.pilotCount)}%)`} />
            ) : null}
            {basis.airtimeSplit ? (
              <Row title="Airtime split" detail={`${splitText(basis.airtimeSplit)} · ${formatAirtimeHours(basis.airtimeSplit.airborneSeconds)} in all`} />
            ) : null}
            {active.excluded.length > 0 ? (
              <Row
                testID="analysis-excluded"
                title={`${active.excluded.length} ${active.excluded.length === 1 ? 'pilot is' : 'pilots are'} in the scores but not in this analysis`}
                detail="Which, and why"
                onPress={() => router.push(view.href('/method') as never)}
              />
            ) : null}
          </Group>,
          <Group key="sections" title="Sections" testID="analysis-sections">
            {[
              ...rows.slice(0, method === -1 ? rows.length : method).map((s) => (
                <Row key={s.slug} testID={`analysis-section-${s.slug}`} title={s.label} detail={facts[s.slug]} onPress={() => router.push(view.href(`/${s.slug}`) as never)} />
              )),
              <Row key="similar" testID="analysis-section-similar" title="Similar pilots" onPress={() => router.push(view.href('/similar') as never)} />,
              ...rows.slice(method === -1 ? rows.length : method).map((s) => (
                <Row key={s.slug} testID={`analysis-section-${s.slug}`} title={s.label} detail={facts[s.slug]} onPress={() => router.push(view.href(`/${s.slug}`) as never)} />
              )),
            ]}
          </Group>,
        ];
      }}
    </AnalysisFrame>
  );
}
