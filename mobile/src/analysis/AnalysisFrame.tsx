/**
 * What every analysis screen wears (the website's TaskAnalysisFrame): the
 * stale banner, the pending state — a cold analysis answers `pending` and is
 * computed in the background, so the screen says it is working this out and
 * polls — a task that cannot be analysed saying why, and the class choice.
 *
 * `children` returns the screen's GROUPS as an array, never a fragment:
 * Android's list only sees a section that is its direct child
 * (mobile/CLAUDE.md, "Lists"), and React flattens an array where it does not
 * flatten a fragment.
 */
import type { TaskAnalysisReport } from '@glidecomp/engine';
import { Stack } from 'expo-router';
import type { ReactElement } from 'react';
import { View } from 'react-native';

import { ChoiceRow } from '@/ui/choice-row';
import { GroupedList, Group, Note } from '@/ui/grouped-list';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';

import type { AnalysisView } from './use-analysis';

export function AnalysisFrame({
  view,
  title,
  testID,
  children,
}: {
  view: AnalysisView;
  title: string;
  testID?: string;
  children: (ctx: { report: TaskAnalysisReport; active: NonNullable<AnalysisView['active']> }) => ReactElement[];
}) {
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title, headerLargeTitle: false }} />
      <StaleBanner query={view.analysis} />
      <QueryGate query={view.analysis} loading="Loading the analysis…" notFound="This task doesn’t exist, or isn’t public.">
        {(data) => {
          if (data.error) {
            return (
              <GroupedList testID={testID}>
                <Group>
                  <Note>{data.error}</Note>
                </Group>
              </GroupedList>
            );
          }
          if (data.pending || !view.active || !view.report) {
            return (
              <GroupedList testID={testID}>
                <Group>
                  <Note>
                    {data.pending
                      ? 'Working this out. The analysis is being computed from every pilot’s track; this screen fills in when it’s ready.'
                      : 'No analysis for this task yet.'}
                  </Note>
                </Group>
              </GroupedList>
            );
          }
          const active = view.active;
          return (
            <GroupedList testID={testID}>
              {view.classes.length > 1 ? (
                <Group>
                  <ChoiceRow
                    testID="analysis-class"
                    title="Class"
                    value={view.selectedClass}
                    choices={view.classes.map((c) => ({ value: c.pilot_class, label: c.pilot_class }))}
                    onChange={view.selectClass}
                  />
                </Group>
              ) : null}
              {children({ report: view.report, active })}
            </GroupedList>
          );
        }}
      </QueryGate>
    </View>
  );
}
