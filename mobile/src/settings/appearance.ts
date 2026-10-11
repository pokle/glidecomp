/**
 * Light, dark, or the phone's own setting — on this phone only, as on the
 * website ("How GlideComp looks on this device").
 */
import Storage from 'expo-sqlite/kv-store';
import { useSyncExternalStore } from 'react';
import { Appearance } from 'react-native';

export type AppearanceChoice = 'auto' | 'light' | 'dark';

const KEY = 'appearance';

function load(): AppearanceChoice {
  try {
    const raw = Storage.getItemSync(KEY);
    return raw === 'light' || raw === 'dark' ? raw : 'auto';
  } catch {
    return 'auto';
  }
}

let current: AppearanceChoice | null = null;
const listeners = new Set<() => void>();

function snapshot(): AppearanceChoice {
  current ??= load();
  return current;
}

export function useAppearance(): AppearanceChoice {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    snapshot,
    snapshot,
  );
}

/** Apply the stored choice; called once at launch. */
export function applyAppearance(): void {
  Appearance.setColorScheme(snapshot());
}

export function setAppearance(choice: AppearanceChoice): void {
  current = choice;
  try {
    Storage.setItemSync(KEY, choice);
  } catch {
    // Applied for this session even if the store refuses it.
  }
  Appearance.setColorScheme(choice);
  listeners.forEach((l) => l());
}
