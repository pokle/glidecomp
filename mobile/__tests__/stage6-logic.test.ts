import type { PilotFlight } from '@glidecomp/client/account';
import { DEFAULT_UNITS, type WaypointFileRecord } from '@glidecomp/engine';

import { groupFlightsByComp } from '@/lib/my-flights';
import { qrPath } from '@/lib/qr';
import { filterWaypoints, waypointDetail, waypointTitle } from '@/lib/waypoint-rows';

const wp = (over: Partial<WaypointFileRecord>): WaypointFileRecord => ({
  code: 'CANUN',
  name: 'Canungra Launch',
  latitude: -28.012345,
  longitude: 153.123456,
  altitude: 620,
  radius: 400,
  ...over,
});

describe('waypoint rows', () => {
  it('prints a zero altitude as an altitude and an absent one as absent', () => {
    expect(waypointDetail(wp({ altitude: 0 }), DEFAULT_UNITS)).toMatch(/^-28\.012345, 153\.123456 · 0\s?m · 400\s?m$/);
    expect(waypointDetail(wp({ altitude: undefined }), DEFAULT_UNITS)).toContain('no altitude');
  });

  it('prints altitudes in the reader’s unit and radii in metres', () => {
    const detail = waypointDetail(wp({ radius: 1000 }), { ...DEFAULT_UNITS, altitude: 'ft' });
    expect(detail).toMatch(/· 2034\s?ft ·/);
    expect(detail).toMatch(/· 1\s?km$/);
  });

  it('filters by code, name or coordinates, keeping the file’s indexes', () => {
    const set = [wp({}), wp({ code: 'BEECH', name: 'Beechmont', latitude: -28.2, longitude: 153.2 })];
    expect(filterWaypoints(set, '')).toEqual([0, 1]);
    expect(filterWaypoints(set, 'beech')).toEqual([1]);
    expect(filterWaypoints(set, '-28.0123')).toEqual([0]);
    expect(filterWaypoints(set, 'nothing')).toEqual([]);
  });

  it('titles a row by its code, with the long name when there is one', () => {
    expect(waypointTitle(wp({}))).toBe('CANUN  Canungra Launch');
    expect(waypointTitle(wp({ name: 'CANUN' }))).toBe('CANUN');
  });
});

describe('qrPath', () => {
  it('draws a square code with its three finder patterns', () => {
    const { size, d } = qrPath('XCTSK:{"version":2}');
    expect(size).toBeGreaterThanOrEqual(21);
    // Every finder pattern starts with a seven-module run on its first row.
    expect(d.startsWith('M0 0h7v1h-7z')).toBe(true);
    expect(d).toContain(`M${size - 7} 0h7v1h-7z`);
  });
});

describe('groupFlightsByComp', () => {
  const flight = (over: Partial<PilotFlight>): PilotFlight => ({
    comp_id: 'a',
    comp_name: 'A',
    task_id: 't1',
    task_name: 'Task 1',
    task_date: '2026-01-10',
    pilot_class: 'open',
    comp_pilot_id: 'p',
    kind: 'track',
    recorded_at: '2026-01-10T05:00:00Z',
    rank: 1,
    class_size: 10,
    total_score: 900,
    ...over,
  });

  it('puts the competition flown most recently first, its tasks newest first', () => {
    const groups = groupFlightsByComp([
      flight({ task_id: 't1', task_date: '2026-01-10' }),
      flight({ comp_id: 'b', comp_name: 'B', task_id: 'u1', task_date: '2026-03-01' }),
      flight({ task_id: 't2', task_date: '2026-01-11' }),
    ]);
    expect(groups.map((g) => g.comp_id)).toEqual(['b', 'a']);
    expect(groups[1].flights.map((f) => f.task_id)).toEqual(['t2', 't1']);
  });
});
