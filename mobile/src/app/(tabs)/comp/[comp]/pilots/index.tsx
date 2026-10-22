/**
 * Pilots — the roster (IA §11, stage 7): a list of sheets, grouped by class
 * and read down by WPRS points. Unclaimed entries are marked, and never
 * linked to anyone on a name. Add, import a CSV (the website's format and
 * rules), fill CIVL IDs and WPRS points, or export.
 *
 * Every edit is audited; class is a scoring input and the server marks the
 * scores stale for it.
 */
import { fillCivlIds, fillRankings } from '@glidecomp/client/civl-rankings';
import { exportCsvContent, pilotToRow, slugify, validateRows } from '@glidecomp/client/roster-csv';
import { idFromSegment } from '@glidecomp/client/slug';
import type { CompDetailData } from '@glidecomp/client/types';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';

import { bulkSaveRoster, lookupRankings, writeErrorText } from '@/api/organiser';
import { useComp, useRosterDetail } from '@/api/queries';
import { rosterByClass, rosterDetail } from '@/lib/roster';
import { shareFile } from '@/lib/send-file';
import { ActionRow, GroupedList, Group, Note, Row } from '@/ui/grouped-list';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';

export default function RosterScreen() {
  const { comp: segment } = useLocalSearchParams<{ comp: string }>();
  const compId = idFromSegment(segment);
  const comp = useComp(compId);
  const roster = useRosterDetail(compId);
  const [busy, setBusy] = useState<string | null>(null);
  const base = `/comp/${segment}/pilots`;

  async function fillFromCivl(c: CompDetailData) {
    const rows = (roster.data ?? []).map(pilotToRow);
    if (rows.length === 0) return;
    setBusy('Looking up the CIVL rankings…');
    try {
      const ids = fillCivlIds(rows, await lookupRankings(c.comp_id, rows));
      const ranks = fillRankings(ids.rows, await lookupRankings(c.comp_id, ids.rows));
      if (ids.filled === 0 && ranks.filled === 0) {
        Alert.alert(
          'Nothing to fill',
          ranks.already_set > 0
            ? `${ranks.already_set} pilots already have WPRS points. Clear a pilot’s points to fill the newer number.`
            : 'No CIVL ranking list matched a pilot without an ID or points.',
        );
        return;
      }
      const { payload, errors } = validateRows(ranks.rows, c.pilot_classes);
      if (errors.length > 0) {
        Alert.alert('Fix the roster first', errors[0]);
        return;
      }
      await bulkSaveRoster(c.comp_id, payload);
      Alert.alert('Roster filled', `${ids.filled} CIVL IDs and ${ranks.filled} WPRS scores added. Nothing already set was changed.`);
    } catch (err) {
      Alert.alert('Couldn’t fill the roster', writeErrorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function exportCsv(c: CompDetailData) {
    const text = exportCsvContent((roster.data ?? []).map(pilotToRow));
    await shareFile({ filename: `pilots-${slugify(c.name)}.csv`, mimeType: 'text/csv', text }, `${c.name} pilots`).catch(() =>
      Alert.alert('Couldn’t share the file', 'Try again.'),
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          title: 'Pilots',
          headerRight: () => (
            <Pressable accessibilityRole="button" accessibilityLabel="Add pilot" hitSlop={12} testID="roster-add" onPress={() => router.push(`${base}/new` as never)}>
              <Text style={{ fontSize: 17, color: '#007AFF' }}>Add</Text>
            </Pressable>
          ),
        }}
      />
      <StaleBanner query={roster} />
      <QueryGate query={roster} loading="Loading the roster…" notFound="This competition doesn’t exist, or isn’t public.">
        {(pilots) => {
          const c = comp.data;
          const groups = rosterByClass(pilots, c?.pilot_classes ?? []);
          return (
            <GroupedList testID="roster">
              <Group>
                <Note>
                  {c?.open_registration
                    ? 'Open registration: any signed-in pilot joins by submitting a track. Change it in Settings → Access.'
                    : 'Only an organiser adds pilots. Change it in Settings → Access.'}
                </Note>
                {busy ? <Note>{busy}</Note> : null}
              </Group>
              {pilots.length === 0 ? (
                <Group>
                  <Note>No pilots yet. Add them one at a time, or import a CSV.</Note>
                </Group>
              ) : null}
              {groups.map((g) => (
                <Group key={g.pilotClass} title={`${g.pilotClass} · ${g.pilots.length}`}>
                  {g.pilots.map((p) => (
                    <Row
                      key={p.comp_pilot_id}
                      testID={`roster-${p.comp_pilot_id}`}
                      title={p.name}
                      detail={rosterDetail(p)}
                      value={p.wprs_points !== null ? `WPRS ${p.wprs_points}` : undefined}
                      onPress={() => router.push(`${base}/${p.comp_pilot_id}` as never)}
                    />
                  ))}
                </Group>
              ))}
              {c ? (
                <Group title="Roster">
                  <Row testID="roster-import" title="Import CSV" detail="Replaces the roster with the file’s pilots" onPress={() => router.push(`${base}/import` as never)} />
                  <ActionRow testID="roster-civl" title="Fill CIVL IDs and WPRS points" onPress={() => void fillFromCivl(c)} />
                  <ActionRow testID="roster-export" title="Export CSV" onPress={() => void exportCsv(c)} />
                </Group>
              ) : null}
            </GroupedList>
          );
        }}
      </QueryGate>
    </View>
  );
}
