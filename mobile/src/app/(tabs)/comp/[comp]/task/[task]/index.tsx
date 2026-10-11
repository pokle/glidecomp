/**
 * A task (IA §7): its card with any stopped or closed state in words, the
 * route, and the day's weather. Scores arrive in stage 3.
 */
import { calculateOptimizedTaskDistance, formatDistance } from '@glidecomp/engine';
import { formatTaskDate } from '@glidecomp/client/format';
import { idFromSegment, taskPath, taskRoutePath, taskWeatherPath } from '@glidecomp/client/slug';
import type { CompDetailData, TaskDetailData } from '@glidecomp/client/types';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { View } from 'react-native';

import { useComp, useTask } from '@/api/queries';
import { taskStatusLines } from '@/lib/task-status';
import { useUnits } from '@/settings/units';
import { GroupedList, Group, Note, Row } from '@/ui/grouped-list';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';

export default function TaskScreen() {
  const params = useLocalSearchParams<{ comp: string; task: string }>();
  const compId = idFromSegment(params.comp);
  const taskId = idFromSegment(params.task);
  const comp = useComp(compId);
  const task = useTask(compId, taskId);
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: task.data?.name ?? '' }} />
      <StaleBanner query={task} />
      <QueryGate
        query={task}
        loading="Loading the task…"
        notFound="This task doesn’t exist, or isn’t public.">
        {(data) => <TaskBody task={data} comp={comp.data} />}
      </QueryGate>
    </View>
  );
}

function TaskBody({ task, comp }: { task: TaskDetailData; comp: CompDetailData | undefined }) {
  const prefs = useUnits();
  const distance = useMemo(() => {
    if (!task.xctsk) return null;
    try {
      return calculateOptimizedTaskDistance(task.xctsk);
    } catch {
      return null;
    }
  }, [task.xctsk]);
  const status = taskStatusLines(task, comp);
  const compName = comp?.name;
  const go = (path: string) => () => router.push(path as never);
  return (
    <GroupedList testID="task-screen">
      <Group>
        <Row
          title="Date"
          value={formatTaskDate(task.task_date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
        />
        {task.pilot_classes.length > 0 ? <Row title="Classes" value={task.pilot_classes.join(', ')} /> : null}
        {status.map((line) => (
          <Row key={line.title} testID="task-status" title={line.title} detail={line.detail} />
        ))}
      </Group>

      <Group title="Route">
        {task.xctsk ? (
          <>
            <Row
              title="Turnpoints"
              value={String(task.xctsk.turnpoints.length)}
              onPress={go(taskRoutePath(task.comp_id, compName, task.task_id, task.name))}
            />
            {distance != null ? (
              <Row title="Distance" value={formatDistance(distance, { prefs, decimals: 1 }).withUnit} />
            ) : null}
          </>
        ) : (
          <Note>Route not set yet.</Note>
        )}
      </Group>

      <Group title="The day">
        <Row
          title="Weather"
          detail={task.weather_notes.trim() ? 'Organiser’s notes and the forecast' : 'The forecast'}
          onPress={go(taskWeatherPath(task.comp_id, compName, task.task_id, task.name))}
        />
      </Group>

      <Group title="Results">
        <Row
          title="Task scores"
          onPress={go(`${taskPath(task.comp_id, compName, task.task_id, task.name)}/scores`)}
        />
      </Group>
    </GroupedList>
  );
}
