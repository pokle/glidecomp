/**
 * The account's writes from the Me tab: the pilot profile. The display name
 * travels with it — competition-api renames the account too (issue #539), so
 * the two can never disagree — under the server's own name checks.
 */
import type { PilotProfile } from '@glidecomp/client/account';
import { fetchWithRetry } from '@glidecomp/client/retry';

import { ApiError, api } from './client';

/** The server refused the save, and said why in a sentence for the reader. */
export class ProfileSaveError extends Error {}

export async function saveProfile(changes: Partial<PilotProfile>): Promise<PilotProfile> {
  const res = await fetchWithRetry(() => api.api.comp.pilot.$patch({ json: changes as never }));
  if (res.ok) return (await res.json()) as PilotProfile;
  if (res.status < 500) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ProfileSaveError(body?.error ?? 'GlideComp couldn’t save that.');
  }
  throw new ApiError(res.status);
}
