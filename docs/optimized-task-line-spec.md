# Optimized Task Line Specification

## Overview

The Optimized Task Line feature calculates and displays the shortest achievable distance through a paragliding/hanggliding competition task by finding optimal points to tag turnpoint cylinders, rather than flying through their centers.

This provides pilots with:
- **True task distance**: The actual shortest achievable distance
- **Visual guidance**: Optimal line showing where to tag each turnpoint
- **Segment distances**: Distance labels on each leg of the optimized route

## Background

In paragliding and hanggliding competitions, tasks are defined with cylindrical turnpoints. Pilots must enter each cylinder to validate the turnpoint, but they don't need to fly through the center. The shortest possible route tags each cylinder at its edge.

### Prior Art

This implementation is based on algorithms used in professional scoring systems:

- **LK8000** ([PR #286](https://github.com/LK8000/LK8000/pull/286)): "For exit turnpoint distance to circle equation have multiple local minimum, we always use local minimum point nearest of next turnpoint"
- **igclib** ([GitHub](https://github.com/teobouvard/igclib)): Uses Quasi-Newton methods for task optimization
- **XContest** / **XCTrack**: Industry-standard flight optimization
- **AirScore** ([GitHub](https://github.com/geoffwong/airscore)): GAP-based scoring software
- **Touring n Circles Problem** ([Research Paper](https://www.matec-conferences.org/articles/matecconf/pdf/2018/91/matecconf_eitce2018_03027.pdf)): Mathematical foundation for shortest paths through multiple circles

## Algorithm

### Core Principle

Each turnpoint cylinder is tagged at **one optimal point** on its perimeter that minimizes the total path distance. This is a constrained optimization problem where we must find points p₁, p₂, ..., pₙ such that:

- Each point pᵢ lies on the perimeter of circle i
- The sum of distances d(p₁,p₂) + d(p₂,p₃) + ... + d(pₙ₋₁,pₙ) is minimized

### Implementation

Since issue #599 the implementation is the S7F 2026 §7.1 normative algorithm
set, split across two modules:

- **`web/engine/src/route-optimizer.ts`** — the spec's machinery, task-shape
  agnostic: the §7.1.2 localised Transverse Mercator projection (LTM, Annex
  A's alternative implementation, with the latitude-dependent scaling), the
  §7.1.3 **PathFinder** algorithm (Ding, Xie & Jiang 2018 — see the annotated
  transcription in
  [docs/reference/ding-2018-touring-n-circles/](reference/ding-2018-touring-n-circles/ding-2018-touring-n-circles.md))
  extended to line control zones per Annex B, §7.1.6 FindTaskAreaCentre,
  §7.1.7 ProjectionCorrection and the composed §7.1.8 RouteOptimizer.
- **`web/engine/src/task-optimizer.ts`** — what a task's route MEANS: which
  point is the launch, where the ESS pins, how a cylinder or LINE goal
  terminates the route. It builds the §7.1.1 route definition and hands it to
  RouteOptimizer.

The pipeline per route: project every control zone into a Cartesian plane
about the task-area centre (computed once per task and cached), run
PathFinder's odd/even block-coordinate sweeps until the path length changes by
no more than ε = 0.1 m, project the path points back to WGS84, snap each one
onto its control zone's true boundary (ProjectionCorrection, via the Vincenty
inverse azimuth + direct step), and measure the corrected path with the
§7.1.5 EllipsoidDistance.

Per circle, PathFinder follows Ding et al.'s case split: when the
neighbouring path points admit a straight crossing, the tag is the **first
intersection** of the leg with the circle; when both neighbours are strictly
inside, or the leg misses the circle, the tag is the reflection point (found
by a coarse angular scan plus golden-section refinement — the closed-form PCP
quartic is not used, the paper's own printed coefficients being unreliable;
the minimum is the same point).

Three placements are fixed by rule rather than searched (FAI S7F §7.2):

**First turnpoint (launch):** the turnpoint's **centre**, whatever its type or
radius — Annex A §2.2: "the distance is measured from the center of the launch
waypoint (regardless of whether it has been given a radius)". A route that
begins directly at the start cylinder (no TAKEOFF row, as AirScore-imported
tasks often are) therefore includes the centre→boundary kilometres. The one
exception is the trimmed task behind `distanceOrigin: 'start'`
(`XCTask.firstTurnpointAtBoundary`), whose scored distance begins at the start
crossing, so its first turnpoint keeps the boundary measurement.

**Mid-route ESS:** pinned to the incoming leg — Annex A §3.2.4: the ESS fix is
the nearest boundary point toward the previous optimised point, never dragged
toward goal. The task path deliberately kinks at ESS, which makes its
launch→ESS prefix equal the §6.4.2 `launchToESSPath` (a standalone
optimisation) by construction — so slicing the task path at the ESS yields the
spec's launch-to-ESS and speed-section distances.

**Last turnpoint (goal):** the nearest boundary point toward the previous
optimised point (constructed from the goal centre's bearing to it), or the
closest point on a LINE goal.

**Crossed cylinders:** when the prev→next leg passes straight through a
cylinder, every chord point ties on distance; §7.1.3 places the tag at the
leg's **first intersection** with the cylinder (Ding et al.'s crossing case).
This is the one visible departure from AirScore's published per-leg
cumulatives, which reflect the boundary point nearest the chord — the same
chord, up to a radius apart along it, at identical total distance.

#### Convergence

PathFinder alternates: solve every odd-numbered circle with the even ones
held fixed, then the evens with the odds fixed, until a full round moves the
planar path length by no more than the spec's threshold:

```
ε = 0.1 m           // §7.1.3
iteration cap = 50 + num_elements × 10   // safety net only; the sweep length
                                         // is monotone non-increasing
```

### Cylinder Tolerance

CIVL GAP specifies a tolerance band on cylinder radii to compensate for differences between distance calculation methods:

- **Cat 1 (World/Continental championships):** 0.1%
- **Cat 2 (other FAI competitions):** up to 0.5%

This is applied in `detectCylinderCrossings()` via `XCTask.cylinderTolerance`.
The value comes from the task file — `parseXCTask` reads a declared
`cylinderTolerance` field (the AirScore importer writes the comp's
`error_margin` into it), and only a task that declares none falls back to
the 0.5% default. The effective radius for crossing detection is
`radius × (1 + tolerance)`, but the crossing point is interpolated to the
nominal radius. The band's width is a scoring decision, not a nicety: on a
33.5 km ENTER start ring the default band is 167.5 m wide, and scoring a
comp that declared 0.05% (16.75 m) with it swallowed every pilot's exit
past the ring — see issue #577 and the changelog below.

## Geometry Functions

All geographic calculations use the centralized `geo.ts` module, which implements WGS84 ellipsoid formulas for CIVL-accurate scoring:

```typescript
import { ellipsoidDistance, inverseGeodesic, destinationPoint } from './geo';
```

### Available Functions

- `ellipsoidDistance(lat1, lon1, lat2, lon2)` - the §7.1.5 EllipsoidDistance: WGS84 distance in metres (Vincenty inverse)
- `inverseGeodesic(lat1, lon1, lat2, lon2)` - the §7.1.4 InverseGeodesic: distance AND initial azimuth (Vincenty inverse)
- `destinationPoint(lat, lon, distanceMeters, bearingRadians)` - the §7.1.4 DirectGeodesic: destination point on WGS84 ellipsoid (Vincenty direct)

**Note**: Never implement inline geo math. Always use the `geo.ts` module.

## Visual Representation

Visual styling for the task line, distance labels, and turnpoint rendering is defined in the "Task" section of [`mapbox-interactions-spec.md`](mapbox-interactions-spec.md) — the single source of truth for all map visuals.

### Total Distance Display
Shown in the flight info panel:
```
Task: 7 TPs, 133.08 km (optimized)
```

## API

### Core Functions

```typescript
/**
 * Calculate the optimized task line
 * Returns array of lat/lon points representing optimal tags
 */
export function calculateOptimizedTaskLine(
  task: XCTask
): { lat: number; lon: number }[]

/**
 * Calculate total optimized distance
 * Returns distance in meters
 */
export function calculateOptimizedTaskDistance(
  task: XCTask
): number

/**
 * Get individual segment distances
 * Returns array of distances in meters for each segment
 */
export function getOptimizedSegmentDistances(
  task: XCTask
): number[]

/**
 * The FAI S7F §8.6.1 remaining route from an arbitrary position: the
 * shortest path of {point(position), un-reached zones…, goal}, optimised
 * with the same §6.4.1 algorithm (ESS pin included, goal line taken from
 * the TASK's final leg). Behind a landed-out pilot's flown distance
 * (taskDistance − remaining) and a manual flight's made-good distance.
 */
export function optimizeRemainingRoute(
  task: XCTask,
  lastReachedIndex: number,
  position: { lat: number; lon: number }
): { line: { lat: number; lon: number }[]; distance: number } | null
```

### Map Provider Integration

The MapBox provider renders the optimized task line:

```typescript
interface MapProvider {
  setTask(task: XCTask): Promise<void>
}
```

When a task is set:
1. Calculate optimized path using `calculateOptimizedTaskLine()`
2. Render the path as a polyline/LineString
3. Calculate segment distances using `getOptimizedSegmentDistances()`
4. Create labels at the midpoint of each segment

## Performance Considerations

### Computational Complexity

PathFinder is O(kn) sweeps of cheap planar geometry (Ding et al.'s Theorem
3); the expensive ellipsoid work — projecting the route in, correcting the
tags back onto boundaries, summing distances — is O(n) Vincenty evaluations
per route. This is substantially cheaper than the previous implementation,
whose per-circle golden-section search evaluated dozens of Vincenty distances
per cylinder per pass. A typical task optimises in well under a millisecond.

### Caching
The optimised task line is cached per task object in a `WeakMap`, keyed on a
cheap content string (turnpoint types/radii/coordinates + goal type) so an
in-place edit — the analysis page's task editor adjusts radii on the live
object — can never be served a stale line. The §7.1.6 task-area centre and
its LTM projection are cached the same way (the spec computes the centre
ONCE per task and reuses it for every route of that task). Sequence
resolution, the explainers and the task analysis all recompute the line per
pilot, so the caches are what keep the §9.3 per-fix remaining-route
optimisations affordable; the remaining routes themselves (fresh route per
position, but the task's cached projection) are not cached.

## Limitations and Future Enhancements

### Current Limitations
1. **No turn direction constraints**: Doesn't account for sectors (e.g., "must turn left around turnpoint"). All turnpoints are treated as full cylinders.

### Potential Enhancements
1. **Sector support**: Handle sector turnpoints (entry/exit sectors with specific angles)

2. **FAI triangle detection**: Detect and optimize FAI triangle tasks with their specific constraints

## Testing

Tests are in `web/engine/tests/task-optimizer.test.ts`, with the S7F §6.4
rules covered by three dedicated files:

- `spec-distances.test.ts` — the launch-centre rule, the ESS pin and the
  concentric-ENTER-start out-and-back route against three curated archive
  fixtures (`tests/fixtures/*.xctsk`), asserting AirScore's published
  per-waypoint cumulative distances.
- `best-progress-remaining.test.ts` — the §8.6.1 remaining-route
  measurement: dogleg re-optimisation, LINE goals, un-reached exit
  cylinders, the carried `remainingRoute`, manual-flight parity.
- `distance-corpus.test.ts` — the §6.4.2 prefix property over every bundled
  task (CI), plus the whole glidecomp-archive back-catalogue and
  modern-generation task-distance parity when `GLIDECOMP_COMPS_DIR` points
  at an archive checkout.

### Unit Tests
1. **Two turnpoints**: Simple bearing-based approach
2. **Collinear turnpoints**: Produces straight-line path
3. **Complex task with large cylinders**: Iterative produces shorter distance
4. **Segment distances sum to total**: Consistency check
5. **Points on cylinders**: The first point is the launch centre; every other optimized point lies within 1m of its turnpoint cylinder

### Integration Tests
1. **face.xctsk**: Iterative convergence beats the single-pass distance (the route starts at the SSS cylinder, so under the launch-centre rule the totals carry its 3 km radius: ~80.3 km vs the old edge-measured 77.3 km)
2. **Corryong Cup T1 scoring**: Full pipeline test (IGC parsing → turnpoint sequence → GAP scoring) in `gap-scoring-integration.test.ts`

## References

- **FAI Sporting Code Section 7A**: Paragliding competition rules
- **GAP (GAP Annex to Section 7A)**: Scoring algorithm specifications
- **XContest Rules**: https://www.xcontest.org/world/en/rules/
- **LK8000 Task Optimization**: https://github.com/LK8000/LK8000/pull/286
- **Touring n Circles**: https://www.matec-conferences.org/articles/matecconf/pdf/2018/91/matecconf_eitce2018_03027.pdf
- **Golden Section Search**: https://en.wikipedia.org/wiki/Golden-section_search
- **Andoyer-Lambert Formula**: WGS84 ellipsoid distance approximation (~2 ppm accuracy vs Vincenty)

## Change Log

### 2026-08-10: S7F 2026 §7.1 PathFinder route optimisation (issue #599)
- Adopted the 2026 edition's normative algorithm set in
  `route-optimizer.ts`: LTM projection (§7.1.2, Annex A, latitude-dependent
  scaling), PathFinder (§7.1.3, Ding et al. 2018, ε = 0.1 m; Annex B line
  extension), FindTaskAreaCentre (§7.1.6), ProjectionCorrection (§7.1.7),
  RouteOptimizer (§7.1.8)
- Replaced the per-cylinder ellipsoidal golden-section search; a crossed
  cylinder now tags the leg's first intersection (§7.1.3) instead of the
  boundary point nearest the chord
- `goalLinePointAt` walks the geodesic azimuth instead of a spherical
  bearing (the drawn line sagged metres off the goal centre)
- Task distances move by at most metre scale over the archive; the
  /scoring/gap deviation note about the route optimiser is removed

### 2026-08-08: Declared cylinder tolerance honoured (issue #577)
- `parseXCTask` reads the task file's `cylinderTolerance` field; the 0.5%
  default now applies only to tasks that declare none. Before this, every
  imported comp scored with a band up to 10× wider than it declared — on
  bright-open-2025-open-t3 (takeoff inside a 33.5 km ENTER start ring) the
  default band swallowed the field's shallow exits past the ring and scored
  everyone landed out at the start. Engine scoring version 33 → 34

### 2026-08-08: S7F §6.4 distance definitions (2024 edition)
- Launch measured from the first turnpoint's CENTRE regardless of type
  (Annex A §2.2) — SSS-first tasks gain their start radius, matching
  AirScore; `distanceOrigin: 'start'` keeps boundary semantics via
  `XCTask.firstTurnpointAtBoundary`
- Mid-route ESS pinned to the incoming leg (Annex A §3.2.4) — the task path
  kinks at ESS and its launch→ESS prefix equals the §6.4.2 launchToESSPath
- `optimizeRemainingRoute()` — the §8.6.1 per-position remaining-route
  optimisation behind flown distance and manual flights
- Deterministic tag on a crossed cylinder (boundary point nearest the
  chord); nearest-boundary points constructed from the centre's bearing;
  converged pass adopted; task line cached per task object
- Verified against the glidecomp-archive back-catalogue (196 tasks with
  published AirScore results); engine scoring version 31 → 32

### 2026-03-20: CIVL-Accurate Scoring
- Added iterative convergence — re-runs until < 1m change, matching CIVL GAP Annex A
- Added cylinder tolerance (`XCTask.cylinderTolerance`) — default 0.5% (Cat 2), configurable to 0.1% (Cat 1)
- Replaced haversine (spherical) with Andoyer-Lambert distance formula (WGS84 ellipsoid)
- Replaced Turf.js destination with Vincenty direct formula (WGS84 ellipsoid)
- Removed `@turf/distance` and `@turf/destination` dependencies

### 2026-01-20: Simplified to MapBox Only
- Removed Google Maps and MapLibre providers
- MapBox GL JS is now the only supported map provider

### 2026-01-11: Initial Implementation
- Implemented optimized task line calculation using golden section search
- Added distance labels to task line segments
- Integrated with map providers
- Updated flight info display to show optimized distance
