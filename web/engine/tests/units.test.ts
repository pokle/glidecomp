import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_UNITS,
  TO_SI,
  formatAltitude,
  formatSpeed,
  formatUnit,
  getSegmentLengthMeters,
  getUnitLabel,
  type UnitPreferences,
} from '../src/units';
import { formatThresholdForDisplay, parseThresholdInput } from '../src/threshold-parser';

const IMPERIAL: UnitPreferences = {
  speed: 'mph',
  altitude: 'ft',
  distance: 'mi',
  climbRate: 'ft/min',
};

describe('canonical toSI factors', () => {
  it('carries the exact defined values, not truncations', () => {
    expect(TO_SI.mph).toBe(0.44704);
    expect(TO_SI.ft).toBe(0.3048);
    expect(TO_SI.knots).toBe(0.51444);
    expect(TO_SI.mi).toBe(1609.344);
    expect(TO_SI.nmi).toBe(1852);
    expect(TO_SI['ft/min']).toBe(0.3048 / 60);
  });

  it('drives display as the exact reciprocal', () => {
    // 0.44704 m/s IS one mile per hour, so it must display as exactly 1.
    expect(formatSpeed(TO_SI.mph, { prefs: IMPERIAL }).value).toBeCloseTo(1, 12);
    expect(formatAltitude(TO_SI.ft, { prefs: IMPERIAL }).value).toBeCloseTo(1, 12);
    expect(getSegmentLengthMeters('mi')).toBe(TO_SI.mi);
    expect(getSegmentLengthMeters('nmi')).toBe(TO_SI.nmi);
  });

  it('round-trips a parsed threshold back to the value typed', () => {
    const parsed = parseThresholdInput('15 mph', 'speed');
    expect(parsed?.valueSI).toBeCloseTo(15 * 0.44704, 12);
    expect(formatThresholdForDisplay(parsed!.valueSI, 'speed', IMPERIAL)).toBe('15 mph');

    const climb = parseThresholdInput('200 fpm', 'climbRate');
    expect(formatThresholdForDisplay(climb!.valueSI, 'climbRate', IMPERIAL)).toBe('200 ft/min');
  });

  it('displays the exact conversion where the truncated factor was a foot out', () => {
    // 1372 m is 4501.31 ft; the old 3.281 factor displayed it as 4502 ft.
    expect(formatAltitude(1372, { prefs: IMPERIAL }).withUnit).toBe('4501\u{00A0}ft');
  });
});

describe('formatUnit edge validation', () => {
  it('falls back to the preference when a unit override is unrecognised', () => {
    const out = formatUnit(10, 'speed', { unit: 'furlongs/fortnight' });
    expect(out.withUnit).toBe('36\u{00A0}km/h');
  });

  it('honours a recognised unit override', () => {
    expect(formatUnit(10, 'speed', { unit: 'mph' }).formatted).toBe('22');
  });
});

describe('unit labels', () => {
  it('reads the label straight from the typed table', () => {
    expect(getUnitLabel('speed', DEFAULT_UNITS)).toBe('km/h');
    expect(getUnitLabel('climbRate', IMPERIAL)).toBe('fpm');
  });
});
