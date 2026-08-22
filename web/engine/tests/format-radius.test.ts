import { describe, expect, it } from 'bun:test';
import { formatCylinderRadius, formatRadius } from '../src/units';

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

describe('formatCylinderRadius', () => {
  const imperial = { distance: 'mi', altitude: 'ft', speed: 'mph', climbRate: 'ft/min' } as const;

  it('states a cylinder in metres however the reader reads distances', () => {
    // Same numbers a briefing, an .xctsk and the editor's chips carry — the
    // FAI states a cylinder radius in metres, so it is not the reader's to
    // convert (issue #662: a "1.9 mi" reading beside a metres-only editor).
    expect(formatCylinderRadius(400).withUnit).toBe('400m');
    expect(formatCylinderRadius(5000).withUnit).toBe('5km');
    expect(formatCylinderRadius(2500).withUnit).toBe('2.5km');
  });

  it('takes no preferences at all — nothing can make it convert', () => {
    // The distance formatter beside it DOES follow the preference; this is the
    // contrast the type system now enforces (formatCylinderRadius has no opts).
    expect(formatRadius(8000, { prefs: imperial }).withUnit).toBe('5mi');
    expect(formatCylinderRadius(8000).withUnit).toBe('8km');
  });
});
