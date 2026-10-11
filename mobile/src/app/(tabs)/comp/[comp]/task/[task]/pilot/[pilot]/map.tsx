/**
 * The report card's track map, full screen: the route, the pilot's flight,
 * and — opened from a line of the explanation — where that line happened.
 * The tracklog loads on its own; until it arrives (or for a manual flight
 * with none) the map shows the task and the markers.
 */
import { idFromSegment } from '@glidecomp/client/slug';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { View } from 'react-native';

import { useFixes, useReportCard } from '@/lib/use-report-card';
import { TrackMap } from '@/map/TrackMap';
import { ReportCardGate } from '@/ui/ReportCardGate';

export default function TrackMapScreen() {
  const params = useLocalSearchParams<{ comp: string; task: string; pilot: string; item?: string }>();
  const compId = idFromSegment(params.comp);
  const taskId = idFromSegment(params.task);
  const pilotId = idFromSegment(params.pilot);
  const { state } = useReportCard(compId, taskId, pilotId);
  const { fixes } = useFixes(compId, taskId, pilotId);
  const card = state.kind === 'ready' ? state.card : null;
  const events = useMemo(() => (card ? [...card.eventsByItem.values()] : []), [card]);
  const focus = card && params.item ? (card.eventsByItem.get(params.item) ?? null) : null;
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'Track map', headerLargeTitle: false }} />
      <ReportCardGate state={state} compId={compId} taskId={taskId}>
        {(c) => (
          <TrackMap
            task={c.mapTask}
            fixes={fixes}
            events={events}
            focus={focus}
            openDistanceLine={c.openDistanceLine}
            bestProgressRoute={c.bestProgressRoute}
            timeZone={c.comp.timezone ?? null}
          />
        )}
      </ReportCardGate>
    </View>
  );
}
