# Engine code quality review (2026-08-06)

NO behaviour change — the 2026-08-06 engine code quality review. The
scorer's three derived predicates (distance difficulty, the effective
ESS-not-goal factor, the best-time source) are exported and called by
the explainers instead of being re-typed by hand in each of them; the
WGS84 metres-per-degree series and the radians→compass conversion each
collapse to one definition in geo.ts; resolveSequenceOnce becomes the
named pipeline its FAI-citing comments already described; and the eight
inline S7F §11 roundings in the scorer call the helper that file
defined. Every arithmetic expression was carried across unchanged, and
the two coarse metres-per-degree approximations (the circle fit, the
crossings bounding-box pre-filter) were deliberately KEPT rather than
made accurate — the bbox one is load-bearing, since a denominator that
is too LARGE would shrink the box and could discard a fix the exact
distance check accepts.
scoreFlights' seven numbered step comments likewise became five named
steps, and the 2,128-line score-explanation-sections.ts became eleven
per-concern modules behind the same entry module.
FlightScoringData's four correlated optionals (leadingAggregate, fixes,
sequence, trackless) are now one required discriminated union,
FlightLeadingInput — 'aggregate' | 'track' | 'none'. The runtime throw
that described the invariant in prose is gone, because the invariant is
now in the type. The stored per-track payload is UNCHANGED: it was
always the backend's own flat CachedFlightAnalysis rather than
FlightScoringData, and the worker converts at the boundary in both
directions, so no revive step was needed and no D1 row changes shape.
The fingerprint also moves because the guard's own root list grew:
manual-flight.ts measures a track-less pilot's distance and the backend
calls it directly, so it reached published scores while sitting outside
every root's import closure. The cache roll is harmless — scores
recompute identically, verified byte-for-byte over 376,405 scored
fields spanning every bundled task across 14 parameter variants.
