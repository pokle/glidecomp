# Task Optimization Algorithm Comparison

Comparison of shortest-route-through-cylinders algorithms: TaskScore engine vs AirScore vs FAI/CIVL GAP specification.

## Summary

All three systems solve the same geometric problem: find the shortest path from start through a sequence of turnpoint cylinders to goal. The differences are in optimization method, coordinate system, distance formula, and iteration strategy.

| Aspect | TaskScore | AirScore (Python) | FAI/CIVL GAP Spec |
|---|---|---|---|
| **Optimization method** | Golden section search per cylinder | Angle bisector projection + iteration | Iterative projection (Annex A) |
| **Coordinate system** | Geographic (lat/lon) | Planar (transverse Mercator projection) | Planar (UTM projection) |
| **Distance formula** | Andoyer-Lambert (WGS84 ellipsoid) | Geodesic (WGS84 ellipsoid via geographiclib) | Andoyer-Lambert or FAI sphere |
| **Iteration strategy** | Forward pass repeated until convergence (< 1m change) | Forward pass repeated until convergence (≤1m change) | Repeated until no further reduction |
| **Earth model** | WGS84 ellipsoid | WGS84 ellipsoid | WGS84 ellipsoid (Cat 1) or FAI sphere |
| **Cylinder tolerance** | 0.5% default (configurable) | 0.5% | 0.1% (Cat 1), 0.5% (Cat 2) |

## 1. TaskScore Engine Algorithm

**Source:** [`web/engine/src/task-optimizer.ts`](../../web/engine/src/task-optimizer.ts)

### Approach: Golden Section Search

For each intermediate turnpoint, the algorithm searches for the angle θ ∈ [0, 2π] that minimizes:

```
cost(θ) = distance(prev_optimized_point, point_on_circle(θ)) + distance(point_on_circle(θ), next_center)
```

- **First turnpoint:** Point placed on circle along bearing toward next turnpoint center
- **Last turnpoint:** Point placed on circle along bearing from previous optimized point
- **Intermediate turnpoints:** Golden section search (tolerance 1e-5 radians, ~30 iterations)

### Key Characteristics

- **Iterative convergence** — re-runs the forward pass using previous iteration's optimized points until total distance changes by < 1m
- **WGS84 ellipsoid geometry** — uses Andoyer-Lambert distance formula and Vincenty direct for destination
- **No coordinate projection** — works directly in geographic coordinates (no UTM/Mercator)

### Strengths
- Simple, fast, easy to understand
- Golden section search is mathematically guaranteed for unimodal functions
- Iterative convergence matches CIVL specification
- WGS84 distance + destination match the FAI distance formula

### Weaknesses
- **No coordinate projection** — works directly in geographic coordinates rather than UTM (marginal accuracy difference)

## 2. AirScore Algorithm (Python — FAI-CIVL)

