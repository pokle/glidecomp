/**
 * Scores (IA §8): the competition's results by class — the standings, the
 * top three per task, teams, and any one task's scores. The views and their
 * names are the website's (CompScoresSection), over the same pure transforms
 * in @glidecomp/client.
 */
import { formatRankedScore, formatTaskDate } from '@glidecomp/client/format';
import {
  aggregateTeams,
  buildClassGroups,
  computeTop3Rows,
  tasksForGroup,
  type ClassGroup,
} from '@glidecomp/client/scores-views';
import { idFromSegment, pilotPath } from '@glidecomp/client/slug';
import type { CompDetailData, CompScores } from '@glidecomp/client/types';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { useComp, useCompScores } from '@/api/queries';
import { shareScoresCsv } from '@/lib/share-scores';
import { ChoiceRow } from '@/ui/choice-row';
import { Freshness } from '@/ui/Freshness';
import { GroupedList, Group, Note, Row } from '@/ui/grouped-list';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';

type ScoresView = 'standings' | 'top3' | 'teams' | 'bytask';

export default function CompScoresScreen() {
  const { comp: segment } = useLocalSearchParams<{ comp: string }>();
  const compId = idFromSegment(segment);
  const comp = useComp(compId);
  const scores = useCompScores(compId);
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          title: 'Scores',
          headerRight: () =>
            scores.data && comp.data ? (
              <Pressable
                accessibilityRole="button"
                hitSlop={12}
                onPress={() => shareScoresCsv(scores.data!, comp.data!.name)}>
                <Text style={{ fontSize: 17, color: '#007AFF' }}>Export</Text>
              </Pressable>
            ) : null,
        }}
      />
      <StaleBanner query={scores} />
      <QueryGate query={scores} loading="Loading the scores…"
        repair
        notFound="This competition doesn’t exist, or isn’t public.">
        {(data) => <ScoresBody scores={data} comp={comp.data} />}
      </QueryGate>
    </View>
  );
}

function ScoresBody({ scores, comp }: { scores: CompScores; comp: CompDetailData | undefined }) {
  const groups = useMemo(() => buildClassGroups(scores.class_scores), [scores.class_scores]);
  const teams = useMemo(() => aggregateTeams(scores.class_scores), [scores.class_scores]);
  const [groupLabel, setGroupLabel] = useState(groups[0]?.label ?? '');
  const [view, setView] = useState<ScoresView>('standings');
  const group = groups.find((g) => g.label === groupLabel) ?? groups[0];
  const views = [
    { value: 'standings' as const, label: 'Standings' },
    { value: 'top3' as const, label: 'Top 3 per task & class' },
    ...(teams.length > 0 ? [{ value: 'teams' as const, label: 'Teams' }] : []),
    ...(scores.tasks.length > 0 ? [{ value: 'bytask' as const, label: 'Scores by task' }] : []),
  ];
  return (
    <GroupedList testID="comp-scores">
      <Group>
        <Freshness computedAt={scores.computed_at} stale={scores.stale} timeZone={comp?.timezone ?? null} />
        {groups.length > 1 ? (
          <ChoiceRow
            title="Class"
            value={group?.label ?? ''}
            choices={groups.map((g) => ({ value: g.label, label: g.label }))}
            onChange={setGroupLabel}
            testID="class-choice"
          />
        ) : null}
        <ChoiceRow title="View" value={view} choices={views} onChange={setView} testID="view-choice" />
      </Group>
      {!group ? (
        <Group>
          <Note>No scores yet.</Note>
        </Group>
      ) : view === 'standings' ? (
        <Standings group={group} compId={scores.comp_id} />
      ) : view === 'top3' ? (
        <Top3 group={group} scores={scores} />
      ) : view === 'teams' ? (
        <Group title="Teams">
          {teams.map((t) => (
            <Row
              key={t.team_name}
              title={`${t.rank}. ${t.team_name}`}
              detail={t.pilots.join(', ')}
              value={formatRankedScore(t.total_score)}
            />
          ))}
        </Group>
      ) : (
        <ByTask group={group} scores={scores} comp={comp} />
      )}
    </GroupedList>
  );
}

function Standings({ group, compId }: { group: ClassGroup; compId: string }) {
  return (
    <Group title={group.label}>
      {group.pilots.map((p) => (
        <Row
          key={`${p.comp_pilot_id}-${p.rank}`}
          testID={`standing-row-${p.comp_pilot_id}`}
          title={`${p.rank}. ${p.pilot_name}`}
          detail={p.team_name ?? undefined}
          value={formatRankedScore(p.total_score)}
          onPress={() => router.push(`/comp/${compId}/pilot/${p.comp_pilot_id}` as never)}
        />
      ))}
    </Group>
  );
}

function Top3({ group, scores }: { group: ClassGroup; scores: CompScores }) {
  const rows = computeTop3Rows(group, scores.tasks);
  return (
    <>
      {rows.map((row) => (
        <Group
          key={row.task_id ?? 'total'}
          title={row.task_date ? `${row.label} · ${formatTaskDate(row.task_date, { day: 'numeric', month: 'short' })}` : row.label}>
          {row.entries.length === 0 ? (
            <Note>No scores.</Note>
          ) : (
            row.entries.map((e, i) => (
              <Row key={e.comp_pilot_id} title={`${i + 1}. ${e.pilot_name}`} value={formatRankedScore(e.score)} />
            ))
          )}
        </Group>
      ))}
    </>
  );
}

function ByTask({
  group,
  scores,
  comp,
}: {
  group: ClassGroup;
  scores: CompScores;
  comp: CompDetailData | undefined;
}) {
  const tasks = tasksForGroup(group, scores.tasks);
  const [taskId, setTaskId] = useState(tasks[0]?.task_id ?? '');
  const task = tasks.find((t) => t.task_id === taskId) ?? tasks[0];
  if (!task) {
    return (
      <Group>
        <Note>No tasks scored for this class yet.</Note>
      </Group>
    );
  }
  const entries = group.pilots
    .flatMap((p) => {
      const e = p.tasks.find((t) => t.task_id === task.task_id);
      return e ? [{ pilot: p, entry: e }] : [];
    })
    .sort((a, b) => a.entry.rank - b.entry.rank);
  return (
    <>
      <Group>
        <ChoiceRow
          title="Task"
          value={task.task_id}
          choices={tasks.map((t) => ({ value: t.task_id, label: t.task_name }))}
          onChange={setTaskId}
        />
      </Group>
      <Group title={task.task_name}>
        {entries.map(({ pilot, entry }) => (
          <Row
            key={pilot.comp_pilot_id}
            title={`${entry.rank}. ${pilot.pilot_name}`}
            value={formatRankedScore(entry.score)}
            onPress={() =>
              router.push(
                pilotPath(scores.comp_id, comp?.name, task.task_id, task.task_name, pilot.comp_pilot_id, pilot.pilot_name) as never,
              )
            }
          />
        ))}
      </Group>
    </>
  );
}
