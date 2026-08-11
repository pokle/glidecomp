# The task's declared cylinder tolerance is honoured

The task's declared cylinder tolerance is honoured (issue #577).
parseXCTask now reads the xctsk file's `cylinderTolerance` field —
the XCTask type, the API validator, the AirScore importer (which
writes the comp's error_margin into it) and the route editor all
already carried it, but the parser dropped it, so every task scored
with the 0.5% engine default (§8.1 Cat 2 maximum) instead of the
band the comp declared (0.05% on most imported comps — 10× tighter).
Scores move only where a crossing decision fell between the two
bands. The found case is bright-open-2025-open-t3: the takeoff sits
INSIDE the 33.5 km ENTER start ring, pilots exit past the boundary
by ~100 m and re-enter to start, and the default band (167.5 m at
that radius) never saw them outside — no enter crossing, no start,
the whole field scored landed out at ~14 km instead of the published
101.66 km. With the declared 0.05% band the field resolves to goal.
