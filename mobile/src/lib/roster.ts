/**
 * The roster as the organiser reads it (IA §11): grouped by class in the
 * comp's own class order, and within a class by WPRS points, highest first —
 * launch order is set from them, so it is the one column an organiser reads
 * the list down. Unranked pilots follow, by name; "no score" is neither a
 * good one nor a bad one.
 */
import type { CompPilot } from '@glidecomp/client/roster-csv';

export interface RosterClass {
  pilotClass: string;
  pilots: CompPilot[];
}

export function rosterByClass(pilots: readonly CompPilot[], classOrder: readonly string[]): RosterClass[] {
  const byClass = new Map<string, CompPilot[]>();
  for (const p of pilots) {
    const list = byClass.get(p.pilot_class) ?? [];
    list.push(p);
    byClass.set(p.pilot_class, list);
  }
  const order = [...classOrder, ...[...byClass.keys()].filter((c) => !classOrder.includes(c)).sort()];
  return order
    .filter((c) => byClass.has(c))
    .map((pilotClass) => ({
      pilotClass,
      pilots: byClass.get(pilotClass)!.sort((a, b) => {
        if (a.wprs_points !== null && b.wprs_points !== null) return b.wprs_points - a.wprs_points;
        if (a.wprs_points !== null) return -1;
        if (b.wprs_points !== null) return 1;
        return a.name.localeCompare(b.name);
      }),
    }));
}

/** A row's second line: who the entry belongs to, and their team. Unclaimed entries say so. */
export function rosterDetail(p: CompPilot): string {
  return [p.linked ? (p.linked_email ?? 'Claimed') : 'Unclaimed', p.team_name].filter(Boolean).join(' · ');
}
