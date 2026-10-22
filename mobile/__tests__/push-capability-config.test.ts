/**
 * A development build signed by a free Personal Team must not ask for the
 * Push Notifications capability: the team cannot have it, and Xcode then
 * refuses to make a provisioning profile at all (it broke `bun run ios` on a
 * phone). The plugin must be told explicitly, because prebuild applies it to
 * any app that has the package, entitlement and all.
 */
type Plugin = string | [string, Record<string, unknown>];

function loadConfig(env: Record<string, string | undefined>) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  try {
    let config: { plugins: Plugin[]; extra: Record<string, unknown> } | undefined;
    jest.isolateModules(() => {
      config = require('../app.config').default;
    });
    return config!;
  } finally {
    process.env = saved;
  }
}

const notificationsOptions = (plugins: Plugin[]) =>
  (plugins.find((p) => Array.isArray(p) && p[0] === 'expo-notifications') as [string, Record<string, unknown>] | undefined)?.[1];

describe('push notifications in the app config', () => {
  it('a store build asks for remote notifications', () => {
    const config = loadConfig({ APP_VARIANT: 'production' });
    expect(notificationsOptions(config.plugins)?.enableRemoteNotifications).toBe(true);
    expect(config.extra.pushNotifications).toBe(true);
  });

  it('PUSH_NOTIFICATIONS=1 turns them on for a development build', () => {
    const config = loadConfig({ APP_VARIANT: undefined, PUSH_NOTIFICATIONS: '1' });
    expect(notificationsOptions(config.plugins)?.enableRemoteNotifications).toBe(true);
  });

  it('a development build without it lists the plugin with remote notifications off', () => {
    const config = loadConfig({ APP_VARIANT: undefined, PUSH_NOTIFICATIONS: '0' });
    expect(notificationsOptions(config.plugins)).toMatchObject({ enableRemoteNotifications: false });
    expect(config.extra.pushNotifications).toBe(false);
  });
});
