/**
 * Browser-specific unit formatting wrappers.
 *
 * Re-exports all formatting functions from @taskscore/engine, but wired
 * to read unit preferences from the browser config singleton.
 * Also provides onUnitsChanged() for reactive UI updates.
 */

import { config, type UnitPreferences } from './config';
import {
  formatSpeed as _formatSpeed,
  formatAltitude as _formatAltitude,
  formatDistance as _formatDistance,
  formatClimbRate as _formatClimbRate,
  formatAltitudeChange as _formatAltitudeChange,
  formatRadius as _formatRadius,
  type FormattedValue,
  type DetectionThresholds,
} from '@taskscore/engine';

export type { FormattedValue, UnitPreferences };

export const formatSpeed = (mps: number, opts?: { showSign?: boolean }) =>
  _formatSpeed(mps, { ...opts, prefs: config.getUnits() });

export const formatAltitude = (m: number, opts?: { showSign?: boolean; decimals?: number }) =>
  _formatAltitude(m, { ...opts, prefs: config.getUnits() });

export const formatDistance = (m: number, opts?: { decimals?: number }) =>
  _formatDistance(m, { ...opts, prefs: config.getUnits() });

export const formatClimbRate = (mps: number, opts?: { showSign?: boolean }) =>
  _formatClimbRate(mps, { ...opts, prefs: config.getUnits() });

export const formatAltitudeChange = (m: number) =>
  _formatAltitudeChange(m, { prefs: config.getUnits() });

export const formatRadius = (meters: number): FormattedValue =>
  _formatRadius(meters, { prefs: config.getUnits() });

/**
 * Subscribe to unit preference changes
 */
export function onUnitsChanged(
  callback: (units: UnitPreferences) => void
): () => void {
  let previousUnits = config.getUnits();

  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    const newUnits: UnitPreferences = detail.units;
    if (
      newUnits.speed === previousUnits.speed &&
      newUnits.altitude === previousUnits.altitude &&
      newUnits.distance === previousUnits.distance &&
      newUnits.climbRate === previousUnits.climbRate
    ) {
      return;
    }
    previousUnits = newUnits;
    callback(newUnits);
  };

  window.addEventListener('taskscore:preferences-changed', handler);
  return () => window.removeEventListener('taskscore:preferences-changed', handler);
}

/**
 * Get resolved detection thresholds (defaults + user overrides)
 */
export function getThresholds(): DetectionThresholds {
  return config.getThresholds();
}

/**
 * Subscribe to any preference changes (units or thresholds)
 */
export function onPreferencesChanged(
  callback: () => void
): () => void {
  const handler = () => callback();
  window.addEventListener('taskscore:preferences-changed', handler);
  return () => window.removeEventListener('taskscore:preferences-changed', handler);
}
