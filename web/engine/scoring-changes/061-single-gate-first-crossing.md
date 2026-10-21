# A single-gate race starts at the first crossing after the gate

**Points move, on single-gate races, by at most 0.5 points, through leading
points only.** Over the 211-comp
[archive](https://github.com/pokle/glidecomp-archive) (184 GAP tasks), 23
pilot totals moved on seven tasks: bright-open-2025 Task 1,
dalby-big-air-2026 Tasks 4 and 5 and floater Task 6, forbes-flatlands-2022
Task 6, forbes-flatlands-2023 Task 4 and forbes-flatlands-2025 Task 4. No
task's weights or available points moved. The 13 bundled tasks are
unchanged.

## What changed

S7F 2026 §9.2.4: "In Races with single start gate, a control zone's
validation time is always the first crossing time after the start gate time,
and after the previous control zone's validation time." Only multi-gate races
and Time Trials let a later crossing replace an earlier one.

The engine tried every start crossing for every task type and kept the best
flight: most turnpoints, then most distance, then the LATEST crossing. In a
single-gate race the first crossing after the gate always reaches at least as
many turnpoints as a later one, so where both reached the same turnpoints and
distance, the tie went to the later crossing. That honoured a re-start the
task type does not allow. The pilot's start time snaps to the gate either way
(§9.2.4.1), so time points never moved. But the reported start crossing did,
and so did the leading coefficient, which counts only the fixes from the start
crossing on (§12.3.1).

A single-gate race now takes the first start crossing after the gate. Because
a crossing counts in either direction (§6.2.1, note 056), a pilot who flies
through the start cylinder starts where they ENTERED it, not where they left
it on the far side.

The report card says so. When a pilot crossed the start cylinder more than
once, the start section explains that in a single-gate race the first
crossing after the gate is the start, and that a later crossing changes
nothing.

Multi-gate races, Time Trials and races without gates keep the best-flight
search. A pre-gate start is unchanged too: when no crossing after the gate
reaches a turnpoint, an earlier crossing the pilot raced from is still the
start, scored as an early start (§13.3).

Issue [#587](https://github.com/pokle/glidecomp/issues/587).
