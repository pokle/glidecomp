# Leading points end where the scored flight ends

**Points move, for pilots still airborne at a goal deadline or at a stopped
task's stop.** Over the 211-comp
[archive](https://github.com/pokle/glidecomp-archive) (184 GAP tasks, scored
without stops by `web/scripts/audit-scoring-change.ts`), the deadline half of
this change moved one pilot by 0.7 points (bright-open-2026, Task 4). The 13
bundled tasks are unchanged. The stopped-task half cannot be measured there,
because the audit scores no stops; its size is set out below.

## What changed

The leading coefficient is built from a scan of the pilot's tracklog. That
scan ran to the pilot's ESS time, or to the end of the file, and ignored the
two times that end a scored flight:

- **The stop** (§13.4.5): "no pilot gets points from any part of the flight
  after the task stop time". Distance and turnpoints were already clipped at
  the scored-window end; the leading scan was not.
- **The goal deadline** (§12.3.1 caps `taskTime` at the deadline). Again,
  distance was clipped and leading was not.

In the review's reproduction, two pilots fly identical tracks up to the stop
and only B keeps flying. Their leading coefficients should be identical, and
were not:

| | A (LC, leading pts) | B (LC, leading pts) |
|---|---|---|
| PG | 0.26927, 16.3 | 0.25027, 18.4 |
| HG | 0.58676, 3.2 | 0.63746, 2.7 |

The scan now stops at the end of the scored flight: the earlier of the
deadline and, on a stopped task, the pilot's scored-window end. The same clip
feeds the competition server's cached per-track leading aggregate. Where the
field's leading graph ends (§12.3.1 `maxTime`) is unchanged — it was already
capped at the deadline and the stop.

Engine code review 2026-10-20, finding 1.1.
