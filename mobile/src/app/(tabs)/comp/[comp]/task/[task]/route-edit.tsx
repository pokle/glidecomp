/**
 * Edit route (IA Q8, stage 7): the task's route on a phone — the draft on a
 * map, its turnpoints as a list that opens each one in a sheet, and the
 * start and goal settings — saved as one task PATCH, which the server
 * audits and re-scores.
 *
 * The rules are the website's, shared through @glidecomp/client: rows from
 * `turnpointsToRows`, the goal-stays-last reconcile from `turnpoint-draft`,
 * validation and assembly from `route-editor` (`assembleRouteTask`), and the
 * stored shape from `xctskForPatch`. Gates and the deadline are typed in the
 * comp's own zone and stored as UTC, as on the website; radii are metres,
 * altitudes the reader's unit.
 */
import {
  assembleRouteTask,
  turnpointsToRows,
  xctskForPatch,
  type RouteRow,
  type RouteSettings,
} from '@glidecomp/client/route-editor';
import { editableGates, gateToHHMM, TYPE_LABELS } from '@glidecomp/client/route';
import { idFromSegment } from '@glidecomp/client/slug';
import { utcToZonedHHMM, zonedToUtcHHMM, zoneNameWithOffset } from '@glidecomp/client/time';
import { blankDraft, inferAddedType, type TurnpointDraft } from '@glidecomp/client/turnpoint-draft';
import type { CompDetailData, TaskDetailData } from '@glidecomp/client/types';
import { formatAltitude, formatCylinderRadius, type XCTask } from '@glidecomp/engine';
import { router, Stack, useLocalSearchParams, useTheme } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { updateTask } from '@/api/organiser';
import { useComp, useCompWaypoints, useTask } from '@/api/queries';
import { TurnpointSheet } from '@/components/TurnpointSheet';
import { applyDraft, moveRow, removeRow } from '@/lib/route-draft';
import { TrackMap } from '@/map/TrackMap';
import { useUnits } from '@/settings/units';
import { Choices, Field, FormCard, FormHint, FormMessage, FormScreen, PrimaryButton, TextButton } from '@/ui/form';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';
import { useFormSave, useUnsavedGuard } from '@/ui/use-form-save';

export default function RouteEditScreen() {
  const params = useLocalSearchParams<{ comp: string; task: string }>();
  const compId = idFromSegment(params.comp);
  const comp = useComp(compId);
  const task = useTask(compId, idFromSegment(params.task));
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'Edit route', headerLargeTitle: false }} />
      <StaleBanner query={task} />
      <QueryGate query={task} loading="Loading the task…" notFound="This task doesn’t exist, or isn’t public.">
        {(data) => (comp.data ? <RouteEditor task={data} comp={comp.data} /> : <View />)}
      </QueryGate>
    </View>
  );
}

