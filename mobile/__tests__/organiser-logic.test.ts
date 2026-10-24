import type { CompPilot } from '@glidecomp/client/roster-csv';
import type { RouteRow } from '@glidecomp/client/route-editor';
import { blankDraft } from '@glidecomp/client/turnpoint-draft';
import type { ManualFlightEntry, PilotListEntry, PilotStatusEntry, TrackInfo } from '@glidecomp/client/types';

import { pilotStateLine, pilotTaskRows } from '@/lib/pilots-tracks';
import { rosterByClass, rosterDetail } from '@/lib/roster';
import { applyDraft, moveRow, removeRow } from '@/lib/route-draft';
import { isTimeZone, parseEmails } from '@/lib/settings-form';
import { isIsoDate, nextTaskName, taskFormProblem, toggleClass } from '@/lib/task-form';

const row = (id: number, name: string, type: RouteRow['type'] = ''): RouteRow => ({
  id,
  name,
  description: '',
  type,
  coords: '-28, 153',
  radius: 400,
  altitude: '',
  leg: null,
  dir: null,
});

describe('route rows', () => {
  let n = 100;
  const nextId = () => ++n;

  it('adds a turnpoint typed Goal at the end, demoting the old goal', () => {
    const rows = [row(1, 'T', 'TAKEOFF'), row(2, 'S', 'SSS'), row(3, 'G', 'GOAL')];
    const next = applyDraft(rows, null, { ...blankDraft('GOAL'), name: 'G2', coords: '-28.1, 153.1' }, nextId);
    expect(next.map((r) => [r.name, r.type])).toEqual([
      ['T', 'TAKEOFF'],
      ['S', 'SSS'],
      ['G', ''],
      ['G2', 'GOAL'],
    ]);
  });

  it('moving the goal off the end hands Goal to the new last turnpoint', () => {
    const rows = [row(1, 'T', 'TAKEOFF'), row(2, 'A'), row(3, 'G', 'GOAL')];
    const next = moveRow(rows, 3, -1);
    expect(next.map((r) => [r.name, r.type])).toEqual([
      ['T', 'TAKEOFF'],
      ['G', ''],
      ['A', 'GOAL'],
    ]);
  });

  it('does nothing past either end, and removes a row', () => {
    const rows = [row(1, 'T', 'TAKEOFF'), row(2, 'A')];
    expect(moveRow(rows, 1, -1)).toBe(rows);
    expect(removeRow(rows, 2).map((r) => r.name)).toEqual(['T']);
  });
});

const pilot = (id: string, name: string, cls = 'open'): PilotListEntry => ({ comp_pilot_id: id, name, linked_email: null, pilot_class: cls });
const track = (id: string, active = true): TrackInfo => ({
  task_track_id: `t${id}`,
  comp_pilot_id: id,
  pilot_name: id,
  igc_pilot_name: null,
  pilot_class: 'open',
  uploaded_at: '2026-01-10T05:00:00Z',
  file_size: 1,
  penalty_points: 0,
  penalty_reason: null,
  uploaded_by_name: null,
  uploaded_on_behalf: false,
  active,
});

describe('pilots & tracks', () => {
  const roster = [pilot('a', 'Ann'), pilot('b', 'Bob'), pilot('c', 'Cat'), pilot('d', 'Dan'), pilot('e', 'Eve', 'sport')];
  const statuses: PilotStatusEntry[] = [
    { task_pilot_status_id: 's', task_id: 't', comp_pilot_id: 'c', pilot_name: 'Cat', status_key: 'absent', status_label: 'Absent', note: null, set_by_name: 'x', set_at: '' },
  ];
  const manual = [{ comp_pilot_id: 'd', active: true, made_goal: false } as ManualFlightEntry];
  const rows = pilotTaskRows({
    roster,
    taskClasses: ['open'],
    tracks: [track('a'), track('b'), track('c', false)],
    statuses,
    manual,
    withheld: new Map([['b', ['Wrong day']]]),
  });

  it('lists only the task’s classes, needing attention first', () => {
    expect(rows.map((r) => [r.pilot.name, r.needsAttention])).toEqual([
      ['Bob', true],
      ['Ann', false],
      ['Cat', false],
      ['Dan', false],
    ]);
  });

  it('says what each pilot’s state is', () => {
    const line = (name: string) => pilotStateLine(rows.find((r) => r.pilot.name === name)!.state, () => '15:00');
    expect(line('Ann')).toBe('Track submitted 15:00');
    expect(line('Bob')).toBe('Track withheld: Wrong day');
    expect(line('Cat')).toBe('Absent');
    expect(line('Dan')).toBe('Manual flight');
  });

  it('a pilot with nothing needs attention, and says when a track was set aside', () => {
    const only = pilotTaskRows({ roster: [pilot('x', 'Xi')], taskClasses: [], tracks: [track('x', false)], statuses: [], manual: [], withheld: new Map() });
    expect(only[0].needsAttention).toBe(true);
    expect(pilotStateLine(only[0].state, () => '')).toBe('No track (one was set aside)');
  });
});

const rp = (name: string, cls: string, wprs: number | null, linked = false): CompPilot =>
  ({ comp_pilot_id: name, name, pilot_class: cls, wprs_points: wprs, linked, linked_email: linked ? `${name}@x.com` : null, team_name: null } as CompPilot);

describe('roster', () => {
  it('groups by the comp’s class order and reads down by WPRS points, unranked last', () => {
    const groups = rosterByClass([rp('Zed', 'sport', null), rp('Amy', 'open', null), rp('Bea', 'open', 214.6), rp('Cy', 'open', 300)], ['open', 'sport']);
    expect(groups.map((g) => [g.pilotClass, g.pilots.map((p) => p.name)])).toEqual([
      ['open', ['Cy', 'Bea', 'Amy']],
      ['sport', ['Zed']],
    ]);
  });

  it('marks unclaimed entries', () => {
    expect(rosterDetail(rp('Amy', 'open', null))).toBe('Unclaimed');
    expect(rosterDetail(rp('Bea', 'open', null, true))).toBe('Bea@x.com');
  });
});

describe('task form', () => {
  it('checks the date, the name and the classes', () => {
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(taskFormProblem({ name: ' ', date: '2026-01-10', classes: ['open'] })).toMatch(/name/);
    expect(taskFormProblem({ name: 'T', date: '10/01/2026', classes: ['open'] })).toMatch(/YYYY-MM-DD/);
    expect(taskFormProblem({ name: 'T', date: '2026-01-10', classes: [] })).toMatch(/class/);
    expect(taskFormProblem({ name: 'T', date: '2026-01-10', classes: ['open'] })).toBeNull();
  });

  it('names the next task, and keeps class order when toggling', () => {
    expect(nextTaskName([{ name: 'Task 1' }, { name: 'Task 3' }])).toBe('Task 4');
    expect(nextTaskName([{ name: 'Task 2' }])).toBe('Task 3');
    expect(toggleClass(['sport'], 'open', ['open', 'sport'])).toEqual(['open', 'sport']);
    expect(toggleClass(['open', 'sport'], 'open', ['open', 'sport'])).toEqual(['sport']);
  });
});

describe('settings checks', () => {
  it('knows a timezone, and reads a list of emails', () => {
    expect(isTimeZone('Australia/Melbourne')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(parseEmails('a@x.com, B@x.com\nc@y.org')).toEqual({ emails: ['a@x.com', 'b@x.com', 'c@y.org'], bad: null });
    expect(parseEmails('a@x.com, nope').bad).toBe('nope');
  });
});
