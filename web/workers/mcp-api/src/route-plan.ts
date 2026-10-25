/**
 * A quick-task line, read as the route it would make (docs/2026-10-24-mcp-oauth-plan.md
 * §5, phase 3). Behind preview_route, which shows the reading, and
 * set_task_route, which saves it.
 *
 * It is the website's route editor, step for step, with no step of its own:
 * `quickTaskApply` reads the line, `reconcileRoute` applies it over the route
 * the task already holds (so a turnpoint the line still names keeps its
 * coordinates, altitude and long name), `assembleRouteTask` adds the start and
 * goal, and `xctskForPatch` writes the body the task PATCH takes. An assistant
 * and an organiser typing the same line get the same route.
 *
 * What it adds is the one rule the editor doesn't need. Quick entry is
 * forgiving by design — it shows its best guess and a tap corrects it — and an
 * assistant has no tap. So every name token is marked EXACT or not: exact when
 * it spells a competition waypoint's code, or a turnpoint the route already
 * has, letter for letter (case and accents aside). A fuzzy match may propose,
 * never dispose (CLAUDE.md, "Names may propose, never dispose"): only a line
 * whose every name is exact is `ready` to save.
 */
import type { WaypointFileRecord, XCTask } from "@glidecomp/engine";
import {
  parseQuickTask,
  quickTaskApply,
} from "../../../frontend/src/react/comp/quick-task";
import { reconcileRoute, removedByReconcile } from "../../../frontend/src/react/comp/route-reconcile";
import { editableGates } from "../../../frontend/src/react/comp/route";
import {
  assembleRouteTask,
  turnpointsToRows,
  xctskForPatch,
  type RouteSettings,
} from "../../../frontend/src/react/comp/route-editor";
import { NEW_ROW_RADIUS } from "../../../frontend/src/react/comp/turnpoint-draft";
import { utcToZonedHHMM, zonedToUtcHHMM } from "../../../frontend/src/react/lib/time";

/** How many runners-up a fuzzy token reports. */
const ALTERNATIVES = 5;

export interface PlannedTurnpoint {
  /** The token as written. */
  typed: string;
  /** The waypoint code (or existing turnpoint name) it was read as; null if none. */
  read_as: string | null;
  /** The waypoint's long name, when it has one. */
  description?: string;
  /** True only when `typed` spells `read_as` exactly. */
  exact: boolean;
  /** Other waypoints the token could mean, best first — only for a token that isn't exact. */
  alternatives?: Array<{ code: string; name: string }>;
}

export interface RoutePlan {
  turnpoints: PlannedTurnpoint[];
  /** Name tokens that matched nothing at all. */
  unmatched: string[];
  /** What blocks saving: start problems, and route problems the editor would refuse. */
  problems: string[];
  /** What saves but deserves a look (no start, no ESS…), as the editor warns. */
  warnings: string[];
  /** Turnpoints the task has now that this line would remove. */
  removes: string[];
  /** The line tidied: every role named, the start written out — what to send to set_task_route. */
  line: string;
  /** The task PATCH body, when nothing blocks the route itself. */
  xctsk: Record<string, unknown> | null;
  /** Every name exact, nothing unmatched, no problems: set_task_route will take it. */
  ready: boolean;
}

export interface PlanInput {
  line: string;
  waypoints: WaypointFileRecord[];
  /** The task's stored route, or null when it has none yet. */
  current: XCTask | null;
  taskDate: string;
  /** The comp's IANA zone; start gates in the line are read in it. Null = UTC. */
  timeZone: string | null;
  openDistance: boolean;
}

/** Case and accent blind, like quick-task's own matching. */
function norm(s: string): string {
  return s.trim().normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
}

