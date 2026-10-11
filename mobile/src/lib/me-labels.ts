/** Words the Me tab prints about the account and the reader's settings. */
import type { AuthUser, PilotProfile } from '@glidecomp/client/account';
import { ID_FIELDS } from '@glidecomp/client/account';

import type { AppearanceChoice } from '@/settings/appearance';

export const APPEARANCE_CHOICES: { value: AppearanceChoice; label: string; detail: string }[] = [
  { value: 'light', label: 'Light', detail: 'Always use the light theme' },
  { value: 'dark', label: 'Dark', detail: 'Always use the dark theme' },
  { value: 'auto', label: 'Auto', detail: 'Follow your phone’s setting' },
];

export function appearanceLabel(choice: AppearanceChoice): string {
  return APPEARANCE_CHOICES.find((c) => c.value === choice)?.label ?? 'Auto';
}

/** The account's heading: its name, or its address while it has none. */
export function accountTitle(user: AuthUser): string {
  return user.name.trim() || user.email;
}

/** "CIVL 12345 · SAFA 678" — the IDs this pilot has filled in, briefly. */
export function pilotIdSummary(profile: PilotProfile | undefined): string | undefined {
  if (!profile) return undefined;
  const ids = ID_FIELDS.filter((f) => profile[f.key]?.trim()).map(
    (f) => `${f.label.replace(/ ID$/, '')} ${profile[f.key]!.trim()}`,
  );
  return ids.length > 0 ? ids.join(' · ') : undefined;
}
