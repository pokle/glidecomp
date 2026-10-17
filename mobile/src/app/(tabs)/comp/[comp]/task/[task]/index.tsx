/**
 * A task (IA §7): its card with any stopped or closed state in words, the
 * route, the day's weather, the results — and, by role, the reader's own
 * track (registered pilots) and the organiser's rows (`is_admin`).
 */
import { calculateOptimizedTaskDistance, formatDistance } from '@glidecomp/engine';
import type { PilotFlight } from '@glidecomp/client/account';
import { formatTaskDate, isPastCloseDate, ordinal } from '@glidecomp/client/format';
import { idFromSegment, pilotPath, taskPath, taskRoutePath, taskWeatherPath } from '@glidecomp/client/slug';
import type { CompDetailData, TaskDetailData } from '@glidecomp/client/types';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { View } from 'react-native';

import { useComp, useMyFlights, useRegistrations, useTask } from '@/api/queries';
import { useUserId } from '@/auth/session';
import { flightOnTask, submittedWhen } from '@/lib/yours';
import { taskStatusLines } from '@/lib/task-status';
import { useUnits } from '@/settings/units';
import { ActionRow, GroupedList, Group, Note, Row } from '@/ui/grouped-list';
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
  const userId = useUserId();
  const registered = !!useRegistrations(userId).data?.some((r) => r.comp_id === task.comp_id);
  const flights = useMyFlights(registered ? userId : null);
  const base = taskPath(task.comp_id, compName, task.task_id, task.name);
  const go = (path: string) => () => router.push(path as never);
  // The website's rule: nobody submits after the comp closes; a task closed
  // for submissions still takes tracks from its organisers.
  const canSubmit = !!comp && !isPastCloseDate(comp.close_date) && (!task.submissions_closed || comp.is_admin);
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

      {canSubmit ? (
        <Group>
          <ActionRow
            testID="task-submit"
            title="Submit track"
            onPress={() =>
              router.push({ pathname: '/submit', params: { comp: task.comp_id, task: task.task_id } } as never)
            }
          />
        </Group>
      ) : null}

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
        <Row title="Task scores" onPress={go(`${base}/scores`)} />
      </Group>

      {registered ? (
        <Group title="Your track" testID="your-track">
          <YourTrack
            flight={flightOnTask(flights.data, task.task_id)}
            loading={flights.data === undefined}
            timeZone={comp?.timezone ?? null}
            taskDate={task.task_date}
            open={(f) => router.push(pilotPath(task.comp_id, compName, task.task_id, task.name, f.comp_pilot_id, undefined) as never)}
          />
        </Group>
      ) : null}

      {comp?.is_admin ? (
        <Group title="Organiser" testID="organiser">
          <Row title="Pilots & tracks" value={String(task.track_count)} onPress={go(`${base}/pilots`)} />
          <Row title="Task settings" onPress={go(`${base}/settings`)} />
        </Group>
      ) : null}
    </GroupedList>
  );
}

function YourTrack({
  flight,
  loading,
  timeZone,
  taskDate,
  open,
}: {
  flight: PilotFlight | null;
  loading: boolean;
  timeZone: string | null;
  taskDate: string;
  open: (flight: PilotFlight) => void;
}) {
  if (!flight) return <Note>{loading ? 'Looking for your track…' : 'No track from you yet.'}</Note>;
  const title =
    flight.kind === 'manual'
      ? 'Flight recorded by the organiser'
      : `Submitted ${submittedWhen(flight.recorded_at, taskDate, timeZone)}`;
  return (
    <Row
      testID="your-flight"
      title={title}
      value={flight.rank != null && flight.class_size != null ? `${ordinal(flight.rank)} of ${flight.class_size}` : undefined}
      detail={flight.rank == null ? 'Not scored yet' : undefined}
      onPress={() => open(flight)}
    />
  );
}
