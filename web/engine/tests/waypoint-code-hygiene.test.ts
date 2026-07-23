import { describe, expect, it } from 'bun:test';
import {
  cleanWaypointCode,
  cleanWaypointCodes,
  describeCodeChanges,
} from '../src/waypoint-files';

const wp = (code: string) => ({ code, name: code, latitude: 0, longitude: 0, altitude: 0, radius: 400 });

describe('cleanWaypointCode', () => {
  it('replaces spaces and commas with underscores', () => {
    expect(cleanWaypointCode('Break o Day')).toBe('Break_o_Day');
    expect(cleanWaypointCode('Winkipop,Hangliders')).toBe('Winkipop_Hangliders');
    expect(cleanWaypointCode('a  b')).toBe('a_b');
  });

  it('trims padding rather than turning it into underscores', () => {
    expect(cleanWaypointCode('0DALBY      ')).toBe('0DALBY');
    expect(cleanWaypointCode('  ELLIOT  ')).toBe('ELLIOT');
  });

  it('leaves punctuation a code is allowed to have', () => {
    expect(cleanWaypointCode('Mt_Buffalo_-_Lookout')).toBe('Mt_Buffalo_-_Lookout');
    expect(cleanWaypointCode('Gutt_Ridge_No.1')).toBe('Gutt_Ridge_No.1');
    expect(cleanWaypointCode('13th_Beach/W')).toBe('13th_Beach/W');
  });

  it('falls back when nothing is left', () => {
    expect(cleanWaypointCode('   ')).toBe('WP');
    expect(cleanWaypointCode(',')).toBe('WP');
  });
});

describe('cleanWaypointCodes', () => {
  it('leaves an already-clean set untouched, objects and all', () => {
    const input = [wp('ELLIOT'), wp('MTMITA')];
    const { waypoints, changes } = cleanWaypointCodes(input);
    expect(changes).toEqual([]);
    expect(waypoints[0]).toBe(input[0]);
    expect(waypoints[1]).toBe(input[1]);
  });

  it('numbers duplicates, first one keeping the plain code', () => {
    const { waypoints, changes } = cleanWaypointCodes([wp('Big_Hill'), wp('Big_Hill'), wp('Big_Hill')]);
    expect(waypoints.map((w) => w.code)).toEqual(['Big_Hill', 'Big_Hill2', 'Big_Hill3']);
    expect(changes).toEqual([
      { from: 'Big_Hill', to: 'Big_Hill2', reason: 'duplicate' },
      { from: 'Big_Hill', to: 'Big_Hill3', reason: 'duplicate' },
    ]);
  });

  it('numbers a collision that cleaning itself created', () => {
    // "A B" and "A,B" both clean to A_B — the clash didn't exist before.
    const { waypoints } = cleanWaypointCodes([wp('A B'), wp('A,B')]);
    expect(waypoints.map((w) => w.code)).toEqual(['A_B', 'A_B2']);
  });

  it('treats codes differing only in case as the same code', () => {
    const { waypoints } = cleanWaypointCodes([wp('elliot'), wp('ELLIOT')]);
    expect(waypoints.map((w) => w.code)).toEqual(['elliot', 'ELLIOT2']);
  });

  it('keeps every other field and the original order', () => {
    const { waypoints } = cleanWaypointCodes([
      { code: 'A B', name: 'Alpha', latitude: -36.5, longitude: 147.8, altitude: 900, radius: 1000 },
    ]);
    expect(waypoints[0]).toEqual({
      code: 'A_B',
      name: 'Alpha',
      latitude: -36.5,
      longitude: 147.8,
      altitude: 900,
      radius: 1000,
    });
  });
});

describe('describeCodeChanges', () => {
  it('is null when nothing changed', () => {
    expect(describeCodeChanges([])).toBeNull();
  });

  it('names the first few and counts the rest', () => {
    const changes = Array.from({ length: 5 }, (_, i) => ({
      from: `A ${i}`,
      to: `A_${i}`,
      reason: 'cleaned' as const,
    }));
    const message = describeCodeChanges(changes)!;
    expect(message).toContain('Adjusted 5 waypoint codes');
    expect(message).toContain('"A 0" → A_0');
    expect(message).toContain('and 2 more');
  });
});
