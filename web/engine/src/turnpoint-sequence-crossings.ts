/**
 * Cylinder + goal-line crossing detection.
 *
 * Turns a tracklog into the list of raw boundary crossings (with the S7F §8.1
 * tolerance band and per-turnpoint enter/exit direction) that the sequence
 * resolver selects the scored sequence from.
 */

import type { XCTask } from './xctsk-parser';
import type { IGCFix } from './igc-parser';
import { andoyerDistance } from './geo';
import { getGoalIndex } from './xctsk-parser';
import { computeTurnpointDirections, type TurnpointDirection } from './task-optimizer';
import {
  computeGoalLine,
  goalLineCrossingFraction,
  goalSemicircleBoundaryFraction,
  isForwardGoalCrossing,
  isInGoalSemicircle,
  type GoalLine,
} from './goal-line';
import {
  DEFAULT_CYLINDER_TOLERANCE,
  MIN_CYLINDER_TOLERANCE_M,
} from './turnpoint-sequence-types';
import type { CylinderCrossing } from './turnpoint-sequence-types';

/**
 * Outer edge of a cylinder's tolerance band (§8.1): the radius at which an
 * entry cylinder is credited. Shared by crossing detection and the
 * presence-based reaching check so both use the same notion of "inside".
 */
export function outerDetectionRadius(radius: number, tolerance: number): number {
  return Math.max(radius * (1 + tolerance), radius + MIN_CYLINDER_TOLERANCE_M);
}

/**
 * Inner edge of a cylinder's tolerance band (§8.1): the radius at which an
 * EXIT cylinder is credited — the pilot leaving is credited a touch early
 * rather than a touch late. Applies to the EXIT start and to inferred exit
 * turnpoints (see {@link computeTurnpointDirections}).
 */
