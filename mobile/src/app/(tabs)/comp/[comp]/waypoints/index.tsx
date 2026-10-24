/**
 * Waypoints (IA §10): the competition's waypoint set as a LIST, with the map
 * above it — the website's shape since it dropped the grid (CLAUDE.md,
 * "Mobile first"). Read-only here, so nothing opens: the whole row flies the
 * map to its waypoint, and the pin at its edge says that is what it does.
 * Organisers get Check altitudes and Upload a waypoint file above the list.
 *
 * Altitudes are in the reader's unit (a read-only row is an altitude printed
 * to a reader); a zero is a known altitude and an absent one says so;
 * radii are metres. Send (header) is the same Send to instrument a task has.
 */
import { idFromSegment } from '@glidecomp/client/slug';
import type { WaypointFileRecord } from '@glidecomp/engine';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useComp, useCompWaypoints } from '@/api/queries';
import { filterWaypoints, waypointDetail, waypointTitle } from '@/lib/waypoint-rows';
import { WaypointMap } from '@/map/WaypointMap';
import { useUnits } from '@/settings/units';
import { GroupedList, Group, Note, Row } from '@/ui/grouped-list';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';

/** The map pane: enough to see a flown-to point, leaving most of the screen to the list. */
const MAP_HEIGHT = 220;

export default function CompWaypoints() {
  const { comp: segment } = useLocalSearchParams<{ comp: string }>();
  const waypoints = useCompWaypoints(idFromSegment(segment));
  const isAdmin = !!useComp(idFromSegment(segment)).data?.is_admin;
  const [query, setQuery] = useState('');
  const hasAny = (waypoints.data?.length ?? 0) > 0;
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          title: 'Waypoints',
          headerSearchBarOptions: hasAny
            ? {
                placeholder: 'Filter by code, name or coordinates',
                autoCapitalize: 'none',
                onChangeText: (e) => setQuery(e.nativeEvent.text),
              }
            : undefined,
          headerRight: () =>
            hasAny ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Send waypoints to an instrument"
                hitSlop={12}
                testID="waypoints-send"
                onPress={() => router.push(`/comp/${segment}/waypoints/send` as never)}>
                <Text style={styles.headerButton}>Send</Text>
              </Pressable>
            ) : null,
        }}
      />
      <StaleBanner query={waypoints} />
      <QueryGate
        query={waypoints}
        loading="Loading the waypoints…"
        notFound="This competition doesn’t exist, or isn’t public.">
        {(data) => (
          <WaypointsBody
            waypoints={data}
            query={query}
            organiser={isAdmin ? (screen) => router.push(`/comp/${segment}/waypoints/${screen}` as never) : null}
          />
        )}
      </QueryGate>
    </View>
  );
}

function WaypointsBody({
  waypoints,
  query,
  organiser,
}: {
  waypoints: WaypointFileRecord[];
  query: string;
  /** The organiser's way to Upload and Check altitudes; null for everyone else. */
  organiser: ((screen: 'upload' | 'altitudes') => void) | null;
}) {
  const prefs = useUnits();
  const shown = useMemo(() => filterWaypoints(waypoints, query), [waypoints, query]);
  const [focus, setFocus] = useState<{ index: number; key: number } | null>(null);
  const taps = useRef(0);

  if (waypoints.length === 0) {
    return (
      <GroupedList testID="waypoints">
        <Group>
          <Note>No waypoints yet.</Note>
          {organiser ? <Row testID="waypoints-upload" title="Upload a waypoint file" onPress={() => organiser('upload')} /> : null}
        </Group>
      </GroupedList>
    );
  }

  const heading =
    shown.length === waypoints.length
      ? `${waypoints.length} ${waypoints.length === 1 ? 'waypoint' : 'waypoints'}`
      : `${shown.length} of ${waypoints.length} waypoints`;

  return (
    <View style={{ flex: 1 }}>
      <View style={{ height: MAP_HEIGHT }}>
        <WaypointMap waypoints={waypoints} focus={focus} />
      </View>
      <GroupedList testID="waypoints">
        {organiser ? (
          <Group title="Organiser" testID="waypoints-organiser">
            <Row testID="waypoints-check" title="Check altitudes" detail="Against the terrain map; nothing changes until you apply" onPress={() => organiser('altitudes')} />
            <Row testID="waypoints-upload" title="Upload a waypoint file" detail="Replaces these waypoints" onPress={() => organiser('upload')} />
          </Group>
        ) : null}
        <Group title={heading}>
          {shown.length === 0 ? <Note>No waypoint matches that filter.</Note> : null}
          {shown.map((i) => {
            const w = waypoints[i];
            return (
              <Row
                key={i}
                testID={`waypoint-row-${i}`}
                pin
                title={waypointTitle(w)}
                detail={waypointDetail(w, prefs)}
                onPress={() => setFocus({ index: i, key: ++taps.current })}
              />
            );
          })}
        </Group>
      </GroupedList>
    </View>
  );
}

const styles = StyleSheet.create({
  headerButton: { fontSize: 17, color: '#007AFF' },
});
