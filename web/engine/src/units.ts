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

/**
 * The canonical SI value of one non-SI unit — multiply a display value by
 * this to get metres or metres per second.
 *
 * This is the single table both directions derive from: the display factors
 * below are its reciprocals, and the threshold parser imports it for input
 * parsing, so "1 ft" parsed and 0.3048 m displayed can never disagree. The
 * foot, mile and nautical mile values are exact by international definition
 * (and mph follows from the mile); the knot is the conventional five-figure
 * rounding of 1852/3600 m/s.
 */
export const TO_SI = {
  'km/h': 1 / 3.6,
  mph: 0.44704, // exact: 1609.344 m per mile / 3600 s
  knots: 0.51444,
  ft: 0.3048, // exact
  'ft/min': 0.3048 / 60,
  mi: 1609.344, // exact: metres per statute mile
  nmi: 1852, // exact: metres per nautical mile
} as const;

interface ConversionInfo {
  factor: number;
  decimals: number;
  label: string;
}

type UnitType = keyof UnitPreferences;

// Display factors from SI base units — reciprocals of TO_SI where the unit
// is not itself SI. Keyed by the unit unions above so an entry cannot drift
// from the types, and a typo is a compile error rather than a runtime miss.
const CONVERSIONS: { [K in UnitType]: Record<UnitPreferences[K], ConversionInfo> } = {
  speed: {
    'km/h': { factor: 3.6, decimals: 0, label: 'km/h' },
    mph: { factor: 1 / TO_SI.mph, decimals: 0, label: 'mph' },
    knots: { factor: 1 / TO_SI.knots, decimals: 0, label: 'kts' },
  },
  altitude: {
    m: { factor: 1, decimals: 0, label: 'm' },
    ft: { factor: 1 / TO_SI.ft, decimals: 0, label: 'ft' },
  },
  distance: {
    km: { factor: 0.001, decimals: 2, label: 'km' },
    mi: { factor: 1 / TO_SI.mi, decimals: 2, label: 'mi' },
    nmi: { factor: 1 / TO_SI.nmi, decimals: 2, label: 'NM' },
  },
  climbRate: {
    'm/s': { factor: 1, decimals: 1, label: 'm/s' },
    'ft/min': { factor: 1 / TO_SI['ft/min'], decimals: 0, label: 'fpm' },
    knots: { factor: 1 / TO_SI.knots, decimals: 1, label: 'kts' },
  },
};

export const DEFAULT_UNITS: UnitPreferences = {
  speed: 'km/h',
  altitude: 'm',
  distance: 'km',
  climbRate: 'm/s',
};

export interface FormattedValue {
  value: number;
  formatted: string; // e.g., "45"
  withUnit: string; // e.g., "45 km/h" — joined with a non-breaking space
  unit: string; // e.g., "km/h"
}

/**
 * Convert and format a value for display
 */
export function formatUnit<K extends UnitType>(
  value: number,
  unitType: K,
  options?: {
    unit?: string; // Override unit preference
    decimals?: number; // Override decimal places
    showSign?: boolean; // Show +/- prefix
    prefs?: UnitPreferences; // Unit preferences (defaults to SI units)
  }
): FormattedValue {
  const prefs = options?.prefs ?? DEFAULT_UNITS;
  // `options.unit` is this module's one stringly edge — overrides arrive from
  // persisted preferences and other untyped callers — so validate it here: an
  // override the table doesn't know falls back to the caller's preference.
  const requested = options?.unit;
  const unitKey: UnitPreferences[K] =
    requested !== undefined && requested in CONVERSIONS[unitType]
      ? (requested as UnitPreferences[K])
      : prefs[unitType];
  const conv: ConversionInfo = CONVERSIONS[unitType][unitKey];

  const converted = value * conv.factor;
  const decimals = options?.decimals ?? conv.decimals;
  const formatted = converted.toFixed(decimals);

  const sign = options?.showSign && converted > 0 ? '+' : '';
  const displayValue = sign + formatted;

  return {
    value: converted,
    formatted: displayValue,
    withUnit: `${displayValue}\u{00A0}${conv.label}`,
    unit: conv.label,
  };
}

// Convenience functions
export const formatSpeed = (mps: number, opts?: { showSign?: boolean; prefs?: UnitPreferences }) =>
  formatUnit(mps, 'speed', opts);

export const formatAltitude = (m: number, opts?: { showSign?: boolean; decimals?: number; prefs?: UnitPreferences }) =>
  formatUnit(m, 'altitude', opts);

export const formatDistance = (m: number, opts?: { decimals?: number; prefs?: UnitPreferences }) =>
  formatUnit(m, 'distance', opts);

export const formatClimbRate = (mps: number, opts?: { showSign?: boolean; decimals?: number; prefs?: UnitPreferences }) =>
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

  // Sub-kilometre radii in metric read as whole metres ("400m"), matching how
  // task briefings state cylinder radii.
  if (unitKey === 'km' && meters < 1000) {
    const rounded = Math.round(meters);
    return {
      value: rounded,
      formatted: String(rounded),
      withUnit: `${rounded}m`,
      unit: 'm',
    };
  }

  const converted = meters * conv.factor;
  // A radius is a stated quantity, not a measurement: a briefing says "2.5 km",
  // so keep the decimal when there is one rather than rounding a 2,500 m
  // cylinder to "3km". Whole values stay clean ("5km", not "5.0km").
  const rounded = Math.round(converted * 10) / 10;
  const formatted = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);

  return {
    value: converted,
    formatted,
    withUnit: `${formatted}${conv.label}`,
    unit: conv.label,
  };
}

/**
 * Get the segment length in meters for a given distance unit.
 * Returns the number of meters in one unit of the given distance type:
 * - km → 1000
 * - mi → 1609.344
 * - nmi → 1852
 */
export function getSegmentLengthMeters(distanceUnit: DistanceUnit): number {
  const lengths: Record<DistanceUnit, number> = {
    km: 1000,
    mi: TO_SI.mi,
    nmi: TO_SI.nmi,
  };
  return lengths[distanceUnit];
}

/**
 * Get the current unit label for a unit type
 */
export function getUnitLabel<K extends UnitType>(unitType: K, prefs?: UnitPreferences): string {
  const p = prefs ?? DEFAULT_UNITS;
  return CONVERSIONS[unitType][p[unitType]].label;
}

/**
 * Get the current unit key for a unit type (e.g., 'km/h', 'm/s')
 */
export function getCurrentUnit(unitType: UnitType, prefs?: UnitPreferences): string {
  const p = prefs ?? DEFAULT_UNITS;
  return p[unitType];
}
