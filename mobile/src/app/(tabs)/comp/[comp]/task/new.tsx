/**
 * Add task (stage 7): a name, a date and the classes that fly it, then into
 * the task — whose Route group is where its route is set.
 */
import { todayInZone } from '@glidecomp/client/format';
import { idFromSegment, taskPath } from '@glidecomp/client/slug';
import type { CompDetailData } from '@glidecomp/client/types';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { createTask } from '@/api/organiser';
import { useComp } from '@/api/queries';
import { ClassPicker } from '@/components/ClassPicker';
import { nextTaskName, taskFormProblem } from '@/lib/task-form';
import { Field, FormCard, FormMessage, FormScreen, PrimaryButton } from '@/ui/form';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';
import { useFormSave } from '@/ui/use-form-save';

export default function NewTaskScreen() {
  const { comp: segment } = useLocalSearchParams<{ comp: string }>();
  const comp = useComp(idFromSegment(segment));
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'Add task', headerLargeTitle: false }} />
      <StaleBanner query={comp} />
      <QueryGate query={comp} loading="Loading the competition…" notFound="This competition doesn’t exist, or isn’t public.">
        {(data) => <NewTaskForm comp={data} />}
      </QueryGate>
    </View>
  );
}

function NewTaskForm({ comp }: { comp: CompDetailData }) {
  const [name, setName] = useState(() => nextTaskName(comp.tasks));
  const [date, setDate] = useState(() => todayInZone(comp.timezone));
  const [classes, setClasses] = useState<string[]>(comp.pilot_classes);
  const { saving, note, setNote, run } = useFormSave();

  async function create() {
    const problem = taskFormProblem({ name, date, classes });
    if (problem) {
      setNote({ kind: 'error', text: problem });
      return;
    }
    const task = await run(() => createTask(comp.comp_id, { name: name.trim(), task_date: date, pilot_classes: classes }));
    if (task) router.replace(taskPath(comp.comp_id, comp.name, task.task_id, task.name) as never);
  }

  return (
    <FormScreen testID="new-task">
      <FormCard>
        <Field label="Name" value={name} onChangeText={setName} testID="new-task-name" />
        <Field
          label="Date (YYYY-MM-DD)"
          value={date}
          onChangeText={setDate}
          autoCapitalize="none"
          keyboardType="numbers-and-punctuation"
          testID="new-task-date"
        />
      </FormCard>
      {comp.pilot_classes.length > 1 ? (
        <FormCard title="Classes flying it">
          <ClassPicker classes={comp.pilot_classes} selected={classes} onChange={setClasses} />
        </FormCard>
      ) : null}
      {note ? <FormMessage kind={note.kind}>{note.text}</FormMessage> : null}
      <PrimaryButton title="Add task" pendingLabel="Adding the task" pending={saving} onPress={() => void create()} testID="new-task-create" />
    </FormScreen>
  );
}
