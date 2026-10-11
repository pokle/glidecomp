/**
 * Comps (IA §5): the launch tab. Flying now, Upcoming, Past — and a search
 * over competitions, tasks, turnpoints and pilots that opens the deepest
 * match rather than the comp it lives in.
 */
import { categoryLabel, formatTaskDateRange } from '@glidecomp/client/format';
import { MIN_SEARCH_CHARS, type SearchResults } from '@glidecomp/client/search';
import { compPath, taskPath, taskRoutePath } from '@glidecomp/client/slug';
import type { CompListEntry } from '@glidecomp/client/types';
import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { useComps, useSearch } from '@/api/queries';
import { groupComps } from '@/lib/comp-groups';
import { GroupedList, Group, Note, Row } from '@/ui/grouped-list';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';

export default function Comps() {
  const [query, setQuery] = useState('');
  const searching = query.trim().length >= MIN_SEARCH_CHARS;
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          title: 'Comps',
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
  return (
    <>
      <StaleBanner query={comps} />
      <QueryGate query={comps} loading="Loading competitions…" notFound="">
        {(list) => {
          const { flyingNow, upcoming, past } = groupComps(list);
          return (
            <GroupedList testID="comp-list">
              {flyingNow.length > 0 ? <CompGroup title="Flying now" comps={flyingNow} /> : null}
              {upcoming.length > 0 ? <CompGroup title="Upcoming" comps={upcoming} /> : null}
              {past.length > 0 ? <CompGroup title="Past" comps={past} /> : null}
              {flyingNow.length + upcoming.length + past.length === 0 ? (
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

function CompGroup({ title, comps }: { title: string; comps: CompListEntry[] }) {
  return (
    <Group title={title}>
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
          ].join(' · ')}
          onPress={() => router.push(compPath(comp.comp_id, comp.name) as never)}
        />
      ))}
    </Group>
  );
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
 * turnpoint opens the task's turnpoints, a pilot the task they flew (their
 * report card, from stage 3).
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
                    ? taskPath(comp.comp_id, comp.name, task.task_id, task.name)
                    : compPath(comp.comp_id, comp.name)) as never,
                )
              }
            />
          ))}
        </Group>
      ) : null}
    </GroupedList>
  );
}
