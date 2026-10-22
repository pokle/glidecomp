/**
 * Weather notes (stage 7): the organiser's account of the day — what the
 * model's grid cell cannot know. Not a scoring input: the server audit-logs
 * an edit with an excerpt and never marks scores stale (docs/weather.md).
 * The website's TaskWeatherNotes, in its words.
 */
import { idFromSegment } from '@glidecomp/client/slug';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { updateTask } from '@/api/organiser';
import { useTask } from '@/api/queries';
import { NotesForm } from '@/components/NotesForm';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';

export default function WeatherNotesScreen() {
  const params = useLocalSearchParams<{ comp: string; task: string }>();
  const compId = idFromSegment(params.comp);
  const taskId = idFromSegment(params.task);
  const task = useTask(compId, taskId);
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'Weather notes', headerLargeTitle: false }} />
      <StaleBanner query={task} />
      <QueryGate query={task} loading="Loading the task…" notFound="This task doesn’t exist, or isn’t public.">
        {(data) => (
          <NotesForm
            testID="weather-notes"
            label="What did the day do?"
            placeholder={'e.g. Slow start, inversion broke about 12:30.\nOverdeveloped by 2pm over the back range.'}
            hint="Shown to everyone on this task and alongside the task analysis charts. Plain text; line breaks are kept."
            saved={data.weather_notes}
            save={(text) => updateTask(compId, taskId, { weather_notes: text })}
            onSaved={() => router.back()}
          />
        )}
      </QueryGate>
    </View>
  );
}
