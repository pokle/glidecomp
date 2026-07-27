/**
 * Geometry for the compact task diagram (see TaskDiagram.tsx).
 *
 * Pure math, no DOM: given an XCTask and a box to draw in, it returns the
 * optimised route projected into diagram units, the turnpoint markers, the
 * direction arrows and the label placements. Kept out of the component so the
 * fiddly parts (projection, fitting, label collision) are unit-testable and
 * the component stays a renderer.
 *
 * Three deliberate choices, because they are the ones that decide whether the
 * diagram reads at 56px as well as at 560px:
 *
 * - **The view is fitted to the optimised route, not to the cylinders.** At
 *   task scale a 400 m turnpoint on a 60 km task is a third of a pixel, so
 *   fitting to cylinder extents buys nothing — and the moment a task uses one
 *   big ring (a 20 km start cylinder is ordinary) it would shrink the route to
 *   a smudge. Cylinders are still drawn, but only the ones inside the legible
 *   band (see MIN_CYLINDER_UNITS / MAX_CYLINDER_FRACTION); the SVG clips what
 *   spills.
 * - **Markers sit on the optimised tag point, not the turnpoint centre.** That
 *   is where the route actually goes, so a label lands beside the line the
 *   reader is following instead of out in empty space beyond a wide cylinder.
 * - **Everything is in diagram units** (the SVG's viewBox units, which are its
 *   CSS pixels at the default size), so a font size means what it says.
 *
 * Deterministic by construction — same task in, same numbers out — so the
 * server-rendered markup and the client's first render agree (SSR pages
 * render this: comp hub, task detail, task field analysis).
 */
import {
  calculateOptimizedTaskLine,
  computeGoalLine,
  computeTurnpointDirections,
  localEastNorth,
  type TurnpointDirection,
  type XCTask,
} from "@glidecomp/engine";

/** Turnpoint role, using the same rule as the turnpoint listing: the declared
 *  type, or GOAL for the last turnpoint of a task that leaves it unset. */
export type TaskDiagramRole = "TAKEOFF" | "SSS" | "ESS" | "GOAL" | null;

export interface DiagramPoint {
  x: number;
  y: number;
}

export interface TaskDiagramTurnpoint {
  index: number;
  name: string;
  role: TaskDiagramRole;
  /** Crossing direction inferred by the engine — 'exit' is the unusual case. */
  direction: TurnpointDirection;
  radiusM: number;
  /** Cylinder centre, diagram units. */
  center: DiagramPoint;
  /** Cylinder radius, diagram units (may exceed the box — the SVG clips). */
  radius: number;
  /** Where the optimised route tags this cylinder, diagram units. */
  tag: DiagramPoint;
  /** Whether the cylinder is worth drawing (see the band constants below). */
  showCylinder: boolean;
  /** Glyph flags. A concentric ESS/goal pair can be both ESS and goal. */
  isStart: boolean;
  isEss: boolean;
  isGoal: boolean;
}

export interface TaskDiagramLabel {
  /** Index of the turnpoint this labels. */
  index: number;
  text: string;
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
}

/** A direction arrow sitting on the route, angle in radians (SVG y-down). */
export interface TaskDiagramArrow {
  x: number;
  y: number;
  angle: number;
}

export interface TaskDiagramLayout {
  width: number;
  height: number;
  /** The optimised route, in draw order. */
  path: DiagramPoint[];
  turnpoints: TaskDiagramTurnpoint[];
  arrows: TaskDiagramArrow[];
  labels: TaskDiagramLabel[];
  /** Endpoints of a LINE goal, when the task declares one. */
  goalLine: [DiagramPoint, DiagramPoint] | null;
  /** Diagram scale — metres per diagram unit. */
  metresPerUnit: number;
}

export interface TaskDiagramOptions {
  width: number;
  height: number;
  /** Inset kept clear on every side, diagram units. */
  padding: number;
  /** Label font size; omit (or 0) to place no labels. */
  labelFontSize?: number;
  /** Truncate label text to this many characters (ellipsis appended). */
  labelMaxChars?: number;
  /** Skip the arrow on legs shorter than this, diagram units. */
  arrowMinLength?: number;
  /** Radius of a turnpoint dot, diagram units — labels clear it. */
  dotRadius?: number;
  /**
   * Draw turnpoint cylinders at all (default true). The smallest presets turn
   * them off: at glyph size the rings crowd the one thing that has to survive
   * — the shape of the route.
   */
  cylinders?: boolean;
}

