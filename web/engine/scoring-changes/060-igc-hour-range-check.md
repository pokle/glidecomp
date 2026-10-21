# One corrupt hour digit no longer moves the rest of a flight a day

**Points move only for a track with a corrupt B-record time.** Every one
of the 5,593 IGC files in the repository and the
[archive](https://github.com/pokle/glidecomp-archive) parses to identical fix
and event times before and after this change, including the one real flight
that crosses midnight (Bright Open 2025 task 3), which still rolls once. No
published score moves.

## What changed

A B record carries the time of day, HHMMSS, and no date, so the parser
decides when a flight crossed midnight UTC (late morning in eastern Australia),
so a crossing must be read reliably. Two weaknesses let one bad character move every fix after it by 24 hours:

- **"Validated" meant six digits.** An hour of 25, or 99, passed, and was
  read as a time the next day.
- **A crossing was "an evening hour, then a morning hour"** — at least 18:00
  followed by at most 06:00. One digit changed in a real morning fix
  (`B0518…` read as `B2318…`) armed that test, and the next honest 05:18 fix
  "crossed midnight".

The review's reproduction changed one character in the Corryong 2026 task 1
winner's real track. The pilot went from **984 points, rank 1, to 485
points, rank 12**: their speed-section time read 92 275 s instead of 5 875 s.
Track quality raised no finding, because the timestamps stayed in order.
Note 050 said a corrupt hour could not do this; its regression test used a
line that was rejected for another reason.

Now:

- **The time is range-checked**: hours 00–23, minutes and seconds 00–59, in
  B and E records alike. Anything else is a malformed record and is dropped
  without touching the day.
- **A crossing is a small step back in the time of day**: a record whose time
  is earlier than the one before it, by less than one hour once taken modulo
  24 hours. 23:58 → 00:01 is a three-minute step. 23:18 → 05:18 is not, so a
  corrupt but legal hour is one forward spike, which the ordering rule of
  note 050 already pops.
- **The record before the crossing must have arrived by a forward step.** A
  pre-midnight spike inside a post-midnight run (00:11, 23:50, 00:12) arrived
  by a 21-minute rewind, so the step back out of it is its own correction, not
  a crossing.

At most one crossing per file still applies (note 050).

Engine code review 2026-10-20, finding 3.1.
