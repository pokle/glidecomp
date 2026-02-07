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

The algorithm treats different positions differently:

#### 1. First Turnpoint (Start)
```
Point is on the circle along the bearing toward the next turnpoint
Angle = bearing(center₁ → center₂)
```

This assumes the pilot is approaching from outside the start cylinder.

#### 2. Last Turnpoint (Goal)
```
Point is on the circle along the bearing from the previous turnpoint
Angle = bearing(centerₙ₋₁ → centerₙ)
```

This represents the entry point into the goal cylinder.

#### 3. Intermediate Turnpoints
For turnpoint i (where 1 < i < n), find the point that minimizes:
```
cost(θ) = distance(pointᵢ₋₁, pointᵢ(θ)) + distance(pointᵢ(θ), centerᵢ₊₁)
```

Where:
- `pointᵢ(θ)` is a point on circle i at angle θ
- `pointᵢ₋₁` is the already-optimized point from the previous cylinder
- `centerᵢ₊₁` is the center of the next turnpoint

**Optimization Method**: Golden section search over θ ∈ [0, 2π]

### Golden Section Search

The golden section search is an efficient algorithm for finding the minimum of a unimodal function (one with a single minimum).

```typescript
function findOptimalCirclePoint(prev, center, radius, next):
  phi = (1 + √5) / 2
  resphi = 2 - phi

  a = 0
  b = 2π
  tolerance = 1e-5

  x1 = a + resphi * (b - a)
  x2 = b - resphi * (b - a)
  f1 = cost(x1)
  f2 = cost(x2)

  while |b - a| > tolerance:
    if f1 < f2:
      b = x2; x2 = x1; f2 = f1
      x1 = a + resphi * (b - a)
      f1 = cost(x1)
    else:
      a = x1; x1 = x2; f1 = f2
      x2 = b - resphi * (b - a)
      f2 = cost(x2)

  return point at angle (a + b) / 2
```

**Convergence**: Golden section search has linear convergence and is guaranteed to find the minimum of a unimodal function.

## Geometry Functions

All geographic calculations use **Turf.js** via the centralized `geo.ts` module:

```typescript
import { haversineDistance, calculateBearingRadians, destinationPoint } from './geo';
```

### Available Functions

- `haversineDistance(lat1, lon1, lat2, lon2)` - Great circle distance in meters
- `calculateBearingRadians(lat1, lon1, lat2, lon2)` - Initial bearing in radians
- `destinationPoint(lat, lon, distanceMeters, bearingRadians)` - Destination point calculation

**Note**: Never implement inline geo math. Always use the `geo.ts` module which wraps Turf.js.

## Visual Representation

### Task Line Display
- **Style**: Dashed line (dash pattern: 4px on, 4px off)
- **Color**: Indigo (#6366f1)
- **Width**: 2px
- **Opacity**: 0.8

### Distance Labels
Each segment between consecutive optimized points displays:
- **Content**: Distance in kilometers with 1 decimal place (e.g., "23.4 km")
- **Position**: Midpoint of the line segment
- **Style**:
  - Background: White
  - Text color: Indigo (#6366f1)
  - Border: 1px solid indigo
  - Font size: 11px
  - Font weight: 600 (semi-bold)
  - Border radius: 4px
  - Padding: 2px 6px

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
- **Two turnpoints**: O(1) - simple bearing calculation
- **N turnpoints**: O(N · log(1/ε)) where ε is the tolerance (1e-5)
  - Golden section search: O(log(1/ε)) per turnpoint
  - Distance calculations: O(1) per iteration

For typical tasks (5-10 turnpoints), optimization completes in < 10ms.

### Caching
The optimized path is calculated on-demand when:
- A task is loaded
- The map provider's `setTask()` is called

Results are not cached as task changes are infrequent.

## Limitations and Future Enhancements

### Current Limitations
1. **Start cylinder assumption**: Assumes pilot approaches from outside the start cylinder. For "Enter" start cylinders (where pilot starts inside), the algorithm still works but may not be optimal.

2. **No turn direction constraints**: Doesn't account for sectors (e.g., "must turn left around turnpoint"). All turnpoints are treated as full cylinders.

3. **Local optimization**: Each point is optimized considering only adjacent points. This is a greedy approach that may not find the global optimum for complex task geometries.

4. **Great circle approximation**: Uses spherical geometry (haversine) rather than WGS84 ellipsoid. Error is < 0.5% for distances typical in paragliding tasks.

### Potential Enhancements
1. **Global optimization**: Implement true global optimization (e.g., simulated annealing, genetic algorithms) to find the absolute shortest path

2. **Sector support**: Handle sector turnpoints (entry/exit sectors with specific angles)

3. **Start cylinder types**: Distinguish between SSS (Start of Speed Section) types:
   - Exit start: Pilot starts inside, optimization begins at cylinder edge
   - Enter start: Pilot starts outside, must enter cylinder

4. **FAI triangle detection**: Detect and optimize FAI triangle tasks with their specific constraints

5. **Ellipsoid geometry**: Use Vincenty's formulae for higher precision on very long tasks

## Testing

### Unit Tests
The implementation should be tested with:

1. **Two turnpoints**: Verify simple bearing-based approach
2. **Three turnpoints (collinear)**: Should produce straight-line path
3. **Three turnpoints (triangle)**: Verify optimization finds reasonable points
4. **Equal radius cylinders**: Test perpendicular tangent cases
5. **Different radius cylinders**: Test geometric offset calculations
6. **Edge cases**:
   - Single turnpoint
   - Zero-radius turnpoints (treat as points)
   - Overlapping cylinders

### Integration Tests
1. Load real XContest tasks and verify:
   - Optimized distance < center-to-center distance
   - Path is continuous (no gaps)
   - Labels render correctly

2. Compare with XContest published distances (should match within 1-2%)

## References

- **FAI Sporting Code Section 7A**: Paragliding competition rules
- **GAP (GAP Annex to Section 7A)**: Scoring algorithm specifications
- **XContest Rules**: https://www.xcontest.org/world/en/rules/
- **LK8000 Task Optimization**: https://github.com/LK8000/LK8000/pull/286
- **Touring n Circles**: https://www.matec-conferences.org/articles/matecconf/pdf/2018/91/matecconf_eitce2018_03027.pdf
- **Golden Section Search**: https://en.wikipedia.org/wiki/Golden-section_search
- **Haversine Formula**: https://en.wikipedia.org/wiki/Haversine_formula

## Change Log

### 2026-01-20: Simplified to MapBox Only
- Removed Google Maps and MapLibre providers
- MapBox GL JS is now the only supported map provider

### 2026-01-11: Initial Implementation
- Implemented optimized task line calculation using golden section search
- Added distance labels to task line segments
- Integrated with map providers
- Updated flight info display to show optimized distance
