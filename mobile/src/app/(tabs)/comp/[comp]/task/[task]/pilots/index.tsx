/**
 * Pilots & tracks (IA §11, Q7 — the organiser's most-used screen during a
 * comp): one row per pilot flying this task, those needing the organiser
 * first — no track yet, or a track a data-quality check withheld. A row
 * opens the pilot's sheet: status, penalty, upload on their behalf, a manual
 * flight, delete or restore, and the quality ruling.
 */
import { idFromSegment } from '@glidecomp/client/slug';
import { formatTimeOfDay } from '@glidecomp/client/time';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { View } from 'react-native';

import { useComp, useManualFlights, usePilotStatuses, useRoster, useTask, useTaskScore, useTaskTracks } from '@/api/queries';
import { pilotStateLine, pilotTaskRows } from '@/lib/pilots-tracks';
import { withheldReasons } from '@/lib/withheld';
import { GroupedList, Group, Note, Row } from '@/ui/grouped-list';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';

export default function PilotsAndTracks() {
  const params = useLocalSearchParams<{ comp: string; task: string }>();
  const compId = idFromSegment(params.comp);
  const taskId = idFromSegment(params.task);
  const comp = useComp(compId);
  const task = useTask(compId, taskId);
  const roster = useRoster(compId);
  const tracks = useTaskTracks(compId, taskId);
  const statuses = usePilotStatuses(compId, taskId);
  const manual = useManualFlights(compId, taskId);
  const score = useTaskScore(compId, taskId);
  const zone = comp.data?.timezone ?? undefined;

  const rows = useMemo(
    () =>
      pilotTaskRows({
        roster: roster.data ?? [],
        taskClasses: task.data?.pilot_classes ?? [],
        tracks: tracks.data ?? [],
        statuses: statuses.data ?? [],
        manual: manual.data ?? [],
        withheld: withheldReasons(score.data),
      }),
    [roster.data, task.data, tracks.data, statuses.data, manual.data, score.data],
  );
  const attention = rows.filter((r) => r.needsAttention);
  const settled = rows.filter((r) => !r.needsAttention);
  const open = (pilotId: string) => () => router.push(`/comp/${params.comp}/task/${params.task}/pilots/${pilotId}` as never);

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'Pilots & tracks' }} />
      <StaleBanner query={tracks} />
      <QueryGate query={roster} loading="Loading the pilots…" notFound="This competition doesn’t exist, or isn’t public.">
        {() => (
          <GroupedList testID="pilots-tracks">
            {rows.length === 0 ? (
              <Group>
                <Note>No pilots fly this task’s classes yet. Add them under the competition’s Pilots.</Note>
              </Group>
            ) : null}
            {attention.length > 0 ? (
              <Group title={`Needs attention · ${attention.length}`} testID="needs-attention">
                {attention.map((r) => (
                  <Row
                    key={r.pilot.comp_pilot_id}
                    testID={`pilot-task-${r.pilot.comp_pilot_id}`}
                    title={r.pilot.name}
                    detail={`${r.pilot.pilot_class} · ${pilotStateLine(r.state, (iso) => formatTimeOfDay(iso, zone))}`}
                    onPress={open(r.pilot.comp_pilot_id)}
                  />
                ))}
              </Group>
            ) : null}
            {settled.length > 0 ? (
              <Group title={`Settled · ${settled.length}`}>
                {settled.map((r) => (
                  <Row
                    key={r.pilot.comp_pilot_id}
                    testID={`pilot-task-${r.pilot.comp_pilot_id}`}
                    title={r.pilot.name}
                    detail={`${r.pilot.pilot_class} · ${pilotStateLine(r.state, (iso) => formatTimeOfDay(iso, zone))}`}
                    onPress={open(r.pilot.comp_pilot_id)}
                  />
                ))}
              </Group>
            ) : null}
          </GroupedList>
        )}
      </QueryGate>
    </View>
  );
}
