/**
 * One roster entry, or a new one (`/pilots/new`): the website's pilot fields
 * that matter on a hill — name, email, class, CIVL ID, glider, team, driver
 * contact and WPRS points — and Remove. An unclaimed entry says so; nothing
 * here links an entry to an account (names may propose, never dispose).
 */
import { parsePoints } from '@glidecomp/client/roster-csv';
import { idFromSegment } from '@glidecomp/client/slug';
import type { CompDetailData } from '@glidecomp/client/types';
import type { CompPilot } from '@glidecomp/client/roster-csv';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { addPilot, removePilot, updatePilot, type RosterFields } from '@/api/organiser';
import { useComp, useRosterDetail } from '@/api/queries';
import { Choices, DangerButton, Field, FormCard, FormHint, FormMessage, FormScreen, PrimaryButton } from '@/ui/form';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';
import { confirmDestructive, useFormSave, useUnsavedGuard } from '@/ui/use-form-save';

export default function RosterPilotScreen() {
  const params = useLocalSearchParams<{ comp: string; pilot: string }>();
  const compId = idFromSegment(params.comp);
  const comp = useComp(compId);
  const roster = useRosterDetail(compId);
  const isNew = params.pilot === 'new';
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: isNew ? 'Add pilot' : 'Pilot', headerLargeTitle: false }} />
      <StaleBanner query={roster} />
      <QueryGate query={roster} loading="Loading the roster…" notFound="This competition doesn’t exist, or isn’t public.">
        {(pilots) => {
          const pilot = isNew ? null : (pilots.find((p) => p.comp_pilot_id === params.pilot) ?? undefined);
          if (pilot === undefined) {
            return (
              <FormScreen>
                <FormHint>This pilot isn’t on the roster any more.</FormHint>
              </FormScreen>
            );
          }
          return comp.data ? <PilotForm comp={comp.data} pilot={pilot} /> : <View />;
        }}
      </QueryGate>
    </View>
  );
}

type Values = { name: string; email: string; pilot_class: string; civl_id: string; glider: string; team_name: string; driver_contact: string; wprs: string };

function valuesOf(p: CompPilot | null, comp: CompDetailData): Values {
  return {
    name: p?.name ?? '',
    email: p?.email ?? '',
    pilot_class: p?.pilot_class ?? comp.default_pilot_class ?? comp.pilot_classes[0] ?? 'open',
    civl_id: p?.civl_id ?? '',
    glider: p?.glider ?? '',
    team_name: p?.team_name ?? '',
    driver_contact: p?.driver_contact ?? '',
    wprs: p?.wprs_points != null ? String(p.wprs_points) : '',
  };
}

function PilotForm({ comp, pilot }: { comp: CompDetailData; pilot: CompPilot | null }) {
  const [saved, setSaved] = useState(() => valuesOf(pilot, comp));
  const [v, setV] = useState(saved);
  const { saving, note, setNote, run } = useFormSave();
  const [leaving, setLeaving] = useState(false);
  const dirty = (Object.keys(v) as (keyof Values)[]).some((k) => v[k] !== saved[k]);
  useUnsavedGuard(dirty && !leaving, saving, 'this pilot');
  const set = (k: keyof Values) => (text: string) => setV((x) => ({ ...x, [k]: text }));
  const orNull = (s: string) => (s.trim() === '' ? null : s.trim());

  async function save() {
    if (!v.name.trim()) return setNote({ kind: 'error', text: 'A pilot needs a name.' });
    const points = v.wprs.trim() === '' ? null : parsePoints(v.wprs);
    if (v.wprs.trim() !== '' && points === null) return setNote({ kind: 'error', text: 'WPRS points are a number above 0, like 214.6.' });
    const fields: RosterFields = {
      registered_pilot_name: v.name.trim(),
      registered_pilot_email: orNull(v.email),
      registered_pilot_civl_id: orNull(v.civl_id),
      registered_pilot_glider: orNull(v.glider),
      pilot_class: v.pilot_class,
      team_name: orNull(v.team_name),
      driver_contact: orNull(v.driver_contact),
      wprs_points: points,
      // A number typed here is the organiser's own, not a list's.
      ...(points !== (pilot?.wprs_points ?? null) ? { civl_ranking_slug: null, civl_ranking_date: null } : {}),
    };
    const ok = await run(async () => {
      if (pilot) await updatePilot(comp.comp_id, pilot.comp_pilot_id, fields);
      else await addPilot(comp.comp_id, fields);
      return true;
    }, pilot ? 'Pilot saved.' : undefined);
    if (ok) {
      setSaved(v);
      if (!pilot) {
        setLeaving(true);
        setTimeout(() => router.back(), 0);
      }
    }
  }

  async function remove() {
    if (!pilot) return;
    if (!(await confirmDestructive(`Remove ${pilot.name}?`, 'Their tracks and results in this competition go with them.', 'Remove'))) return;
    setLeaving(true);
    const ok = await run(async () => {
      await removePilot(comp.comp_id, pilot.comp_pilot_id);
      return true;
    });
    if (ok) router.back();
    else setLeaving(false);
  }

  return (
    <FormScreen testID="roster-pilot">
      {pilot && !pilot.linked ? <FormHint>Unclaimed: no account holds this entry yet. A pilot claims it by signing in with its email or one of its IDs.</FormHint> : null}
      <FormCard>
        <Field label="Name" value={v.name} onChangeText={set('name')} testID="roster-name" />
        <Field label="Email" value={v.email} onChangeText={set('email')} keyboardType="email-address" autoCapitalize="none" testID="roster-email" />
        {comp.pilot_classes.length > 1 ? (
          <Choices
            label="Class"
            value={v.pilot_class}
            choices={comp.pilot_classes.map((c) => ({ value: c, label: c }))}
            onChange={set('pilot_class')}
            testID="roster-class"
          />
        ) : null}
        <Field label="CIVL ID" value={v.civl_id} onChangeText={set('civl_id')} keyboardType="number-pad" testID="roster-civl" />
        <Field label="Glider" value={v.glider} onChangeText={set('glider')} testID="roster-glider" />
        <Field label="Team" value={v.team_name} onChangeText={set('team_name')} testID="roster-team" />
        <Field label="Driver contact" value={v.driver_contact} onChangeText={set('driver_contact')} testID="roster-driver" />
        <Field label="WPRS points" value={v.wprs} onChangeText={set('wprs')} keyboardType="decimal-pad" testID="roster-wprs" />
        <FormHint>Launch order is set from WPRS points. A number typed here is marked as set by the organiser.</FormHint>
      </FormCard>
      {note ? <FormMessage kind={note.kind}>{note.text}</FormMessage> : null}
      <PrimaryButton title={pilot ? 'Save' : 'Add pilot'} pendingLabel="Saving" pending={saving} disabled={!dirty} onPress={() => void save()} testID="roster-save" />
      {pilot ? <DangerButton title="Remove from the roster" onPress={() => void remove()} testID="roster-remove" /> : null}
    </FormScreen>
  );
}
