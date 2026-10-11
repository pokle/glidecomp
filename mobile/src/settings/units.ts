/**
 * The reader's display units, kept on the phone. Stage 4 syncs them to the
 * account (as the website does for a signed-in reader); until then they are
 * this device's alone.
 *
 * Every altitude the app PRINTS honours the preference; cylinder radii never
 * do — a radius is the task's own number, stated in metres (root CLAUDE.md,
 * the altitude rule).
 */
import { DEFAULT_UNITS, type UnitPreferences } from '@glidecomp/engine';
import Storage from 'expo-sqlite/kv-store';
import { useSyncExternalStore } from 'react';

const KEY = 'units';

function load(): UnitPreferences {
  try {
    const raw = Storage.getItemSync(KEY);
    return raw ? { ...DEFAULT_UNITS, ...(JSON.parse(raw) as Partial<UnitPreferences>) } : DEFAULT_UNITS;
  } catch {
    return DEFAULT_UNITS;
  }
}

let current: UnitPreferences | null = null;
const listeners = new Set<() => void>();

function snapshot(): UnitPreferences {
  current ??= load();
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUnits(): UnitPreferences {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function setUnit<K extends keyof UnitPreferences>(key: K, value: UnitPreferences[K]): void {
  current = { ...snapshot(), [key]: value };
  try {
    Storage.setItemSync(KEY, JSON.stringify(current));
  } catch {
    // Kept in memory for this session even if the store refuses it.
  }
  listeners.forEach((l) => l());
}
