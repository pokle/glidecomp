/**
 * Record a manual flight for a pilot with no track (issue #306, FAI S7F
 * §9.2.2) — the website's ManualFlightForm on a phone, in its words. The
 * last turnpoint reached and the landing point; a finish time when they made
 * goal. The made-good distance is previewed exactly as the server computes
 * it, with the engine's own functions, so what the organiser reads is what
 * the pilot is scored.
 */
import { formatCoords, parseCoords } from '@glidecomp/client/route-editor';
import { idFromSegment } from '@glidecomp/client/slug';
import type { CompDetailData, ManualFlightEntry, TaskDetailData } from '@glidecomp/client/types';
import {
  distanceMadeGoodTo,
  formatDistance,
  manualOpenDistanceGeometry,
  taskForDistanceOrigin,
  type XCTask,
} from '@glidecomp/engine';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { saveManualFlight } from '@/api/organiser';
import { useComp, useManualFlights, useRoster, useTask } from '@/api/queries';
import { useUnits } from '@/settings/units';
import { Choices, Field, FormCard, FormHint, FormMessage, FormScreen, PrimaryButton } from '@/ui/form';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';
import { useFormSave, useUnsavedGuard } from '@/ui/use-form-save';

function turnpointLabel(task: XCTask, i: number): string {
  const tp = task.turnpoints[i];
  const name = tp.waypoint.name || `TP${i + 1}`;
  if (i === task.turnpoints.length - 1) return `Goal — ${name}`;
  if (tp.type === 'SSS') return `Start / SSS — ${name}`;
  if (tp.type === 'TAKEOFF') return `Take-off — ${name}`;
  if (tp.type === 'ESS') return `ESS — ${name}`;
  return `${i + 1}. ${name}`;
}

export default function ManualFlightScreen() {
  const params = useLocalSearchParams<{ comp: string; task: string; pilot: string }>();
  const compId = idFromSegment(params.comp);
  const taskId = idFromSegment(params.task);
  const comp = useComp(compId);
  const task = useTask(compId, taskId);
  const manual = useManualFlights(compId, taskId);
  const pilot = useRoster(compId).data?.find((p) => p.comp_pilot_id === params.pilot);
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'Manual flight', headerLargeTitle: false }} />
      <StaleBanner query={task} />
      <QueryGate query={task} loading="Loading the task…" notFound="This task doesn’t exist, or isn’t public.">
        {(data) =>
          !data.xctsk ? (
            <FormScreen>
              <FormHint>Set the task’s route first: a manual flight is measured along it.</FormHint>
            </FormScreen>
          ) : comp.data ? (
            <ManualForm
              comp={comp.data}
              task={data}
              route={data.xctsk}
              pilotId={params.pilot}
              pilotName={pilot?.name ?? 'this pilot'}
              existing={manual.data?.find((m) => m.comp_pilot_id === params.pilot && m.active) ?? null}
            />
          ) : (
            <View />
          )
        }
      </QueryGate>
    </View>
  );
}

function ManualForm({
  comp,
  task,
  route,
  pilotId,
  pilotName,
  existing,
}: {
  comp: CompDetailData;
  task: TaskDetailData;
  route: XCTask;
  pilotId: string;
  pilotName: string;
  existing: ManualFlightEntry | null;
}) {
  const prefs = useUnits();
  const openDistance = comp.scoring_format === 'open_distance';
  const goalIdx = route.turnpoints.length - 1;
  const startIdx = Math.max(0, route.turnpoints.findIndex((tp) => tp.type === 'SSS'));
  const [lastIdx, setLastIdx] = useState(existing ? existing.last_reached_tp_index : startIdx);
  const [coords, setCoords] = useState(existing ? formatCoords(existing.landing_lat, existing.landing_lon) : '');
  const [minutes, setMinutes] = useState(existing?.duration_seconds != null ? String(Math.round(existing.duration_seconds / 60)) : '');
  const { saving, note, setNote, run } = useFormSave();
  const [saved, setSaved] = useState(false);
  useUnsavedGuard(!saved && coords.trim() !== (existing ? formatCoords(existing.landing_lat, existing.landing_lon) : ''), saving, 'this flight');

  const madeGoal = !openDistance && lastIdx === goalIdx;
  const landing = parseCoords(coords);
  const scoringTask = useMemo(() => taskForDistanceOrigin(route, comp.gap_params?.distanceOrigin ?? 'takeoff'), [route, comp.gap_params]);
  const offset = route.turnpoints.length - scoringTask.turnpoints.length;
  const madeGood = useMemo(() => {
    if (!landing) return null;
    try {
      return openDistance
        ? manualOpenDistanceGeometry(route, landing).distance
        : distanceMadeGoodTo(scoringTask, lastIdx - offset, landing);
    } catch {
      return null;
    }
  }, [openDistance, route, scoringTask, offset, lastIdx, landing]);

  async function save() {
    if (!landing) return setNote({ kind: 'error', text: 'Enter the landing point as “latitude, longitude”.' });
    const mins = Number(minutes);
    const ok = await run(async () => {
      await saveManualFlight(comp.comp_id, task.task_id, pilotId, {
        last_reached_tp_index: openDistance ? 0 : lastIdx,
        landing_lat: landing.lat,
        landing_lon: landing.lon,
        duration_seconds: openDistance ? null : madeGoal && minutes.trim() && Number.isFinite(mins) ? Math.round(mins * 60) : null,
      });
      return true;
    });
    if (ok) {
      setSaved(true);
      setTimeout(() => router.back(), 0);
    }
  }

  return (
    <FormScreen testID="manual-flight">
      <FormHint>{`For ${pilotName} on ${task.name}.`}</FormHint>
      {!openDistance ? (
        <FormCard title="Last turnpoint reached">
          <Choices
            label="The furthest turnpoint the pilot legally tagged, in order."
            value={String(lastIdx)}
            choices={route.turnpoints.map((_, i) => ({ value: String(i), label: turnpointLabel(route, i) }))}
            onChange={(v) => setLastIdx(Number(v))}
            testID="manual-last-tp"
          />
        </FormCard>
      ) : null}
      <FormCard>
        <Field
          label="Landing point"
          value={coords}
          onChangeText={setCoords}
          placeholder="-36.550979, 147.890395"
          keyboardType="numbers-and-punctuation"
          autoCapitalize="none"
          testID="manual-landing"
        />
        <FormHint>Latitude, longitude — paste straight from Google Maps.</FormHint>
        {madeGoal ? (
          <>
            <Field label="Finish time (minutes)" value={minutes} onChangeText={setMinutes} keyboardType="number-pad" placeholder="e.g. 92" testID="manual-minutes" />
            <FormHint>Speed-section time, for time and speed points. Optional.</FormHint>
          </>
        ) : null}
      </FormCard>
      <FormHint>
        {madeGood !== null
          ? `${formatDistance(madeGood, { decimals: 1, prefs }).withUnit} ${openDistance ? 'open distance' : 'made good'}${madeGoal ? ' · in goal' : ''}`
          : `Enter a landing point to see the ${openDistance ? 'open distance' : 'made-good distance'}.`}
      </FormHint>
      {note ? <FormMessage kind={note.kind}>{note.text}</FormMessage> : null}
      <PrimaryButton title="Save flight" pendingLabel="Saving" pending={saving} onPress={() => void save()} testID="manual-save" />
    </FormScreen>
  );
}
