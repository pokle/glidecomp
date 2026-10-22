/**
 * Pilots & tracks (IA §11, stage 7): every pilot of the task's classes, with
 * what the task holds for them, the ones needing the organiser first.
 *
 * Evidence is a track XOR a manual flight (issue #306); a status says the
 * pilot did not fly. A track a HARD data-quality check withheld is still a
 * track (the pilot is seated last at 0 with reasons, docs/track-quality.md),
 * and needs the organiser's ruling, so it counts as needing attention, as
 * does a pilot with nothing at all.
 */
import type { ManualFlightEntry, PilotListEntry, PilotStatusEntry, TrackInfo } from '@glidecomp/client/types';

export type PilotTaskState =
  | { kind: 'track'; track: TrackInfo; withheld: string[] | null }
  | { kind: 'manual'; flight: ManualFlightEntry }
  | { kind: 'status'; status: PilotStatusEntry }
  | { kind: 'nothing'; superseded: TrackInfo | null };

export interface PilotTaskRow {
  pilot: PilotListEntry;
  state: PilotTaskState;
  needsAttention: boolean;
}

export function pilotTaskRows(input: {
  roster: readonly PilotListEntry[];
  taskClasses: readonly string[];
  tracks: readonly TrackInfo[];
  statuses: readonly PilotStatusEntry[];
  manual: readonly ManualFlightEntry[];
  /** comp_pilot_id → the reasons a hard check withheld their track. */
  withheld: ReadonlyMap<string, string[]>;
}): PilotTaskRow[] {
  const flies = new Set(input.taskClasses);
  const rows = input.roster
    .filter((p) => flies.size === 0 || flies.has(p.pilot_class))
    .map((pilot): PilotTaskRow => {
      const id = pilot.comp_pilot_id;
      const track = input.tracks.find((t) => t.comp_pilot_id === id && t.active);
      if (track) {
        const reasons = input.withheld.get(id) ?? null;
        return { pilot, state: { kind: 'track', track, withheld: reasons }, needsAttention: reasons !== null };
      }
      const flight = input.manual.find((m) => m.comp_pilot_id === id && m.active);
      if (flight) return { pilot, state: { kind: 'manual', flight }, needsAttention: false };
      const status = input.statuses.find((s) => s.comp_pilot_id === id);
      if (status) return { pilot, state: { kind: 'status', status }, needsAttention: false };
      const superseded = input.tracks.find((t) => t.comp_pilot_id === id && !t.active) ?? null;
      return { pilot, state: { kind: 'nothing', superseded }, needsAttention: true };
    });
  return rows.sort(
    (a, b) => Number(b.needsAttention) - Number(a.needsAttention) || a.pilot.name.localeCompare(b.pilot.name),
  );
}

/** The row's one line of state, in words. */
export function pilotStateLine(state: PilotTaskState, when: (iso: string) => string): string {
  switch (state.kind) {
    case 'track': {
      const penalty = state.track.penalty_points ? ` · penalty ${state.track.penalty_points}` : '';
      if (state.withheld) return `Track withheld: ${state.withheld.join('; ')}`;
      return `Track submitted ${when(state.track.uploaded_at)}${penalty}`;
    }
    case 'manual':
      return state.flight.made_goal ? 'Manual flight · in goal' : 'Manual flight';
    case 'status':
      return state.status.status_label;
    case 'nothing':
      return state.superseded ? 'No track (one was set aside)' : 'No track yet';
  }
}
