/**
 * A task or waypoint QR, full screen (IA §3: a takeover — it owns the device
 * while a briefing room scans it). Black on white whatever the theme, as big
 * as the screen allows, and the screen kept awake while it is up. Tap Done,
 * or swipe it away, to go back.
 *
 * It finds its source again from the route's params rather than carrying
 * the payload: `?comp&task` is a task, `?comp` a competition's waypoints,
 * `?code` a task in the reader's own library, and `swap=1` labels points by
 * their full name. Every source is already on the phone by the time Send to
 * instrument offers the code, so this reads it offline.
 */
import { instrumentQr, type InstrumentSource } from '@glidecomp/client/instrument';
import { useKeepAwake } from 'expo-keep-awake';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useComp, useCompWaypoints, useLibraryTask, useTask } from '@/api/queries';
import { useUserId } from '@/auth/session';
import { QrCode } from '@/components/QrCode';

type Params = { comp?: string; task?: string; code?: string; swap?: string };

export default function QrScreen() {
  useKeepAwake();
  const params = useLocalSearchParams<Params>();
  const swap = params.swap === '1';
  return (
    <SafeAreaView style={styles.screen} testID="qr-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.bar}>
        <Pressable accessibilityRole="button" hitSlop={12} onPress={() => router.back()} testID="qr-done">
          <Text style={styles.done}>Done</Text>
        </Pressable>
      </View>
      {params.code ? (
        <LibraryTaskQr code={params.code} swap={swap} />
      ) : params.comp && params.task ? (
        <TaskQr compId={params.comp} taskId={params.task} swap={swap} />
      ) : params.comp ? (
        <WaypointsQr compId={params.comp} swap={swap} />
      ) : (
        <Message text="Nothing to show." />
      )}
    </SafeAreaView>
  );
}

function TaskQr({ compId, taskId, swap }: { compId: string; taskId: string; swap: boolean }) {
  const task = useTask(compId, taskId);
  if (!task.data) return <Message text={task.isError ? 'Couldn’t load the task.' : 'Loading the task…'} />;
  if (!task.data.xctsk) return <Message text="Route not set yet." />;
  return <Code source={{ kind: 'task', name: task.data.name, task: task.data.xctsk }} swap={swap} noun="turnpoint" />;
}

function WaypointsQr({ compId, swap }: { compId: string; swap: boolean }) {
  const comp = useComp(compId);
  const waypoints = useCompWaypoints(compId);
  if (!waypoints.data) return <Message text={waypoints.isError ? 'Couldn’t load the waypoints.' : 'Loading the waypoints…'} />;
  return (
    <Code
      source={{ kind: 'waypoints', name: comp.data?.name ?? 'Waypoints', records: waypoints.data }}
      swap={swap}
      noun="waypoint"
    />
  );
}

function LibraryTaskQr({ code, swap }: { code: string; swap: boolean }) {
  const task = useLibraryTask(useUserId(), code);
  if (!task.data) return <Message text={task.isError ? 'Couldn’t load the task.' : 'Loading the task…'} />;
  if (!task.data.xctsk) return <Message text="This task file has no route." />;
  return <Code source={{ kind: 'task', name: task.data.display_name, task: task.data.xctsk }} swap={swap} noun="turnpoint" />;
}

function Code({ source, swap, noun }: { source: InstrumentSource; swap: boolean; noun: string }) {
  const { width, height } = useWindowDimensions();
  const qr = instrumentQr(source, { swap });
  if (!qr.value) {
    return (
      <Message
        text={qr.count === 0 ? `No ${noun}s to put in a code yet.` : `Too many ${noun}s (${qr.count}) to fit in a single QR code — send a file instead.`}
      />
    );
  }
  const size = Math.min(width, height - 200) - 32;
  const count = `${qr.count} ${noun}${qr.count === 1 ? '' : 's'}`;
  return (
    <View style={styles.body}>
      <QrCode value={qr.value} size={size} label={`QR code for ${source.name}, ${count}`} />
      <Text style={styles.title}>{source.name}</Text>
      <Text style={styles.caption}>{`Scan with XCTrack, Flyskyhy or any app that reads XCTSK task QRs · ${count}`}</Text>
    </View>
  );
}

function Message({ text }: { text: string }) {
  return (
    <View style={styles.body}>
      <Text style={styles.caption}>{text}</Text>
    </View>
  );
}

// Fixed colours, not the theme's: the code must be dark on light to scan.
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#ffffff' },
  bar: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 16, minHeight: 44, alignItems: 'center' },
  done: { fontSize: 17, fontWeight: '600', color: '#007AFF' },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16, gap: 12 },
  title: { fontSize: 20, fontWeight: '600', color: '#1d1d1f', textAlign: 'center' },
  caption: { fontSize: 15, color: '#3c3c43', textAlign: 'center' },
});
