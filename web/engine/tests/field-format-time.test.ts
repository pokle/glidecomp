// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * The CLI-side time formatter for field-analysis `{ t }` report cells: the
 * engine emits instants; this renders them in the zone the CLI was given.
 */

import { describe, it, expect } from 'bun:test';
import {
  timeWithZone,
  timeRangeWithZone,
  hhmmInZone,
  zoneToken,
} from '../src/field-analysis/format-time';

const T = Date.UTC(2024, 0, 15, 10, 0, 0); // 2024-01-15T10:00:00Z (summer in AU)

describe('field-analysis time formatting', () => {
  it('renders a UTC instant in the given zone with a compact token', () => {
    // Melbourne is AEDT (+11) on this January date.
    expect(timeWithZone(T, 'Australia/Melbourne')).toBe('21:00 AEDT');
    // A half-hour zone keeps the minutes; no named abbreviation → offset token.
    expect(timeWithZone(T, 'Asia/Kolkata')).toBe('15:30 GMT+5:30');
  });

  it('renders an instant range with a single trailing token', () => {
    const to = Date.UTC(2024, 0, 15, 11, 30, 0);
    expect(timeRangeWithZone(T, to, 'Australia/Melbourne')).toBe('21:00–22:30 AEDT');
    expect(timeRangeWithZone(T, to)).toBe('10:00–11:30 UTC');
  });

  it('falls back to UTC when no zone is given', () => {
    expect(timeWithZone(T)).toBe('10:00 UTC');
    expect(zoneToken(T)).toBe('UTC');
    expect(hhmmInZone(T)).toBe('10:00');
  });

  it('falls back to UTC for a zone the runtime does not know', () => {
    expect(hhmmInZone(T, 'Not/AZone')).toBe('10:00');
  });
});
