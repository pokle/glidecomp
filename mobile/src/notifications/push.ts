/**
 * Notifications (stage 9): opt-in, per competition. A competition's
 * "Notifications" row asks the phone for permission the first time it is
 * turned on, registers this device's Expo push token with the server, and
 * follows the comp (`routes/notifications.ts`). The server sends; a tap opens
 * the screen the message names.
 *
 * Never a replacement for the emails — the track notice goes out whatever is
 * set here — and never asked for at launch: a permission prompt belongs to
 * the moment someone asks to be told something.
 */
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import Storage from 'expo-sqlite/kv-store';
import { Platform } from 'react-native';

import { api } from '@/api/client';
import { write } from '@/api/organiser';

const TOKEN_KEY = 'push-token';

const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string }; pushNotifications?: boolean } | undefined;
const projectId = extra?.eas?.projectId;
/** iOS push needs the capability, which a Personal Team build goes without (app.config.ts). */
const capable = Platform.OS !== 'ios' || extra?.pushNotifications === true;

/** A notification that arrives while the app is open still shows. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export type PushReady = { ok: true } | { ok: false; reason: 'simulator' | 'denied' | 'unconfigured' };

/**
 * Make sure this device can be notified: permission, a token, and the token
 * registered for the signed-in account. Safe to call again — the server
 * moves a token to whoever signed in on the phone.
 */
export async function ensurePushToken(): Promise<PushReady> {
  if (!Device.isDevice) return { ok: false, reason: 'simulator' };
  if (!projectId || !capable) return { ok: false, reason: 'unconfigured' };
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Competition news',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return { ok: false, reason: 'denied' };
  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
  await write(() =>
    api.api.user['push-token'].$put({ json: { token, platform: Platform.OS === 'ios' ? 'ios' : 'android' } }),
  );
  await Storage.setItem(TOKEN_KEY, token);
  return { ok: true };
}

/** Signing out: this phone stops hearing about the account that left it. */
export async function forgetPushToken(): Promise<void> {
  const token = await Storage.getItem(TOKEN_KEY).catch(() => null);
  if (!token) return;
  await Storage.removeItem(TOKEN_KEY);
  try {
    await write(() => api.api.user['push-token'].$delete({ json: { token } }));
  } catch {
    // No signal: the server forgets a token when the next sign-in claims it.
  }
}

/** A tapped notification opens the screen it names. Called once, from the root layout. */
export function startNotificationTaps(): () => void {
  const open = (response: Notifications.NotificationResponse | null) => {
    const url = (response?.notification.request.content.data as { url?: unknown } | undefined)?.url;
    if (typeof url === 'string' && url.startsWith('/')) router.push(url as never);
  };
  // A tap that launched the app arrives before any listener could.
  void Notifications.getLastNotificationResponseAsync().then(open, () => {});
  const sub = Notifications.addNotificationResponseReceivedListener(open);
  return () => sub.remove();
}
