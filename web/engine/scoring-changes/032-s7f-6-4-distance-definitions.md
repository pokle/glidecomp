# S7F §6.4 distance definitions

S7F §6.4 distance definitions (2024 edition), verified against the
211-comp archive. Four related changes to the optimiser and the
flown-distance measurement:

(a) Launch centre (Annex A §2.2) — every route is measured from the
first turnpoint's CENTRE "regardless of whether it has been given a
radius", not just when it is typed TAKEOFF. Tasks whose route begins
at the start cylinder (common in AirScore imports — ~60 archive
tasks) previously lost exactly the start radius: 5–10 km of task and
flown distance. The one deliberate exception is the trimmed task
behind distanceOrigin 'start' (scored distance there begins at the
start crossing), marked by the new XCTask.firstTurnpointAtBoundary.

(b) ESS pin (Annex A §3.2.4) — a mid-route ESS fix is "pinned to the
preceding points": the nearest boundary point toward the incoming
leg, never dragged toward goal. The task path now kinks at ESS, and
its launch→ESS prefix equals the §6.4.2 launchToESSPath by
construction, so the sliced speed-section length feeding the leading
coefficient and the §12.3.3 stopped validity is the spec's number
(2.5 km long on the worst archive task before).

(c) §8.6.1 flown distance — a landed-out pilot's remaining distance
is now a fresh shortest-path optimisation from each candidate fix
through the un-reached zones to goal (branch-and-bound over the
track, 5 m tolerance), replacing the frozen-tag approximation; the
measured route is carried on BestProgress.remainingRoute so the map
draws exactly what was scored. Manual flights measure the same way.
Against AirScore's published per-pilot distances (Corryong Cup 2026
T1) the mean error drops from 66 m to under 50 m with the worst
pilot inside 100 m (was 385 m).

(d) Deterministic tag on a crossed cylinder — when a leg passes
straight through a cylinder every chord point ties; the tag now sits
at the boundary point nearest the chord (the spec's construction,
matching AirScore's published cumulatives) instead of wherever the
numeric search landed. Also: nearest-boundary points are computed
from the centre's bearing (the reversed-bearing shortcut drifted by
meridian convergence — tens of metres on long legs), a converged
pass is adopted rather than discarded, and the optimised task line
is cached per task object (content-keyed), which pays for the extra
§8.6.1 optimisations.
