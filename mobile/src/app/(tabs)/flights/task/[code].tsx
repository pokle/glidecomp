/**
 * A task from the reader's own library, to send to an instrument — the same
 * screen a competition task's Send to instrument opens.
 */
import { Stack, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { useLibraryTask } from '@/api/queries';
import { useUserId } from '@/auth/session';
import { SendToInstrument } from '@/components/SendToInstrument';
import { GroupedList, Group, Note } from '@/ui/grouped-list';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';

export default function LibraryTaskScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const task = useLibraryTask(useUserId(), code);
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: task.data?.display_name ?? 'Task' }} />
      <StaleBanner query={task} />
      <QueryGate query={task} loading="Loading the task…" notFound="This task isn’t in your library any more.">
        {(data) =>
          data.xctsk ? (
            <SendToInstrument
              source={{ kind: 'task', name: data.display_name, task: data.xctsk }}
              qrParams={{ code }}
              noun="turnpoint"
            />
          ) : (
            <GroupedList>
              <Group>
                <Note>This task file has no route.</Note>
              </Group>
            </GroupedList>
          )
        }
      </QueryGate>
    </View>
  );
}
