/**
 * The prototype's route drafts (/proto): one per sample task, in memory.
 *
 * It is the REAL draft model (comp/route-draft.ts) and the real time
 * conversions, so the prototype's route pages run the real route logic: the
 * turnpoint list, the map, reordering, the start and goal panels. Only the
 * storage differs. The real editor keeps its draft in this tab's storage
 * (lib/draft-store.ts) and saves through the API; this one forgets on reload
 * and "saves" by remembering what was last saved.
 */
import { useSyncExternalStore } from "react";
import type { WaypointFileRecord } from "@glidecomp/engine";
import {
  contentKey,
  freshDraft,
  isDirty,
  type RouteDraft,
  type RouteDraftContext,
} from "../comp/route-draft";
import { utcToZonedHHMM, zoneNameWithOffset, zonedToUtcHHMM } from "../lib/time";
import { COMP_TIME_ZONE, TASK_DATES, TASK_ROUTES, WAYPOINTS } from "./route-fixture";

interface Entry {
  draft: RouteDraft;
  /** The key of what was last saved: the draft is dirty while it differs. */
  savedKey: string;
  saved: RouteDraft;
}

const entries = new Map<string, Entry>();
/** Waypoints made on Add waypoint and since saved with a route. */
let savedExtra: WaypointFileRecord[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** How a task's times are shown and stored: the competition's zone, on the task's date. */
export function routeTimes(taskId: string) {
  const taskDate = TASK_DATES[taskId] ?? "";
  const ctx: RouteDraftContext = {
    toDisplayTime: (hhmm) => utcToZonedHHMM(taskDate, hhmm, COMP_TIME_ZONE) ?? hhmm,
  };
  return {
    ctx,
    taskDate,
    timeZone: COMP_TIME_ZONE,
    toUtc: (hhmm: string) => zonedToUtcHHMM(taskDate, hhmm, COMP_TIME_ZONE) ?? hhmm,
    timeZoneLabel: taskDate
      ? zoneNameWithOffset(new Date(`${taskDate}T12:00:00Z`), COMP_TIME_ZONE)
      : "UTC",
  };
}

function entry(taskId: string): Entry {
  let e = entries.get(taskId);
  if (!e) {
    const draft = freshDraft(TASK_ROUTES[taskId] ?? null, routeTimes(taskId).ctx);
    e = { draft, saved: draft, savedKey: draft.base };
    entries.set(taskId, e);
  }
  return e;
}

export function updateRoute(taskId: string, change: (d: RouteDraft) => RouteDraft): void {
  const e = entry(taskId);
  const draft = change(e.draft);
  if (draft === e.draft) return;
  entries.set(taskId, { ...e, draft });
  emit();
}

/** "Save": what the draft holds is now the saved route, and its new waypoints the competition's. */
export function saveRoute(taskId: string): void {
  const e = entry(taskId);
  savedExtra = [...savedExtra, ...e.draft.pendingWaypoints];
  const fields = { ...e.draft, pendingWaypoints: [] };
  const key = contentKey(fields);
  const draft = { ...fields, base: key };
  entries.set(taskId, { draft, saved: draft, savedKey: key });
  emit();
}

/** Back to the saved route. */
export function discardRoute(taskId: string): void {
  const e = entry(taskId);
  entries.set(taskId, { ...e, draft: e.saved });
  emit();
}

export function useRoute(taskId: string) {
  const e = useSyncExternalStore(
    subscribe,
    () => entry(taskId),
    () => entry(taskId)
  );
  const extra = useSyncExternalStore(
    subscribe,
    () => savedExtra,
    () => savedExtra
  );
  return {
    draft: e.draft,
    dirty: isDirty(e.draft, e.savedKey),
    update: (change: (d: RouteDraft) => RouteDraft) => updateRoute(taskId, change),
    /** The competition's waypoints, and the ones made here that wait for Save. */
    waypoints: [...WAYPOINTS, ...extra, ...e.draft.pendingWaypoints],
  };
}
