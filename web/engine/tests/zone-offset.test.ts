import { describe, expect, it } from 'bun:test';
import { nextDayISO, zonedDayStartMs, zoneOffsetMs } from '../src/zone-offset';

const HOUR_MS = 3_600_000;

describe('zoneOffsetMs', () => {
  it('reports UTC as zero and fixed offsets as themselves', () => {
    expect(zoneOffsetMs(Date.UTC(2026, 0, 5, 12), 'UTC')).toBe(0);
    // Brisbane never observes daylight saving: +10 all year.
    expect(zoneOffsetMs(Date.UTC(2026, 0, 5, 12), 'Australia/Brisbane')).toBe(10 * HOUR_MS);
    expect(zoneOffsetMs(Date.UTC(2026, 6, 5, 12), 'Australia/Brisbane')).toBe(10 * HOUR_MS);
  });

  it('follows Melbourne across the end of daylight saving', () => {
    // AEDT ends 2026-04-05 at 03:00 local, which is 2026-04-04T16:00Z:
    // clocks wind back to 02:00 AEST and the offset drops from +11 to +10.
    const transitionMs = Date.UTC(2026, 3, 4, 16);
    expect(zoneOffsetMs(transitionMs - 1000, 'Australia/Melbourne')).toBe(11 * HOUR_MS);
    expect(zoneOffsetMs(transitionMs, 'Australia/Melbourne')).toBe(10 * HOUR_MS);
  });

  it('follows Melbourne across the start of daylight saving', () => {
    // AEST ends 2026-10-04 at 02:00 local, which is 2026-10-03T16:00Z:
    // clocks spring forward to 03:00 AEDT and the offset rises to +11.
    const transitionMs = Date.UTC(2026, 9, 3, 16);
    expect(zoneOffsetMs(transitionMs - 1000, 'Australia/Melbourne')).toBe(10 * HOUR_MS);
    expect(zoneOffsetMs(transitionMs, 'Australia/Melbourne')).toBe(11 * HOUR_MS);
  });

  it('handles half-hour and western-hemisphere zones', () => {
    // Adelaide sits on the half hour: +9:30 standard, +10:30 daylight.
    expect(zoneOffsetMs(Date.UTC(2026, 6, 5, 12), 'Australia/Adelaide')).toBe(9.5 * HOUR_MS);
    expect(zoneOffsetMs(Date.UTC(2026, 0, 5, 12), 'Australia/Adelaide')).toBe(10.5 * HOUR_MS);
    // Denver is west of Greenwich: the offset is negative.
    expect(zoneOffsetMs(Date.UTC(2026, 0, 5, 12), 'America/Denver')).toBe(-7 * HOUR_MS);
    expect(zoneOffsetMs(Date.UTC(2026, 6, 5, 12), 'America/Denver')).toBe(-6 * HOUR_MS);
  });

  it('is unmoved by a sub-second instant', () => {
    const ms = Date.UTC(2026, 0, 5, 12, 0, 0, 750);
    expect(zoneOffsetMs(ms, 'Australia/Melbourne')).toBe(11 * HOUR_MS);
  });
});

describe('zonedDayStartMs', () => {
  it('returns local midnight for a zoned day', () => {
    // Melbourne midnight on 2026-01-10 (AEDT, +11) is 13:00Z the day before.
    expect(zonedDayStartMs('2026-01-10', 'Australia/Melbourne'))
      .toBe(Date.UTC(2026, 0, 9, 13));
    // And in winter (AEST, +10) it is 14:00Z.
    expect(zonedDayStartMs('2026-06-10', 'Australia/Melbourne'))
      .toBe(Date.UTC(2026, 5, 9, 14));
  });

  it('handles the day a DST transition lands on', () => {
    // 2026-10-04: Melbourne springs forward at 02:00 local. Midnight that
    // day is still AEST (+10) — the second probe pass must not overshoot.
    expect(zonedDayStartMs('2026-10-04', 'Australia/Melbourne'))
      .toBe(Date.UTC(2026, 9, 3, 14));
  });

  it('falls back to UTC midnight for a null or unknown zone', () => {
    expect(zonedDayStartMs('2026-01-10', null)).toBe(Date.UTC(2026, 0, 10));
    expect(zonedDayStartMs('2026-01-10', 'Not/AZone')).toBe(Date.UTC(2026, 0, 10));
  });

  it('returns null for an unparseable date', () => {
    expect(zonedDayStartMs('not-a-date', 'Australia/Melbourne')).toBeNull();
  });
});

describe('nextDayISO', () => {
  it('advances a calendar day, across month and year ends', () => {
    expect(nextDayISO('2026-01-10')).toBe('2026-01-11');
    expect(nextDayISO('2026-01-31')).toBe('2026-02-01');
    expect(nextDayISO('2025-12-31')).toBe('2026-01-01');
    expect(nextDayISO('2028-02-28')).toBe('2028-02-29'); // leap year
  });
});