/** A cylinder smaller than this is invisible noise, so it isn't drawn. */
const MIN_CYLINDER_UNITS = 3.5;
/** A cylinder wider than this fraction of the box swamps it, so it isn't drawn. */
const MAX_CYLINDER_FRACTION = 0.55;
/** Rough mean glyph advance as a fraction of font size, for label boxes. */
const GLYPH_ADVANCE = 0.58;
/** Used when a task is a single point (open distance): metres of view to show. */
const DEGENERATE_SPAN_M = 2000;

function round(n: number): number {
  // Two decimals: below SVG's rendering resolution at these sizes, and it keeps
  // the server- and client-rendered path strings byte-identical.
  return Math.round(n * 100) / 100;
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Role for a turnpoint, matching TurnpointsTable's rule exactly: the declared
 * type, or GOAL for the last turnpoint of a task that leaves it unset. Shared
 * with the strip and profile views so all four disagree about nothing.
 */
export function turnpointRole(task: XCTask, index: number): TaskDiagramRole {
  const type = task.turnpoints[index]?.type;
  if (type) return type;
  return index === task.turnpoints.length - 1 ? "GOAL" : null;
}

function truncate(text: string, maxChars: number | undefined): string {
  if (!maxChars || text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

/**
 * Project, fit and lay out a task. Returns null for a task with no turnpoints
 * (or one whose coordinates are unusable) — callers render nothing rather than
 * an empty box.
 */
export function buildTaskDiagram(
  task: XCTask,
  options: TaskDiagramOptions
): TaskDiagramLayout | null {
  const tps = task.turnpoints ?? [];
  if (tps.length === 0) return null;
  if (
    tps.some(
      (tp) =>
        !Number.isFinite(tp.waypoint?.lat) || !Number.isFinite(tp.waypoint?.lon)
    )
  ) {
    return null;
  }

  const {
    width,
    height,
    padding,
    labelFontSize = 0,
    labelMaxChars,
    arrowMinLength = 14,
    dotRadius = 2.5,
    cylinders = true,
  } = options;

  const lat0 = mean(tps.map((tp) => tp.waypoint.lat));
  const lon0 = mean(tps.map((tp) => tp.waypoint.lon));
  /** Local flat projection in metres, y flipped so north is up on screen. */
  const project = (lat: number, lon: number): DiagramPoint => {
    const { east, north } = localEastNorth(lat0, lon0, lat, lon);
    return { x: east, y: -north };
  };

  // The optimised route — the same computation the scorer and the turnpoint
  // listing use, so the drawn line can never disagree with the numbers. A
  // half-defined route (the editor's in-progress state) falls back to centres.
  let line: Array<{ lat: number; lon: number }> = [];
  try {
    line = calculateOptimizedTaskLine(task);
  } catch {
    line = [];
  }
  if (line.length !== tps.length) {
    line = tps.map((tp) => ({ lat: tp.waypoint.lat, lon: tp.waypoint.lon }));
  }

  let directions: TurnpointDirection[];
  try {
    directions = computeTurnpointDirections(task, line);
  } catch {
    directions = tps.map(() => "enter" as const);
  }

  let goalLineWorld: [DiagramPoint, DiagramPoint] | null = null;
  try {
    const gl = computeGoalLine(task);
    if (gl) {
      goalLineWorld = [
        project(gl.end1.lat, gl.end1.lon),
        project(gl.end2.lat, gl.end2.lon),
      ];
    }
  } catch {
    goalLineWorld = null;
  }

  const centersM = tps.map((tp) => project(tp.waypoint.lat, tp.waypoint.lon));
  const tagsM = line.map((p) => project(p.lat, p.lon));

  // Fit to the route (plus a LINE goal's extent, which the route only touches
  // at one point but which a reader needs to see whole).
  const fitted = [...tagsM, ...(goalLineWorld ?? [])];
  let minX = Math.min(...fitted.map((p) => p.x));
  let maxX = Math.max(...fitted.map((p) => p.x));
  let minY = Math.min(...fitted.map((p) => p.y));
  let maxY = Math.max(...fitted.map((p) => p.y));

  // A one-turnpoint task (open distance launches from a single cylinder) has
  // no extent at all; show its cylinder instead of dividing by zero.
  if (maxX - minX < 1e-6 && maxY - minY < 1e-6) {
    const half = Math.max(tps[0].radius * 1.2, DEGENERATE_SPAN_M / 2);
    minX -= half;
    maxX += half;
    minY -= half;
    maxY += half;
  }

  const innerW = Math.max(1, width - 2 * padding);
  const innerH = Math.max(1, height - 2 * padding);
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const scale = Math.min(innerW / spanX, innerH / spanY);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const toUnits = (p: DiagramPoint): DiagramPoint => ({
    x: round(width / 2 + (p.x - midX) * scale),
    y: round(height / 2 + (p.y - midY) * scale),
  });

  const path = tagsM.map(toUnits);
  const maxCylinder = Math.min(width, height) * MAX_CYLINDER_FRACTION;
  const lastIndex = tps.length - 1;
  const singlePoint = tps.length === 1;

  const turnpoints: TaskDiagramTurnpoint[] = tps.map((tp, i) => {
    const radius = round(tp.radius * scale);
    const role = turnpointRole(task, i);
    return {
      index: i,
      name: tp.waypoint.name,
      role,
      direction: directions[i] ?? "enter",
      radiusM: tp.radius,
      center: toUnits(centersM[i]),
      radius,
      tag: path[i],
      // A single-turnpoint task IS its cylinder — draw it whatever the size,
      // because otherwise there is nothing on the page at all.
      showCylinder:
        singlePoint ||
        (cylinders && radius >= MIN_CYLINDER_UNITS && radius <= maxCylinder),
      isStart: tp.type === "SSS",
      isEss: tp.type === "ESS",
      isGoal: i === lastIndex && tps.length > 1,
    };
  });

  const goalLine = goalLineWorld
    ? ([toUnits(goalLineWorld[0]), toUnits(goalLineWorld[1])] as [
        DiagramPoint,
        DiagramPoint,
      ])
    : null;

  return {
    width,
    height,
    path,
    turnpoints,
    goalLine,
    arrows: placeArrows(path, arrowMinLength),
    labels:
      labelFontSize > 0
        ? placeLabels(turnpoints, {
            width,
            height,
            padding,
            fontSize: labelFontSize,
            maxChars: labelMaxChars,
            dotRadius,
          })
        : [],
    metresPerUnit: 1 / scale,
  };
}

/**
 * One arrow per leg, at the leg's midpoint, pointing the way the task is
 * flown. Legs too short to carry one are skipped — but a diagram always gets
 * at least one arrow (on its longest leg), because direction is the whole
 * point of drawing arrows and a task of short legs still has a direction.
 */
export function placeArrows(
  path: DiagramPoint[],
  minLength: number
): TaskDiagramArrow[] {
  if (path.length < 2) return [];
  const arrows: TaskDiagramArrow[] = [];
  let longest = { length: -1, index: -1 };

  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > longest.length) longest = { length, index: i };
    if (length < minLength) continue;
    arrows.push({
      x: round((a.x + b.x) / 2),
      y: round((a.y + b.y) / 2),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    });
  }

  if (arrows.length === 0 && longest.index > 0 && longest.length > 0) {
    const a = path[longest.index - 1];
    const b = path[longest.index];
    arrows.push({
      x: round((a.x + b.x) / 2),
      y: round((a.y + b.y) / 2),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    });
  }
  return arrows;
}

interface LabelOptions {
  width: number;
  height: number;
  padding: number;
  fontSize: number;
  maxChars?: number;
  dotRadius: number;
}

/**
 * Place a name beside each turnpoint: pushed outward from the route's centre
 * of mass (so labels fall on the outside of the shape, where there is room),
 * then nudged apart vertically until none overlap, then clamped inside the
 * box. A purely concentric task — every turnpoint on the same summit, which
 * the out-and-return tasks really are — has no outward direction, so those
 * labels fan around a circle by index instead.
 */
export function placeLabels(
  turnpoints: TaskDiagramTurnpoint[],
  options: LabelOptions
): TaskDiagramLabel[] {
  const { width, height, padding, fontSize, maxChars, dotRadius } = options;
  if (turnpoints.length === 0) return [];

  const cx = mean(turnpoints.map((tp) => tp.tag.x));
  const cy = mean(turnpoints.map((tp) => tp.tag.y));
  const gap = dotRadius + fontSize * 0.75;
  const lineHeight = fontSize * 1.15;

  const minY = padding * 0.5 + fontSize * 0.8;
  const maxY = height - padding * 0.5;
  const clampY = (y: number) => Math.min(maxY, Math.max(minY, y));

  const placed = turnpoints.map((tp, i) => {
    let dx = tp.tag.x - cx;
    let dy = tp.tag.y - cy;
    const magnitude = Math.hypot(dx, dy);
    if (magnitude < 1e-6) {
      const angle = (i / turnpoints.length) * Math.PI * 2 - Math.PI / 2;
      dx = Math.cos(angle);
      dy = Math.sin(angle);
    } else {
      dx /= magnitude;
      dy /= magnitude;
    }
    const text = truncate(tp.name, maxChars);
    // Horizontal anchoring follows the push direction so the text grows away
    // from the route rather than back across it.
    const anchor: TaskDiagramLabel["anchor"] =
      dx > 0.35 ? "start" : dx < -0.35 ? "end" : "middle";
    return {
      index: tp.index,
      text,
      // `y` is the text baseline; +0.34em centres the x-height on the offset.
      x: tp.tag.x + dx * gap,
      y: clampY(tp.tag.y + dy * gap + fontSize * 0.34),
      anchor,
      halfWidth: (text.length * GLYPH_ADVANCE * fontSize) / 2,
    };
  });

  // Push overlapping labels apart vertically, re-clamping as we go so a label
  // already pinned to an edge pushes its neighbour inward instead of the two
  // squashing together against the frame. Eight passes is plenty for the
  // handful of turnpoints a task has, and it always terminates.
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i];
        const b = placed[j];
        const dy = b.y - a.y;
        if (Math.abs(dy) >= lineHeight) continue;
        const centreA = a.x + anchorOffset(a.anchor) * a.halfWidth;
        const centreB = b.x + anchorOffset(b.anchor) * b.halfWidth;
        if (Math.abs(centreB - centreA) >= a.halfWidth + b.halfWidth) continue;
        const push = (lineHeight - Math.abs(dy)) / 2 + 0.5;
        const sign = dy === 0 ? -1 : Math.sign(dy);
        a.y = clampY(a.y - sign * push);
        b.y = clampY(b.y + sign * push);
        moved = true;
      }
    }
    if (!moved) break;
  }

  return placed.map((label) => {
    const y = round(label.y);
    // Keep the text box inside the frame; flipping the anchor at an edge beats
    // letting a name run off the diagram.
    const centre = label.x + anchorOffset(label.anchor) * label.halfWidth;
    let x = label.x;
    let anchor = label.anchor;
    if (centre - label.halfWidth < 1) {
      x = 1;
      anchor = "start";
    } else if (centre + label.halfWidth > width - 1) {
      x = width - 1;
      anchor = "end";
    }
    return {
      index: label.index,
      text: label.text,
      x: round(x),
      y: round(y),
      anchor,
    };
  });
}

