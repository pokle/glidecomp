# Elevated Goal and control-zone altitude limits

**No points move in the archive or the bundled comps.** Over the 184 archive
tasks and the 13 bundled tasks, nothing moved: none of them sets either
feature. Points move only on a task that declares one. A production task
whose `.xctsk` already carries XCTrack's `goal.finishAltitude` IS an elevated
goal from now on (see below), so its goal pilots who crossed under the height
lose up to 20% of their time points, and its speed section now ends at goal.

## What changed

These are the two genuinely new control-zone features of the S7F 2026 edition.

### Elevated Goal (§6.2.3.2, §9.2.3.2, §13.1)

A goal line or cylinder set `elevation` metres above the published goal
waypoint altitude: 300 m by default, at most 1000 m.

- It "implicitly also serves as the End of Speed Section", so
  `getEffectiveESSIndex` returns goal for an elevated task, whatever ESS the
  route marks.
- Every crossing validates goal, whatever its altitude (§9.2.3.2).
- A goal pilot whose crossing is below the elevation keeps GoalAltitudeFactor
  of their time points: 0.8 at or below the goal waypoint altitude, 1 at or
  above the elevation, and between them 0.8 + 0.6·AR − 0.6·AR² + 0.2·AR³ with
  AR = (crossing altitude − goal altitude) ÷ elevation. Distance, leading and
  arrival points are unchanged.

The task declares it with XCTrack's own field, `goal.finishAltitude`, which
XCTrack documents as the elevated-goal altitude in metres above the goal
turnpoint — exactly §13.1's *elevation*. GlideComp already parsed and kept that
field; it now scores it. A task is elevated only when the value is positive
AND the goal waypoint has an altitude to measure from; a value over 1000 m is
scored as 1000 m. A track-less (manual) goal flight has no crossing altitude,
so its time points stand in full.

The report card's time section names the crossing altitude, the goal
altitude and the elevation, and prints AR and the factor; the equation folds
the factor in so it reconciles with the published points.

### Altitude limits (§6.2.1, §6.2.2, §9.2.1, §9.2.2)

A turnpoint cylinder may carry an upper and/or a lower limit in metres AMSL
(an absent upper limit is ∞, an absent lower one 0). A crossing counts only
when its altitude lies within the limits ± the 5 m absolute tolerance. The
`.xctsk` format has no field for them, so GlideComp stores them on the
turnpoint as `altitudeLimits: { lower?, upper? }`. The goal never has limits
(§6.2.3).

An out-of-limits crossing is still detected — it moves the pilot across the
cylinder's boundary all the same — but it is flagged and never credits the
turnpoint, as a start or as a reaching. A turnpoint reached by being already
inside it at the previous reaching also needs that reaching's altitude to be
within the limits. The report card lists an out-of-limits start crossing as
such, and says when the sequence stopped at a turnpoint the pilot crossed
only outside its limits.

Issue [#600](https://github.com/pokle/glidecomp/issues/600), the last
follow-up of the single-edition strategy record
[#602](https://github.com/pokle/glidecomp/issues/602).
