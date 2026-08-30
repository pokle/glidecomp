# Engine test fixtures

Real files kept verbatim (apart from trimming) because a hand-typed
approximation cannot prove the parser and the checks agree on real bytes.

## `bright-open-2023-open-t1.xctsk`

The archive's worst launch→ESS divergence under a free-floating ESS: the
course bends hard at a 10 km ESS ring after a 16 km cylinder, so an
optimiser that lets the ESS tag drift toward goal reads the launch→ESS
distance 2.5 km long. Exercises the Annex A §3.2.4 ESS pin in
`spec-distances.test.ts`. From
[pokle/glidecomp-archive](https://github.com/pokle/glidecomp-archive) at
`comps/bright-open-2023-open-t1/` (AirScore reference numbers quoted in the
test come from that folder's `airscore-result-raw.json`).

## `bright-open-2025-open-t3.xctsk`

The task behind issue #577: a 33.5 km ENTER start ring concentric with the
800 m turnpoint after it, and the takeoff INSIDE the ring — pilots must fly
out past the boundary (~100 m excursions) and re-enter to start. The file
declares `cylinderTolerance: 0.0005`; before the parser read that field the
engine's 0.5% default band (167.5 m at this radius) swallowed every exit
and scored the whole field landed out at the start. Exercises the tolerance
parsing and the out-and-back route geometry (`spec-distances.test.ts`;
published cumulatives from the archive folder's `airscore-result-raw.json`).
Same archive provenance, `comps/bright-open-2025-open-t3/`.

## `corryong-cup-2022-open-t1.xctsk`

A task whose route begins directly at the start cylinder — no TAKEOFF row —
as AirScore-imported tasks often do. Exercises the Annex A §2.2 launch-
centre rule (`spec-distances.test.ts`): the published cumulative distances
(also quoted in the test) all measure from the start cylinder's CENTRE, so
an edge-measured route loses exactly the 5 km start radius. Same archive
provenance, `comps/corryong-cup-2022-open-t1/`.

## `mckirdy-wrong-day-nz.igc`

The track that prompted `track-quality.ts`. Submitted to **Corryong Cup 2025,
task 4** (flown 11 Jan 2025 at ELLIOT, Victoria, Australia), it is actually a
**New Zealand** flight from **21 Jan 2025** — `HFDTE210125`, first fix
41°43′S 172°30′E in the Nelson Lakes, 2,186 km from the nearest task
turnpoint. AirScore scored it 0 km / 0 points; GlideComp awarded it the S7F
§5.3 minimum distance and let its hour buckets stretch the task-analysis
day-profile axis from 5 hours to 262.

Trimmed to the headers plus the first and last 100 B-records (11,158 in the
original) — every property the checks read survives: the date header, the
fix instants, the coordinates, and the all-zero pressure channel that makes
this a GNSS-only track. The source lives in
[pokle/glidecomp-archive](https://github.com/pokle/glidecomp-archive) at
`comps/corryong-cup-2025-open-t4/`.
