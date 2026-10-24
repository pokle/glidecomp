import { ANDROID_LINK_PATHS } from '@glidecomp/client/app-links';

import config from '../app.config';

/**
 * The paths Android hands the app (app.config.ts) must be the paths the
 * website's assetlinks association and the app's mapping are built from
 * (@glidecomp/client/app-links). app.config.ts keeps its own copy because the
 * Expo config loader cannot follow a workspace import; this is what keeps the
 * copy honest.
 */
describe('universal links in the app config', () => {
  it('claims exactly the shared Android paths on glidecomp.com, verified', () => {
    const filters = (config as { android: { intentFilters: { autoVerify?: boolean; data: { scheme?: string; host?: string; path?: string; pathPrefix?: string }[] }[] } }).android.intentFilters;
    const links = filters.find((f) => f.autoVerify);
    expect(links).toBeDefined();
    expect(links!.data.map(({ path, pathPrefix }) => (path ? { path } : { pathPrefix }))).toEqual(ANDROID_LINK_PATHS);
    expect(new Set(links!.data.map((d) => `${d.scheme}://${d.host}`))).toEqual(new Set(['https://glidecomp.com']));
  });
});
