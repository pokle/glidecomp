/**
 * Browser-specific unit formatting wrappers.
 *
 * Re-exports all formatting functions from @taskscore/analysis, but wired
 * to read unit preferences from the browser config singleton.
 * Also provides onUnitsChanged() for reactive UI updates.
 */

import { config, type UnitPreferences } from './config';
import {
  formatUnit as _formatUnit,
  formatSpeed as _formatSpeed,
  formatAltitude as _formatAltitude,
  formatDistance as _formatDistance,
  formatClimbRate as _formatClimbRate,
  formatAltitudeChange as _formatAltitudeChange,
  formatRadius as _formatRadius,
  getUnitLabel as _getUnitLabel,
  getCurrentUnit as _getCurrentUnit,
  type FormattedValue,
} from '@taskscore/analysis';

export type { FormattedValue, UnitPreferences };

type UnitType = 'speed' | 'altitude' | 'distance' | 'climbRate';

export function formatUnit(
  value: number,
  unitType: UnitType,
  options?: {
    unit?: string;
    decimals?: number;
    showSign?: boolean;
  }
): FormattedValue {
  return _formatUnit(value, unitType, { ...options, prefs: config.getUnits() });
}

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

export const getUnitLabel = (unitType: UnitType): string =>
  _getUnitLabel(unitType, config.getUnits());

export const getCurrentUnit = (unitType: UnitType): string =>
  _getCurrentUnit(unitType, config.getUnits());

/**
 * Subscribe to unit preference changes
 */
export function onUnitsChanged(
  callback: (units: UnitPreferences) => void
): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    callback(detail.units);
  };

  window.addEventListener('taskscore:preferences-changed', handler);
  return () => window.removeEventListener('taskscore:preferences-changed', handler);
}
