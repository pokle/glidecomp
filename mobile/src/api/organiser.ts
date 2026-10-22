/**
 * The organiser's writes (stage 7): every one an existing competition-api
 * route, so each is audited and, where it changes a scoring input, marks the
 * scores stale on the server — the app inherits both (root CLAUDE.md).
 *
 * A write is never retried on a 4xx (it is the server's answer), and a
 * refusal carries the server's own sentence for the screen to show. After a
 * write, the queries it can have changed are refetched, so the screen the
 * organiser returns to shows what they did.
 */
import type { RankingLookup } from '@glidecomp/client/civl-rankings';
import { fetchWithRetry } from '@glidecomp/client/retry';
import type { BulkPilotRow, ParsedRow } from '@glidecomp/client/roster-csv';
import type { XCTask, WaypointFileRecord } from '@glidecomp/engine';

import { api, ApiError } from './client';
import { queryClient } from './query-client';

/** The server refused the write, and said why in a sentence for the reader. */
export class WriteError extends Error {}

type Responds = Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Send one write. Retries only what `fetchWithRetry` retries (a dropped
 * request, a 5xx); a 4xx comes back as a WriteError with the server's words.
 */
export async function write<T = unknown>(request: () => Responds, fallback = 'GlideComp couldn’t save that.'): Promise<T> {
  const res = await fetchWithRetry(request);
  if (res.ok) return (await res.json().catch(() => ({}))) as T;
  if (res.status < 500) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new WriteError(body?.error ?? fallback);
  }
  throw new ApiError(res.status);
}

/** The sentence to show for a failed write. */
export function writeErrorText(err: unknown): string {
  return err instanceof WriteError ? err.message : 'No answer from GlideComp. Check your signal and try again.';
}

/** Refetch what a write to this comp (and task) can have changed. */
export function refreshComp(compId: string, taskId?: string) {
  const keys: unknown[][] = [['comp', compId], ['comps'], ['compScores', compId], ['activity', compId], ['roster', compId], ['waypoints', compId]];
  if (taskId) {
    keys.push(['weather', compId, taskId], ['task', compId, taskId], ['taskScore', compId, taskId], ['taskTracks', compId, taskId], ['pilotStatuses', compId, taskId], ['manualFlights', compId, taskId]);
  }
  for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
}

const comp = (compId: string) => ({ param: { comp_id: compId } });
const task = (compId: string, taskId: string) => ({ param: { comp_id: compId, task_id: taskId } });
const pilot = (compId: string, taskId: string, pilotId: string) => ({
  param: { comp_id: compId, task_id: taskId, comp_pilot_id: pilotId },
});

// ── Competitions ────────────────────────────────────────────────────────────

export interface NewComp {
  name: string;
  category: 'hg' | 'pg';
  pilot_classes?: string[];
  test?: boolean;
  timezone?: string | null;
}

export async function createComp(body: NewComp): Promise<{ comp_id: string; name: string }> {
  const made = await write<{ comp_id: string; name: string }>(() => api.api.comp.$post({ json: body as never }));
  void queryClient.invalidateQueries({ queryKey: ['comps'] });
  return made;
}

/** Any subset of the comp's settings (`updateCompSchema` on the server). */
export async function updateComp(compId: string, changes: Record<string, unknown>) {
  const out = await write(() => api.api.comp[':comp_id'].$patch({ ...comp(compId), json: changes as never }));
  refreshComp(compId);
  return out;
}

export async function deleteComp(compId: string) {
  await write(() => api.api.comp[':comp_id'].$delete(comp(compId)));
  queryClient.removeQueries({ queryKey: ['comp', compId] });
  void queryClient.invalidateQueries({ queryKey: ['comps'] });
}

export async function rescoreComp(compId: string) {
  await write(() => api.api.comp[':comp_id'].rescore.$post(comp(compId)));
  refreshComp(compId);
}

export async function saveWaypoints(compId: string, waypoints: WaypointFileRecord[]) {
  await write(() => api.api.comp[':comp_id'].waypoints.$put({ ...comp(compId), json: { waypoints } as never }));
  refreshComp(compId);
}

// ── Tasks ───────────────────────────────────────────────────────────────────

export interface NewTask {
  name: string;
  task_date: string;
  pilot_classes: string[];
}

export async function createTask(compId: string, body: NewTask): Promise<{ task_id: string; name: string }> {
  const made = await write<{ task_id: string; name: string }>(() =>
    api.api.comp[':comp_id'].task.$post({ ...comp(compId), json: body as never }),
  );
  refreshComp(compId);
  return made;
}

/** Any subset of the task's fields (`updateTaskSchema`): name, date, classes, route, stop, notes, closed. */
export async function updateTask(
  compId: string,
  taskId: string,
  changes: Partial<{
    name: string;
    task_date: string;
    pilot_classes: string[];
    xctsk: XCTask | null;
    stop_announcement_time: string | null;
    weather_notes: string;
    submissions_closed: boolean;
  }>,
) {
  const out = await write(() =>
    api.api.comp[':comp_id'].task[':task_id'].$patch({ ...task(compId, taskId), json: changes as never }),
  );
  refreshComp(compId, taskId);
  return out;
}

export async function deleteTask(compId: string, taskId: string) {
  await write(() => api.api.comp[':comp_id'].task[':task_id'].$delete(task(compId, taskId)));
  queryClient.removeQueries({ queryKey: ['task', compId, taskId] });
  refreshComp(compId);
}

// ── A pilot on a task ───────────────────────────────────────────────────────

