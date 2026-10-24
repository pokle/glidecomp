/**
 * One turnpoint of the route editor, in a sheet over it (the website's
 * TurnpointSheet, on a phone): its type, the competition waypoint it is set
 * from, and its code, name, coordinates, radius and altitude.
 *
 * Units follow the root rules: the altitude is typed in the reader's own
 * unit and stored in metres (`toAltitudeInput` / `fromAltitudeInput`), and the
 * label says which; a cylinder radius is always metres, the task's own
 * number, with the website's 400 m … 5 km chips. A zero altitude is a known
 * one; only an empty field is unknown.
 */
import { matchWaypoints } from '@glidecomp/client/quick-task';
import { parseCoords } from '@glidecomp/client/route-editor';
import {
  draftWithRecord,
  RADIUS_PRESETS,
  radiusChipLabel,
  typeOptions,
  type TurnpointDraft,
} from '@glidecomp/client/turnpoint-draft';
import { fromAltitudeInput, toAltitudeInput } from '@glidecomp/client/units';
import type { WaypointFileRecord } from '@glidecomp/engine';
import { useTheme } from 'expo-router';
import { useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useUnits } from '@/settings/units';
import { Choices, DangerButton, Field, FormCard, FormHint, FormMessage, FormScreen, PrimaryButton } from '@/ui/form';

