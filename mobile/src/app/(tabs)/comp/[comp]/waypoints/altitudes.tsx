/**
 * Check altitudes (IA §10, stage 7): the competition's waypoint altitudes
 * against the terrain map. It reports nothing until it is run, changes
 * nothing on its own, and every row states BOTH altitudes. The rules are the
 * website's (@glidecomp/client/altitude-check): under 50 m is not a finding,
 * past 300 m the coordinates are the likelier fault, a whole-file ratio or
 * offset is one bulk fix, and a difference of exactly zero prints nothing.
 *
 * The list is a snapshot in membership and order, taken when the check ran:
 * accepting a row leaves it where it is. Accepted rows are written only by
 * Apply, which saves the waypoint file once. The waypoint file is metric, so
 * this screen is too.
 */
import {
  COORD_SUSPECT_DELTA_M,
  SUSPECT_DELTA_M,
  altitudeDelta,
  altitudeVerdict,
  describeAltitudePattern,
  detectAltitudePattern,
  feetToMetres,
  formatAltitudeDelta,
  needsReview,
  reviewSortKey,
  summariseAltitudeCheck,
  type AltitudePair,
} from '@glidecomp/client/altitude-check';
import { idFromSegment } from '@glidecomp/client/slug';
import type { WaypointFileRecord } from '@glidecomp/engine';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from 'expo-router';

import { saveWaypoints } from '@/api/organiser';
import { useCompWaypoints } from '@/api/queries';
import { readElevations, TERRAIN_AVAILABLE } from '@/lib/terrain';
import { FormCard, FormHint, FormMessage, FormScreen, PrimaryButton, TextButton } from '@/ui/form';
import { useFormSave, useUnsavedGuard } from '@/ui/use-form-save';

const m = (n: number) => `${Math.round(n)} m`;

function why(pair: AltitudePair): string | null {
  switch (altitudeVerdict(pair)) {
    case 'missing':
      return 'No altitude in the file; the map has one.';
    case 'coords':
      return `Out by more than ${COORD_SUSPECT_DELTA_M} m: check the coordinates before the altitude.`;
    case 'suspect':
      return `Out by more than ${SUSPECT_DELTA_M} m.`;
    default:
      return null;
  }
}

