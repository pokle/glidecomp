/**
 * Submit a track (stage 5; IA §15, Q3): which task, who the track is for, and
 * the IGC file — then the receipt, or the plain fact that it is waiting.
 *
 * The rules are the website's (@glidecomp/client/submit, shared with its
 * /submit page): the same endpoint choice, the same default task, the same
 * failure codes and the same words. Two things are the app's own:
 *
 * - **Written to the phone first.** Submit puts the track in the upload queue
 *   (submit/queue.ts) and the sheet watches it. With signal it is sent at
 *   once and the receipt follows; without, the sheet says the track is saved
 *   here and NOT yet submitted, and Me → Track uploads shows how it goes.
 * - **A file can arrive first.** "Open in GlideComp" from Files or an
 *   instrument's app opens this sheet with the file already chosen
 *   (+native-intent.tsx).
 *
 * Opened from a task, `comp` and `task` name it and the task step collapses
 * to a line with Change — it never disappears, because filing a track against
 * yesterday's task without being shown which task it was is how a flow like
 * this fails. `retry` reopens a refused track from the queue to fix it.
 */
import {
  IDENTIFIER_KINDS,
  NEW_PILOT_SENTINEL,
  inferIdentifierKind,
  needsSignIn,
  pickDefaultTask,
  repairStepFor,
  taskLine,
  unnamedClasses,
  type IdentifierKind,
  type OpenComp,
  type RegistrationState,
  type SubmitAs,
  type SubmitError,
} from '@glidecomp/client/submit';
import { formatTaskDate } from '@glidecomp/client/format';
import { pilotPath } from '@glidecomp/client/slug';
import type { PilotListEntry } from '@glidecomp/client/types';
import { File } from 'expo-file-system';
import { router, Stack, useLocalSearchParams, useNavigation, usePreventRemove } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, View } from 'react-native';

import { WRITES_ALLOWED } from '@/api/config';
import { useComp, useOpenComps, useRegistrations, useRegistrationState, useRoster, useTask } from '@/api/queries';
import { queryClient } from '@/api/query-client';
import { useIdentity } from '@/auth/session';
import type { Submission } from '@/lib/submission';
import { useUnits } from '@/settings/units';
import { readTrackFile, takeIncomingFile, TrackFileError, useIncomingFile, type PickedTrack } from '@/submit/incoming';
import { readLast } from '@/submit/last';
import { enqueue, queuedBytes, remove, useSubmission, useSubmissions } from '@/submit/queue';
import { failureGroup, receiptGroups } from '@/submit/receipt';
import { ChoiceRow } from '@/ui/choice-row';
import { ActionRow, FieldRow, GroupedList, Group, Note, Row } from '@/ui/grouped-list';
import { useOnline } from '@/ui/QueryStates';

const SELF = 'self';

