/**
 * Threshold input parsing and display formatting.
 *
 * Parses user input like "1.6 ft/min" → SI value, and formats
 * SI values back to display strings using the user's preferred units.
 */

import type { UnitPreferences } from './units';

/**
 * Dimension describes what kind of quantity a threshold measures.
 * Each dimension has recognized units and a SI base unit.
 */
export type ThresholdDimension =
  | 'speed'
  | 'altitude'
  | 'climbRate'
  | 'time'
  | 'angle'
  | 'ratio'
  | 'count';

/** Conversion factor: multiply display value by this to get SI value */
interface UnitConversion {
  toSI: number;
  label: string;
}

/**
 * Maps recognized unit strings to SI conversion factors.
 * SI base: speed=m/s, altitude=m, climbRate=m/s, time=seconds, angle=deg/s
 */
const UNIT_CONVERSIONS: Record<ThresholdDimension, Record<string, UnitConversion>> = {
  speed: {
    'm/s': { toSI: 1, label: 'm/s' },
    'km/h': { toSI: 1 / 3.6, label: 'km/h' },
    'kmh': { toSI: 1 / 3.6, label: 'km/h' },
    'mph': { toSI: 0.44704, label: 'mph' },
    'knots': { toSI: 0.51444, label: 'kts' },
    'kts': { toSI: 0.51444, label: 'kts' },
  },
  altitude: {
    'm': { toSI: 1, label: 'm' },
    'ft': { toSI: 0.3048, label: 'ft' },
    'feet': { toSI: 0.3048, label: 'ft' },
  },
  climbRate: {
    'm/s': { toSI: 1, label: 'm/s' },
    'ft/min': { toSI: 0.00508, label: 'ft/min' },
    'fpm': { toSI: 0.00508, label: 'fpm' },
    'knots': { toSI: 0.51444, label: 'kts' },
    'kts': { toSI: 0.51444, label: 'kts' },
  },
  time: {
    's': { toSI: 1, label: 's' },
    'sec': { toSI: 1, label: 's' },
    'seconds': { toSI: 1, label: 's' },
    'min': { toSI: 60, label: 'min' },
    'minutes': { toSI: 60, label: 'min' },
  },
  angle: {
    'deg/s': { toSI: 1, label: 'deg/s' },
    '\u00b0/s': { toSI: 1, label: 'deg/s' },  // °/s
  },
  ratio: {
    '': { toSI: 1, label: '' },
  },
  count: {
    '': { toSI: 1, label: '' },
    'fixes': { toSI: 1, label: 'fixes' },
  },
};

/** The default display unit for each dimension (used when no unit is specified in input) */
const DEFAULT_DISPLAY_UNITS: Record<ThresholdDimension, string> = {
  speed: 'm/s',
  altitude: 'm',
  climbRate: 'm/s',
  time: 's',
  angle: 'deg/s',
  ratio: '',
  count: '',
};

/** Map from dimension to UnitPreferences key (for dimensions that have one) */
const DIMENSION_TO_PREF: Partial<Record<ThresholdDimension, keyof UnitPreferences>> = {
  speed: 'speed',
  altitude: 'altitude',
  climbRate: 'climbRate',
};

export interface ParsedThresholdInput {
  valueSI: number;
  unit: string;
}

/**
 * Parse a threshold input string like "1.6 ft/min" into an SI value.
 * If no unit is specified, assumes the default display unit for the dimension.
 * Returns null if the input cannot be parsed.
 */
export function parseThresholdInput(
  input: string,
  dimension: ThresholdDimension
): ParsedThresholdInput | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Try to split into number and unit
  const match = trimmed.match(/^([+-]?\d+\.?\d*|\.\d+)\s*(.*)$/);
  if (!match) return null;

  const numValue = parseFloat(match[1]);
  if (!Number.isFinite(numValue)) return null;

  const unitStr = match[2].trim().toLowerCase();
  const conversions = UNIT_CONVERSIONS[dimension];

  if (unitStr === '' || unitStr === undefined) {
    // No unit specified — use the default for this dimension
    const defaultUnit = DEFAULT_DISPLAY_UNITS[dimension];
    const conv = conversions[defaultUnit];
    if (!conv) return null;
    return { valueSI: numValue * conv.toSI, unit: conv.label || defaultUnit };
  }

  // Look up the unit
  const conv = conversions[unitStr];
  if (!conv) return null;

  return { valueSI: numValue * conv.toSI, unit: conv.label || unitStr };
}

/**
 * Get the preferred display unit for a dimension given user preferences.
 */
function getPreferredUnit(dimension: ThresholdDimension, prefs?: UnitPreferences): string {
  if (prefs) {
    const prefKey = DIMENSION_TO_PREF[dimension];
    if (prefKey) {
      const unitKey = prefs[prefKey];
      // Map the preference value to a key in UNIT_CONVERSIONS
      const conversions = UNIT_CONVERSIONS[dimension];
      if (conversions[unitKey]) return unitKey;
    }
  }
  return DEFAULT_DISPLAY_UNITS[dimension];
}

/**
 * Format an SI value for display using the user's preferred unit.
 */
export function formatThresholdForDisplay(
  valueSI: number,
  dimension: ThresholdDimension,
  prefs?: UnitPreferences
): string {
  const unitKey = getPreferredUnit(dimension, prefs);
  const conversions = UNIT_CONVERSIONS[dimension];
  const conv = conversions[unitKey];

  if (!conv || conv.toSI === 0) {
    // Fallback: display as-is
    return String(valueSI);
  }

  const displayValue = valueSI / conv.toSI;

  // Choose appropriate decimal places
  let decimals: number;
  if (dimension === 'count') {
    decimals = 0;
  } else if (Math.abs(displayValue) >= 100) {
    decimals = 0;
  } else if (Math.abs(displayValue) >= 10) {
    decimals = 1;
  } else {
    decimals = 2;
  }

  // Remove trailing zeros
  const formatted = parseFloat(displayValue.toFixed(decimals)).toString();

  if (conv.label) {
    return `${formatted} ${conv.label}`;
  }
  return formatted;
}
