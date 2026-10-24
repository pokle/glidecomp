/**
 * My flights (IA §2, §15): the competition flights this account flew, each
 * opening its report card; then the personal library the website keeps at
 * /u/<username> — tracks to hand on, tasks to send to an instrument — and
 * how much of its allowance is used.
 *
 * Signed out there is nothing of the reader's to show, and the tab says so
 * and points at Me, where signing in lives (never a modal here).
 *
 * Every group is a direct child of the list (mobile/CLAUDE.md, "Lists").
 */
import { storageUsage, type LibraryTrack, type PilotFlight } from '@glidecomp/client/account';
import { formatFileSize, formatTaskDate, ordinal } from '@glidecomp/client/format';
import { pilotPath } from '@glidecomp/client/slug';
import { router, Stack } from 'expo-router';
import { Alert, View } from 'react-native';

import { libraryTrackBytes, useLibraryTasks, useLibraryTracks, useMyFlights } from '@/api/queries';
import { useIdentity } from '@/auth/session';
import { igcBytes } from '@/lib/igc-text';
import { groupFlightsByComp } from '@/lib/my-flights';
import { shareBytes } from '@/lib/send-file';
import { GroupedList, Group, Note, Row } from '@/ui/grouped-list';
import { StaleBanner } from '@/ui/QueryStates';

export default function MyFlights() {
  const identity = useIdentity();
  const userId = identity.kind === 'signed-in' ? identity.user.id : null;
  const flights = useMyFlights(userId);
  const tracks = useLibraryTracks(userId);
  const tasks = useLibraryTasks(userId);

  if (!userId) {
    return (
      <>
        <Stack.Screen options={{ title: 'My flights' }} />
        <GroupedList testID="my-flights">
          <Group>
            <Note>
              {identity.kind === 'checking'
                ? 'Checking your sign-in…'
                : 'Sign in to see your competition flights and the tracks and tasks you keep on GlideComp.'}
            </Note>
            {identity.kind === 'checking' ? null : (
              <Row testID="flights-sign-in" title="Sign in" onPress={() => router.navigate('/me')} />
            )}
          </Group>
        </GroupedList>
      </>
    );
  }

  const comps = groupFlightsByComp(flights.data ?? []);
  const trackList = tracks.data ?? [];
  const taskList = tasks.data ?? [];
  const usage =
    tracks.data && tasks.data
      ? storageUsage(trackList.reduce((sum, t) => sum + t.file_size, 0), trackList.length, taskList.length)
      : null;

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'My flights' }} />
      <StaleBanner query={flights} />
      <GroupedList testID="my-flights">
        {comps.length === 0 ? (
          <Group title="Competition flights">
            <Note>{flights.data ? 'No competition flights yet.' : 'Looking for your flights…'}</Note>
          </Group>
        ) : null}
        {comps.map((comp) => (
          <Group key={comp.comp_id} title={comp.comp_name} testID={`flights-comp-${comp.comp_id}`}>
            {comp.flights.map((f) => (
              <Row
                key={`${f.task_id}-${f.comp_pilot_id}`}
                testID={`flight-${f.task_id}`}
                title={f.task_name}
                detail={flightDetail(f)}
                value={f.rank != null && f.class_size != null ? `${ordinal(f.rank)} of ${f.class_size}` : undefined}
                onPress={() =>
                  router.push(pilotPath(f.comp_id, f.comp_name, f.task_id, f.task_name, f.comp_pilot_id) as never)
                }
              />
            ))}
          </Group>
        ))}

        <Group title="Tracks" testID="library-tracks">
          {trackList.length === 0 ? (
            <Note>{tracks.data ? 'No tracks in your library.' : 'Loading your tracks…'}</Note>
          ) : (
            trackList.map((t) => (
              <Row
                key={t.track_id}
                testID={`library-track-${t.track_id.slice(0, 8)}`}
                title={t.display_name}
                detail={trackDetail(t)}
                onPress={() => void shareTrack(t)}
              />
            ))
          )}
        </Group>

        <Group title="Tasks" testID="library-tasks">
          {taskList.length === 0 ? (
            <Note>{tasks.data ? 'No tasks in your library.' : 'Loading your tasks…'}</Note>
          ) : (
            taskList.map((t) => (
              <Row
                key={t.task_code}
                testID={`library-task-${t.task_code}`}
                title={t.display_name}
                detail="Send to instrument"
                onPress={() => router.push(`/flights/task/${encodeURIComponent(t.task_code)}` as never)}
              />
            ))
          )}
        </Group>

        {usage ? (
          <Group title="Storage" testID="library-storage">
            <Row testID="storage-used" title="Storage used" value={usage.summary} />
            {usage.fraction >= 0.8 ? (
              <Note>{`Storage almost full — ${Math.round(usage.fraction * 100)}% used. Remove old flights on the website or new uploads will fail.`}</Note>
            ) : null}
          </Group>
        ) : null}
      </GroupedList>
    </View>
  );
}

function flightDetail(f: PilotFlight): string {
  const date = formatTaskDate(f.task_date, { weekday: 'short', day: 'numeric', month: 'short' });
  if (f.kind === 'manual') return `${date} · Recorded by the organiser`;
  return f.rank == null ? `${date} · Not scored yet` : date;
}

function trackDetail(t: LibraryTrack): string {
  return [
    t.flight_date ? formatTaskDate(t.flight_date.slice(0, 10), { day: 'numeric', month: 'short', year: 'numeric' }) : null,
    t.glider,
    formatFileSize(t.file_size),
  ]
    .filter(Boolean)
    .join(' · ');
}

async function shareTrack(t: LibraryTrack) {
  try {
    const bytes = igcBytes(await libraryTrackBytes(t.track_id));
    await shareBytes(bytes, t.filename || `${t.display_name}.igc`, t.display_name);
  } catch {
    Alert.alert('Couldn’t get the track', 'Check your signal and try again.');
  }
}
