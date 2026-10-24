/**
 * Comps (IA §5): the launch tab. Yours (signed in), Flying now, Upcoming,
 * Past — and a search
 * over competitions, tasks, turnpoints and pilots that opens the deepest
 * match rather than the comp it lives in.
 */
import { categoryLabel, formatTaskDateRange } from '@glidecomp/client/format';
import { MIN_SEARCH_CHARS, type SearchResults } from '@glidecomp/client/search';
import { compPath, pilotPath, taskPath, taskRoutePath } from '@glidecomp/client/slug';
import type { CompListEntry } from '@glidecomp/client/types';
import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { WRITES_ALLOWED } from '@/api/config';
import { useComps, useRegistrations, useSearch } from '@/api/queries';
import { useUserId } from '@/auth/session';
import { groupComps } from '@/lib/comp-groups';
import { GroupedList, Group, Note, Row } from '@/ui/grouped-list';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';

export default function Comps() {
  const [query, setQuery] = useState('');
  const searching = query.trim().length >= MIN_SEARCH_CHARS;
  const signedIn = useUserId() !== null && WRITES_ALLOWED;
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          title: 'Comps',
          // Anyone signed in may start a competition; it makes them its organiser.
          headerRight: () =>
            signedIn ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="New competition"
                hitSlop={12}
                testID="new-comp-button"
                onPress={() => router.push('/comp/new' as never)}>
                <Text style={{ fontSize: 17, color: '#007AFF' }}>New</Text>
              </Pressable>
            ) : null,
          headerSearchBarOptions: {
            placeholder: 'Comps, tasks, pilots, turnpoints',
            autoCapitalize: 'none',
            onChangeText: (e) => setQuery(e.nativeEvent.text),
          },
        }}
      />
      {searching ? <Search query={query} /> : <CompList />}
    </View>
  );
}

function CompList() {
  const comps = useComps();
  const registrations = useRegistrations(useUserId());
  const registeredIn = new Set((registrations.data ?? []).map((r) => r.comp_id));
  return (
    <>
      <StaleBanner query={comps} />
      <QueryGate query={comps} loading="Loading competitions…" notFound="">
        {(list) => {
          const { yours, flyingNow, upcoming, past } = groupComps(list, new Date(), registeredIn);
          return (
            <GroupedList testID="comp-list">
              {/* Called, not rendered as components: Android's list only
                  recognises a section that is its direct child. */}
              {yours.length > 0 ? compGroup({ title: 'Yours', comps: yours, registeredIn, testID: 'yours' }) : null}
              {flyingNow.length > 0 ? compGroup({ title: 'Flying now', comps: flyingNow }) : null}
              {upcoming.length > 0 ? compGroup({ title: 'Upcoming', comps: upcoming }) : null}
              {past.length > 0 ? compGroup({ title: 'Past', comps: past }) : null}
              {yours.length + flyingNow.length + upcoming.length + past.length === 0 ? (
                <Group>
                  <Note>No competitions yet.</Note>
                </Group>
              ) : null}
            </GroupedList>
          );
        }}
      </QueryGate>
    </>
  );
}

function compGroup({
  title,
  comps,
  registeredIn,
  testID,
}: {
  title: string;
  comps: CompListEntry[];
  /** Given for Yours, whose rows say why each comp is the reader's. */
  registeredIn?: ReadonlySet<string>;
  testID?: string;
}) {
  return (
    <Group key={title} title={title} testID={testID}>
      {comps.map((comp) => (
        <Row
          key={comp.comp_id}
          testID={`comp-row-${comp.comp_id}`}
          title={comp.name}
          detail={[
            categoryLabel(comp.category),
            comp.first_task_date
              ? formatTaskDateRange(comp.first_task_date, comp.last_task_date ?? comp.first_task_date)
              : 'No tasks yet',
            ...(registeredIn ? roleWords(comp, registeredIn) : []),
          ].join(' · ')}
          onPress={() => router.push(compPath(comp.comp_id, comp.name) as never)}
        />
      ))}
    </Group>
  );
}

