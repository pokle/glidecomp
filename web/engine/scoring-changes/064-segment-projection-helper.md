# A segment-projection helper in geo.ts (no points move)

`geo.ts` gains `projectOntoSegment()`, which says how far along a leg a point
falls and how far off the line it is. The task analysis uses it to name where
each of the day's thermals was ("Between B03 and B04").

Nothing that scores a flight calls it. **No points move** for any pilot in any
competition. The engine generation still rolls, because `geo.ts` is in the
scoring import closure, so every competition recomputes once and publishes
the same numbers.
