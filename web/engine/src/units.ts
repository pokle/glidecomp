/**
 * Unit conversion and formatting module.
 * All internal values are in SI units (m, m/s).
 * This module handles conversion to display units.
 */

export type SpeedUnit = 'km/h' | 'mph' | 'knots';
export type AltitudeUnit = 'm' | 'ft';
export type DistanceUnit = 'km' | 'mi' | 'nmi';
export type ClimbRateUnit = 'm/s' | 'ft/min' | 'knots';

export interface UnitPreferences {
  speed: SpeedUnit;
  altitude: AltitudeUnit;
  distance: DistanceUnit;
  climbRate: ClimbRateUnit;
}

interface ConversionInfo {
  factor: number;
  decimals: number;
  label: string;
}

// Conversion factors from SI base units
const CONVERSIONS = {
  speed: {
    'km/h': { factor: 3.6, decimals: 0, label: 'km/h' },
    mph: { factor: 2.237, decimals: 0, label: 'mph' },
    knots: { factor: 1.944, decimals: 0, label: 'kts' },
  } as Record<string, ConversionInfo>,
  altitude: {
    m: { factor: 1, decimals: 0, label: 'm' },
    ft: { factor: 3.281, decimals: 0, label: 'ft' },
  } as Record<string, ConversionInfo>,
  distance: {
    km: { factor: 0.001, decimals: 2, label: 'km' },
    mi: { factor: 0.000621371, decimals: 2, label: 'mi' },
    nmi: { factor: 0.000539957, decimals: 2, label: 'NM' },
  } as Record<string, ConversionInfo>,
  climbRate: {
    'm/s': { factor: 1, decimals: 1, label: 'm/s' },
    'ft/min': { factor: 196.85, decimals: 0, label: 'fpm' },
    knots: { factor: 1.944, decimals: 1, label: 'kts' },
  } as Record<string, ConversionInfo>,
} as const;

type UnitType = keyof typeof CONVERSIONS;

const DEFAULT_UNITS: UnitPreferences = {
  speed: 'km/h',
  altitude: 'm',
  distance: 'km',
  climbRate: 'm/s',
};

export interface FormattedValue {
  value: number;
  formatted: string; // e.g., "45"
  withUnit: string; // e.g., "45km/h"
  unit: string; // e.g., "km/h"
}

/**
 * Convert and format a value for display
 */
export function formatUnit(
  value: number,
  unitType: UnitType,
  options?: {
    unit?: string; // Override unit preference
    decimals?: number; // Override decimal places
    showSign?: boolean; // Show +/- prefix
    prefs?: UnitPreferences; // Unit preferences (defaults to SI units)
  }
): FormattedValue {
  const prefs = options?.prefs ?? DEFAULT_UNITS;
  const unitKey = options?.unit ?? prefs[unitType];
  const conv = CONVERSIONS[unitType][unitKey];

  if (!conv) {
    // Fallback if unit not found
    return {
      value,
      formatted: value.toFixed(0),
      withUnit: value.toFixed(0),
      unit: unitKey,
    };
  }

  const converted = value * conv.factor;
  const decimals = options?.decimals ?? conv.decimals;
  const formatted = converted.toFixed(decimals);

  const sign = options?.showSign && converted > 0 ? '+' : '';
  const displayValue = sign + formatted;

  const withUnit = conv.label ? `${displayValue}\u{00A0}${conv.label}` : displayValue;

  return {
    value: converted,
    formatted: displayValue,
    withUnit,
    unit: conv.label || unitKey,
  };
}

// Convenience functions
export const formatSpeed = (mps: number, opts?: { showSign?: boolean; prefs?: UnitPreferences }) =>
  formatUnit(mps, 'speed', opts);

export const formatAltitude = (m: number, opts?: { showSign?: boolean; decimals?: number; prefs?: UnitPreferences }) =>
  formatUnit(m, 'altitude', opts);

export const formatDistance = (m: number, opts?: { decimals?: number; prefs?: UnitPreferences }) =>
  formatUnit(m, 'distance', opts);

export const formatClimbRate = (mps: number, opts?: { showSign?: boolean; prefs?: UnitPreferences }) =>
  formatUnit(mps, 'climbRate', { ...opts, showSign: opts?.showSign ?? true });

/**
 * Format altitude change (always shows sign)
 */
export const formatAltitudeChange = (m: number, opts?: { prefs?: UnitPreferences }) =>
  formatAltitude(m, { showSign: true, prefs: opts?.prefs });

/**
 * Format a radius value (uses distance unit but with variable precision)
 */
export function formatRadius(meters: number, opts?: { prefs?: UnitPreferences }): FormattedValue {
  const prefs = opts?.prefs ?? DEFAULT_UNITS;
  const unitKey = prefs.distance;
  const conv = CONVERSIONS.distance[unitKey];

  const converted = meters * conv.factor;
  // Use 0 decimals for values >= 1, 1 decimal for smaller
  const decimals = converted >= 1 ? 0 : 1;
  const formatted = converted.toFixed(decimals);

  return {
    value: converted,
    formatted,
    withUnit: `${formatted}${conv.label}`,
    unit: conv.label,
  };
}

/**
 * Get the current unit label for a unit type
 */
export function getUnitLabel(unitType: UnitType, prefs?: UnitPreferences): string {
  const p = prefs ?? DEFAULT_UNITS;
  const unitKey = p[unitType];
  const conv = CONVERSIONS[unitType][unitKey];
  return conv?.label || unitKey;
}

/**
 * Get the current unit key for a unit type (e.g., 'km/h', 'm/s')
 */
export function getCurrentUnit(unitType: UnitType, prefs?: UnitPreferences): string {
  const p = prefs ?? DEFAULT_UNITS;
  return p[unitType];
}
