/**
 * Competition analysis (stage 8): the same separation question asked across
 * every task — a pure aggregation over the stored task analyses. Behaviours
 * rank by their mean signed ρ, so the ones that pulled the same way every
 * day come first; each row says how consistently, and every task's own ρ.
 *
 * Each task analysis is linked under its own TASK (the comp analysis collects
 * them, it is not their parent).
 */
import { compAnalysisRows, consistencyWords, rhoText } from '@glidecomp/client/analysis';
import { idFromSegment, taskAnalysisPath } from '@glidecomp/client/slug';
import type { CompMetricAggregate } from '@glidecomp/engine';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { useComp, useCompAnalysis } from '@/api/queries';
import { ChoiceRow } from '@/ui/choice-row';
import { GroupedList, Group, Note, Row } from '@/ui/grouped-list';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';

function perTask(m: CompMetricAggregate, labels: string[]): string {
  return m.perTaskRho
    .map((rho, i) => `${labels[i] ?? `T${i + 1}`} ${rho === null ? '—' : rhoText(rho).replace('ρ ', '')}`)
    .join(' · ');
}

export default function CompAnalysisScreen() {
  const { comp: segment } = useLocalSearchParams<{ comp: string }>();
  const compId = idFromSegment(segment);
  const comp = useComp(compId);
  const analysis = useCompAnalysis(compId);
  const [cls, setCls] = useState<string | null>(null);
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'Analysis', headerLargeTitle: false }} />
      <StaleBanner query={analysis} />
      <QueryGate query={analysis} loading="Loading the analysis…" notFound="This competition doesn’t exist, or isn’t public.">
        {(data) => {
          const active = data.classes.find((c) => c.pilot_class === cls) ?? data.classes[0];
          const rows = active ? compAnalysisRows(active.aggregate) : null;
          const labels = active?.aggregate.taskLabels ?? data.task_labels;
          return (
            <GroupedList testID="comp-analysis">
              {data.pending_task_count > 0 ? (
                <Group>
                  <Note>{`Working this out: ${data.pending_task_count} of ${data.total_task_count} tasks are still being analysed. This screen fills in as they land.`}</Note>
                </Group>
              ) : null}
              {data.classes.length > 1 && active ? (
                <Group>
                  <ChoiceRow
                    testID="comp-analysis-class"
                    title="Class"
                    value={active.pilot_class}
                    choices={data.classes.map((c) => ({ value: c.pilot_class, label: c.pilot_class }))}
                    onChange={setCls}
                  />
                </Group>
              ) : null}
              {rows && rows.ranked.length > 0 ? (
                <Group title="Which behaviours went with better ranks, across tasks" testID="comp-analysis-ranked">
                  <Note>Sorted so the behaviours that pulled the same way on every task come first.</Note>
                  {rows.ranked.map((m) => (
                    <Row
                      key={m.id}
                      title={m.label}
                      value={m.meanSignedRho === null ? undefined : rhoText(m.meanSignedRho)}
                      detail={`${consistencyWords(m.consistency, m.signSummary.negative + m.signSummary.positive)} · ${perTask(m, labels)}`}
                    />
                  ))}
                  {rows.uncorrelated.length > 0 ? (
                    <Note>{`${rows.uncorrelated.length} more ${rows.uncorrelated.length === 1 ? 'metric describes' : 'metrics describe'} the day, not a pilot, so they have no row here.`}</Note>
                  ) : null}
                </Group>
              ) : (
                <Group>
                  <Note>No behaviour has a correlation in any task yet.</Note>
                </Group>
              )}
              {rows && rows.outcomes.length > 0 ? (
                <Group title="Checks on the scoring">
                  <Note>They are here as a check on the analysis. A weak pattern means that something is wrong in the numbers, and not in the flying of any pilot.</Note>
                  {rows.outcomes.map((m) => (
                    <Row key={m.id} title={m.label} value={m.meanSignedRho === null ? undefined : rhoText(m.meanSignedRho)} detail={perTask(m, labels)} />
                  ))}
                </Group>
              ) : null}
              <Group title="Each task’s analysis">
                {data.tasks.map((t) => (
                  <Row
                    key={t.task_id}
                    testID={`comp-analysis-task-${t.task_id}`}
                    title={t.task_name}
                    detail={t.label}
                    onPress={() => router.push(taskAnalysisPath(compId, comp.data?.name, t.task_id, t.task_name) as never)}
                  />
                ))}
              </Group>
            </GroupedList>
          );
        }}
      </QueryGate>
    </View>
  );
}
