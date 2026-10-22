/**
 * My flights' competition flights, one group per competition: the
 * competition flown most recently first, and its tasks newest first — the
 * order the server sends them in.
 */
import type { PilotFlight } from '@glidecomp/client/account';

export interface CompFlights {
  comp_id: string;
  comp_name: string;
  flights: PilotFlight[];
}

export function groupFlightsByComp(flights: readonly PilotFlight[]): CompFlights[] {
  const byComp = new Map<string, CompFlights>();
  for (const f of flights) {
    const group = byComp.get(f.comp_id) ?? { comp_id: f.comp_id, comp_name: f.comp_name, flights: [] };
    group.flights.push(f);
    byComp.set(f.comp_id, group);
  }
  const latest = (g: CompFlights) => g.flights.reduce((max, f) => (f.task_date > max ? f.task_date : max), '');
  return [...byComp.values()]
    .map((g) => ({ ...g, flights: [...g.flights].sort((a, b) => b.task_date.localeCompare(a.task_date)) }))
    .sort((a, b) => latest(b).localeCompare(latest(a)));
}
