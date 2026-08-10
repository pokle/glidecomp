import { describe, expect, it } from 'bun:test';
import { zoneOffsetMs } from '../src/zone-offset';

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
