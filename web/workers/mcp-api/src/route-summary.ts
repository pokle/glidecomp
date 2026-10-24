/**
 * A task's route as an assistant should read it: the turnpoints, the route as
 * the route editor's one-line "quick task" text, the start configuration in
 * words, the optimised distance, and a revision an edit can be checked against
 * (`route_rev`, for phase 3's set_task_route).
 *
 * The wording comes from the website's own helpers (imported by path, as
 * functions/sitemap.xml.ts imports the slug helpers), so an assistant and the
 * route editor can never describe the same route two ways. All of them are
 * pure: no DOM, no React.
 */
import {
  calculateOptimizedTaskDistance,
  parseXCTask,
  type XCTask,
} from "@glidecomp/engine";
import { editableGates, startConfigSummary } from "../../../frontend/src/react/comp/route";
import { quickTaskText, type QuickType } from "../../../frontend/src/react/comp/quick-task";
import { utcToZonedHHMM } from "../../../frontend/src/react/lib/time";

export interface RouteTurnpoint {
  name: string;
  /** TAKEOFF, SSS, ESS, GOAL or TURNPOINT. */
  role: string;
  radius_m: number;
  lat: number;
  lon: number;
  /** Absent when the task file doesn't know it — never 0 by default. */
  altitude_m?: number;
}

export interface RouteSummary {
  turnpoints: RouteTurnpoint[];
  /** The route as the route editor's quick-task line, comp-local start gates. */
  quick_task: string;
  /** "Race to goal · exit start · 3 start gates: 13:15, … AEDT (GMT+11)". */
  start: string | null;
  /** Optimised (shortest flyable) distance, km, to one decimal. */
  distance_km: number | null;
  /** Changes whenever the stored route does. */
  route_rev: string;
}

function roleOf(task: XCTask, index: number): string {
  const tp = task.turnpoints[index]!;
  if (index === task.turnpoints.length - 1 && tp.type !== "TAKEOFF") return "GOAL";
  return tp.type ?? "TURNPOINT";
}

/** A short, stable fingerprint of the stored route. */
export async function routeRevision(xctsk: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(xctsk));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function summariseRoute(
  xctsk: unknown,
  opts: { taskDate?: string | null; timeZone?: string | null } = {}
): Promise<RouteSummary> {
  const task = parseXCTask(JSON.stringify(xctsk));

  const turnpoints = task.turnpoints.map((tp, i) => ({
    name: tp.waypoint.name,
    role: roleOf(task, i),
    radius_m: tp.radius,
    lat: tp.waypoint.lat,
    lon: tp.waypoint.lon,
    ...(typeof tp.waypoint.altSmoothed === "number" ? { altitude_m: tp.waypoint.altSmoothed } : {}),
  }));

  // The line states gates comp-local, as the editor's does.
  const { taskDate, timeZone } = opts;
  const gates = editableGates(task.sss).map((g) =>
    taskDate && timeZone ? (utcToZonedHHMM(taskDate, g, timeZone) ?? g) : g
  );
  const quick_task = quickTaskText(
    task.turnpoints.map((tp, i) => ({
      name: tp.waypoint.name,
      radius: tp.radius,
      type: (roleOf(task, i) === "GOAL" || !tp.type ? "" : tp.type) as QuickType,
    })),
    task.sss ? { start: { direction: task.sss.direction, type: task.sss.type, gates } } : {}
  );

  let distance_km: number | null = null;
  try {
    distance_km = Math.round(calculateOptimizedTaskDistance(task) / 100) / 10;
  } catch {
    distance_km = null;
  }

  return {
    turnpoints,
    quick_task,
    start: task.sss ? startConfigSummary(task.sss, { timeZone, taskDate: taskDate ?? undefined }) : null,
    distance_km,
    route_rev: await routeRevision(xctsk),
  };
}