export function innerDetectionRadius(radius: number, tolerance: number): number {
  return Math.max(0, Math.min(radius * (1 - tolerance), radius - MIN_CYLINDER_TOLERANCE_M));
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Detect all cylinder boundary crossings in the tracklog.
 *
 * Scans consecutive fix pairs and records every transition across a
 * turnpoint cylinder boundary. Each crossing is tracked per task position
 * index, not per waypoint identity. Crossings are interpolated between
 * the two fixes that straddle the boundary.
 *
 * Exported separately so the UI can visualize all crossings on the map
 * independently of the sequence resolution.
 *
 * @param task - The competition task definition
 * @param fixes - The pilot's GPS tracklog
 * @param directions - Optional precomputed per-turnpoint directions
 *   ({@link computeTurnpointDirections}) to avoid recomputing the optimized
 *   route; computed from the task when omitted
 * @returns All crossings sorted by time
 */
export function detectCylinderCrossings(
  task: XCTask,
  fixes: IGCFix[],
  directions?: TurnpointDirection[]
): CylinderCrossing[] {
  if (fixes.length < 2) return [];

  const crossings: CylinderCrossing[] = [];

  // CIVL GAP cylinder tolerance (FAI S7F §8.1): a band of a percentage plus a
  // 5 m absolute minimum, applied when deciding whether a pilot reached a
  // cylinder, to absorb distance-measurement differences between flight
  // recorders and scoring programs. Default 0.5% (Cat 2 maximum).
  const tolerance = task.cylinderTolerance ?? DEFAULT_CYLINDER_TOLERANCE;

  // EXIT cylinders are the one place the *inner* edge of the band matters: a
  // pilot leaving an EXIT start is credited once they cross the inner radius
  // outward (§8.2/§8.3), and an inferred exit turnpoint (a cylinder the route
  // reaches from inside — see computeTurnpointDirections) is credited at the
  // same edge. Every entry cylinder is credited at the outer edge.
  const dirs = directions ?? computeTurnpointDirections(task);

  // Goal line (S7F §6.3.1): when the task's goal is a LINE, the goal task
  // position is detected against the line + control semicircle instead of a
  // cylinder. Null means cylinder goal — the loop below handles it as before.
  const goalLine = computeGoalLine(task);
  const goalIdx = getGoalIndex(task);

  const DEG = Math.PI / 180;

  for (let tpIdx = 0; tpIdx < task.turnpoints.length; tpIdx++) {
    if (goalLine && tpIdx === goalIdx) {
      detectGoalLineCrossings(goalLine, fixes, tpIdx, crossings);
      continue;
    }
    const tp = task.turnpoints[tpIdx];
    const centerLat = tp.waypoint.lat;
    const centerLon = tp.waypoint.lon;
    // Tolerance band (§8.1): outerRadius = max(r×(1+tol), r+5),
    // innerRadius = min(r×(1−tol), r−5). Entry cylinders detect against the
    // outer edge; EXIT cylinders (the EXIT start and inferred exit
    // turnpoints) detect against the inner edge so the pilot is credited
    // with leaving a touch early rather than a touch late.
    const outerRadius = outerDetectionRadius(tp.radius, tolerance);
    const innerRadius = innerDetectionRadius(tp.radius, tolerance);
    const detectRadius = dirs[tpIdx] === 'exit' ? innerRadius : outerRadius;
    // Bounding box uses the outer radius (always ≥ detectRadius) to stay
    // conservative regardless of which edge we detect against.
    const radius = outerRadius;

    // Conservative lat/lon bounding box around the cylinder. Any point inside
    // the cylinder is guaranteed to fall inside this box, so a fix outside the
    // box is definitely outside the cylinder and can skip the (much costlier)
    // ellipsoidal distance call. The denominators under-estimate metres-per-
    // degree and a 1% margin is added, so the box strictly contains the
    // cylinder — this is a pure speed-up with no effect on which fixes are
    // classified inside/outside. (Assumes tasks don't span the ±180° meridian,
    // the same assumption the linear crossing interpolation below already makes.)
    const latDelta = (radius / 110540) * 1.01;
    const cosLat = Math.cos((Math.abs(centerLat) + latDelta) * DEG);
    const lonDelta = (radius / (111000 * Math.max(cosLat, 1e-6))) * 1.01;

    const isInside = (lat: number, lon: number): boolean => {
      const dLat = lat - centerLat;
      if (dLat > latDelta || dLat < -latDelta) return false;
      const dLon = lon - centerLon;
      if (dLon > lonDelta || dLon < -lonDelta) return false;
      return andoyerDistance(lat, lon, centerLat, centerLon) <= detectRadius;
    };

    const distToCenter = (fix: IGCFix): number =>
      andoyerDistance(fix.latitude, fix.longitude, centerLat, centerLon);

    // Does the straight segment d0→d1 (distances to center) pass through the
    // nominal radius in this crossing's radial direction? Entering means the
    // distance falls through the radius; exiting means it rises through it.
    const nominalRadius = tp.radius;
    const crossesNominal = (d0: number, d1: number, direction: 'enter' | 'exit'): boolean =>
      direction === 'enter'
        ? d0 > nominalRadius && d1 <= nominalRadius
        : d0 < nominalRadius && d1 >= nominalRadius;

    let prevInside = isInside(fixes[0].latitude, fixes[0].longitude);
    // First fix index of the current same-side run of the detection-edge
    // state machine. Bounds the backward scan below: fixes
    // [lastFlipFixIdx .. fixIdx-1] are all on the prevInside side.
    let lastFlipFixIdx = 0;

    for (let fixIdx = 1; fixIdx < fixes.length; fixIdx++) {
      const currInside = isInside(fixes[fixIdx].latitude, fixes[fixIdx].longitude);

      if (prevInside !== currInside) {
        const prevFix = fixes[fixIdx - 1];
        const currFix = fixes[fixIdx];
        const direction: 'enter' | 'exit' = currInside ? 'enter' : 'exit';

        // Interpolate crossing point between the two fixes
        const prevDist = distToCenter(prevFix);
        const currDist = distToCenter(currFix);

        // Interpolate to the nominal radius (without tolerance)
        const tRaw = (prevDist - nominalRadius) / (prevDist - currDist);

        // The detection edge (outer band edge, or inner for an EXIT start)
        // differs from the nominal radius, so the pair that crosses the
        // detection edge doesn't necessarily straddle the nominal radius —
        // the pilot may cross it a few fixes earlier or later while inside
        // the tolerance band. Anchor the crossing to the fix pair that
        // physically straddles the nominal radius:
        //  - tRaw in [0,1]: this pair — the common single-step case.
        //  - tRaw > 1: the nominal radius lies further along the flight
        //    path; scan forward while the detection-edge state holds.
        //  - tRaw < 0: it was crossed earlier in this band episode; scan
        //    backward to the previous state flip.
        // Only when no pair in the band episode straddles the nominal
        // radius did the pilot merely reach the tolerance band — a
        // tolerance-credited near-miss (§8.1) anchored at the clamped edge.
        let anchorPrev = prevFix;
        let anchorCurr = currFix;
        let anchorFixIndex = fixIdx;
        let t = Math.max(0, Math.min(1, tRaw));
        let toleranceCredited = tRaw < 0 || tRaw > 1;

        if (tRaw > 1) {
          let d0 = currDist;
          for (let j = fixIdx; j + 1 < fixes.length; j++) {
            // Stop at the next detection-edge flip — that boundary belongs
            // to the next crossing.
            if ((d0 <= detectRadius) !== currInside) break;
            const d1 = distToCenter(fixes[j + 1]);
            if (crossesNominal(d0, d1, direction)) {
              anchorPrev = fixes[j];
              anchorCurr = fixes[j + 1];
              anchorFixIndex = j + 1;
              t = (d0 - nominalRadius) / (d0 - d1);
              toleranceCredited = false;
              break;
            }
            d0 = d1;
          }
        } else if (tRaw < 0) {
          let d1 = prevDist;
          for (let j = fixIdx - 1; j > lastFlipFixIdx; j--) {
            const d0 = distToCenter(fixes[j - 1]);
            if (crossesNominal(d0, d1, direction)) {
              anchorPrev = fixes[j - 1];
              anchorCurr = fixes[j];
              anchorFixIndex = j;
              t = (d0 - nominalRadius) / (d0 - d1);
              toleranceCredited = false;
              break;
            }
            d1 = d0;
          }
        }

        const crossingLat = anchorPrev.latitude + t * (anchorCurr.latitude - anchorPrev.latitude);
        const crossingLon = anchorPrev.longitude + t * (anchorCurr.longitude - anchorPrev.longitude);
        const crossingAlt = anchorPrev.gnssAltitude + t * (anchorCurr.gnssAltitude - anchorPrev.gnssAltitude);

        const prevTime = anchorPrev.time.getTime();
        const currTime = anchorCurr.time.getTime();
        const crossingTime = new Date(prevTime + t * (currTime - prevTime));

        const distanceToCenter = andoyerDistance(
          crossingLat, crossingLon, centerLat, centerLon
        );

        crossings.push({
          taskIndex: tpIdx,
          fixIndex: anchorFixIndex,
          time: crossingTime,
          latitude: crossingLat,
          longitude: crossingLon,
          altitude: crossingAlt,
          direction,
          distanceToCenter,
          toleranceCredited,
        });

        lastFlipFixIdx = fixIdx;
      }

      prevInside = currInside;
    }
  }

  // Sort all crossings by time
  crossings.sort((a, b) => a.time.getTime() - b.time.getTime());

  return crossings;
}

/**
 * Detect goal-line crossings (S7F §6.3.1) for the goal task position and
 * append them to `out`.
 *
 * The pilot is "inside" goal when in the control semicircle behind the line
 * ({@link isInGoalSemicircle}); a track segment that intersects the line
 * itself is a crossing even when neither fix lands in the semicircle (a
 * fast crossing near an endpoint can leave no fix inside). To keep the
 * enter/exit alternation consistent with the semicircle state — which the
 * presence-based reaching logic relies on — such a through-crossing emits an
 * 'enter' and an 'exit' at the same interpolated instant.
 *
 * No tolerance band applies: the §8.1 band is defined for cylinders; the
 * goal line is exact geometry (its semicircle already absorbs the
 * fast-crossing case), so `toleranceCredited` is always false here.
 */
function detectGoalLineCrossings(
  goalLine: GoalLine,
  fixes: IGCFix[],
  taskIndex: number,
  out: CylinderCrossing[]
): void {
  if (fixes.length < 2) return;

  const centerLat = goalLine.center.lat;
  const centerLon = goalLine.center.lon;

  // Conservative bounding box around the line + semicircle (everything lies
  // within halfWidth of the centre). A fix pair whose own bbox doesn't
  // overlap it can't produce a crossing — skips the frame math for the vast
  // majority of the track. Same margin scheme as the cylinder loop.
  const DEG = Math.PI / 180;
  const reach = goalLine.halfWidth;
  const latDelta = (reach / 110540) * 1.01;
  const cosLat = Math.cos((Math.abs(centerLat) + latDelta) * DEG);
  const lonDelta = (reach / (111000 * Math.max(cosLat, 1e-6))) * 1.01;

  const push = (
    anchorPrev: IGCFix,
    anchorCurr: IGCFix,
    fixIndex: number,
    t: number,
    direction: 'enter' | 'exit',
    viaSemicircleArc = false
  ): void => {
    const lat = anchorPrev.latitude + t * (anchorCurr.latitude - anchorPrev.latitude);
    const lon = anchorPrev.longitude + t * (anchorCurr.longitude - anchorPrev.longitude);
    const alt = anchorPrev.gnssAltitude + t * (anchorCurr.gnssAltitude - anchorPrev.gnssAltitude);
    const prevTime = anchorPrev.time.getTime();
    out.push({
      taskIndex,
      fixIndex,
      time: new Date(prevTime + t * (anchorCurr.time.getTime() - prevTime)),
      latitude: lat,
      longitude: lon,
      altitude: alt,
      direction,
      distanceToCenter: andoyerDistance(lat, lon, centerLat, centerLon),
      toleranceCredited: false,
      ...(viaSemicircleArc ? { goalSemicircleCredited: true } : {}),
    });
  };

  let prevInside = isInGoalSemicircle(goalLine, fixes[0].latitude, fixes[0].longitude);

  for (let fixIdx = 1; fixIdx < fixes.length; fixIdx++) {
    const p0 = fixes[fixIdx - 1];
    const p1 = fixes[fixIdx];

    // Bbox rejection: segment bbox vs goal-region bbox.
    const minLat = Math.min(p0.latitude, p1.latitude);
    const maxLat = Math.max(p0.latitude, p1.latitude);
    const minLon = Math.min(p0.longitude, p1.longitude);
    const maxLon = Math.max(p0.longitude, p1.longitude);
    if (
      minLat > centerLat + latDelta || maxLat < centerLat - latDelta ||
      minLon > centerLon + lonDelta || maxLon < centerLon - lonDelta
    ) {
      // Both endpoints (and the whole segment) are outside the region, so
      // the pilot is outside the semicircle at p1 too.
      prevInside = false;
      continue;
    }

    const from = { lat: p0.latitude, lon: p0.longitude };
    const to = { lat: p1.latitude, lon: p1.longitude };
    const currInside = isInGoalSemicircle(goalLine, to.lat, to.lon);
    const lineT = goalLineCrossingFraction(goalLine, from, to);

    if (lineT !== null) {
      if (prevInside !== currInside) {
        // Crossing the line into (or back out of) the semicircle.
        push(p0, p1, fixIdx, lineT, currInside ? 'enter' : 'exit');
      } else {
        // Crossed the line but neither fix is in the semicircle (e.g. a fast
        // pass near an endpoint): an instantaneous enter+exit pair keeps the
        // crossing on record without corrupting the inside/outside state.
        const direction = isForwardGoalCrossing(goalLine, from, to);
        push(p0, p1, fixIdx, lineT, direction ? 'enter' : 'exit');
        push(p0, p1, fixIdx, lineT, direction ? 'exit' : 'enter');
      }
    } else if (prevInside !== currInside) {
      // Entered or left through the semicircle's arc (no line intersection).
      const t = goalSemicircleBoundaryFraction(goalLine, from, to);
      push(p0, p1, fixIdx, t, currInside ? 'enter' : 'exit', true);
    }

    prevInside = currInside;
  }
}
