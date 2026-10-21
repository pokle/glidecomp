# A time trial's start gate counts

**Points move, on time-trial tasks with a start gate, by up to 9.7 points.**
Over the 211-comp [archive](https://github.com/pokle/glidecomp-archive), eight
pilot totals moved on five HG time-trial tasks (dalby-big-air-2026 floater
Tasks 2–4, forbes-flatlands-2022 sports Tasks 3 and 6), mostly through
leading points. The 13 bundled tasks are unchanged.

## What changed

S7F 2026 §6.3.2: in a Time Trial "start is defined by a single 'start gate' …
Pilots are free to start any time after this start gate", and each pilot is
timed from their own start (§9.2.4.1). §12.3.1 starts the leading clock at
"the first start gate time (as defined for the task)". The engine read gates
for races only, so a time trial's gate did nothing:

- A pilot who left before the gate had a valid start, with full time and
  leading points. It is now a failed start, handled as in a race (§13.3): HG
  scores the complete flight with the jump-the-gun penalty, PG scores the
  launch→SSS distance.
- The leading clock began at the field's first crossing instead of at the
  gate. It now begins at the gate.

Each pilot's speed-section time still runs from their own crossing; the gate
never sets a time-trial pilot's start time, except for an early starter, whose
clock is anchored at the gate as an early racer's is. A lone `00:00:00Z` gate
is still read as "no gate", as for races.

Engine code review 2026-10-20, finding 1.5.
