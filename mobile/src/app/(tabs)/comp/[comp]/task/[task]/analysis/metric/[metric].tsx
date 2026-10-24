/**
 * One behaviour on this task (stage 8): what it measures, how it lined up
 * with rank, and every pilot's reading in rank order — the exact numbers a
 * chart on the website draws. A null is "not applicable", never zero, and
 * the top of the field going without a reading is said out loud.
 */
import { rhoText } from '@glidecomp/client/analysis';
import { notableExcludedRanks, notableRanksPhrase } from '@glidecomp/client/analysis-exclusions';
import { directionWords, unitWords, verdictWords } from '@glidecomp/client/analysis-units';
import { formatMetricValue } from '@glidecomp/engine';
import { useLocalSearchParams } from 'expo-router';

import { AnalysisFrame } from '@/analysis/AnalysisFrame';
import { tableGroup } from '@/analysis/table-group';
import { useAnalysis } from '@/analysis/use-analysis';
import { DayProfileChart } from '@/charts/DayProfileChart';
import { useUnits } from '@/settings/units';
import { Embedded, Group, Note, Row } from '@/ui/grouped-list';

export default function MetricScreen() {
  const { metric: id } = useLocalSearchParams<{ metric: string }>();
  const view = useAnalysis();
  const prefs = useUnits();
  const label = view.report?.metrics.find((m) => m.id === id)?.label ?? 'Behaviour';
  return (
    <AnalysisFrame view={view} title={label} testID="analysis-metric">
      {({ report }) => {
        const m = report.metrics.find((x) => x.id === id);
        if (!m) return [<Group key="none"><Note>This behaviour isn’t in this task’s analysis.</Note></Group>];
        const byTrack = new Map(m.perPilot.map((p) => [p.trackFile, p]));
        const missingTop = notableExcludedRanks(report.pilots, m.perPilot);
        const c = m.correlation;
        return [
          <Group key="about">
            <Note>{m.explanation}</Note>
            <Row title="Direction" value={directionWords(m.direction)} />
            {c ? (
              <Row
                title="Against rank"
                value={rhoText(c.rho)}
                detail={`${verdictWords(c.verdict)} · ${c.n} pilots${c.noiseFloor !== undefined ? ` · noise floor ${c.noiseFloor.toFixed(2)}` : ''}`}
              />
            ) : (
              <Row title="Against rank" detail="Too few pilots with a reading, or no spread between them." />
            )}
            {m.error ? <Note>{`Couldn’t be measured: ${m.error}`}</Note> : null}
            {(m.fieldSummary ?? []).map((line, i) => (
              <Note key={i}>{line}</Note>
            ))}
            {missingTop.length > 0 ? <Note>{`No reading for ${notableRanksPhrase(missingTop)}.`}</Note> : null}
          </Group>,
          ...((m.extraSeries ?? []).length > 0
            ? [
                <Group key="chart" title="Through the day">
                  <Embedded>
                    <DayProfileChart series={m.extraSeries ?? []} timeZone={view.timeZone} prefs={prefs} />
                  </Embedded>
                </Group>,
              ]
            : []),
          <Group key="pilots" title={`Every pilot, in rank order (${unitWords(m.unit)})`} testID="metric-pilots">
            {report.pilots.map((p) => {
              const v = byTrack.get(p.trackFile);
              return (
                <Row
                  key={p.trackFile}
                  title={`${p.rank}. ${p.pilotName}`}
                  value={v?.value == null ? '—' : `${formatMetricValue(m.unit, v.value)} ${m.unit === 'count' || m.unit === 'ratio' ? '' : m.unit}`.trim()}
                  detail={v?.note}
                />
              );
            })}
          </Group>,
          ...(m.extraTables ?? []).map((t, i) => tableGroup(t, view.timeZone, `t${i}`)),
        ];
      }}
    </AnalysisFrame>
  );
}