/** Why a comp is in Yours: "Organiser", "Registered", and "Hidden" for a test comp. */
function roleWords(comp: CompListEntry, registeredIn: ReadonlySet<string>): string[] {
  return [
    ...(comp.is_admin ? ['Organiser'] : []),
    ...(registeredIn.has(comp.comp_id) ? ['Registered'] : []),
    ...(comp.test ? ['Hidden'] : []),
  ];
}

function Search({ query }: { query: string }) {
  const search = useSearch(query);
  return (
    <>
      <StaleBanner query={search} />
      <QueryGate query={search} loading="Searching…" notFound="">
        {(results) => <SearchGroups results={results} />}
      </QueryGate>
    </>
  );
}

/**
 * Grouped by what matched. Each row opens the deepest thing it names: a
 * turnpoint opens the task's turnpoints, a pilot their report card for the
 * task they flew — or, matched in a comp rather than a task, their series.
 */
function SearchGroups({ results }: { results: SearchResults }) {
  const comps = results.comps.filter((c) => c.matched);
  const tasks = results.comps.flatMap((c) =>
    c.tasks.filter((t) => t.matched).map((t) => ({ comp: c, task: t })),
  );
  const turnpoints = results.comps.flatMap((c) =>
    c.tasks.filter((t) => t.matched_turnpoints.length > 0).map((t) => ({ comp: c, task: t })),
  );
  const pilots = results.comps.flatMap((c) => [
    ...c.tasks.flatMap((t) => t.pilots.map((p) => ({ comp: c, task: t, pilot: p }))),
    ...c.pilots.map((p) => ({ comp: c, task: null, pilot: p })),
  ]);
  const nothing = comps.length + tasks.length + turnpoints.length + pilots.length === 0;
  return (
    <GroupedList testID="search-results">
      {nothing ? (
        <Group>
          <Note>Nothing matches. Try a competition, a task, a pilot or a turnpoint code.</Note>
        </Group>
      ) : null}
      {comps.length > 0 ? (
        <Group title="Competitions">
          {comps.map((c) => (
            <Row
              key={c.comp_id}
              title={c.name}
              detail={`${categoryLabel(c.category)} · ${c.task_count} ${c.task_count === 1 ? 'task' : 'tasks'}`}
              onPress={() => router.push(compPath(c.comp_id, c.name) as never)}
            />
          ))}
        </Group>
      ) : null}
      {tasks.length > 0 ? (
        <Group title="Tasks">
          {tasks.map(({ comp, task }) => (
            <Row
              key={task.task_id}
              title={task.name}
              detail={comp.name}
              onPress={() =>
                router.push(taskPath(comp.comp_id, comp.name, task.task_id, task.name) as never)
              }
            />
          ))}
        </Group>
      ) : null}
      {turnpoints.length > 0 ? (
        <Group title="Turnpoints">
          {turnpoints.map(({ comp, task }) => (
            <Row
              key={`tp-${task.task_id}`}
              title={task.matched_turnpoints.join(', ')}
              detail={`${task.name} · ${comp.name}`}
              onPress={() =>
                router.push(taskRoutePath(comp.comp_id, comp.name, task.task_id, task.name) as never)
              }
            />
          ))}
        </Group>
      ) : null}
      {pilots.length > 0 ? (
        <Group title="Pilots">
          {pilots.map(({ comp, task, pilot }) => (
            <Row
              key={`${pilot.comp_pilot_id}-${task?.task_id ?? 'comp'}`}
              title={pilot.name}
              detail={task ? `${task.name} · ${comp.name}` : comp.name}
              onPress={() =>
                router.push(
                  (task
                    ? pilotPath(comp.comp_id, comp.name, task.task_id, task.name, pilot.comp_pilot_id, pilot.name)
                    : `${compPath(comp.comp_id, comp.name)}/pilot/${pilot.comp_pilot_id}`) as never,
                )
              }
            />
          ))}
        </Group>
      ) : null}
    </GroupedList>
  );
}
