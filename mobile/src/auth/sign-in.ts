/** What every way of signing in does once the auth worker has said yes. */
import { saveProfile } from '@/api/account';

import type { ProviderResult } from './providers';
import { completeSignIn, getIdentity, refreshIdentity } from './session';

export async function finishProviderSignIn(result: Extract<ProviderResult, { kind: 'signed-in' }>): Promise<void> {
  await completeSignIn(result.user);
  // Apple's first sign-in carries the pilot's name for the app to keep; the
  // account has none yet (the worker refuses it inside the token, SEC-55).
  const current = getIdentity();
  if (result.name && current.kind === 'signed-in' && !current.user.name.trim()) {
    try {
      await saveProfile({ name: result.name });
      await refreshIdentity();
    } catch {
      // Onboarding's "Add your name" row asks instead.
    }
  }
}
