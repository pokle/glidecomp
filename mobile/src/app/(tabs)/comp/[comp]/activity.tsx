/**
 * Activity (IA §12): the competition's audit log — its public transparency
 * record — newest first, grouped by the day it happened in the
 * competition's zone, with the website's filters. Every entry is the
 * sentence the server wrote when the change was made (root CLAUDE.md: every
 * mutation that could affect scores is audited, in words), so the screen
 * only lays it out.
 *
 * Kept on the phone like every read, a page at a time; "Show older" asks
 * for the next.
 */
import { ACTIVITY_FILTERS, groupActivityByDay, type ActivityFilter } from '@glidecomp/client/audit';
import { formatTaskDate } from '@glidecomp/client/format';
import { idFromSegment } from '@glidecomp/client/slug';
import { formatTimeOfDay } from '@glidecomp/client/time';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { useActivity, useComp } from '@/api/queries';
import { ChoiceRow } from '@/ui/choice-row';
import { ActionRow, GroupedList, Group, Note, Row } from '@/ui/grouped-list';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';

export default function CompActivity() {
  const { comp: segment } = useLocalSearchParams<{ comp: string }>();
  const compId = idFromSegment(segment);
  const comp = useComp(compId);
  const [filter, setFilter] = useState<ActivityFilter>('');
  const activity = useActivity(compId, filter);
  const zone = comp.data?.timezone ?? null;
  const entries = useMemo(() => activity.data?.pages.flatMap((p) => p.entries) ?? [], [activity.data]);
  const days = useMemo(() => groupActivityByDay(entries, zone), [entries, zone]);
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'Activity' }} />
      <StaleBanner query={activity} />
      <QueryGate query={activity} loading="Loading the activity…" notFound="This competition doesn’t exist, or isn’t public.">
        {() => (
          <GroupedList testID="activity">
            <Group>
              <ChoiceRow
                testID="activity-filter"
                title="Show"
                value={filter === '' ? 'all' : filter}
                choices={ACTIVITY_FILTERS.map((f) => ({ value: f.value === '' ? 'all' : f.value, label: f.label }))}
                onChange={(v) => setFilter(v === 'all' ? '' : (v as ActivityFilter))}
              />
            </Group>
            {days.length === 0 ? (
              <Group>
                <Note>No activity yet.</Note>
              </Group>
            ) : null}
            {days.map((day) => (
              <Group key={day.date} title={formatTaskDate(day.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}>
                {day.entries.map((e) => (
                  <Row
                    key={e.audit_id}
                    testID={`activity-${e.audit_id}`}
                    title={e.description}
                    detail={`${formatTimeOfDay(e.timestamp, zone ?? undefined)} · ${e.actor_name}`}
                  />
                ))}
              </Group>
            ))}
            {activity.hasNextPage ? (
              <Group>
                {activity.isFetchingNextPage ? (
                  <Note>Loading older activity…</Note>
                ) : (
                  <ActionRow testID="activity-more" title="Show older" onPress={() => void activity.fetchNextPage()} />
                )}
              </Group>
            ) : null}
          </GroupedList>
        )}
      </QueryGate>
    </View>
  );
}
