/**
 * The Comps tab's groups (IA §5): Yours, then Flying now, Upcoming, Past.
 *
 * Yours is every comp the reader is registered in or organises — lifted out
 * of the others rather than repeated, so a pilot's own competition is not one
 * row among strangers'. It is the only group a hidden `test` comp can appear
 * in: the list names one only to its organisers.
 *
 * Decided from the comp's task dates against "today" in the comp's own zone
 * when it has one (a comp in Valle de Bravo is not "flying now" because it is
 * already tomorrow in Australia), else the phone's. A comp with no tasks yet
 * is upcoming: an organiser has set it up and not yet laid out a day.
 */
import type { CompListEntry } from '@glidecomp/client/types';
import { todayInZone } from '@glidecomp/client/format';

export interface CompGroups {
  yours: CompListEntry[];
  flyingNow: CompListEntry[];
  upcoming: CompListEntry[];
  past: CompListEntry[];
}

export type CompPhase = 'flyingNow' | 'upcoming' | 'past';

export function compPhase(comp: CompListEntry, now: Date = new Date()): CompPhase {
  const today = safeToday(comp.timezone ?? null, now);
  const first = comp.first_task_date;
  const last = comp.last_task_date ?? first;
  if (!first || !last || first > today) return 'upcoming';
  if (last < today) return 'past';
  return 'flyingNow';
}

export function groupComps(
  comps: readonly CompListEntry[],
  now: Date = new Date(),
  registeredIn: ReadonlySet<string> = new Set(),
): CompGroups {
  const groups: CompGroups = { yours: [], flyingNow: [], upcoming: [], past: [] };
  for (const comp of comps) {
    if (comp.is_admin || registeredIn.has(comp.comp_id)) groups.yours.push(comp);
    else if (!comp.test) groups[compPhase(comp, now)].push(comp);
  }
  // Soonest first for what is to come; most recent first for what is done.
  const byFirst = (a: CompListEntry, b: CompListEntry) =>
    (a.first_task_date ?? '9999').localeCompare(b.first_task_date ?? '9999');
  groups.flyingNow.sort(byFirst);
  groups.upcoming.sort(byFirst);
  groups.past.sort((a, b) => (b.last_task_date ?? '').localeCompare(a.last_task_date ?? ''));
  // Yours: what is on now, then what is coming, then what is done — each in
  // its own group's order.
  const rank: Record<CompPhase, number> = { flyingNow: 0, upcoming: 1, past: 2 };
  groups.yours.sort((a, b) => {
    const pa = compPhase(a, now);
    const pb = compPhase(b, now);
    if (pa !== pb) return rank[pa] - rank[pb];
    return pa === 'past'
      ? (b.last_task_date ?? '').localeCompare(a.last_task_date ?? '')
      : byFirst(a, b);
  });
  return groups;
}

function safeToday(zone: string | null, now: Date): string {
  try {
    return todayInZone(zone, now);
  } catch {
    // A zone this runtime does not know: fall back to the phone's.
    return todayInZone(null, now);
  }
}
