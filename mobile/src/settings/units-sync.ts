/**
 * Units follow the account (stage 4), through the same per-account blob the
 * website syncs (`/api/auth/preferences`, its `prefs.units`).
 *
 * The website's rules, kept: the account wins where it has a value, and a
 * device with something the account lacks uploads it; a change is pushed two
 * seconds after the last tap; last write wins. One difference: the blob holds
 * the website's other preferences too, which this app knows nothing of, so a
 * push re-reads it and changes `units` alone rather than replacing it.
 */
import type { UnitPreferences } from '@glidecomp/engine';

import { authRequest, getJson } from '@/api/client';
import { getIdentity, subscribeIdentity } from '@/auth/session';

import { adoptUnits, getUnits, onUnitsChangedHere } from './units';

type Prefs = Record<string, unknown> & { units?: Partial<UnitPreferences> };

const PUSH_DELAY_MS = 2_000;

async function readPrefs(): Promise<Prefs> {
  return (await getJson<{ prefs: Prefs }>(authRequest('/preferences'))).prefs ?? {};
}

async function writeUnits(prefs: Prefs): Promise<void> {
  await getJson(
    authRequest('/preferences', {
      method: 'PUT',
      body: JSON.stringify({ prefs: { ...prefs, units: getUnits() } }),
    }),
  );
}

/** On signing in (or launching signed in): bring the account's units here. */
async function pull(): Promise<void> {
  const prefs = await readPrefs();
  if (prefs.units && Object.keys(prefs.units).length > 0) adoptUnits(prefs.units);
  else await writeUnits(prefs);
}

async function push(): Promise<void> {
  await writeUnits(await readPrefs());
}

/** Started once, from the root layout. A failure waits for the next change. */
export function startUnitsSync(): () => void {
  let pulledFor: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const onIdentity = () => {
    const current = getIdentity();
    if (current.kind !== 'signed-in') {
      pulledFor = null;
      return;
    }
    if (!current.confirmed || pulledFor === current.user.id) return;
    pulledFor = current.user.id;
    pull().catch(() => {
      pulledFor = null; // try again on the next confirmation
    });
  };

  const offIdentity = subscribeIdentity(onIdentity);
  onIdentity();
  const offUnits = onUnitsChangedHere(() => {
    if (getIdentity().kind !== 'signed-in') return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      push().catch(() => {});
    }, PUSH_DELAY_MS);
  });
  return () => {
    offIdentity();
    offUnits();
    if (timer) clearTimeout(timer);
  };
}
