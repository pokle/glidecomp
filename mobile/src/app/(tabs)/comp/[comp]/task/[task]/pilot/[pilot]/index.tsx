/**
 * The report card: why a pilot got the score they got on one task (IA Q6).
 *
 * A summary list of the explanation's sections with their points; each opens
 * to its own screen with the substituted arithmetic (report-card rule (a)).
 * The narrative is built by the website's own function from the same four
 * payloads (`useReportCard`), so every number here is the website's number.
 * The map and the data-cleaning chart need the tracklog, which loads on its
 * own and is never waited on.
 */
import { formatScore, formatTaskDate, ordinal } from '@glidecomp/client/format';
import type { ReportCard } from '@glidecomp/client/report-card';
import { predatesS7f2026, rulesEditionLabel } from '@glidecomp/client/rules-edition';
import { compScoresPath, idFromSegment } from '@glidecomp/client/slug';
import type { CompScores } from '@glidecomp/client/types';
import { formatInstant, zoneNameWithOffset } from '@glidecomp/client/time';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { useCompScores } from '@/api/queries';
import { openDoc } from '@/lib/open-doc';
import { sectionPoints } from '@/lib/section-points';
import { useReportCard } from '@/lib/use-report-card';
import { Group, GroupedList, Note, Row } from '@/ui/grouped-list';
import { StaleBanner } from '@/ui/QueryStates';
import { ReportCardGate } from '@/ui/ReportCardGate';

export default function ReportCardScreen() {
  const params = useLocalSearchParams<{ comp: string; task: string; pilot: string }>();
  const ids = {
    compId: idFromSegment(params.comp),
    taskId: idFromSegment(params.task),
    pilotId: idFromSegment(params.pilot),
  };
  const { state, score } = useReportCard(ids.compId, ids.taskId, ids.pilotId);
  const base = `/comp/${params.comp}/task/${params.task}/pilot/${params.pilot}`;
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: state.kind === 'ready' ? state.card.entry.pilot_name : 'Report card' }} />
      <StaleBanner query={score} />
      <ReportCardGate state={state} compId={ids.compId} taskId={ids.taskId}>
        {(card) => <Summary card={card} base={base} compId={ids.compId} taskId={ids.taskId} pilotId={ids.pilotId} />}
      </ReportCardGate>
    </View>
  );
}

