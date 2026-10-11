/**
 * Route → Turnpoints (IA §7): the start and goal in the website's words,
 * then every turnpoint. Altitudes in the reader's unit; a zero altitude is a
 * known one, and an absent one is simply not printed. Cylinder radii are
 * always metres: they are the task's own numbers.
 */
import { formatAltitude, formatCylinderRadius, type Turnpoint } from '@glidecomp/engine';
import { goalSummary, startConfigSummary, TYPE_LABELS } from '@glidecomp/client/route';
import { idFromSegment } from '@glidecomp/client/slug';
import { Stack, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { useComp, useTask } from '@/api/queries';
import { useUnits } from '@/settings/units';
import { GroupedList, Group, Note, Row } from '@/ui/grouped-list';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';

function role(tp: Turnpoint, index: number, count: number): string {
  if (tp.type) return TYPE_LABELS[tp.type] ?? tp.type;
  return index === count - 1 ? TYPE_LABELS.GOAL : TYPE_LABELS[''];
}

export default function RouteScreen() {
  const params = useLocalSearchParams<{ comp: string; task: string }>();
  const compId = idFromSegment(params.comp);
  const task = useTask(compId, idFromSegment(params.task));
  const comp = useComp(compId);
  const prefs = useUnits();
  const zone = comp.data?.timezone ?? null;
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'Turnpoints' }} />
      <StaleBanner query={task} />
      <QueryGate query={task} loading="Loading the route…" notFound="This task doesn’t exist, or isn’t public.">
        {(data) => {
          const xctsk = data.xctsk;
          if (!xctsk) {
            return (
              <GroupedList>
                <Group>
                  <Note>Route not set yet.</Note>
                </Group>
              </GroupedList>
            );
          }
          const count = xctsk.turnpoints.length;
          const when = { timeZone: zone, taskDate: data.task_date };
          return (
            <GroupedList testID="turnpoints">
              {xctsk.sss || xctsk.goal ? (
                <Group>
                  {xctsk.sss ? (
                    <Row title="Start of speed section" detail={startConfigSummary(xctsk.sss, when)} />
                  ) : null}
                  {xctsk.goal ? <Row title="Goal" detail={goalSummary(xctsk.goal, when)} /> : null}
                </Group>
              ) : null}
              <Group title={`${count} ${count === 1 ? 'turnpoint' : 'turnpoints'}`}>
                {xctsk.turnpoints.map((tp, i) => {
                  const alt = tp.waypoint.altSmoothed;
                  return (
                    <Row
                      key={i}
                      testID={`turnpoint-${i}`}
                      title={`${i + 1}. ${tp.waypoint.name}`}
                      detail={[
                        role(tp, i, count),
                        tp.waypoint.description || null,
                        alt != null && Number.isFinite(alt) ? formatAltitude(alt, { prefs }).withUnit : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                      value={formatCylinderRadius(tp.radius).withUnit}
                    />
                  );
                })}
              </Group>
            </GroupedList>
          );
        }}
      </QueryGate>
    </View>
  );
}