/** Absent or did not fly; `null` returns the pilot to present. */
export async function setPilotStatus(compId: string, taskId: string, pilotId: string, status: 'absent' | 'dnf' | null) {
  const route = api.api.comp[':comp_id'].task[':task_id']['pilot-status'][':comp_pilot_id'];
  if (status === null) await write(() => route.$delete(pilot(compId, taskId, pilotId)));
  else await write(() => route.$put({ ...pilot(compId, taskId, pilotId), json: { status_key: status } as never }));
  refreshComp(compId, taskId);
}

export async function setPenalty(compId: string, taskId: string, pilotId: string, points: number, reason: string) {
  await write(() =>
    api.api.comp[':comp_id'].task[':task_id'].igc[':comp_pilot_id'].$patch({
      ...pilot(compId, taskId, pilotId),
      json: { penalty_points: points, penalty_reason: reason.trim() || null } as never,
    }),
  );
  refreshComp(compId, taskId);
}

/** The scorekeeper's ruling on a withheld track (FAI S7A §4.4.6): `true` scores it anyway. */
export async function setQualityOverride(compId: string, taskId: string, pilotId: string, override: boolean) {
  await write(() =>
    api.api.comp[':comp_id'].task[':task_id'].igc[':comp_pilot_id']['quality-override'].$patch({
      ...pilot(compId, taskId, pilotId),
      json: { quality_override: override },
    }),
  );
  refreshComp(compId, taskId);
}

export async function deleteTrack(compId: string, taskId: string, pilotId: string) {
  await write(() => api.api.comp[':comp_id'].task[':task_id'].igc[':comp_pilot_id'].$delete(pilot(compId, taskId, pilotId)));
  refreshComp(compId, taskId);
}

export async function restoreTrack(compId: string, taskId: string, pilotId: string) {
  await write(() =>
    api.api.comp[':comp_id'].task[':task_id'].igc[':comp_pilot_id'].restore.$post(pilot(compId, taskId, pilotId)),
  );
  refreshComp(compId, taskId);
}

export interface ManualFlightInput {
  last_reached_tp_index: number;
  landing_lat: number;
  landing_lon: number;
  duration_seconds?: number | null;
}

/** A manual flight for a track-less pilot (FAI S7F §9.2.2). */
export async function saveManualFlight(compId: string, taskId: string, pilotId: string, body: ManualFlightInput) {
  await write(() =>
    api.api.comp[':comp_id'].task[':task_id']['manual-flight'][':comp_pilot_id'].$put({
      ...pilot(compId, taskId, pilotId),
      json: body as never,
    }),
  );
  refreshComp(compId, taskId);
}

export async function deleteManualFlight(compId: string, taskId: string, pilotId: string) {
  await write(() =>
    api.api.comp[':comp_id'].task[':task_id']['manual-flight'][':comp_pilot_id'].$delete(pilot(compId, taskId, pilotId)),
  );
  refreshComp(compId, taskId);
}

// ── The roster ──────────────────────────────────────────────────────────────

/** A roster row as the server takes it (`compPilotFieldsSchema`). */
export type RosterFields = {
  registered_pilot_name: string;
  registered_pilot_email?: string | null;
  registered_pilot_civl_id?: string | null;
  registered_pilot_glider?: string | null;
  pilot_class: string;
  team_name?: string | null;
  driver_contact?: string | null;
  wprs_points?: number | null;
  civl_ranking_slug?: string | null;
  civl_ranking_date?: string | null;
};

export async function addPilot(compId: string, body: RosterFields) {
  const out = await write(() => api.api.comp[':comp_id'].pilot.$post({ ...comp(compId), json: body as never }));
  refreshComp(compId);
  return out;
}

export async function updatePilot(compId: string, pilotId: string, changes: Partial<RosterFields>) {
  const out = await write(() =>
    api.api.comp[':comp_id'].pilot[':comp_pilot_id'].$patch({
      param: { comp_id: compId, comp_pilot_id: pilotId },
      json: changes as never,
    }),
  );
  refreshComp(compId);
  return out;
}

export async function removePilot(compId: string, pilotId: string) {
  await write(() =>
    api.api.comp[':comp_id'].pilot[':comp_pilot_id'].$delete({ param: { comp_id: compId, comp_pilot_id: pilotId } }),
  );
  refreshComp(compId);
}

/**
 * Replace the roster in one go — what a CSV import does. Rows carrying a
 * `comp_pilot_id` update that pilot; rows without one are new; pilots left
 * out are REMOVED, so the caller always sends the whole roster.
 */
export async function bulkSaveRoster(compId: string, pilots: BulkPilotRow[]) {
  const out = await write(() => api.api.comp[':comp_id'].pilot.bulk.$post({ ...comp(compId), json: { pilots } as never }));
  refreshComp(compId);
  return out;
}

/** What the CIVL ranking lists make of these rows (keyed by index into them). */
export async function lookupRankings(compId: string, rows: ParsedRow[]): Promise<RankingLookup> {
  return write<RankingLookup>(() =>
    api.api.comp[':comp_id'].pilot['civl-rankings'].$post({
      ...comp(compId),
      json: { pilots: rows.map((r) => ({ name: r.name, civl_id: r.civl_id })) },
    }),
  );
}

/** Follow, or stop following, a competition's notifications (stage 9). */
export async function setCompNotify(compId: string, enabled: boolean): Promise<void> {
  await write(() => api.api.comp[':comp_id'].notify.$put({ ...comp(compId), json: { enabled } }));
  void queryClient.invalidateQueries({ queryKey: ['compNotify', compId] });
}
