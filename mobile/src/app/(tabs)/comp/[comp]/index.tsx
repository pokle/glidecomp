/**
 * A competition (IA §6): its card, its tasks by day (every task alike, #514),
 * then Results and Competition rows. Read-only and signed out in stage 2; the
 * "You" group and organiser rows arrive with sign-in in stage 4.
 */
import { formatTaskDate, formatTaskDateRange, scoringFormatLabel } from '@glidecomp/client/format';
import {
  compAnalysisPath,
  compPath,
  compScoresPath,
  compWaypointsPath,
  idFromSegment,
  taskPath,
} from '@glidecomp/client/slug';
import type { CompDetailData } from '@glidecomp/client/types';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { useComp } from '@/api/queries';
import { wingLabel } from '@/lib/labels';
import { groupTasksByDay } from '@/lib/task-days';
import { GroupedList, Group, Note, Row } from '@/ui/grouped-list';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';

export default function CompScreen() {
  const { comp: segment } = useLocalSearchParams<{ comp: string }>();
  const comp = useComp(idFromSegment(segment));
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: comp.data?.name ?? '' }} />
      <StaleBanner query={comp} />
      <QueryGate
        query={comp}
        loading="Loading the competition…"
        notFound="This competition doesn’t exist, or isn’t public.">
        {(data) => <CompBody comp={data} />}
      </QueryGate>
    </View>
  );
}

function CompBody({ comp }: { comp: CompDetailData }) {
  const days = groupTasksByDay(comp.tasks);
  const dates = comp.tasks.map((t) => t.task_date).sort();
  const go = (path: string) => () => router.push(path as never);
  return (
    <GroupedList testID="comp-screen">
      <Group>
        <Row title="Wing" value={wingLabel(comp.category)} />
        <Row title="Scoring" value={scoringFormatLabel(comp.scoring_format)} />
        {comp.pilot_classes.length > 0 ? (
          <Row title="Classes" value={comp.pilot_classes.join(', ')} />
        ) : null}
        <Row
          title="Dates"
          value={dates.length > 0 ? formatTaskDateRange(dates[0], dates[dates.length - 1]) : 'No tasks yet'}
        />
        {comp.admins.length > 0 ? (
          <Row
            title={comp.admins.length === 1 ? 'Organiser' : 'Organisers'}
            detail={comp.admins.map((a) => a.name || a.email).join(', ')}
          />
        ) : null}
      </Group>

      {days.length === 0 ? (
        <Group title="Tasks">
          <Note>No tasks yet.</Note>
        </Group>
      ) : (
        days.map((day) => (
          <Group key={day.date} title={formatTaskDate(day.date, { weekday: 'long', day: 'numeric', month: 'long' })}>
            {day.tasks.map((task) => (
              <Row
                key={task.task_id}
                testID={`task-row-${task.task_id}`}
                title={task.name}
                detail={
                  [task.pilot_classes.join(', '), task.has_xctsk ? null : 'Route not set yet']
                    .filter(Boolean)
                    .join(' · ') || undefined
                }
                onPress={go(taskPath(comp.comp_id, comp.name, task.task_id, task.name))}
              />
            ))}
          </Group>
        ))
      )}

      <Group title="Results">
        <Row title="Scores" onPress={go(compScoresPath(comp.comp_id, comp.name))} />
        <Row title="Analysis" onPress={go(compAnalysisPath(comp.comp_id, comp.name))} />
      </Group>

      <Group title="Competition">
        <Row title="Waypoints" onPress={go(compWaypointsPath(comp.comp_id, comp.name))} />
        <Row title="Activity" onPress={go(`${compPath(comp.comp_id, comp.name)}/activity`)} />
      </Group>
    </GroupedList>
  );
}