export function TurnpointSheet({
  draft: initial,
  isLast,
  waypoints,
  onDone,
  onCancel,
  onRemove,
}: {
  draft: TurnpointDraft;
  /** This turnpoint is the route's last, so it is the scoring goal whatever its type. */
  isLast: boolean;
  waypoints: WaypointFileRecord[];
  onDone: (draft: TurnpointDraft) => void;
  onCancel: () => void;
  /** Absent while adding: there is nothing to remove yet. */
  onRemove?: () => void;
}) {
  const prefs = useUnits();
  const { colors } = useTheme();
  // Android has no page sheet: the modal fills the screen, edge to edge like
  // the app, so it draws under the status and navigation bars and must clear
  // them itself — or Cancel and Done sit under the clock. iOS's page sheet
  // already starts below the status bar.
  const insets = useSafeAreaInsets();
  const edge = Platform.OS === 'android' ? insets : { top: 0, bottom: 0 };
  const [draft, setDraft] = useState<TurnpointDraft>(initial);
  const [altitude, setAltitude] = useState(() =>
    initial.altitude === '' || !Number.isFinite(Number(initial.altitude))
      ? ''
      : String(Math.round(toAltitudeInput(Number(initial.altitude), prefs))),
  );
  const [search, setSearch] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const matches = search.trim() ? matchWaypoints(search, waypoints, 6) : [];
  const unit = prefs.altitude === 'ft' ? 'ft' : 'm';

  function pick(rec: WaypointFileRecord) {
    const next = draftWithRecord(draft, rec);
    setDraft(next);
    setAltitude(next.altitude === '' ? '' : String(Math.round(toAltitudeInput(Number(next.altitude), prefs))));
    setSearch('');
  }

  function done() {
    if (!String(draft.name).trim()) return setProblem('A turnpoint needs a code.');
    if (!parseCoords(String(draft.coords))) return setProblem('Enter the coordinates as “lat, lon”, e.g. -36.550979, 147.890395.');
    const radius = Number(draft.radius);
    if (!Number.isInteger(radius) || radius < 1 || radius > 50000) return setProblem('The radius is a whole number of metres, 1 to 50000.');
    const typed = altitude.trim();
    if (typed !== '' && !Number.isFinite(Number(typed))) return setProblem('The altitude is a number, or empty when it is not known.');
    onDone({ ...draft, altitude: typed === '' ? '' : Math.round(fromAltitudeInput(Number(typed), prefs)) });
  }

  return (
    <Modal animationType="slide" presentationStyle="pageSheet" onRequestClose={onCancel}>
      <View style={[styles.bar, { backgroundColor: colors.card, borderColor: colors.border, paddingTop: edge.top, minHeight: 56 + edge.top }]}>
        <Pressable accessibilityRole="button" hitSlop={12} onPress={onCancel} testID="turnpoint-cancel">
          <Text style={[styles.barButton, { color: colors.primary }]}>Cancel</Text>
        </Pressable>
        <Text style={[styles.barTitle, { color: colors.text }]} accessibilityRole="header">
          {onRemove ? 'Turnpoint' : 'Add turnpoint'}
        </Text>
        <Pressable accessibilityRole="button" hitSlop={12} onPress={done} testID="turnpoint-done">
          <Text style={[styles.barButton, styles.barDone, { color: colors.primary }]}>Done</Text>
        </Pressable>
      </View>
      <FormScreen testID="turnpoint-sheet">
        <FormCard>
          <Choices
            label="Type"
            value={draft.type}
            choices={typeOptions({ lastIsGoal: isLast })}
            onChange={(type) => setDraft((d) => ({ ...d, type }))}
            testID="turnpoint-type"
          />
        </FormCard>
        {waypoints.length > 0 ? (
          <FormCard title="From a waypoint">
            <Field
              label="Find a competition waypoint"
              value={search}
              onChangeText={setSearch}
              autoCapitalize="characters"
              autoCorrect={false}
              placeholder="Code or name"
              testID="turnpoint-search"
            />
            {matches.map((rec) => (
              <Pressable
                key={`${rec.code}-${rec.latitude}`}
                accessibilityRole="button"
                onPress={() => pick(rec)}
                style={styles.match}
                testID={`turnpoint-match-${rec.code}`}>
                <Text style={[styles.matchCode, { color: colors.text }]}>{rec.code}</Text>
                {rec.name !== rec.code ? <Text style={[styles.matchName, { color: colors.text }]}>{rec.name}</Text> : null}
              </Pressable>
            ))}
          </FormCard>
        ) : null}
        <FormCard title="Details">
          <Field
            label="Code"
            value={String(draft.name)}
            onChangeText={(name) => setDraft((d) => ({ ...d, name }))}
            autoCapitalize="characters"
            testID="turnpoint-code"
          />
          <Field
            label="Name"
            value={String(draft.description)}
            onChangeText={(description) => setDraft((d) => ({ ...d, description }))}
            testID="turnpoint-name"
          />
          <Field
            label="Coordinates (lat, lon)"
            value={String(draft.coords)}
            onChangeText={(coords) => setDraft((d) => ({ ...d, coords }))}
            keyboardType="numbers-and-punctuation"
            autoCapitalize="none"
            placeholder="-36.550979, 147.890395"
            testID="turnpoint-coords"
          />
          <Field
            label="Radius (m)"
            value={String(draft.radius)}
            onChangeText={(radius) => setDraft((d) => ({ ...d, radius }))}
            keyboardType="number-pad"
            testID="turnpoint-radius"
          />
          <Choices
            label="Common radii"
            value={String(draft.radius)}
            choices={RADIUS_PRESETS.map((m) => ({ value: String(m), label: radiusChipLabel(m) }))}
            onChange={(radius) => setDraft((d) => ({ ...d, radius: Number(radius) }))}
          />
          <Field
            label={`Altitude (${unit})`}
            value={altitude}
            onChangeText={setAltitude}
            keyboardType="numbers-and-punctuation"
            placeholder="Not known"
            testID="turnpoint-altitude"
          />
          <FormHint>A waypoint at sea level is 0; leave the altitude empty only when it isn’t known.</FormHint>
        </FormCard>
        {problem ? <FormMessage kind="error">{problem}</FormMessage> : null}
        <PrimaryButton title="Done" onPress={done} />
        {onRemove ? <DangerButton title="Remove turnpoint" onPress={onRemove} testID="turnpoint-remove" /> : null}
        <View style={{ height: edge.bottom }} />
      </FormScreen>
    </Modal>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    minHeight: 56,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  barTitle: { fontSize: 17, fontWeight: '600' },
  barButton: { fontSize: 17 },
  barDone: { fontWeight: '600' },
  match: { minHeight: 44, justifyContent: 'center', paddingVertical: 4 },
  matchCode: { fontSize: 17, fontWeight: '600' },
  matchName: { fontSize: 15, opacity: 0.7 },
});
