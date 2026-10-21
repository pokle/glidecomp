# A mid-route ESS is no longer pinned (S7F 2026 §7.2)

**Points move, by a few points, on tasks whose ESS is before goal.** Over the
211-comp [archive](https://github.com/pokle/glidecomp-archive), about a dozen
such tasks moved, almost all by under 2 points per pilot. The largest single
change is 8.3 points (bright-open-2023, Task 1), from a landed-out pilot's
distance. Of the bundled tasks, kosci-loop Ridge Run moved by up to 3.0 points
and unungra-cup-2020 Task 1 by up to 1.9.

Task distances fall by the pin's excess:

| Task | Before | After |
|---|---|---|
| unungra-cup-2020-open-t1 | 67.356 km | 66.729 km |
| kosci-loop-t3 | 17.431 km | 17.281 km |

dalby-big-air-2026-floater-t2 now matches the 45.33 km AirScore published. It
had been a documented exception (+403 m) in the archive parity test.

## What changed

The 2024 edition pinned a mid-route ESS: its route point was the boundary
point nearest the incoming leg, ignoring the route beyond (Annex A §3.2.4).
The 2026 edition has no such rule. It treats the ESS as an ordinary element
of the task route, and measures the speed section on a route of its own:
launch to ESS, ending at the ESS cylinder (§7.2 `launchToESSPath`). The engine
still pinned the ESS, and cited §7.2 for it.

The pin is gone, from the task distance and from every pilot's remaining
route. The speed-section length (leading points) and the launch→ESS distance
(stopped-task validity) are now read from the launch→ESS route, not from the
task line. Without the pin, those two differ wherever the ESS is not the goal.

The pin also broke the best-progress search's 5 m guarantee: its skip proof
assumes the remaining distance changes by at most 1 m per metre moved, and a
pinned tag swinging round the ESS ring can change it by about 2 m per metre.
On 37 of 292 real tracks the search stopped more than 5 m short; the worst
under-credited a pilot by 39.8 m. Without the pin the worst is 4.0 m.

Removing it exposed a deadlock the pin had hidden: two identical consecutive
cylinders (an ESS on the goal cylinder) lock the route optimiser onto its
tie-break point. Identical consecutive cylinders are now one control zone
that shares one tag. corryong-cup-2026-floater-t2 with its ESS untyped
measured 20.237 km for that reason; it now measures 19.473 km either way.

Engine code review 2026-10-20, findings 1.4 and 1.11 (the identical-cylinder
part).