**Source:** [`airscore/core/route.py`](https://github.com/kuaka/FAI-Airscore) (John Stevenson's implementation)

### Approach: Planar Projection + Angle Bisector + Iteration

#### Step 1: Project to Plane
Convert all turnpoint coordinates from WGS84 to a transverse Mercator plane centered on the task area. This converts the spherical geometry problem into a 2D Euclidean geometry problem.

#### Step 2: Optimize Each Cylinder (`process_cylinder`)
For each cylinder C between predecessor A and successor B, the core operation is **angle bisector projection**:

1. Calculate distances |AC| and |BC|
2. Find point K on line segment AB such that |AK|/|KB| = |AC|/|BC| (angle bisector theorem)
3. Project K through the cylinder center C onto the circle boundary → this is the optimal touching point R

Special cases handled:
- A and B are the same point → project through center
- A or B is inside the circle → direct intersection
- Line AB intersects the circle → use intersection point
- 180° case (A, C, B collinear) → perpendicular offset

#### Step 3: Iterate Until Convergence
Repeat the forward pass (step 2) using the newly optimized points as A and B, until the total path distance changes by less than 1 meter or max iterations are reached.

```
max_iterations = num_turnpoints * 10
tolerance = 1.0  # meter
```

### Key Characteristics

- **Iterative convergence** — later adjustments propagate back through re-optimization
- **Planar geometry** — all optimization happens in projected 2D coordinates
- **WGS84 distances** — final distances computed on the ellipsoid via geographiclib
- **Handles goal lines** — perpendicular projection onto line segments (not just cylinders)

### Strengths
- Matches the FAI/CIVL specification closely
- Iterative convergence handles complex task geometries better
- Proper ellipsoid distance calculation
- Handles all edge cases (collinear points, overlapping cylinders, goal lines)

### Weaknesses
- More complex implementation (~350 lines of geometry code)
- Planar projection introduces distortion for tasks spanning large areas
- Multiple special cases to handle

### Legacy Algorithm (Geoff Wong, 2008)
The original Perl/Python algorithm used a different approach:
- 3D ECEF (Earth-Centered Earth-Fixed) Cartesian coordinates
- Cross-product based angle bisection in 3D space
- Fixed 3-pass iteration (not convergence-based)
- `polar2cartesian()` / `cartesian2polar()` for coordinate conversion

## 3. FAI/CIVL GAP Specification (Section 7F, Annex A)

**Source:** [FAI Sporting Code Section 7F (2024)](https://www.fai.org/sites/default/files/civl/documents/sporting_code_s7_f_-_xc_scoring_2024.pdf)

### Specified Algorithm

The FAI/CIVL specification defines the algorithm in Annex A with these requirements:

#### Coordinate System
- Project all coordinates to a single UTM zone (based on first task point's longitude)
- Force all subsequent points to the same UTM zone, even if they fall outside it
- All optimization happens in the projected 2D plane

#### Cylinder Intersection Cases
For each control zone circle, given incoming point A and outgoing point B:

1. **Single intersection** (line AB touches circle once): Place point R at the intersection
2. **Two intersections** (line AB crosses circle): Place R at the intersection closest to the perpendicular from the circle center
3. **No intersection** (line AB misses circle): Place R where angles ∠ARC = ∠BRC (angle bisector), determined by the ratio |AK|/|BK| = |AR|/|BR|

#### Iteration
- Start with touching points at turnpoint centers
- After first pass, points move to circle boundaries
- Repeat until no further distance reduction occurs

#### Distance Measurement
- Final distances calculated using "the current FAI distance formula" on WGS84 ellipsoid
- The specification references the Andoyer-Lambert formula (a variation of the inverse geodesic problem)
- Cat 1 competitions use WGS84 ellipsoid; Cat 2 may use FAI sphere (R = 6371.0 km)

#### Cylinder Tolerance
- **Cat 1:** 0.1% tolerance on cylinder radius
- **Cat 2:** Up to 0.5% tolerance
- Purpose: compensate for differences between distance calculations (FAI sphere vs WGS84)

#### Task Distance Definition
> "Task distance is the shortest possible distance a pilot has to fly to finish the task, meaning he has to fly to the boundary of each cylinder, not the turnpoints at the cylinders' centres."

## Detailed Comparison

### Optimization Method

| | TaskScore | AirScore | CIVL Spec |
|---|---|---|---|
| Core technique | 1D golden section search on angle θ | 2D angle bisector geometry | 2D angle bisector geometry |
| Search space | Circle perimeter (0 to 2π) | Direct geometric construction | Direct geometric construction |
| Per-cylinder work | ~30 iterations of cost function | Single geometric operation | Single geometric operation |
| Re-optimization | Until convergence (< 1m) | Until convergence | Until convergence |

**Analysis:** TaskScore's golden section search and AirScore's angle bisector both find the same optimal point for a single cylinder, but they find it differently. The golden section search numerically minimizes the cost function, while the angle bisector geometrically constructs the optimal point directly. For a single cylinder with fixed predecessor and successor, both produce the same result.

All three systems now use iterative convergence: each re-runs the optimization pass with updated touching points until the total path distance stabilises. On `face.xctsk` (Corryong Cup 2026 — 7 km cylinder, acute angles), iterative convergence shortened the task distance by 209 m compared to a single-pass approach.

### Distance Formula

| | TaskScore | AirScore | CIVL Spec |
|---|---|---|---|
| Optimization distances | Andoyer-Lambert (WGS84 ellipsoid) | Euclidean (projected plane) | Euclidean (projected plane) |
| Final reported distance | Andoyer-Lambert (WGS84 ellipsoid) | Geodesic (WGS84 ellipsoid) | Andoyer-Lambert (WGS84) |
| Earth model | WGS84 ellipsoid | WGS84 ellipsoid | WGS84 ellipsoid (Cat 1) |
| Max error vs WGS84 | ~2 ppm vs Vincenty | < 0.01% | Reference standard |

All three systems now use the WGS84 ellipsoid for distance calculation. TaskScore uses the Andoyer-Lambert formula, which is accurate to ~2 ppm vs Vincenty's iterative solution — well within the tolerance needed for competition scoring. The remaining difference between TaskScore and AirScore/CIVL is in the optimization method (geographic coordinates vs projected plane), not the distance formula.

### Coordinate System

TaskScore works directly in geographic coordinates (lat/lon), computing WGS84 ellipsoid distances (Andoyer-Lambert) for each golden section iteration. AirScore and the CIVL spec project to a 2D plane first, then work in Euclidean geometry.

**Trade-offs:**
- Planar projection: Fast Euclidean math, but introduces projection distortion (< 0.04% in UTM)
- Geographic coordinates + Andoyer: No projection distortion, accurate WGS84 distances (~2 ppm vs Vincenty), but slightly more computation per iteration

## Recommendations

### To Better Match CIVL Spec

1. ~~**Add iterative convergence**~~ — **Done.** Re-runs the optimization pass until total distance changes by < 1m, matching CIVL GAP Annex A. On `face.xctsk` (7 km cylinder, acute angles), this shortened the task distance by 209 m vs the old single-pass approach.

2. ~~**Use WGS84 ellipsoid distances**~~ — **Done.** Replaced haversine with Andoyer-Lambert (WGS84 ellipsoid) for all distance calculations, and Vincenty direct formula for destination point computation. Removed `@turf/distance` and `@turf/destination` dependencies. Accuracy: ~2 ppm vs Vincenty reference, validated against 33 real IGC tracks.

3. ~~**Add cylinder tolerance**~~ — **Done.** `XCTask.cylinderTolerance` field controls the tolerance fraction (default 0.5% for Cat 2). Applied in `detectCylinderCrossings` by expanding the effective radius for crossing detection, while interpolating to the nominal radius for the crossing point.

4. **Consider UTM projection** — For the optimization loop, project to UTM and use Euclidean geometry for the angle bisector calculation. This would match the spec exactly, but the accuracy gain over geographic coordinates + Andoyer is marginal.

### Current Status

TaskScore is intended for scoring HG and PG competitions. The algorithm now matches the CIVL specification in all key areas:

**Done:**
- WGS84 ellipsoid distances (Andoyer-Lambert) — matches the FAI distance formula
- Vincenty direct formula for destination points — consistent with distance calculations
- Iterative convergence — re-runs until < 1m change, matching CIVL GAP Annex A
- Cylinder tolerance — configurable per-task (default 0.5%, Cat 1 = 0.1%)

**Nice to have:**
- UTM projection for the optimization loop (would match the spec exactly, but geographic coordinates + Andoyer produce equivalent results)

## References

- [FAI Sporting Code Section 7F – XC Scoring (2024)](https://www.fai.org/sites/default/files/civl/documents/sporting_code_s7_f_-_xc_scoring_2024.pdf)
- [FAI Sporting Code CIVL GAP Annex to Section 7A](https://www.fai.org/sites/default/files/documents/sporting_code_s7a-xc-civl_gap_annex_1.pdf)
- [GlideAngle/CIVL-GAP (LaTeX source)](https://github.com/GlideAngle/CIVL-GAP)
- [geoffwong/airscore (original Perl)](https://github.com/geoffwong/airscore)
- [kuaka/FAI-Airscore (Python)](https://github.com/kuaka/FAI-Airscore)
- [LK8000 Task Optimization PR #286](https://github.com/LK8000/LK8000/pull/286)
- [Touring n Circles Problem](https://www.matec-conferences.org/articles/matecconf/pdf/2018/91/matecconf_eitce2018_03027.pdf)