function RouteEditor({ task, comp }: { task: TaskDetailData; comp: CompDetailData }) {
  const prefs = useUnits();
  const { colors } = useTheme();
  const waypoints = useCompWaypoints(comp.comp_id).data ?? [];
  const openDistance = comp.scoring_format === 'open_distance';
  const tz = comp.timezone;
  const toLocal = (hhmm: string) => (tz ? (utcToZonedHHMM(task.task_date, hhmm, tz) ?? hhmm) : hhmm);
  const toUtc = (hhmm: string) => (tz ? (zonedToUtcHHMM(task.task_date, hhmm, tz) ?? hhmm) : hhmm);
  const zoneText = tz ? zoneNameWithOffset(new Date(`${task.task_date}T12:00:00Z`), tz) : 'UTC';

  const idRef = useRef(0);
  const nextId = () => ++idRef.current;
  const [rows, setRows] = useState<RouteRow[]>(() => turnpointsToRows(task.xctsk?.turnpoints ?? [], nextId));
  const [settings, setSettings] = useState<RouteSettings>(() => {
    const deadline = task.xctsk?.goal?.deadline ? gateToHHMM(task.xctsk.goal.deadline) : null;
    return {
      sssType: task.xctsk?.sss?.type ?? 'RACE',
      direction: task.xctsk?.sss?.direction ?? 'EXIT',
      gates: editableGates(task.xctsk?.sss).map(toLocal),
      goalType: task.xctsk?.goal?.type ?? 'CYLINDER',
      goalDeadline: deadline ? toLocal(deadline) : '',
      goalElevation: task.xctsk?.goal?.finishAltitude,
    };
  });
  const [editing, setEditing] = useState<{ id: number | null; draft: TurnpointDraft } | null>(null);
  const [touched, setTouched] = useState(false);
  const [saved, setSaved] = useState(false);
  const { saving, note, setNote, run } = useFormSave();
  useUnsavedGuard(touched && !saved, saving, 'this route');

  const assembled = useMemo(
    () => assembleRouteTask(rows, settings, { openDistance, base: task.xctsk, toUtc }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, settings, openDistance, task.xctsk],
  );
  // The draft as the map draws it: whatever turnpoints are valid so far.
  const preview: XCTask | null = useMemo(() => {
    const tps = assembleRouteTask(rows, settings, { openDistance, base: task.xctsk, toUtc: (t) => t });
    const turnpoints = tps.task?.turnpoints ?? [];
    return turnpoints.length > 0 ? { taskType: 'CLASSIC', version: 1, turnpoints } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);
  const mapKey = preview?.turnpoints.map((t) => `${t.waypoint.lat},${t.waypoint.lon},${t.radius}`).join('|') ?? '';

  const change = (fn: (r: RouteRow[]) => RouteRow[]) => {
    setRows(fn);
    setTouched(true);
    setNote(null);
  };
  const set = (patch: Partial<RouteSettings>) => {
    setSettings((s) => ({ ...s, ...patch }));
    setTouched(true);
    setNote(null);
  };

  async function save() {
    if (!assembled.task) return setNote({ kind: 'error', text: assembled.errors[0] ?? 'The route has a problem.' });
    const ok = await run(async () => {
      await updateTask(comp.comp_id, task.task_id, { xctsk: xctskForPatch(assembled.task!) as unknown as XCTask });
      return true;
    });
    if (ok) {
      setSaved(true);
      setTimeout(() => router.back(), 0);
    }
  }

  return (
    <FormScreen testID="route-editor">
      {preview ? (
        <View style={styles.map}>
          <TrackMap
            key={mapKey}
            task={preview}
            fixes={null}
            events={[]}
            focus={null}
            openDistanceLine={null}
            bestProgressRoute={null}
            timeZone={tz}
          />
        </View>
      ) : null}

      <FormCard title={`${rows.length} ${rows.length === 1 ? 'turnpoint' : 'turnpoints'}`}>
        {rows.map((row, i) => {
          const alt = String(row.altitude).trim();
          return (
            <View key={row.id} style={[styles.row, { borderColor: colors.border }]}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Turnpoint ${i + 1}, ${row.name || 'unnamed'}`}
                style={styles.rowMain}
                onPress={() => setEditing({ id: row.id, draft: row })}
                testID={`route-row-${i}`}>
                <Text style={[styles.rowTitle, { color: colors.text }]}>{`${i + 1}. ${row.name || 'Unnamed'}`}</Text>
                <Text style={[styles.rowDetail, { color: colors.text }]}>
                  {[
                    TYPE_LABELS[row.type] ?? 'Turnpoint',
                    Number.isFinite(Number(row.radius)) ? formatCylinderRadius(Number(row.radius)).withUnit : null,
                    alt !== '' && Number.isFinite(Number(alt)) ? formatAltitude(Number(alt), { prefs }).withUnit : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Move ${row.name || 'turnpoint'} up`}
                disabled={i === 0}
                onPress={() => change((r) => moveRow(r, row.id, -1))}
                style={[styles.move, { opacity: i === 0 ? 0.3 : 1 }]}>
                <Text style={[styles.moveText, { color: colors.primary }]}>↑</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Move ${row.name || 'turnpoint'} down`}
                disabled={i === rows.length - 1}
                onPress={() => change((r) => moveRow(r, row.id, 1))}
                style={[styles.move, { opacity: i === rows.length - 1 ? 0.3 : 1 }]}>
                <Text style={[styles.moveText, { color: colors.primary }]}>↓</Text>
              </Pressable>
            </View>
          );
        })}
        <TextButton
          title="Add turnpoint"
          onPress={() => setEditing({ id: null, draft: blankDraft(inferAddedType(rows, { openDistance })) })}
          testID="route-add"
        />
      </FormCard>

      {openDistance ? null : (
        <>
          <FormCard title="Start">
            <Choices
              label="Start type"
              value={settings.sssType}
              choices={[
                { value: 'RACE', label: 'Race to goal' },
                { value: 'ELAPSED-TIME', label: 'Elapsed time' },
              ]}
              onChange={(sssType) => set({ sssType })}
              testID="route-sss-type"
            />
            <Choices
              label="Start direction"
              value={settings.direction}
              choices={[
                { value: 'EXIT', label: 'Exit — cross outward' },
                { value: 'ENTER', label: 'Enter — cross inward' },
              ]}
              onChange={(direction) => set({ direction })}
              testID="route-direction"
            />
            <FormHint>
              {settings.sssType === 'RACE'
                ? `Start gates, ${zoneText}. A pilot’s start time is the last gate at or before their start crossing (FAI S7F §9.2.4.1).`
                : `Start open, ${zoneText}. Elapsed-time pilots are timed from their actual start crossing; a gate only sets when the start opens.`}
            </FormHint>
            {settings.gates.map((g, i) => (
              <View key={i} style={styles.gate}>
                <View style={{ flex: 1 }}>
                  <Field
                    label={`Gate ${i + 1} (HH:MM)`}
                    value={g}
                    onChangeText={(text) => set({ gates: settings.gates.map((x, j) => (j === i ? text : x)) })}
                    keyboardType="numbers-and-punctuation"
                    testID={`route-gate-${i}`}
                  />
                </View>
                <TextButton title="Remove" onPress={() => set({ gates: settings.gates.filter((_, j) => j !== i) })} />
              </View>
            ))}
            {settings.sssType === 'RACE' && settings.gates.length === 0 ? (
              <FormHint>No start gates — every pilot will be timed from their actual start crossing, like an elapsed-time task.</FormHint>
            ) : null}
            <TextButton title="Add gate" onPress={() => set({ gates: [...settings.gates, ''] })} testID="route-add-gate" />
          </FormCard>

          <FormCard title="Goal">
            <Choices
              label="Goal type"
              value={settings.goalType}
              choices={[
                { value: 'CYLINDER', label: 'Cylinder' },
                { value: 'LINE', label: 'Line' },
              ]}
              onChange={(goalType) => set({ goalType })}
              testID="route-goal-type"
            />
            <Field
              label={`Goal deadline, HH:MM (${zoneText})`}
              value={settings.goalDeadline}
              onChangeText={(goalDeadline) => set({ goalDeadline })}
              placeholder="No deadline"
              keyboardType="numbers-and-punctuation"
              testID="route-deadline"
            />
          </FormCard>
        </>
      )}

      {assembled.warnings.map((w) => (
        <FormHint key={w}>{`⚠ ${w}`}</FormHint>
      ))}
      {touched && assembled.errors.length > 0 ? <FormMessage kind="error">{assembled.errors[0]}</FormMessage> : null}
      {note ? <FormMessage kind={note.kind}>{note.text}</FormMessage> : null}
      <PrimaryButton
        title="Save route"
        pendingLabel="Saving the route"
        pending={saving}
        disabled={!touched}
        onPress={() => void save()}
        testID="route-save"
      />

      {editing ? (
        <TurnpointSheet
          draft={editing.draft}
          isLast={editing.id === null || rows[rows.length - 1]?.id === editing.id}
          waypoints={waypoints}
          onCancel={() => setEditing(null)}
          onDone={(draft) => {
            change((r) => applyDraft(r, editing.id, draft, nextId));
            setEditing(null);
          }}
          onRemove={
            editing.id === null
              ? undefined
              : () => {
                  const id = editing.id!;
                  change((r) => removeRow(r, id));
                  setEditing(null);
                }
          }
        />
      ) : null}
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  map: { height: 240, borderRadius: 12, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 56 },
  rowMain: { flex: 1, paddingVertical: 8, minHeight: 44, justifyContent: 'center' },
  rowTitle: { fontSize: 17, fontWeight: '600' },
  rowDetail: { fontSize: 14, opacity: 0.7, marginTop: 2 },
  move: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  moveText: { fontSize: 22 },
  gate: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
});
