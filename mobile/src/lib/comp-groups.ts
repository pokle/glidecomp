/**
 * The Comps tab's three groups (IA §5): Flying now, Upcoming, Past.
 *
 * Decided from the comp's task dates against "today" in the comp's own zone
 * when it has one (a comp in Valle de Bravo is not "flying now" because it is
 * already tomorrow in Australia), else the phone's. A comp with no tasks yet
 * is upcoming: an organiser has set it up and not yet laid out a day.
 */
import type { CompListEntry } from '@glidecomp/client/types';
import { todayInZone } from '@glidecomp/client/format';

export interface CompGroups {
  flyingNow: CompListEntry[];
  upcoming: CompListEntry[];
  past: CompListEntry[];
}

export function groupComps(comps: readonly CompListEntry[], now: Date = new Date()): CompGroups {
  const groups: CompGroups = { flyingNow: [], upcoming: [], past: [] };
  for (const comp of comps) {
    if (comp.test) continue;
    const today = safeToday(comp.timezone ?? null, now);
    const first = comp.first_task_date;
    const last = comp.last_task_date ?? first;
    if (!first || !last || first > today) groups.upcoming.push(comp);
    else if (last < today) groups.past.push(comp);
    else groups.flyingNow.push(comp);
  }
  // Soonest first for what is to come; most recent first for what is done.
  const byFirst = (a: CompListEntry, b: CompListEntry) =>
    (a.first_task_date ?? '9999').localeCompare(b.first_task_date ?? '9999');
  groups.flyingNow.sort(byFirst);
  groups.upcoming.sort(byFirst);
  groups.past.sort((a, b) => (b.last_task_date ?? '').localeCompare(a.last_task_date ?? ''));
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
