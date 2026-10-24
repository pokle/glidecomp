/**
 * One pilot on one task, for the organiser (stage 7): their status, the
 * track's penalty, the data-quality ruling, delete or restore, a manual
 * flight, and upload on their behalf. Every one is an existing audited route;
 * the server marks the scores stale for each that is a scoring input.
 *
 * The quality ruling is the organiser's (FAI S7A §4.4.6): a withheld track
 * can be scored anyway, and an overruled one withheld again.
 */
import { idFromSegment } from '@glidecomp/client/slug';
import { formatTimeOfDay } from '@glidecomp/client/time';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';

import {
  deleteManualFlight,
  deleteTrack,
  restoreTrack,
  setPenalty,
  setPilotStatus,
  setQualityOverride,
} from '@/api/organiser';
import {
  useComp,
  useManualFlights,
  usePilotAnalysis,
  usePilotStatuses,
  useRoster,
  useTaskScore,
  useTaskTracks,
} from '@/api/queries';
import { pilotStateLine, pilotTaskRows } from '@/lib/pilots-tracks';
import { withheldReasons } from '@/lib/withheld';
import {
  Choices,
  DangerButton,
  Field,
  FormCard,
  FormHint,
  FormMessage,
  FormScreen,
  TextButton,
} from '@/ui/form';
import { confirmDestructive, useFormSave } from '@/ui/use-form-save';

type Status = 'present' | 'absent' | 'dnf';