export default function CheckAltitudes() {
  const { comp: segment } = useLocalSearchParams<{ comp: string }>();
  const compId = idFromSegment(segment);
  const waypoints = useCompWaypoints(compId).data;
  const { colors } = useTheme();
  const [checking, setChecking] = useState(false);
  const [mapAlt, setMapAlt] = useState<(number | undefined)[] | null>(null);
  const [order, setOrder] = useState<number[]>([]);
  const [draft, setDraft] = useState<WaypointFileRecord[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const { saving, note, setNote, run } = useFormSave();
  const [applied, setApplied] = useState(false);

  const records = draft ?? waypoints ?? [];
  const changed = useMemo(
    () => (draft && waypoints ? draft.filter((w, i) => w.altitude !== waypoints[i]?.altitude).length : 0),
    [draft, waypoints],
  );
  useUnsavedGuard(changed > 0 && !applied, saving, 'these altitudes');

  const pairs: AltitudePair[] = records.map((w, i) => ({ fileAlt: w.altitude, mapAlt: mapAlt?.[i] }));
  const summary = mapAlt ? summariseAltitudeCheck(pairs) : null;
  const pattern = mapAlt ? detectAltitudePattern(pairs) : null;
  const listed = order.filter((i) => showAll || needsReview({ fileAlt: waypoints?.[i]?.altitude, mapAlt: mapAlt?.[i] }));

  async function check() {
    if (!waypoints) return;
    setChecking(true);
    setNote(null);
    try {
      const elevations = await readElevations(waypoints.map((w) => ({ lat: w.latitude, lon: w.longitude })));
      const byIndex = elevations.map((e) => (e === null ? undefined : Math.round(e)));
      if (byIndex.every((e) => e === undefined)) {
        setNote({ kind: 'error', text: 'Couldn’t read terrain elevations from Mapbox. Check your signal and try again.' });
        return;
      }
      setMapAlt(byIndex);
      // A snapshot: sorted by the size of the disagreement once, never again.
      const firstPairs = waypoints.map((w, i) => ({ fileAlt: w.altitude, mapAlt: byIndex[i] }));
      setOrder(waypoints.map((_, i) => i).sort((a, b) => reviewSortKey(firstPairs[b]) - reviewSortKey(firstPairs[a])));
      setDraft(waypoints.map((w) => ({ ...w })));
    } catch {
      setNote({ kind: 'error', text: 'Couldn’t read terrain elevations from Mapbox. Check your signal and try again.' });
    } finally {
      setChecking(false);
    }
  }

  const accept = (indexes: number[]) =>
    setDraft((d) => d && d.map((w, i) => (indexes.includes(i) && mapAlt?.[i] !== undefined ? { ...w, altitude: mapAlt[i] } : w)));

  const convertFromFeet = () =>
    setDraft((d) => d && d.map((w) => (w.altitude === undefined ? w : { ...w, altitude: feetToMetres(w.altitude) })));

  async function apply() {
    if (!draft) return;
    const ok = await run(async () => {
      await saveWaypoints(compId, draft);
      return true;
    });
    if (ok) {
      setApplied(true);
      setTimeout(() => router.back(), 0);
    }
  }

  const acceptable = listed.filter((i) => mapAlt?.[i] !== undefined && records[i]?.altitude !== mapAlt[i]);

  return (
    <FormScreen testID="check-altitudes">
      <Stack.Screen options={{ title: 'Check altitudes', headerLargeTitle: false }} />
      {!mapAlt ? (
        <FormCard>
          <FormHint>
            Compares every waypoint’s altitude with the terrain map, and changes nothing until you apply what you accept. It needs
            signal: the terrain is read from Mapbox.
          </FormHint>
          {TERRAIN_AVAILABLE ? (
            <PrimaryButton title="Check altitudes" pendingLabel="Reading the terrain" pending={checking} disabled={!waypoints?.length} onPress={() => void check()} testID="altitudes-run" />
          ) : (
            <FormHint>This build has no Mapbox token, so it can’t read the terrain.</FormHint>
          )}
        </FormCard>
      ) : (
        <>
          <FormCard>
            <Text accessibilityLiveRegion="polite" style={[styles.summary, { color: colors.text }]}>
              {summary!.reviewable > 0
                ? `${summary!.reviewable} of ${records.length} waypoints to look at`
                : summary!.compared === 0
                  ? 'No altitudes could be compared with the map'
                  : `Every altitude that could be checked agrees with the map to within ${SUSPECT_DELTA_M} m`}
            </Text>
            <FormHint>
              {[
                summary!.suspect > 0 ? `${summary!.suspect} differ by more than ${SUSPECT_DELTA_M} m` : null,
                summary!.coords > 0 ? `${summary!.coords} by more than ${COORD_SUSPECT_DELTA_M} m` : null,
                summary!.missing > 0 ? `${summary!.missing} carry no altitude` : null,
                summary!.ok > 0 ? `${summary!.ok} agree` : null,
                summary!.unreachable > 0 ? `${summary!.unreachable} could not be read from the map` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </FormHint>
            {summary!.corruptTerrainRead > 0 ? (
              <FormHint>
                {`${summary!.corruptTerrainRead === 1 ? '1 altitude is' : `${summary!.corruptTerrainRead} altitudes are`} out by almost exactly 6553.6 m, or a multiple of it. That is not anything in your waypoint file: it is the signature of a terrain reading taken before a decoding fault was fixed, and taking the map’s altitude now corrects it.`}
              </FormHint>
            ) : null}
            {pattern ? (
              <>
                <FormHint>{describeAltitudePattern(pattern)}</FormHint>
                {pattern.kind === 'feet' ? <TextButton title="Convert all from feet" onPress={convertFromFeet} testID="altitudes-feet" /> : null}
              </>
            ) : null}
          </FormCard>

          <FormCard title={showAll ? `All ${records.length} waypoints` : 'To look at'}>
            {listed.length === 0 ? <FormHint>Nothing to look at.</FormHint> : null}
            {listed.map((i) => {
              const w = records[i];
              const original = waypoints?.[i];
              const pair = { fileAlt: original?.altitude, mapAlt: mapAlt[i] };
              const delta = altitudeDelta(pair);
              const taken = mapAlt[i] !== undefined && w.altitude === mapAlt[i] && original?.altitude !== mapAlt[i];
              return (
                <Pressable
                  key={i}
                  accessibilityRole="button"
                  accessibilityState={{ selected: taken }}
                  disabled={mapAlt[i] === undefined}
                  onPress={() => (taken ? setDraft((d) => d && d.map((x, j) => (j === i ? { ...x, altitude: original?.altitude } : x))) : accept([i]))}
                  style={[styles.row, { borderColor: colors.border }]}
                  testID={`altitude-row-${i}`}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.code, { color: colors.text }]}>{w.code}</Text>
                    <Text style={[styles.pair, { color: colors.text }]}>
                      {`${original?.altitude === undefined ? 'no altitude in the file' : `file ${m(original.altitude)}`} → ${mapAlt[i] === undefined ? 'no map reading' : `map ${m(mapAlt[i]!)}`}`}
                      {delta === undefined || Math.round(delta) === 0 ? '' : `  ${formatAltitudeDelta(delta)} m`}
                    </Text>
                    {why(pair) ? <Text style={[styles.why, { color: colors.text }]}>{why(pair)}</Text> : null}
                  </View>
                  {mapAlt[i] !== undefined ? (
                    <Text style={[styles.take, { color: colors.primary }]}>{taken ? `✓ ${m(mapAlt[i]!)}` : `Use ${m(mapAlt[i]!)}`}</Text>
                  ) : null}
                </Pressable>
              );
            })}
            <TextButton
              title={showAll ? 'Show only the ones to look at' : `Show all ${records.length} waypoints`}
              onPress={() => setShowAll((s) => !s)}
            />
          </FormCard>

          {acceptable.length > 0 ? (
            <TextButton title={`Use the map’s altitude for all ${acceptable.length}`} onPress={() => accept(acceptable)} testID="altitudes-accept-all" />
          ) : null}
          <FormHint>Nothing is saved until you apply. Tasks already built keep their own copy of a waypoint, so corrections here do not change them.</FormHint>
          {note ? <FormMessage kind={note.kind}>{note.text}</FormMessage> : null}
          <PrimaryButton
            title={changed > 0 ? `Apply ${changed} ${changed === 1 ? 'change' : 'changes'}` : 'Apply'}
            pendingLabel="Saving the waypoints"
            pending={saving}
            disabled={changed === 0}
            onPress={() => void apply()}
            testID="altitudes-apply"
          />
        </>
      )}
      {!mapAlt && note ? <FormMessage kind={note.kind}>{note.text}</FormMessage> : null}
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  summary: { fontSize: 17, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 56, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  code: { fontSize: 17, fontWeight: '600' },
  pair: { fontSize: 14, fontVariant: ['tabular-nums'], marginTop: 2 },
  why: { fontSize: 13, opacity: 0.7, marginTop: 2 },
  take: { fontSize: 15, fontWeight: '600' },
});
