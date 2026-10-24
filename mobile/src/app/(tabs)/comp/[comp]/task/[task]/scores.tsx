/**
 * One task's scores, by class (the website's ScoresSection). A pilot whose
 * tracklog a hard data-quality check withheld keeps their place at the foot
 * of the list at 0, with the reasons on the row: a 0 with no reason reads as
 * a scoring bug (docs/track-quality.md).
 */
import { formatDistance } from '@glidecomp/engine';
import { formatDuration, formatRankedScore } from '@glidecomp/client/format';
import { idFromSegment, pilotPath } from '@glidecomp/client/slug';
import type { ClassScore, PilotScoreEntry, TaskScoreData } from '@glidecomp/client/types';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { useComp, useTask, useTaskScore } from '@/api/queries';
import { useUnits } from '@/settings/units';
import { ChoiceRow } from '@/ui/choice-row';
import { Freshness } from '@/ui/Freshness';
import { Group, GroupedList, Note, Row } from '@/ui/grouped-list';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';

export default function TaskScoresScreen() {
  const params = useLocalSearchParams<{ comp: string; task: string }>();
  const compId = idFromSegment(params.comp);
  const taskId = idFromSegment(params.task);
  const comp = useComp(compId);
  const task = useTask(compId, taskId);
  const score = useTaskScore(compId, taskId);
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'Task scores' }} />
      <StaleBanner query={score} />
      <QueryGate query={score} loading="Loading the scores…"
        repair
        notFound="This task doesn’t exist, or isn’t public.">
        {(data) => (
          <TaskScoresBody
            data={data}
            compName={comp.data?.name}
            taskName={task.data?.name}
            timeZone={comp.data?.timezone ?? null}
          />
        )}
      </QueryGate>
    </View>
  );
}

function TaskScoresBody({
  data,
  compName,
  taskName,
  timeZone,
}: {
  data: TaskScoreData;
  compName: string | undefined;
  taskName: string | undefined;
  timeZone: string | null;
}) {
  const classes = data.class_scores;
  const [pilotClass, setPilotClass] = useState(classes[0]?.pilot_class ?? '');
  const cls = classes.find((c) => c.pilot_class === pilotClass) ?? classes[0];
  return (
    <GroupedList testID="task-scores">
      <Group>
        <Freshness computedAt={data.computed_at} stale={data.stale} timeZone={timeZone} />
        {classes.length > 1 ? (
          <ChoiceRow
            title="Class"
            value={cls?.pilot_class ?? ''}
            choices={classes.map((c) => ({ value: c.pilot_class, label: c.pilot_class }))}
            onChange={setPilotClass}
            testID="class-choice"
          />
        ) : null}
      </Group>
      {!cls || cls.pilots.length === 0 ? (
        <Group>
          <Note>No scores yet.</Note>
        </Group>
      ) : (
        <ClassRows
          cls={cls}
          openDistance={data.scoring_format === 'open_distance'}
          open={(p) =>
            router.push(
              pilotPath(data.comp_id, compName, data.task_id, taskName, p.comp_pilot_id, p.pilot_name) as never,
            )
          }
        />
      )}
    </GroupedList>
  );
}

function ClassRows({
  cls,
  openDistance,
  open,
}: {
  cls: ClassScore;
  openDistance: boolean;
  open: (p: PilotScoreEntry) => void;
}) {
  const prefs = useUnits();
  const detail = (p: PilotScoreEntry): string => {
    if (p.track_excluded) return `Excluded: ${p.track_excluded.reasons.join('; ')}`;
    const parts: string[] = [];
    if (!openDistance) parts.push(p.made_goal ? 'Goal' : p.reached_ess ? 'ESS' : 'Landed');
    parts.push(formatDistance(p.flown_distance, { prefs, decimals: 1 }).withUnit);
    if (p.speed_section_time != null) parts.push(formatDuration(p.speed_section_time));
    // Stored positive for a deduction, negative for a bonus (the website's sign).
    if (p.penalty_points !== 0)
      parts.push(`penalty ${p.penalty_points < 0 ? '+' : '−'}${Math.abs(p.penalty_points)}`);
    return parts.join(' · ');
  };
  return (
    <Group title={cls.pilot_class}>
      {cls.pilots.map((p) => (
        <Row
          key={p.comp_pilot_id}
          testID={`score-row-${p.comp_pilot_id}`}
          title={`${p.rank}. ${p.pilot_name}`}
          detail={detail(p)}
          value={formatRankedScore(p.total_score)}
          onPress={() => open(p)}
        />
      ))}
    </Group>
  );
}
