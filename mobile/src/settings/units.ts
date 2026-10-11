/**
 * The reader's display units, kept on the phone and, while signed in, synced
 * to the account as the website does (units-sync.ts), so a change on either
 * follows the pilot to the other.
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
/** Told of the reader's own changes, not of ones the account brought in. */
const changeListeners = new Set<() => void>();

function snapshot(): UnitPreferences {
  current ??= load();
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getUnits(): UnitPreferences {
  return snapshot();
}

/** Called when the reader changes a unit here (units-sync pushes it). */
export function onUnitsChangedHere(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export function useUnits(): UnitPreferences {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function store(next: UnitPreferences): void {
  current = next;
  try {
    Storage.setItemSync(KEY, JSON.stringify(current));
  } catch {
    // Kept in memory for this session even if the store refuses it.
  }
  listeners.forEach((l) => l());
}

export function setUnit<K extends keyof UnitPreferences>(key: K, value: UnitPreferences[K]): void {
  store({ ...snapshot(), [key]: value });
  changeListeners.forEach((l) => l());
}

/** Take the account's units, as the website's sync does: the cloud wins. */
export function adoptUnits(units: Partial<UnitPreferences>): void {
  store({ ...DEFAULT_UNITS, ...snapshot(), ...units });
}
