# A start counts whichever way the pilot crosses the start cylinder

**Points move, on three archive tasks, by up to 878 points for a pilot who had
no valid start before.** Over the 211-comp
[archive](https://github.com/pokle/glidecomp-archive) (184 GAP tasks), 125
pilot totals moved, on bright-open-2020 Task 4, bright-open-2021 Task 2 and
forbes-flatlands-2024 sports Task 3. All three declare an ENTER start that the
field flew as an exit. The 13 bundled tasks are unchanged.

- bright-open-2021 Task 2 now has 27 pilots at ESS. AirScore published 27;
  GlideComp had 26.
- forbes-flatlands-2024 sports Task 3: four pilots scored 0 with no start.
  Their mean distance from the published score falls from 522 to 118 points.
- bright-open-2020 Task 4 was stopped at 15:30 and the audit scores it
  unstopped, so its totals cannot be compared with the published ones. The
  task's own AirScore record marks the start as an exit, while the archived
  task file says ENTER.

## What changed

S7F 2026 §6.2.1: "The direction in which such a crossing occurs is irrelevant
… Task setters may still choose to indicate whether the start or subsequent
turnpoint cylinders are 'enter' or 'exit' … But pilots are not bound to those
indications." The engine still discarded every start crossing that went the
other way to the task's declared `sss.direction`. The same track over an
entered air start scored goal at 29.60 km when the task said ENTER, and landed
out at 12.80 km with no time when it said EXIT.

Every crossing of the start cylinder is now a start candidate. The start is
still the last crossing before continuing through the task (§6.3), and the
gate rules are unchanged. The declared direction only picks which edge of the
5 m tolerance band a start is detected at.

One consequence needed a guard. On an out-and-return task whose goal lies
inside the start cylinder, a pilot flying home crosses back INTO the start
after every gate. That crossing leads nowhere, so it is not where the pilot
"continued to fly through the remainder of the task". It must not displace a
pre-gate start the pilot actually raced from. When no post-gate crossing
reaches a turnpoint and a pre-gate one does, the pre-gate crossing is the
start, scored as an early start (§13.3) — what it was before this change.
Without the guard, four HG pilots in the archive lost about 850 points each.

A v2 task file (`XCTSK:` QR) with no `d` used to read as an EXIT start; it now
reads as ENTER, as a v1 file with no `direction` always has. XCTrack codes
`d` as 1 = ENTER, 2 = EXIT.

Engine code review 2026-10-20, finding 1.3.
