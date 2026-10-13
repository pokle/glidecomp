import type { AuthUser, PilotFlight, PilotProfile } from '@glidecomp/client/account';
import type { CompListEntry, CompScores } from '@glidecomp/client/types';

import { groupComps } from '@/lib/comp-groups';
import { decideIdentity, initialIdentity, type Identity } from '@/lib/identity';
import { accountTitle, appearanceLabel, pilotIdSummary } from '@/lib/me-labels';
import { findSeriesPilot, flightOnTask, submittedWhen } from '@/lib/yours';

const user: AuthUser = { id: 'u1', name: 'Jo Smith', email: 'jo@example.com', image: null, username: 'jo' };
const NOW = 1_000_000;

describe('who is signed in (#481: a failure to ask is not an answer)', () => {
  const signedIn: Identity = { kind: 'signed-in', user, confirmed: true, checkedAt: 1 };

  it('opens as the last confirmed user, unconfirmed, before anyone is asked', () => {
    expect(initialIdentity(true, { user, checkedAt: 5 })).toEqual({
      kind: 'signed-in',
      user,
      confirmed: false,
      checkedAt: 5,
    });
    expect(initialIdentity(true, null)).toEqual({ kind: 'checking' });
    expect(initialIdentity(false, { user, checkedAt: 5 })).toEqual({ kind: 'signed-out' });
  });

  it('a dropped request keeps the reader signed in, and says it could not check', () => {
    expect(decideIdentity(signedIn, { kind: 'unreachable' }, NOW)).toEqual({ ...signedIn, confirmed: false });
    expect(decideIdentity({ kind: 'checking' }, { kind: 'unreachable' }, NOW)).toEqual({ kind: 'checking' });
  });

  it('only a real answer signs anyone out', () => {
    expect(decideIdentity(signedIn, { kind: 'answer', user: null }, NOW)).toEqual({ kind: 'signed-out' });
    expect(decideIdentity(signedIn, { kind: 'refused', status: 401 }, NOW)).toEqual({ kind: 'signed-out' });
  });

  it('a refusal that is not "no session" changes nothing', () => {
    expect(decideIdentity(signedIn, { kind: 'refused', status: 429 }, NOW)).toBe(signedIn);
  });

  it('an answer confirms the user and when', () => {
    const renamed = { ...user, name: 'Jo Citizen' };
    expect(decideIdentity({ kind: 'checking' }, { kind: 'answer', user: renamed }, NOW)).toEqual({
      kind: 'signed-in',
      user: renamed,
      confirmed: true,
      checkedAt: NOW,
    });
  });
});

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

describe('Yours', () => {
  const now = new Date('2026-10-10T02:00:00Z');

  it('lifts the comps the reader is on or runs out of the other groups', () => {
    const g = groupComps(
      [
        comp({ comp_id: 'flying', first_task_date: '2026-10-09', last_task_date: '2026-10-12' }),
        comp({ comp_id: 'mine-past', first_task_date: '2026-01-05', last_task_date: '2026-01-07' }),
        comp({ comp_id: 'mine-now', first_task_date: '2026-10-09', last_task_date: '2026-10-11' }),
        comp({ comp_id: 'run', is_admin: true, first_task_date: '2026-11-01' }),
      ],
      now,
      new Set(['mine-past', 'mine-now']),
    );
    expect(g.yours.map((c) => c.comp_id)).toEqual(['mine-now', 'run', 'mine-past']);
    expect(g.flyingNow.map((c) => c.comp_id)).toEqual(['flying']);
    expect(g.past).toEqual([]);
  });

  it('a hidden comp appears only in its organiser’s Yours', () => {
    const hidden = comp({ comp_id: 'rehearsal', test: true, first_task_date: '2026-10-10' });
    expect(groupComps([hidden], now, new Set(['rehearsal'])).yours).toEqual([hidden]);
    expect(groupComps([{ ...hidden, is_admin: true }], now).yours.map((c) => c.comp_id)).toEqual(['rehearsal']);
    const g = groupComps([hidden], now);
    expect(g.yours.length + g.flyingNow.length + g.upcoming.length + g.past.length).toBe(0);
  });
});

describe('the reader’s own place', () => {
  it('finds their series row and the size of their class', () => {
    const scores = {
      class_scores: [
        { pilot_class: 'open', pilots: [{ comp_pilot_id: 'a' }, { comp_pilot_id: 'b' }] },
        { pilot_class: 'floater', pilots: [{ comp_pilot_id: 'me', rank: 1, total_score: 900 }] },
      ],
    } as unknown as CompScores;
    expect(findSeriesPilot(scores, 'me')).toMatchObject({ pilotClass: 'floater', fieldSize: 1 });
    expect(findSeriesPilot(scores, 'nobody')).toBeNull();
  });

  it('says when the track was handed in, in the comp’s zone', () => {
    // 04:52 UTC is 15:52 on 7 Jan in Melbourne (daylight saving).
    expect(submittedWhen('2026-01-07T04:52:10Z', '2026-01-07', 'Australia/Melbourne')).toBe('15:52');
    expect(submittedWhen('2026-01-08T22:05:00Z', '2026-01-07', 'Australia/Melbourne')).toBe('9 Jan, 09:05');
  });

  it('finds their flight on a task', () => {
    const flights = [{ task_id: 't1' }, { task_id: 't2' }] as PilotFlight[];
    expect(flightOnTask(flights, 't2')).toBe(flights[1]);
    expect(flightOnTask(flights, 't3')).toBeNull();
    expect(flightOnTask(undefined, 't1')).toBeNull();
  });
});

describe('the Me tab’s words', () => {
  it('names the account by its name, or its address while it has none', () => {
    expect(accountTitle(user)).toBe('Jo Smith');
    expect(accountTitle({ ...user, name: '  ' })).toBe('jo@example.com');
  });

  it('summarises the pilot IDs filled in', () => {
    const profile = { civl_id: '12345', safa_id: ' 678 ', ushpa_id: null, name: 'Jo' } as unknown as PilotProfile;
    expect(pilotIdSummary(profile)).toBe('CIVL 12345 · SAFA 678');
    expect(pilotIdSummary({ civl_id: '' } as unknown as PilotProfile)).toBeUndefined();
  });

  it('labels the appearance choice', () => {
    expect(appearanceLabel('auto')).toBe('Auto');
    expect(appearanceLabel('dark')).toBe('Dark');
  });
});
