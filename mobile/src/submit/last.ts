/**
 * What the pilot last submitted anonymously, so day two of a comp costs no
 * typing — the website's `glidecomp:last-submit`, with the same rules
 * (@glidecomp/client/submit). In the secure store rather than plain storage:
 * the identifier can be an email address. A convenience only — the server
 * re-checks it every time.
 *
 * Written only once the server has ACCEPTED a track, as on the website: an
 * identifier it refused is not worth offering again.
 */
import { readLastSubmission, writeLastSubmission, type LastSubmission } from '@glidecomp/client/submit';

import { secureStorage } from '@/auth/client';

const KEY = 'glidecomp_last_submit';

const store = {
  getItem: () => secureStorage.getItem(KEY),
  setItem: (_key: string, value: string) => void secureStorage.setItemAsync(KEY, value).catch(() => {}),
};

export function readLast(): LastSubmission | null {
  return readLastSubmission(store);
}

export function rememberLast(value: LastSubmission): void {
  writeLastSubmission(store, value);
}