/** The start and goal settings the stored route carries, in comp-local time. */
function settingsOf(current: XCTask | null, toLocal: (hhmm: string) => string): RouteSettings {
  const deadline = current?.goal?.deadline ? /^(\d{2}:\d{2})/.exec(current.goal.deadline)?.[1] : undefined;
  return {
    sssType: current?.sss?.type ?? "RACE",
    direction: current?.sss?.direction ?? "EXIT",
    gates: editableGates(current?.sss).map(toLocal),
    goalType: current?.goal?.type ?? "CYLINDER",
    goalDeadline: deadline ? toLocal(deadline) : "",
    goalElevation: current?.goal?.finishAltitude,
  };
}

export function planRoute(input: PlanInput): RoutePlan {
  const { line, waypoints, current, taskDate, timeZone, openDistance } = input;
  const toLocal = (hhmm: string) => (timeZone ? (utcToZonedHHMM(taskDate, hhmm, timeZone) ?? hhmm) : hhmm);
  const toUtc = (hhmm: string) => (timeZone ? (zonedToUtcHHMM(taskDate, hhmm, timeZone) ?? hhmm) : hhmm);

  let id = 0;
  const nextId = () => ++id;
  const rows = turnpointsToRows(current?.turnpoints ?? [], nextId);
  const knownNames = rows.map((r) => String(r.name));
  const known = new Set(knownNames.map(norm));
  // Codes are unique within a comp's set — competition-api's waypoint PUT
  // (cleanWaypointCodes) guarantees it — so a code names one waypoint.
  const codes = new Map(waypoints.map((w) => [norm(w.code), w] as const));

  const applied = quickTaskApply(line, waypoints, { defaultRadius: NEW_ROW_RADIUS, knownNames });
  // The same parse quickTaskApply makes, for the runners-up it doesn't return.
  const items = parseQuickTask(line, waypoints, { defaultRadius: NEW_ROW_RADIUS, candidateLimit: ALTERNATIVES + 1 });

  const turnpoints: PlannedTurnpoint[] = [];
  const unmatched: string[] = [];
  for (const item of items) {
    const typed = item.query;
    if (known.has(norm(typed))) {
      // Names a turnpoint the route already has: kept as it is, not re-picked.
      turnpoints.push({ typed, read_as: knownNames.find((n) => norm(n) === norm(typed))!, exact: true });
      continue;
    }
    const exact = codes.get(norm(typed));
    if (exact) {
      turnpoints.push({
        typed,
        read_as: exact.code,
        ...(exact.name && exact.name !== exact.code ? { description: exact.name } : {}),
        exact: true,
      });
      continue;
    }
    const best = item.candidates[0];
    if (!best) {
      unmatched.push(typed);
      continue;
    }
    turnpoints.push({
      typed,
      read_as: best.code,
      ...(best.name && best.name !== best.code ? { description: best.name } : {}),
      exact: false,
      alternatives: item.candidates.slice(1, ALTERNATIVES + 1).map((w) => ({ code: w.code, name: w.name })),
    });
  }

  const nextRows = reconcileRoute(rows, applied.picks, nextId);
  const removes = removedByReconcile(rows, applied.picks).map((r) => String(r.name));

  // The line carries the start, as it does in the editor: when the route it
  // describes has a start, the line's settings replace the stored ones.
  const settings = settingsOf(current, toLocal);
  if (!openDistance && applied.start) {
    settings.sssType = applied.start.type;
    settings.direction = applied.start.direction;
    settings.gates = applied.start.gates;
  }
  const assembled = assembleRouteTask(nextRows, settings, { openDistance, base: current, toUtc });

  const problems = [...applied.problems, ...assembled.errors];
  const xctsk = assembled.task ? xctskForPatch(assembled.task) : null;
  return {
    turnpoints,
    unmatched,
    problems,
    warnings: assembled.warnings,
    removes,
    line: applied.spelledText,
    xctsk,
    ready:
      xctsk !== null &&
      problems.length === 0 &&
      unmatched.length === 0 &&
      turnpoints.length > 0 &&
      turnpoints.every((t) => t.exact),
  };
}
