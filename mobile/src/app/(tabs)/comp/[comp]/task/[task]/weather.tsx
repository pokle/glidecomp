/**
 * The day → Weather (IA §7): the organiser's account first, then the
 * model's. A prediction is never read as a record (docs/weather.md): the
 * group is named for its source's kind — "Forecast" for a day still to come —
 * and the credit says it is a grid cell, not a reading at launch.
 */
import { sampleProvenance } from '@glidecomp/client/met';
import { idFromSegment } from '@glidecomp/client/slug';
import { sourceKindLabel, type TaskWeatherData } from '@glidecomp/client/weather';
import { Stack, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { useComp, useTask, useTaskWeather } from '@/api/queries';
import { weatherRows } from '@/lib/weather-hours';
import { useUnits } from '@/settings/units';
import { GroupedList, Group, Note, Row } from '@/ui/grouped-list';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function WeatherScreen() {
  const params = useLocalSearchParams<{ comp: string; task: string }>();
  const compId = idFromSegment(params.comp);
  const taskId = idFromSegment(params.task);
  const weather = useTaskWeather(compId, taskId);
  const comp = useComp(compId);
  useTask(compId, taskId);
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'Weather' }} />
      <StaleBanner query={weather} />
      <QueryGate query={weather} loading="Loading the day’s weather…" notFound="This task doesn’t exist, or isn’t public.">
        {(data) => <WeatherBody data={data} timeZone={comp.data?.timezone ?? null} />}
      </QueryGate>
    </View>
  );
}

function WeatherBody({ data, timeZone }: { data: TaskWeatherData; timeZone: string | null }) {
  const prefs = useUnits();
  const notes = data.notes.trim();
  const w = data.weather;
  const rows = w ? weatherRows(w, timeZone, prefs) : [];
  return (
    <GroupedList testID="weather">
      <Group title="Organiser’s notes">
        <Note>{notes || 'No notes from the organisers for this day.'}</Note>
      </Group>
      {w && rows.length > 0 ? (
        <>
          <Group title={capitalise(sourceKindLabel(w.source.kind))}>
            {rows.map((row) => (
              <Row key={row.key} title={row.time} value={row.wind} detail={row.detail || undefined} />
            ))}
          </Group>
          <Group>
            <Note>
              {`${capitalise(sourceKindLabel(w.source.kind))} data from ${w.source.attribution} (${w.source.model}, ${w.source.license}). Sampled at ${w.source.pointLat.toFixed(3)}, ${w.source.pointLon.toFixed(3)}${sampleProvenance(w)} A grid cell, not a reading at launch — the organiser’s notes are the local ground truth.`}
            </Note>
          </Group>
        </>
      ) : (
        <Group title="Forecast">
          <Note>
            {data.too_far_ahead
              ? 'This task is further ahead than the forecast reaches. The conditions will appear here about two weeks out.'
              : data.pending
                ? 'Fetching the day’s weather — it will appear here in a moment.'
                : 'No weather for this task.'}
          </Note>
        </Group>
      )}
    </GroupedList>
  );
}
