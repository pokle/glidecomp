import { describe, expect, it } from 'bun:test';
import { formatRadius } from '../src/units';

describe('formatRadius', () => {
  it('states sub-kilometre metric radii as whole metres', () => {
    expect(formatRadius(400).withUnit).toBe('400m');
    expect(formatRadius(999).withUnit).toBe('999m');
  });

  it('keeps the decimal a radius was set with', () => {
    // The bug this guards: a 2,500 m cylinder read as "3km".
    expect(formatRadius(2500).withUnit).toBe('2.5km');
    expect(formatRadius(1500).withUnit).toBe('1.5km');
    expect(formatRadius(10500).withUnit).toBe('10.5km');
  });

  it('leaves whole kilometres clean', () => {
    expect(formatRadius(1000).withUnit).toBe('1km');
    expect(formatRadius(5000).withUnit).toBe('5km');
    expect(formatRadius(50000).withUnit).toBe('50km');
  });

  it('rounds beyond one decimal', () => {
    expect(formatRadius(2540).withUnit).toBe('2.5km');
    expect(formatRadius(2560).withUnit).toBe('2.6km');
  });

  it('follows a non-metric distance preference', () => {
    const prefs = { distance: 'mi', altitude: 'ft', speed: 'mph', climbRate: 'ft/min' } as const;
    // 8 km ≈ 4.97 mi — the decimal is the whole point at this size.
    expect(formatRadius(8000, { prefs }).withUnit).toBe('5mi');
    expect(formatRadius(4000, { prefs }).withUnit).toBe('2.5mi');
    // Small radii stay sub-unit rather than collapsing to "0mi".
    expect(formatRadius(400, { prefs }).withUnit).toBe('0.2mi');
  });
});
