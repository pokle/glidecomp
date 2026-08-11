# S7F 2026 §7.1: PathFinder route optimisation adopted

**Date:** 2026-08-10 · **Issue:** [#599](https://github.com/pokle/glidecomp/issues/599)

The 2026 edition of FAI Sporting Code Section 7F makes its route-optimisation
algorithm normative (§7.1). GlideComp's own corpus-verified optimiser — a
per-cylinder golden-section search evaluated directly on the ellipsoid — is
replaced by the specification's algorithm set:

- the §7.1.2 localised Transverse Mercator projection with the
  latitude-dependent scaling (Annex A's alternative implementation);
- the §7.1.3 **PathFinder** shortest-path algorithm (Ding, Xie & Jiang 2018),
  ε = 0.1 m, extended to line control zones per Annex B;
- §7.1.6 FindTaskAreaCentre, computed once per task and reused for every
  route of that task — including the §9.3 per-fix remaining routes;
- §7.1.7 ProjectionCorrection, snapping each path point back onto its
  control zone's true WGS84 boundary;
- the composed §7.1.8 RouteOptimizer, measuring the corrected path with the
  §7.1.5 EllipsoidDistance.

The FAI placement rules are unchanged: the launch measured from its centre,
the mid-route ESS pinned to the incoming leg, the goal's nearest-boundary
(or goal-line) tag. Two visible behaviour changes ride along:

1. **A crossed cylinder tags the leg's first intersection** (§7.1.3's
   crossing case) instead of the boundary point nearest the chord. The tag
   moves along the crossing chord — up to a radius — at identical total
   distance.
2. **`goalLinePointAt` walks the geodesic azimuth** (§7.1.4 InverseGeodesic)
   instead of a spherical bearing. The drawn goal line previously sagged
   metres off the goal centre at its middle (2.8 m on a 4 km line at 47°
   latitude); distances measured TO the goal line move by the same scale.

## Do points move?

Yes, by metre-scale distances only. Measured with
`web/scripts/audit-scoring-change.ts` over the glidecomp-archive
back-catalogue (184 scored tasks):

- **No task's validities, weights or available points changed.**
- 304 pilot totals across 48 tasks moved by more than 0.05 points; the
  largest single-pilot change is **3.1 points** (bright-open-2024 open
  Task 1). The movement comes from landed-out pilots' flown distances —
  the remaining-route measurement lands on marginally different route
  points — and from task distances shifting by metres.
- The archive parity suite (`distance-corpus.test.ts`) still holds: every
  modern-generation task distance matches the AirScore-published `task_dist`
  within the existing tolerances, with the same three understood exceptions.

The engine generation rolls (it is derived from these sources), so every
competition recomputes on next read.