export default function SubmitSheet() {
  // `pilot`: an organiser's "Upload on behalf" from Pilots & tracks names the pilot.
  const params = useLocalSearchParams<{ comp?: string; task?: string; retry?: string; pilot?: string }>();
  const identity = useIdentity();
  const user = identity.kind === 'signed-in' ? identity.user : null;
  const units = useUnits();
  const { items } = useSubmissions();
  const retrying = params.retry ? (items.find((s) => s.id === params.retry) ?? null) : null;

  // ── Which task
  const openComps = useOpenComps();
  const [compId, setCompId] = useState(params.comp ?? retrying?.compId ?? '');
  const [taskId, setTaskId] = useState(params.task ?? retrying?.taskId ?? '');
  // Closed only when the caller named the task; once open it stays open —
  // choosing is not finishing, and the dates either side are worth reading.
  const [editingTask, setEditingTask] = useState(!(params.task ?? retrying?.taskId));
  const comp = useComp(compId);
  const task = useTask(compId, taskId);

  // ── Who it is for
  const last = useMemo(() => (user ? null : readLast()), [user]);
  const retryAnon = retrying?.as.kind === 'anonymous' ? retrying.as : null;
  const [identifierKind, setIdentifierKind] = useState<IdentifierKind>(
    retryAnon?.identifierKind ?? last?.identifierKind ?? 'email',
  );
  const [identifierValue, setIdentifierValue] = useState(retryAnon?.identifierValue ?? last?.identifierValue ?? '');
  const [onBehalfOf, setOnBehalfOf] = useState(
    retrying?.as.kind === 'on-behalf' ? retrying.as.compPilotId : (params.pilot ?? SELF),
  );
  const [choosingPilot, setChoosingPilot] = useState(false);
  const [pilotFilter, setPilotFilter] = useState('');
  const [chosenRegistration, setChosenRegistration] = useState<string | null>(
    retrying?.as.kind === 'self' ? (retrying.as.registration ?? null) : null,
  );
  const [identifierOverride, setIdentifierOverride] = useState<{ kind: IdentifierKind; value: string } | null>(null);
  const [findingMe, setFindingMe] = useState(false);
  const [findKind, setFindKind] = useState<IdentifierKind>('civl_id');
  const [findValue, setFindValue] = useState('');

  const registrations = useRegistrations(user?.id ?? null);
  const registeredHere = !!registrations.data?.some((r) => r.comp_id === compId);
  const canOnBehalf = !!user && !!comp.data && (comp.data.is_admin || (comp.data.open_igc_upload && registeredHere));
  const roster = useRoster(compId || null, { enabled: canOnBehalf });
  const registration = useRegistrationState(
    compId || null,
    user && onBehalfOf === SELF ? user.id : null,
    identifierOverride,
  );

  // ── The file
  const [track, setTrack] = useState<PickedTrack | null>(null);
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const incoming = useIncomingFile();

  // ── Outcome
  const [failure, setFailure] = useState<SubmitError | null>(retrying?.failure ?? null);
  const [queuing, setQueuing] = useState(false);
  const [queuedId, setQueuedId] = useState<string | null>(null);
  const { sub: queued, sending } = useSubmission(queuedId);
  const online = useOnline();
  const navigation = useNavigation();

  // A chosen file that was never submitted is the one thing this sheet can
  // lose. Once queued, the track is safe on the phone and the sheet may go.
  // Discard lifts the guard first and leaves on the next render: dispatching
  // the held action while the guard still stands only asks again.
  const [leaving, setLeaving] = useState<Parameters<typeof navigation.dispatch>[0] | null>(null);
  usePreventRemove(!!track && !queuedId && !queuing && !leaving, ({ data }) => {
    Alert.alert('Discard this track?', 'It hasn’t been submitted.', [
      { text: 'Keep it', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => setLeaving(data.action) },
    ]);
  });
  useEffect(() => {
    if (leaving) navigation.dispatch(leaving);
  }, [leaving, navigation]);

  // The default task, once the open comps are known — unless the caller named
  // one: the list must never overrule a task somebody chose to submit to.
  const defaulted = useRef(false);
  useEffect(() => {
    if (defaulted.current || !openComps.data || taskId) return;
    defaulted.current = true;
    const pick = pickDefaultTask(openComps.data, {
      fromUrl: { compId: params.comp ?? null, taskId: null },
      last,
    });
    if (pick) {
      setCompId(pick.compId);
      setTaskId(pick.taskId);
    }
  }, [openComps.data, taskId, params.comp, last]);

  // A file from outside the app.
  useEffect(() => {
    if (!incoming) return;
    takeIncomingFile(incoming);
    void pick(incoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming]);

  // Reopening a refused track: its file is already on the phone.
  useEffect(() => {
    if (!retrying || track) return;
    void queuedBytes(retrying)
      .then((gz) =>
        setTrack({ name: retrying.fileName, rawBytes: retrying.rawBytes, gz, pilotName: retrying.filePilotName }),
      )
      .catch(() => setFileError('That track is no longer on this phone. Choose the file again.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retrying?.id]);

  // The server refused the track this sheet queued: back to the form, with
  // the step that can fix it, and a fresh answer to "which one are you?".
  useEffect(() => {
    if (queued?.status !== 'refused') return;
    setFailure(queued.failure ?? null);
    setQueuedId(null);
    if (queued.failure?.code === 'identity_ambiguous') {
      void queryClient.invalidateQueries({ queryKey: ['registrationState'] });
    }
  }, [queued?.status, queued?.failure]);

  async function pick(uri?: string) {
    setFileError(null);
    setFailure(null);
    let source = uri;
    if (!source) {
      const picked = await File.pickFileAsync();
      if (picked.canceled) return;
      source = picked.result.uri;
    }
    setReading(true);
    try {
      setTrack(await readTrackFile(source));
    } catch (err) {
      setTrack(null);
      setFileError(err instanceof TrackFileError ? err.message : 'GlideComp couldn’t read that file. Try choosing it again.');
    } finally {
      setReading(false);
    }
  }

  const selectedComp = openComps.data?.find((c) => c.comp_id === compId) ?? null;
  const selectedTask = selectedComp?.tasks.find((t) => t.task_id === taskId) ?? null;
  const compName = selectedComp?.name ?? comp.data?.name ?? retrying?.compName ?? null;
  const taskName = selectedTask?.name ?? task.data?.name ?? retrying?.taskName ?? null;
  const timezone = selectedComp?.timezone ?? comp.data?.timezone ?? null;

  function fail(error: string, code?: SubmitError['code']) {
    setFailure({ error, code });
  }

  async function submit() {
    if (!compId || !taskId) return fail('Choose the task you flew.', 'task_not_found');
    if (!track) return fail('Choose your IGC file.', 'invalid_file');
    if (!user && identifierValue.trim() === '') return fail('Tell us who the track is for.', 'bad_identifier');
    // Asked and unanswered. The server refuses to guess either way, but being
    // stopped before the upload beats being stopped after it.
    if (user && onBehalfOf === SELF && registration.data?.state === 'choose' && !chosenRegistration) {
      return fail(
        'Tell us which registration is yours, so your track is not filed under a second entry.',
        'identity_ambiguous',
      );
    }
    const as: SubmitAs = user
      ? onBehalfOf !== SELF
        ? { kind: 'on-behalf', compPilotId: onBehalfOf }
        : { kind: 'self', registration: chosenRegistration }
      : { kind: 'anonymous', identifierKind, identifierValue: identifierValue.trim() };
    setFailure(null);
    setQueuing(true);
    try {
      const sub = await enqueue(
        {
          accountId: user?.id ?? null,
          compId,
          taskId,
          compName,
          taskName,
          timezone,
          as,
          forLabel: forWhom(as),
          fileName: track.name,
          rawBytes: track.rawBytes,
          filePilotName: track.pilotName,
        },
        track.gz,
      );
      if (retrying) remove(retrying.id);
      setQueuedId(sub.id);
    } catch {
      fail('GlideComp couldn’t save the track on this phone. Check there is space, and try again.');
    } finally {
      setQueuing(false);
    }
  }

  function forWhom(as: SubmitAs): string {
    switch (as.kind) {
      case 'anonymous':
        // "CIVL ID 77001"; an email address names itself.
        return as.identifierKind === 'email'
          ? as.identifierValue
          : `${IDENTIFIER_KINDS.find((k) => k.value === as.identifierKind)?.label ?? ''} ${as.identifierValue}`.trim();
      case 'on-behalf':
        return roster.data?.find((p) => p.comp_pilot_id === as.compPilotId)?.name ?? 'another pilot';
      case 'self': {
        const linked = registration.data?.state === 'linked' ? registration.data.comp_pilot.registered_pilot_name : null;
        const chosen =
          registration.data?.state === 'choose'
            ? registration.data.candidates.find((c) => c.comp_pilot_id === as.registration)?.registered_pilot_name
            : null;
        return linked ?? chosen ?? (user?.name.trim() || user?.email || 'you');
      }
    }
  }

  function another() {
    setQueuedId(null);
    setTrack(null);
    setFailure(null);
  }

  function openScoreCard(sub: Submission) {
    const id = sub.accepted?.comp_pilot_id;
    if (!id) return;
    router.dismiss();
    router.push(
      pilotPath(sub.compId, sub.compName, sub.taskId, sub.taskName, id, sub.accepted?.pilot_name ?? null) as never,
    );
  }

  // ── After Submit: the receipt, or where the track is.
  if (queued && queued.status !== 'refused') {
    return (
      <>
        <Stack.Screen
          options={{
            title:
              queued.status !== 'sent' ? 'Submit a track' : queued.accepted?.replaced ? 'Track replaced' : 'Track submitted',
          }}
        />
        <GroupedList testID="submit-outcome">
          {queued.status === 'sent' ? receiptGroups(queued, units) : null}
          {queued.status === 'sent' ? (
            <Group>
              <Row testID="view-score-card" title="View provisional score card" onPress={() => openScoreCard(queued)} />
              <ActionRow testID="submit-another" title="Submit another track" onPress={another} />
            </Group>
          ) : sending && online ? (
            <Group title="Sending your track…" testID="submit-sending">
              <Note>
                It hasn’t been submitted until this says so. You can close this: it carries on, and Me → Track
                uploads shows how it’s going.
              </Note>
            </Group>
          ) : (
            <Group title="Saved on this phone" testID="submit-waiting">
              <Note>
                No signal, so your track is saved on this phone. It hasn’t been submitted yet: GlideComp sends it
                as soon as there is signal, even if you close this. Me → Track uploads shows how it’s going.
              </Note>
            </Group>
          )}
          {queued.status !== 'sent' ? (
            <Group>
              <ActionRow testID="submit-done" title="Done" onPress={() => router.dismiss()} />
            </Group>
          ) : null}
        </GroupedList>
      </>
    );
  }

  const repairStep = repairStepFor(failure?.code);
  const comps = openComps.data ?? null;
  const pilots = (roster.data ?? []).filter((p) =>
    pilotFilter.trim() ? p.name.toLowerCase().includes(pilotFilter.trim().toLowerCase()) : true,
  );
  const onBehalfName = roster.data?.find((p) => p.comp_pilot_id === onBehalfOf);

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'Submit a track' }} />
      <GroupedList testID="submit-sheet">
        {!WRITES_ALLOWED ? (
          <Group>
            <Note>
              This development build reads glidecomp.com but never writes to it, so it can’t submit tracks there.
              Point it at your local workers to submit.
            </Note>
          </Group>
        ) : null}

        {/* 1. Which task */}
        {!editingTask && taskId ? (
          <Group title="Which task did you fly?" testID="task-step">
            <Row
              testID="task-chosen"
              title={taskLine(selectedComp, selectedTask, undefined, {
                compName,
                taskName,
                pilotClasses: task.data?.pilot_classes,
              })}
              detail={
                (selectedTask?.task_date ?? task.data?.task_date)
                  ? formatTaskDate((selectedTask?.task_date ?? task.data?.task_date)!, {
                      weekday: 'short',
                      day: 'numeric',
                      month: 'short',
                    })
                  : undefined
              }
            />
            <ActionRow testID="task-change" title="Change" onPress={() => setEditingTask(true)} />
          </Group>
        ) : comps === null ? (
          <Group title="Which task did you fly?" testID="task-step">
            <Note>
              {openComps.isError
                ? 'No signal, and this phone hasn’t seen which competitions are open. Open your task from Comps and submit from there.'
                : 'Finding competitions flying now…'}
            </Note>
          </Group>
        ) : comps.length === 0 ? (
          <Group title="Which task did you fly?" testID="task-step">
            <Note>
              No competitions are open for submissions right now. Open your competition’s task from Comps and submit
              from there.
            </Note>
          </Group>
        ) : (
          <Group title="Which task did you fly?" testID="task-step">
            <Note>Competitions taking tracks now, most recent task first.</Note>
          </Group>
        )}
        {editingTask && comps && comps.length > 0
          ? taskGroups(comps, compId, taskId, (c, t) => {
              setCompId(c);
              setTaskId(t);
              setChosenRegistration(null);
              setOnBehalfOf(SELF);
            })
          : null}

        {/* 2. Who it is for */}
        {user ? (
          <Group title="Who is the track for?" testID="identity-step">
            {canOnBehalf ? (
              <Row
                testID="submitting-for"
                title="Submitting for"
                value={onBehalfOf === SELF ? myself(user.name) : (onBehalfName?.name ?? '…')}
                onPress={() => setChoosingPilot((v) => !v)}
              />
            ) : (
              <Row title="Submitting for" value={myself(user.name)} />
            )}
            {canOnBehalf && choosingPilot ? (
              <FieldRow label="Search pilots" onChangeText={setPilotFilter} testID="pilot-search" />
            ) : null}
            {canOnBehalf && choosingPilot ? (
              <Row
                title={myself(user.name)}
                selected={onBehalfOf === SELF}
                onPress={() => {
                  setOnBehalfOf(SELF);
                  setChoosingPilot(false);
                }}
              />
            ) : null}
            {canOnBehalf && choosingPilot
              ? pilots.map((p: PilotListEntry) => (
                  <Row
                    key={p.comp_pilot_id}
                    testID={`roster-pilot-${p.comp_pilot_id}`}
                    title={p.name}
                    detail={p.pilot_class}
                    selected={onBehalfOf === p.comp_pilot_id}
                    onPress={() => {
                      setOnBehalfOf(p.comp_pilot_id);
                      setChoosingPilot(false);
                    }}
                  />
                ))
              : null}
            {onBehalfOf === SELF && compId
              ? registrationRows(registration.data ?? null, registration.isError, chosenRegistration, setChosenRegistration)
              : null}
            {onBehalfOf === SELF && registration.data?.state === 'choose' && !findingMe ? (
              <ActionRow
                testID="find-me"
                title="I’m registered under a different name"
                onPress={() => setFindingMe(true)}
              />
            ) : null}
            {onBehalfOf === SELF && registration.data?.state === 'choose' && findingMe ? (
              <ChoiceRow
                title="Find me by"
                value={findKind}
                choices={IDENTIFIER_KINDS}
                onChange={setFindKind}
                stacked
              />
            ) : null}
            {onBehalfOf === SELF && registration.data?.state === 'choose' && findingMe ? (
              <FieldRow
                label={IDENTIFIER_KINDS.find((k) => k.value === findKind)?.label ?? ''}
                email={findKind === 'email'}
                onChangeText={setFindValue}
              />
            ) : null}
            {onBehalfOf === SELF && registration.data?.state === 'choose' && findingMe ? (
              <ActionRow
                title="Find me"
                onPress={() => {
                  setChosenRegistration(null);
                  setIdentifierOverride(findValue.trim() ? { kind: findKind, value: findValue.trim() } : null);
                }}
              />
            ) : null}
            {identifierOverride && registration.data?.state === 'choose' && registration.data.candidates.length === 0 ? (
              <Note>Nothing on this roster answers to that. Pick yourself from the list, or ask the organiser.</Note>
            ) : null}
            <Note>
              This submission is recorded in the competition’s public activity log, and we email the registered
              pilot to tell them about it.
            </Note>
          </Group>
        ) : (
          <Group title="Who is the track for?" testID="identity-step">
            <Note>
              No account needed. Tell us how you are registered for this competition and we will match you to the
              roster.
            </Note>
            <ChoiceRow
              testID="ident-kind"
              title="Identify yourself by"
              value={identifierKind}
              choices={IDENTIFIER_KINDS}
              onChange={setIdentifierKind}
              stacked
            />
            <FieldRow
              testID="ident-value"
              label={IDENTIFIER_KINDS.find((k) => k.value === identifierKind)?.label ?? ''}
              defaultValue={identifierValue}
              email={identifierKind === 'email'}
              onChangeText={(next) => {
                setIdentifierValue(next);
                setIdentifierKind((k) => inferIdentifierKind(next, k));
              }}
            />
            <Note>
              This submission is recorded in the competition’s public activity log, and we email the registered
              pilot to tell them about it.
            </Note>
          </Group>
        )}

        {/* 3. The file */}
        <Group title="Your IGC file" testID="file-step">
          {track ? (
            <Row
              testID="file-chosen"
              title={track.name}
              detail={track.pilotName ? `Pilot named in the file: ${track.pilotName}` : undefined}
            />
          ) : null}
          {fileError ? <Note>{fileError}</Note> : null}
          <ActionRow
            testID="choose-file"
            title={reading ? 'Reading the file…' : track ? 'Change file…' : 'Choose IGC file…'}
            onPress={() => {
              if (!reading) void pick();
            }}
          />
        </Group>

        {failure
          ? failureGroup(
              failure,
              needsSignIn(failure.code) ? (
                <Row
                  title="Sign in to submit"
                  onPress={() => {
                    router.dismiss();
                    router.navigate('/me' as never);
                  }}
                />
              ) : repairStep ? (
                <Note>{repairWords[repairStep]}</Note>
              ) : null,
            )
          : null}

        {WRITES_ALLOWED ? (
          <Group>
            <ActionRow
              testID="submit-track"
              title={queuing ? 'Submitting…' : 'Submit track'}
              onPress={() => {
                if (!queuing) void submit();
              }}
            />
          </Group>
        ) : null}
      </GroupedList>
    </View>
  );
}

/** Where to look to fix a refusal — the website highlights the step instead. */
const repairWords = {
  task: 'Check the task above.',
  identity: 'Check who the track is for, above.',
  file: 'Check the file above.',
} as const;

function myself(name: string): string {
  return name.trim() ? `Myself (${name.trim()})` : 'Myself';
}

/**
 * The task step's list: a group per competition, a row per task, the chosen
 * one checked. The date beside each task is how a pilot avoids filing today's
 * flight against yesterday's, so it is on every row. A task names its class
 * only when its own name does not (`unnamedClasses`).
 */
function taskGroups(
  comps: OpenComp[],
  compId: string,
  taskId: string,
  onPick: (compId: string, taskId: string) => void,
) {
  return comps.map((c) => (
    <Group key={c.comp_id} title={c.name} testID={`open-comp-${c.comp_id}`}>
      {c.tasks.map((t) => {
        const extra = unnamedClasses(t.name, t.pilot_classes);
        return (
          <Row
            key={t.task_id}
            testID={`open-task-${t.task_id}`}
            title={t.name}
            detail={[extra, formatTaskDate(t.task_date, { weekday: 'short', day: 'numeric', month: 'short' })]
              .filter(Boolean)
              .join(' · ')}
            selected={c.comp_id === compId && t.task_id === taskId}
            onPress={() => onPick(c.comp_id, t.task_id)}
          />
        );
      })}
    </Group>
  ));
}

/**
 * "Which registration are you?" — the rows, inside the who-for group.
 * Nothing is preselected: preselecting the likeliest is how somebody files a
 * track against a stranger, and the order is a name likeness — a hint, never
 * a verdict.
 */
function registrationRows(
  state: RegistrationState | null,
  failed: boolean,
  chosen: string | null,
  onChoose: (value: string) => void,
) {
  // Unknown is not "new", and must never be shown as though it were.
  if (state === null) {
    return (
      <Note key="reg-unknown">
        {failed
          ? 'GlideComp couldn’t check your registration just now. Submit anyway: your track waits on this phone if it must, and if GlideComp needs to know which entry is yours, it will ask.'
          : 'Checking your registration…'}
      </Note>
    );
  }
  if (state.state === 'linked') {
    return (
      <Note key="reg-linked">{`Filing as ${state.comp_pilot.registered_pilot_name} (${state.comp_pilot.pilot_class}).`}</Note>
    );
  }
  if (state.state === 'new') {
    return (
      <Note key="reg-new">
        {state.may_register
          ? 'You are not on this competition’s roster yet. Submitting a track will add you.'
          : 'You are not on this competition’s roster yet, and it does not accept pilots adding themselves — ask the organiser.'}
      </Note>
    );
  }
  return [
    <Note key="reg-ask">
      {state.matched_by
        ? 'That identifier is registered here. Confirm which entry is yours:'
        : 'We could not tell which entry on this competition’s roster is you. Pick yourself, so your track is not filed under a second entry:'}
    </Note>,
    ...state.candidates.map((c) => (
      <Row
        key={c.comp_pilot_id}
        testID={`registration-${c.comp_pilot_id}`}
        title={c.registered_pilot_name}
        detail={[c.pilot_class, c.notify_email_masked].filter(Boolean).join(' · ')}
        selected={chosen === c.comp_pilot_id}
        onPress={() => onChoose(c.comp_pilot_id)}
      />
    )),
    ...(state.may_register
      ? [
          <Row
            key="new-pilot"
            testID="registration-new"
            title="None of these — register me as a new pilot"
            selected={chosen === NEW_PILOT_SENTINEL}
            onPress={() => onChoose(NEW_PILOT_SENTINEL)}
          />,
        ]
      : []),
  ];
}