/**
 * Where to draw the ESS timing gate: a point on the incoming leg, set back
 * `offset` units from the turnpoint, plus the leg's angle so the tick can be
 * drawn across it.
 *
 * Set BACK rather than through the marker because an ESS is very often the
 * last turnpoint too, and a tick through the goal's ring reads as a
 * strike-through — a "prohibited" symbol on the one place a pilot is trying
 * to reach.
 *
 * The offset is capped at 40% of the leg, so a short final leg (an ESS ring
 * nearly concentric with its goal — the ordinary out-and-return shape) still
 * puts the gate on the leg rather than back past the previous turnpoint.
 * Returns null for a zero-length leg, which has no direction to be
 * perpendicular to.
 */
export function gateTickPlacement(
  point: DiagramPoint,
  from: DiagramPoint,
  offset: number
): { x: number; y: number; angle: number } | null {
  const legX = point.x - from.x;
  const legY = point.y - from.y;
  const legLength = Math.hypot(legX, legY);
  if (legLength < 1e-6) return null;

  const back = Math.min(offset, legLength * 0.4);
  return {
    x: round(point.x - (legX / legLength) * back),
    y: round(point.y - (legY / legLength) * back),
    // Perpendicular to the leg — the gate is crossed, not followed.
    angle: Math.atan2(legY, legX) + Math.PI / 2,
  };
}

/** Signed distance from a label's anchor point to its box centre, in half-widths. */
function anchorOffset(anchor: TaskDiagramLabel["anchor"]): number {
  return anchor === "start" ? 1 : anchor === "end" ? -1 : 0;
}

/**
 * Text alternative for the diagram: the route read out in order. This is the
 * whole content of the picture for a screen-reader user, so it names every
 * turnpoint rather than summarising ("a task with 6 turnpoints" tells nobody
 * anything they can act on).
 */
export function describeTaskRoute(task: XCTask): string {
  const names = (task.turnpoints ?? []).map((tp, i) => {
    const role = turnpointRole(task, i);
    return role ? `${tp.waypoint.name} (${role})` : tp.waypoint.name;
  });
  if (names.length === 0) return "Task route: no turnpoints set";
  return `Task route: ${names.join(", then ")}`;
}