function Summary({
  card,
  base,
  compId,
  taskId,
  pilotId,
}: {
  card: ReportCard;
  base: string;
  compId: string;
  taskId: string;
  pilotId: string;
}) {
  const { entry, explanation, comp, task } = card;
  const timeZone = comp.timezone ?? undefined;
  const excluded = entry.track_excluded != null;
  const quality = card.trackQuality;
  // The excluded-track narrative already lists the findings; showing them
  // twice reads as a bug. An OVERRIDDEN track keeps them here, the only place.
  const showQuality = quality != null && quality.findings.length > 0 && !excluded;
  const cleaning = card.altitudeCleaning;
  const repaired = cleaning != null && cleaning.repairedFixCount > 0;
  const historical = card.rulesEdition === 's7f-2026' && predatesS7f2026(task.task_date);
  return (
    <GroupedList testID="report-card">
      <Group>
        <Note>{explanation.headline}</Note>
        {explanation.headlineNote ? <Note>{explanation.headlineNote}</Note> : null}
        <Row
          title={task.name}
          detail={`${formatTaskDate(task.task_date)} · ${card.pilotClass}`}
          value={ordinal(entry.rank)}
          testID="report-card-rank"
        />
        {card.official ? (
          <Row
            title="Officially"
            detail={card.official.source}
            value={`${ordinal(card.official.rank)} · ${Math.round(card.official.total)} pts`}
            onPress={card.official.url ? () => openDoc(card.official!.url!) : undefined}
          />
        ) : null}
        <Row title="Rules" value={rulesEditionLabel(card.rulesEdition)} onPress={() => openDoc('/scoring/gap')} />
        <Note>
          {`Scores computed ${formatInstant(new Date(card.scoreComputedAt), timeZone)}${card.scoreStale ? ' — a re-score is in progress' : ''}. Times in ${zoneNameWithOffset(new Date(`${task.task_date}T12:00:00Z`), timeZone)}.`}
        </Note>
        {historical ? (
          <Note>
            This competition was flown before the FAI S7F 2026 scoring rules took effect (1 May 2026). GlideComp scores
            every task under the 2026 rules, so the scores shown here are indicative and can differ from the officially
            published results.
          </Note>
        ) : null}
      </Group>

      {showQuality ? (
        <Group title={quality.hardFailed ? 'Tracklog excluded from scoring' : 'Check this tracklog'}>
          {quality.findings.map((f) => (
            <Row key={f.id} title={f.title} detail={f.detail} />
          ))}
          <Row title="How track validity checks work" onPress={() => openDoc('/scoring/track-validity')} />
        </Group>
      ) : null}

      <Group title="The score">
        {explanation.sections.map((section) => (
          <Row
            key={section.id}
            testID={`section-row-${section.id}`}
            title={section.title}
            detail={section.rank ?? section.summary}
            value={sectionPoints(section)}
            onPress={() => router.push(`${base}/section/${section.id}` as never)}
          />
        ))}
        {excluded ? (
          <Row title="How track validity checks work" onPress={() => openDoc('/scoring/track-validity')} />
        ) : null}
      </Group>

      <Group title="The flight">
        <Row
          title="Track map"
          detail="The route, the flight, and where each step happened"
          onPress={() => router.push(`${base}/map` as never)}
          testID="track-map-row"
        />
        {repaired ? (
          <Row
            title="Track data cleaning"
            detail={`${cleaning.repairedFixCount} of ${cleaning.totalFixCount} GPS fixes repaired`}
            onPress={() => router.push(`${base}/cleaning` as never)}
            testID="track-cleaning-row"
          />
        ) : null}
      </Group>

      <TaskInComp compId={compId} compName={comp.name} taskId={taskId} pilotId={pilotId} />
    </GroupedList>
  );
}

/**
 * What this task did to the pilot's competition score — the website's
 * TaskInCompScores, in its words. Supplementary: the score above is explained
 * in full without it, so while the comp's scores load (or if they can't),
 * the group simply isn't there.
 */
function TaskInComp({
  compId,
  compName,
  taskId,
  pilotId,
}: {
  compId: string;
  compName: string;
  taskId: string;
  pilotId: string;
}) {
  const scores = useCompScores(compId);
  if (!scores.data) return null;
  const found = findTaskInComp(scores.data, taskId, pilotId);
  if (!found) return null;
  const { rank, fieldSize, compTotal, task } = found;
  const total = formatScore(compTotal);
  const text =
    task.ftv_status === 'discarded'
      ? `Under Fixed Total Validity this task was discarded — it was among your weakest and does not count toward your ${total}-point competition total.`
      : task.ftv_status === 'partial'
        ? `Under Fixed Total Validity this task counted in part: ${formatScore(task.ftv_counted_score ?? task.score)} of its ${formatScore(task.score)} points went into your ${total}-point competition total.`
        : `These ${formatScore(task.score)} points are part of your ${total}-point competition total.`;
  return (
    <Group title="This task in the competition">
      <Row title="Place in the competition" value={`${ordinal(rank)} of ${fieldSize}`} />
      <Note>{text}</Note>
      <Row
        title="Full competition scores"
        onPress={() => router.push(compScoresPath(compId, compName) as never)}
      />
      <Row
        title="This pilot’s series"
        onPress={() => router.push(`/comp/${compId}/pilot/${pilotId}` as never)}
      />
    </Group>
  );
}

function findTaskInComp(scores: CompScores, taskId: string, pilotId: string) {
  for (const cls of scores.class_scores) {
    const pilot = cls.pilots.find((p) => p.comp_pilot_id === pilotId);
    if (!pilot) continue;
    const task = pilot.tasks.find((t) => t.task_id === taskId);
    return task ? { rank: pilot.rank, fieldSize: cls.pilots.length, compTotal: pilot.total_score, task } : null;
  }
  return null;
}
