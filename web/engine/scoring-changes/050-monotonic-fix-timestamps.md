# Monotonic fix timestamps at parse time

**No points move.** Verified directly: `parseIGC` was run over all 5,592 real
tracks available (the 5,112-track [archive](https://github.com/pokle/glidecomp-archive),
the 478 bundled sample tracks, and the demo track) before and after this
change, and the parsed output — every fix time, position, altitude channel and
cleaned altitude, every event, the declared task and the altitude-cleaning
report — is byte-identical on every file. The AirScore parity report over the
bundled comps is unchanged line for line. The engine generation still rolls, so
every competition recomputes; the recompute is harmless.

## What changed

`parseIGC` now guarantees that the `fixes` it returns are **non-decreasing in
time**. Every time-window loop in the engine — altitude cleaning, track
quality, event detection, every dt-based rate — already assumed this, and
nothing could establish it: a B record carries HHMMSS and no date, and the
day-offset heuristic only ever counted up, so a file stamped `12:00:00,
11:00:00, 12:00:00` parsed to a fix list that ran backwards. Those loops were
made *bounded* on such input by the #470/#471 hardening (note 030), but their
output was arbitrary rather than principled. Closes #530.

Three decisions, all at parse time:

- **Duplicate timestamps are kept.** The B record's resolution is one second,
  so a logger sampling above 1 Hz legitimately writes several fixes per
  second — 24 of the 5,590 corpus tracks do. Dropping them would discard real
  position data.
- **Strictly backwards fixes are dropped, not clamped or coalesced.** Clamping
  invents a timestamp the logger never wrote and turns one corrupt jump into a
  dense run of zero-dt fixes; dropping leaves every retained fix exactly as
  logged. An isolated *forward* spike is popped instead of being kept, so a
  single fix stamped hours ahead costs one fix rather than truncating the whole
  rest of the flight. A sustained rewind is not a spike: there the first
  ordering wins and the rewound run goes. What was discarded is counted in the
  new `IGCFile.timeOrder` report.
- **At most one midnight crossing per file.** An IGC file is one flight and no
  flight lasts 24 hours, so a second ≥18h→≤6h transition is a corrupt clock,
  not a second crossing. Uncapped, an oscillating time field marched the day
  offset forward without bound: timestamps stayed monotone so nothing objected,
  while track quality saw a flight days away from its task. Exactly one file in
  the corpus crosses midnight at all (Bright Open 2025 task 3, a genuine
  23:58→04:47 UTC flight), and it crosses once.

## The rollover heuristic no longer reads discarded records

The day-offset heuristic took the hour straight off the raw line, *before* the
record was field-validated — so records that were then thrown away still
steered it. A corrupt line whose hour field read `99` armed `prevHours >= 18`,
and the next honest morning fix shifted every fix after it a day forward; a
line whose hour field was not numeric set `prevHours` to `NaN`, which compares
false against everything and disarmed a genuine crossing. Both are now
impossible: only a validated HHMMSS advances the state. E-record times are
digit-validated for the same reason, so a malformed event is dropped instead of
becoming an `Invalid Date` on its way through the shared rollover state.

No corpus file has a malformed B record, which is why none of this moves a
score today. It is a guarantee for corrupt and adversarial input.