export default function PilotOnTask() {
  const params = useLocalSearchParams<{ comp: string; task: string; pilot: string }>();
  const compId = idFromSegment(params.comp);
  const taskId = idFromSegment(params.task);
  const pilotId = params.pilot;
  const comp = useComp(compId);
  const roster = useRoster(compId);
  const tracks = useTaskTracks(compId, taskId);
  const statuses = usePilotStatuses(compId, taskId);
  const manual = useManualFlights(compId, taskId);
  const score = useTaskScore(compId, taskId);
  const zone = comp.data?.timezone ?? undefined;
  const { saving, note, run } = useFormSave();

  const row = useMemo(
    () =>
      pilotTaskRows({
        roster: (roster.data ?? []).filter((p) => p.comp_pilot_id === pilotId),
        taskClasses: [],
        tracks: tracks.data ?? [],
        statuses: statuses.data ?? [],
        manual: manual.data ?? [],
        withheld: withheldReasons(score.data),
      })[0],
    [roster.data, pilotId, tracks.data, statuses.data, manual.data, score.data],
  );
  const track = row?.state.kind === 'track' ? row.state.track : null;
  const analysis = usePilotAnalysis(compId, taskId, pilotId, { enabled: !!track });
  const hardFailed = !!track && !!analysis.data?.track_quality?.hardFailed;
  const withheld = row?.state.kind === 'track' ? row.state.withheld : null;

  const status: Status = row?.state.kind === 'status' && (row.state.status.status_key === 'absent' || row.state.status.status_key === 'dnf')
    ? (row.state.status.status_key as Status)
    : 'present';
  const [points, setPoints] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    setPoints(track ? String(track.penalty_points || '') : '');
    setReason(track?.penalty_reason ?? '');
  }, [track]);

  if (!row) {
    return (
      <FormScreen>
        <Stack.Screen options={{ title: 'Pilot', headerLargeTitle: false }} />
        <FormHint>{roster.data ? 'This pilot isn’t on the roster any more.' : 'Loading the pilot…'}</FormHint>
      </FormScreen>
    );
  }

  async function changeStatus(next: Status) {
    if (next === status) return;
    if (next !== 'present' && (row!.state.kind === 'track' || row!.state.kind === 'manual')) {
      const ok = await confirmDestructive(
        next === 'absent' ? 'Mark absent?' : 'Mark did not fly?',
        'Their track or manual flight is set aside, not deleted, and can be restored.',
        next === 'absent' ? 'Mark absent' : 'Mark did not fly',
      );
      if (!ok) return;
    }
    await run(() => setPilotStatus(compId, taskId, pilotId, next === 'present' ? null : next), 'Status saved.');
  }

  async function savePenalty() {
    const n = points.trim() === '' ? 0 : Number(points);
    if (!Number.isFinite(n)) return;
    await run(() => setPenalty(compId, taskId, pilotId, n, reason), 'Penalty saved.');
  }

  async function removeTrack() {
    if (!(await confirmDestructive('Delete this track?', `${row!.pilot.name}’s track is deleted and their score recomputed.`, 'Delete')))
      return;
    await run(() => deleteTrack(compId, taskId, pilotId), 'Track deleted.');
  }

  const base = `/comp/${params.comp}/task/${params.task}/pilots/${pilotId}`;

  return (
    <FormScreen testID="pilot-on-task">
      <Stack.Screen options={{ title: row.pilot.name, headerLargeTitle: false }} />
      <FormHint>{`${row.pilot.pilot_class} · ${pilotStateLine(row.state, (iso) => formatTimeOfDay(iso, zone))}`}</FormHint>

      <FormCard title="Status">
        <Choices
          label="On this task"
          value={status}
          choices={[
            { value: 'present', label: 'Present' },
            { value: 'absent', label: 'Absent' },
            { value: 'dnf', label: 'Did not fly' },
          ]}
          onChange={(s) => void changeStatus(s)}
          testID="pilot-status"
        />
        <FormHint>Absent and did not fly feed launch validity (FAI S7F §9.1).</FormHint>
      </FormCard>

      {track ? (
        <FormCard title="Track">
          <Field
            label="Penalty points"
            value={points}
            onChangeText={setPoints}
            keyboardType="numbers-and-punctuation"
            placeholder="0"
            testID="pilot-penalty"
          />
          <Field label="Reason" value={reason} onChangeText={setReason} testID="pilot-penalty-reason" />
          <TextButton title="Save penalty" onPress={() => void savePenalty()} testID="pilot-penalty-save" />
          {withheld ? (
            <>
              <FormHint>{`Withheld from scoring by a data-quality check: ${withheld.join('; ')}`}</FormHint>
              <TextButton
                title="Score this track anyway"
                onPress={() => void run(() => setQualityOverride(compId, taskId, pilotId, true), 'The track is scored.')}
                testID="pilot-quality-override"
              />
            </>
          ) : hardFailed ? (
            <>
              <FormHint>A data-quality check failed this track, and it is being scored on your ruling.</FormHint>
              <TextButton
                title="Withhold it again"
                onPress={() => void run(() => setQualityOverride(compId, taskId, pilotId, false), 'The track is withheld.')}
                testID="pilot-quality-withhold"
              />
            </>
          ) : null}
          <DangerButton title="Delete track" onPress={() => void removeTrack()} testID="pilot-delete-track" />
        </FormCard>
      ) : null}

      {row.state.kind === 'nothing' && row.state.superseded ? (
        <FormCard title="Set-aside track">
          <FormHint>{`A track submitted ${formatTimeOfDay(row.state.superseded.uploaded_at, zone)} was set aside.`}</FormHint>
          <TextButton
            title="Restore it"
            onPress={() => void run(() => restoreTrack(compId, taskId, pilotId), 'Track restored.')}
            testID="pilot-restore-track"
          />
        </FormCard>
      ) : null}

      <FormCard title="Evidence">
        <TextButton
          title={track ? 'Upload a replacement track' : 'Upload a track on their behalf'}
          onPress={() => router.push({ pathname: '/submit', params: { comp: compId, task: taskId, pilot: pilotId } } as never)}
          testID="pilot-upload"
        />
        <TextButton
          title={row.state.kind === 'manual' ? 'Edit the manual flight' : 'Record a manual flight'}
          onPress={() => router.push(`${base}/manual` as never)}
          testID="pilot-manual"
        />
        {row.state.kind === 'manual' ? (
          <TextButton
            title="Remove the manual flight"
            onPress={() => void run(() => deleteManualFlight(compId, taskId, pilotId), 'Manual flight removed.')}
            testID="pilot-manual-remove"
          />
        ) : null}
        <FormHint>A manual flight scores a pilot with no track from the last turnpoint they reached and where they landed (FAI S7F §9.2.2).</FormHint>
      </FormCard>

      {note ? <FormMessage kind={note.kind}>{note.text}</FormMessage> : null}
      {saving ? <FormHint>Saving…</FormHint> : null}
    </FormScreen>
  );
}
