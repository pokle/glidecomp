import type { CompListEntry, TaskSummary } from '@glidecomp/client/types';
import type { TaskWeather } from '@glidecomp/client/weather';
import { DEFAULT_UNITS } from '@glidecomp/engine';

import { ago } from '@/lib/ago';
import { groupComps } from '@/lib/comp-groups';
import { groupTasksByDay } from '@/lib/task-days';
import { taskStatusLines } from '@/lib/task-status';
import { weatherRows } from '@/lib/weather-hours';

function comp(over: Partial<CompListEntry>): CompListEntry {
  return {
    comp_id: 'x',
    name: 'Comp',
    category: 'hg',
    creation_date: '2026-01-01T00:00:00Z',
    pilot_classes: ['open'],
    is_admin: false,
    test: false,
    first_task_date: null,
    last_task_date: null,
    ...over,
  };
}

describe('groupComps', () => {
  const now = new Date('2026-10-10T02:00:00Z'); // 13:00 in Melbourne, 10 Oct

  it('sorts comps into flying now, upcoming and past', () => {
    const g = groupComps(
      [
        comp({ comp_id: 'now', first_task_date: '2026-10-09', last_task_date: '2026-10-12' }),
        comp({ comp_id: 'soon', first_task_date: '2026-11-01', last_task_date: '2026-11-05' }),
        comp({ comp_id: 'done', first_task_date: '2026-01-05', last_task_date: '2026-01-07' }),
        comp({ comp_id: 'empty' }),
      ],
      now,
    );
    expect(g.flyingNow.map((c) => c.comp_id)).toEqual(['now']);
    expect(g.upcoming.map((c) => c.comp_id)).toEqual(['soon', 'empty']);
    expect(g.past.map((c) => c.comp_id)).toEqual(['done']);
  });

  it('decides "today" in the comp’s own zone', () => {
    // 22:00 UTC on 9 Oct is already 10 Oct in Melbourne, still 9 Oct in Mexico City.
    const late = new Date('2026-10-09T22:00:00Z');
    const day = { first_task_date: '2026-10-10', last_task_date: '2026-10-10' };
    const g = groupComps(
      [
        comp({ comp_id: 'aus', timezone: 'Australia/Melbourne', ...day }),
        comp({ comp_id: 'mex', timezone: 'America/Mexico_City', ...day }),
      ],
      late,
    );
    expect(g.flyingNow.map((c) => c.comp_id)).toEqual(['aus']);
    expect(g.upcoming.map((c) => c.comp_id)).toEqual(['mex']);
  });

  it('leaves hidden test comps out', () => {
    const g = groupComps([comp({ test: true, first_task_date: '2026-10-10', last_task_date: '2026-10-10' })], now);
    expect(g.flyingNow.length + g.upcoming.length + g.past.length).toBe(0);
  });
});

describe('groupTasksByDay', () => {
  const task = (id: string, date: string, name: string) =>
    ({ task_id: id, task_date: date, name }) as TaskSummary;

  it('groups by day, newest day first, every task alike', () => {
    const days = groupTasksByDay([
      task('a', '2026-01-05', 'Task 1 (Open)'),
      task('b', '2026-01-06', 'Task 2 (Open)'),
      task('c', '2026-01-05', 'Task 1 (Floater)'),
    ]);
    expect(days.map((d) => d.date)).toEqual(['2026-01-06', '2026-01-05']);
    expect(days[1].tasks.map((t) => t.task_id)).toEqual(['c', 'a']);
  });
});

describe('taskStatusLines', () => {
  it('says nothing about a task that ran normally and is open', () => {
    expect(taskStatusLines({ stop_announcement_time: null, submissions_closed: false }, undefined)).toEqual([]);
  });

  it('words a stopped task in the comp’s zone', () => {
    const [line] = taskStatusLines(
      { stop_announcement_time: '2026-01-05T04:30:00Z', submissions_closed: false },
      { close_date: null, timezone: 'Australia/Melbourne' },
    );
    expect(line.title).toBe('Task stopped');
    expect(line.detail).toContain('15:30');
    expect(line.detail).toContain('FAI S7F §13.4');
  });

  it('prefers the task’s own closure to the comp’s', () => {
    const lines = taskStatusLines(
      { stop_announcement_time: null, submissions_closed: true },
      { close_date: '2020-01-01', timezone: null },
    );
    expect(lines.map((l) => l.title)).toEqual(['Closed for track submissions']);
  });

  it('says when the competition has closed', () => {
    const [line] = taskStatusLines(
      { stop_announcement_time: null, submissions_closed: false },
      { close_date: '2020-01-01', timezone: null },
    );
    expect(line.title).toBe('Competition closed');
  });
});

describe('ago', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  it.each([
    [now - 20_000, 'just now'],
    [now - 60_000, '1 minute ago'],
    [now - 4 * 60_000, '4 minutes ago'],
    [now - 2 * 3_600_000, '2 hours ago'],
    [now - 3 * 86_400_000, '3 days ago'],
  ])('%#', (then, words) => expect(ago(then, now)).toBe(words));
});

describe('weatherRows', () => {
  const hour = (t: string, over: object = {}) => ({
    t,
    surface: { windDirectionDeg: 270, windSpeedKmh: 18, windGustKmh: 30, temperatureC: 20, dewPointC: 10 },
    levels: [],
    cloud: { lowPct: 0, midPct: 0, highPct: 0, totalPct: 25 },
    boundaryLayerDepthM: 1500,
    cloudBaseAglM: 1800,
    capeJkg: null,
    shortwaveWm2: null,
    precipitationMm: null,
    ...over,
  });
  const weather = {
    source: {},
    resolved: {
      lat: -36.2,
      lon: 147.9,
      elevationM: null,
      fromMs: Date.parse('2026-01-05T00:00:00Z'),
      toMs: Date.parse('2026-01-05T08:00:00Z'),
    },
    hours: [hour('2026-01-05T02:00:00Z')],
  } as unknown as TaskWeather;

  it('reads an hour in the comp’s zone and the reader’s units', () => {
    const [row] = weatherRows(weather, 'Australia/Melbourne', DEFAULT_UNITS);
    expect(row.time).toBe('13:00');
    expect(row.wind).toBe('18 km/h W');
    // The usable ceiling is the lower of the mixed layer and the cloud base.
    expect(row.detail).toBe('gusts 30 km/h · cloud 25% · ceiling 1500 m above ground');
  });

  it('follows an imperial reader', () => {
    const [row] = weatherRows(weather, 'Australia/Melbourne', { ...DEFAULT_UNITS, speed: 'knots', altitude: 'ft' });
    expect(row.wind).toMatch(/kt|knots/);
    expect(row.detail).toContain('ft above ground');
  });
});
