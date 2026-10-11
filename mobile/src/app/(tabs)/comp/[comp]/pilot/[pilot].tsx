/**
 * A pilot's series: where they stand in their class, and what every task
 * contributed. On an FTV comp a task can count in part or not at all, so each
 * row says how it counted — the website's FtvBreakdown, in the same words —
 * and the total still adds up in front of the reader.
 */
import { formatScore, formatTaskDate, ordinal } from '@glidecomp/client/format';
import type { PilotTaskEntry, TaskInfo } from '@glidecomp/client/scores-views';
import { idFromSegment, pilotPath } from '@glidecomp/client/slug';
import type { CompScores } from '@glidecomp/client/types';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { useComp, useCompScores } from '@/api/queries';
import { findSeriesPilot } from '@/lib/yours';
import { Freshness } from '@/ui/Freshness';
import { Group, GroupedList, Note, Row } from '@/ui/grouped-list';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';

export default function PilotSeriesScreen() {
  const params = useLocalSearchParams<{ comp: string; pilot: string }>();
  const compId = idFromSegment(params.comp);
  const pilotId = idFromSegment(params.pilot);
  const comp = useComp(compId);
  const scores = useCompScores(compId);
  return (
    <View style={{ flex: 1 }}>
      <StaleBanner query={scores} />
      <QueryGate query={scores} loading="Loading the scores…" notFound="This competition doesn’t exist, or isn’t public.">
        {(data) => (
          <SeriesBody scores={data} pilotId={pilotId} compName={comp.data?.name} timeZone={comp.data?.timezone ?? null} />
        )}
      </QueryGate>
    </View>
  );
}

function SeriesBody({
  scores,
  pilotId,
  compName,
  timeZone,
}: {
  scores: CompScores;
  pilotId: string;
  compName: string | undefined;
  timeZone: string | null;
}) {
  const found = findSeriesPilot(scores, pilotId);
  if (!found) {
    return (
      <GroupedList>
        <Stack.Screen options={{ title: 'Pilot' }} />
        <Group>
          <Note>This pilot has no scores in this competition.</Note>
        </Group>
      </GroupedList>
    );
  }
  const { pilot, pilotClass, fieldSize } = found;
  const ftv = scores.series_scoring === 'ftv';
  const tasks = scores.tasks
    .filter((t) => t.classes.includes(pilotClass))
    .sort((a, b) => a.task_date.localeCompare(b.task_date));
  const discardShare = scores.ftv_factor != null ? ` (${Math.round(scores.ftv_factor * 100)}% of total validity discarded)` : '';
  return (
    <GroupedList testID="pilot-series">
      <Stack.Screen options={{ title: pilot.pilot_name }} />
      <Group>
        <Freshness computedAt={scores.computed_at} stale={scores.stale} timeZone={timeZone} />
        <Row title="Class" value={pilotClass} />
        <Row title="Place" value={`${ordinal(pilot.rank)} of ${fieldSize}`} />
        <Row title={ftv ? 'FTV total' : 'Total'} value={formatScore(pilot.total_score)} testID="series-total" />
      </Group>
      {ftv ? (
        <Group title="Fixed Total Validity">
          <Note>{`Best tasks are kept until the fixed validity cap is reached${discardShare}.`}</Note>
        </Group>
      ) : null}
      <Group title="Tasks">
        {tasks.map((task) => (
          <TaskRow
            key={task.task_id}
            task={task}
            entry={pilot.tasks.find((t) => t.task_id === task.task_id)}
            ftv={ftv}
            open={() =>
              router.push(
                pilotPath(scores.comp_id, compName, task.task_id, task.task_name, pilot.comp_pilot_id, pilot.pilot_name) as never,
              )
            }
          />
        ))}
      </Group>
    </GroupedList>
  );
}

function TaskRow({
  task,
  entry,
  ftv,
  open,
}: {
  task: TaskInfo;
  entry: PilotTaskEntry | undefined;
  ftv: boolean;
  open: () => void;
}) {
  const date = formatTaskDate(task.task_date, { day: 'numeric', month: 'short' });
  if (!entry) return <Row title={task.task_name} detail={`${date} · not flown`} />;
  let how = `${ordinal(entry.rank)} on the day`;
  let value = formatScore(entry.score);
  if (ftv && entry.ftv_status === 'discarded') {
    how = 'Discarded under FTV';
  } else if (ftv && entry.ftv_status === 'partial') {
    how = `Counted in part: ${formatScore(entry.ftv_counted_score ?? 0)} of ${formatScore(entry.score)}`;
    value = formatScore(entry.ftv_counted_score ?? entry.score);
  }
  return (
    <Row
      testID={`series-task-${task.task_id}`}
      title={task.task_name}
      detail={`${date} · ${how}`}
      value={value}
      onPress={open}
    />
  );
}
