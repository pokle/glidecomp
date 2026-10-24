/**
 * Task → Send to instrument (IA §7): this task's route as an XCTrack task
 * file, its turnpoints in every waypoint format, or a QR for the briefing.
 */
import { idFromSegment } from '@glidecomp/client/slug';
import { Stack, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { useTask } from '@/api/queries';
import { SendToInstrument } from '@/components/SendToInstrument';
import { GroupedList, Group, Note } from '@/ui/grouped-list';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';

export default function SendTaskScreen() {
  const params = useLocalSearchParams<{ comp: string; task: string }>();
  const compId = idFromSegment(params.comp);
  const taskId = idFromSegment(params.task);
  const task = useTask(compId, taskId);
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'Send to instrument' }} />
      <StaleBanner query={task} />
      <QueryGate query={task} loading="Loading the task…" notFound="This task doesn’t exist, or isn’t public.">
        {(data) =>
          data.xctsk ? (
            <SendToInstrument
              source={{ kind: 'task', name: data.name, task: data.xctsk }}
              qrParams={{ comp: compId, task: taskId }}
              noun="turnpoint"
            />
          ) : (
            <GroupedList>
              <Group>
                <Note>Route not set yet, so there is nothing to send.</Note>
              </Group>
            </GroupedList>
          )
        }
      </QueryGate>
    </View>
  );
}
