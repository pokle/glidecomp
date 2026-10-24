/**
 * Task settings (IA §14, stage 7): name, date, classes, the task stop, open
 * for submissions, and delete — the website's TaskSettings, field for field
 * and in its words. The route and the weather notes are edited from their
 * own rows on the task view, beside what they edit, not from here.
 *
 * The stop is a comp-local time of day on the task date, as the website
 * takes it; the server stores the UTC instant and re-scores under the
 * stopped-task rules (FAI S7F §13.4).
 */
import { idFromSegment, compPath } from '@glidecomp/client/slug';
import { utcISOToZonedDateTimeLocal, zonedDateTimeLocalToUtcISO, zoneLabel } from '@glidecomp/client/time';
import type { CompDetailData, TaskDetailData } from '@glidecomp/client/types';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { deleteTask, updateTask } from '@/api/organiser';
import { useComp, useTask } from '@/api/queries';
import { ClassPicker } from '@/components/ClassPicker';
import { taskFormProblem } from '@/lib/task-form';
import { DangerButton, Field, FormCard, FormHint, FormMessage, FormScreen, PrimaryButton, Toggle } from '@/ui/form';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';
import { confirmDestructive, useFormSave, useUnsavedGuard } from '@/ui/use-form-save';

export default function TaskSettingsScreen() {
  const params = useLocalSearchParams<{ comp: string; task: string }>();
  const compId = idFromSegment(params.comp);
  const comp = useComp(compId);
  const task = useTask(compId, idFromSegment(params.task));
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'Task settings', headerLargeTitle: false }} />
      <StaleBanner query={task} />
      <QueryGate query={task} loading="Loading the task…" notFound="This task doesn’t exist, or isn’t public.">
        {(data) => (comp.data ? <TaskSettingsForm task={data} comp={comp.data} /> : <View />)}
      </QueryGate>
    </View>
  );
}

const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

function TaskSettingsForm({ task, comp }: { task: TaskDetailData; comp: CompDetailData }) {
  const zone = comp.timezone;
  const savedStop = task.stop_announcement_time
    ? (utcISOToZonedDateTimeLocal(task.stop_announcement_time, zone)?.slice(11, 16) ?? '')
    : '';
  const [name, setName] = useState(task.name);
  const [date, setDate] = useState(task.task_date);
  const [classes, setClasses] = useState<string[]>(task.pilot_classes);
  const [stop, setStop] = useState(savedStop);
  const [open, setOpen] = useState(!task.submissions_closed);
  const { saving, note, setNote, run } = useFormSave();
  const [deleting, setDeleting] = useState(false);
  const dirty =
    name !== task.name ||
    date !== task.task_date ||
    classes.join() !== task.pilot_classes.join() ||
    stop !== savedStop ||
    open !== !task.submissions_closed;
  useUnsavedGuard(dirty && !deleting, saving, 'these task settings');

  async function save() {
    const problem = taskFormProblem({ name, date, classes });
    if (problem) return setNote({ kind: 'error', text: problem });
    if (stop && !HHMM.test(stop.trim())) return setNote({ kind: 'error', text: 'Enter the stop time as HH:MM, or leave it empty.' });
    const stopIso = stop.trim() ? zonedDateTimeLocalToUtcISO(`${date}T${stop.trim().padStart(5, '0')}`, zone) : null;
    await run(
      () =>
        updateTask(comp.comp_id, task.task_id, {
          name: name.trim(),
          task_date: date,
          pilot_classes: classes,
          stop_announcement_time: stopIso,
          submissions_closed: !open,
        }),
      'Task settings saved.',
    );
  }

  async function remove() {
    if (!(await confirmDestructive('Delete this task?', 'This cannot be undone.', 'Delete'))) return;
    setDeleting(true);
    const ok = await run(async () => {
      await deleteTask(comp.comp_id, task.task_id);
      return true;
    });
    if (ok) router.dismissTo(compPath(comp.comp_id, comp.name) as never);
    else setDeleting(false);
  }

  return (
    <FormScreen testID="task-settings">
      <FormCard>
        <Field label="Name" value={name} onChangeText={setName} testID="task-settings-name" />
        <Field
          label="Date (YYYY-MM-DD)"
          value={date}
          onChangeText={setDate}
          autoCapitalize="none"
          keyboardType="numbers-and-punctuation"
          testID="task-settings-date"
        />
      </FormCard>
      {comp.pilot_classes.length > 1 ? (
        <FormCard title="Classes flying it">
          <ClassPicker classes={comp.pilot_classes} selected={classes} onChange={setClasses} />
        </FormCard>
      ) : null}
      <FormCard title="Task stop">
        <Field
          label={`Stop announcement time, HH:MM (${zoneLabel(new Date(`${date}T12:00:00Z`), zone ?? 'UTC')})`}
          value={stop}
          onChangeText={setStop}
          placeholder="Not stopped"
          keyboardType="numbers-and-punctuation"
          testID="task-settings-stop"
        />
        <FormHint>
          Set only when the task was stopped mid-flight (weather calldown). Scores are recomputed under the stopped-task
          rules (FAI S7F §13.4): a scored-back stop time, a clipped scoring window, and an altitude bonus for pilots
          still flying. Leave empty for a task that ran to completion.
        </FormHint>
      </FormCard>
      <FormCard>
        <Toggle
          label="Open for track submissions"
          hint="Turn this off and pilots can no longer send tracks or manual flights for this task. Organisers still can, so a late recovery does not need it turned back on."
          value={open}
          onChange={setOpen}
          testID="task-settings-open"
        />
      </FormCard>
      {note ? <FormMessage kind={note.kind}>{note.text}</FormMessage> : null}
      <PrimaryButton title="Save" pendingLabel="Saving" pending={saving} disabled={!dirty} onPress={() => void save()} testID="task-settings-save" />
      <DangerButton title="Delete task" onPress={() => void remove()} testID="task-settings-delete" />
    </FormScreen>
  );
}
