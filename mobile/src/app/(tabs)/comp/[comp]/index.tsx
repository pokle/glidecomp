/**
 * A competition (IA §6): its card, the reader's own "You" group when they are
 * on the roster, its tasks by day (every task alike, #514), then Results and
 * Competition rows — with the organiser's rows only for an organiser
 * (`is_admin`): hide, never disable.
 *
 * The You group is about the reader, not about a task: it never features one
 * (stage 0, decision 1).
 */
import { formatRankedScore, formatTaskDate, formatTaskDateRange, ordinal, scoringFormatLabel } from '@glidecomp/client/format';
import {
  compAnalysisPath,
  compPath,
  compScoresPath,
  compWaypointsPath,
  idFromSegment,
  taskPath,
} from '@glidecomp/client/slug';
import type { CompDetailData } from '@glidecomp/client/types';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Alert, View } from 'react-native';

import { useComp, useCompScores, useRegistrations } from '@/api/queries';
import { useUserId } from '@/auth/session';
import { findSeriesPilot } from '@/lib/yours';
import { wingLabel } from '@/lib/labels';
import { groupTasksByDay } from '@/lib/task-days';
import { rescoreComp, writeErrorText } from '@/api/organiser';
import { ActionRow, GroupedList, Group, Note, Row } from '@/ui/grouped-list';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';

export default function CompScreen() {
  const { comp: segment } = useLocalSearchParams<{ comp: string }>();
  const comp = useComp(idFromSegment(segment));
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: comp.data?.name ?? '' }} />
      <StaleBanner query={comp} />
      <QueryGate
        query={comp}
        loading="Loading the competition…"
        notFound="This competition doesn’t exist, or isn’t public.">
        {(data) => <CompBody comp={data} />}
      </QueryGate>
    </View>
  );
}

function CompBody({ comp }: { comp: CompDetailData }) {
  const registrations = useRegistrations(useUserId());
  const mine = registrations.data?.find((r) => r.comp_id === comp.comp_id);
  // Asked only of a registered pilot's comp view, for "Your score".
  const scores = useCompScores(comp.comp_id, { enabled: !!mine });
  const place = mine && scores.data ? findSeriesPilot(scores.data, mine.comp_pilot_id) : null;
  const days = groupTasksByDay(comp.tasks);
  const dates = comp.tasks.map((t) => t.task_date).sort();
  const go = (path: string) => () => router.push(path as never);
  return (
    <GroupedList testID="comp-screen">
      <Group>
        <Row title="Wing" value={wingLabel(comp.category)} />
        <Row title="Scoring" value={scoringFormatLabel(comp.scoring_format)} />
        {comp.pilot_classes.length > 0 ? (
          <Row title="Classes" value={comp.pilot_classes.join(', ')} />
        ) : null}
        <Row
          title="Dates"
          value={dates.length > 0 ? formatTaskDateRange(dates[0], dates[dates.length - 1]) : 'No tasks yet'}
        />
        {comp.admins.length > 0 ? (
          <Row
            title={comp.admins.length === 1 ? 'Organiser' : 'Organisers'}
            detail={comp.admins.map((a) => a.name || a.email).join(', ')}
          />
        ) : null}
        {comp.test && comp.is_admin ? (
          <Row title="Hidden" detail="Only this competition’s organisers can see it." />
        ) : null}
        {comp.organiser_notes?.trim() ? (
          <Row testID="organiser-notes" title="Organiser’s notes" detail={comp.organiser_notes.trim()} />
        ) : null}
      </Group>

      {/* The reader's own entry. Inline, not a component: Android's list
          only recognises a section that is its direct child. */}
      {mine ? (
        <Group title="You" testID="you">
          <Row
            testID="registered-as"
            title="Registered as"
            value={`${mine.registered_pilot_name} · ${mine.pilot_class}`}
          />
          {place ? (
            <Row
              testID="your-score"
              title="Your score"
              value={`${ordinal(place.pilot.rank)} · ${formatRankedScore(place.pilot.total_score)} pts`}
              onPress={go(`${compPath(comp.comp_id, comp.name)}/pilot/${mine.comp_pilot_id}`)}
            />
          ) : null}
        </Group>
      ) : null}

      {days.length === 0 ? (
        <Group title="Tasks">
          <Note>No tasks yet.</Note>
        </Group>
      ) : (
        days.map((day) => (
          <Group key={day.date} title={formatTaskDate(day.date, { weekday: 'long', day: 'numeric', month: 'long' })}>
            {day.tasks.map((task) => (
              <Row
                key={task.task_id}
                testID={`task-row-${task.task_id}`}
                title={task.name}
                detail={
                  [task.pilot_classes.join(', '), task.has_xctsk ? null : 'Route not set yet']
                    .filter(Boolean)
                    .join(' · ') || undefined
                }
                onPress={go(taskPath(comp.comp_id, comp.name, task.task_id, task.name))}
              />
            ))}
          </Group>
        ))
      )}

      {/* The organiser's day, from the hill (stage 7). Hidden, not disabled,
          for everyone else. */}
      {comp.is_admin ? (
        <Group title="Organiser" testID="comp-organiser">
          <Row testID="add-task" title="Add task" onPress={go(`${compPath(comp.comp_id, comp.name)}/task/new`)} />
          <Row
            testID="edit-organiser-notes"
            title="Organiser’s notes"
            detail={comp.organiser_notes?.trim() ? 'Edit the notes on this competition' : 'Add a note for every pilot'}
            onPress={go(`${compPath(comp.comp_id, comp.name)}/notes`)}
          />
          <ActionRow testID="recompute-scores" title="Recompute scores" onPress={() => void recompute(comp)} />
        </Group>
      ) : null}

      <Group title="Results">
        <Row title="Scores" onPress={go(compScoresPath(comp.comp_id, comp.name))} />
        <Row title="Analysis" onPress={go(compAnalysisPath(comp.comp_id, comp.name))} />
      </Group>

      <Group title="Competition">
        <Row title="Waypoints" onPress={go(compWaypointsPath(comp.comp_id, comp.name))} />
        {comp.is_admin ? (
          <Row
            testID="organiser-pilots"
            title="Pilots"
            value={String(comp.pilot_count)}
            onPress={go(`${compPath(comp.comp_id, comp.name)}/pilots`)}
          />
        ) : null}
        <Row title="Activity" onPress={go(`${compPath(comp.comp_id, comp.name)}/activity`)} />
        {comp.is_admin ? (
          <Row
            testID="organiser-settings"
            title="Settings"
            onPress={go(`${compPath(comp.comp_id, comp.name)}/settings`)}
          />
        ) : null}
      </Group>
    </GroupedList>
  );
}

/**
 * Recompute scores: what the website's Recompute does. The server marks every
 * task stale and re-scores in the background; Scores shows the new numbers
 * when they land.
 */
async function recompute(comp: CompDetailData) {
  try {
    await rescoreComp(comp.comp_id);
    Alert.alert('Recomputing scores', 'Every task is being scored again. Scores updates when it’s done.');
  } catch (err) {
    Alert.alert('Couldn’t recompute', writeErrorText(err));
  }
}
