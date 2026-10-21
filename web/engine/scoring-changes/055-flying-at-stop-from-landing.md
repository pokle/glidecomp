# Stopped tasks: "flying at the stop" is read from the landing, not the end of the file

**Points move, on stopped tasks only, and only for a pilot whose logger kept
recording on the ground after they landed before the stop.** The bundled
competitions and the 211-comp archive cannot measure it: the archive audit
scores without stops, and the bundled tracks are trimmed at landing.

## What changed

On a stopped task, a pilot still flying at the stop earns the §13.4.6 altitude
bonus, and a pilot who had landed is counted in the landed-before-stop figure
that stopped-task validity uses (§13.4.3). The engine used to decide "still
flying" from where the tracklog ENDS: a file that reached the scored-window
end counted as airborne at it.

A logger left running in the landing field reaches the window end too. The
code assumed that could only earn a bonus near zero, but the bonus is height
above **goal**, not above the landing field. In the review's reproduction, an
HG pilot who landed at minute 20 in a field 300 m above goal, with the stop at
minute 30:

| | Flying at stop | Bonus | Scored distance |
|---|---|---|---|
| Logger off at landing | no | 0 m | 16.01 km |
| Logger left on | **yes** | **1 500 m** | **17.51 km** |

and the pilot dropped out of the landed-before-stop count (2/2 → 1/2).

The engine now detects the landing from the track itself, with the same
landing detector the flight analysis uses. A pilot is flying at the stop when
the track reaches the window end AND the last sustained flight indication is
at or after it. A track that is still airborne at its last fixes (the logger
was switched off in the air, or the file ends at the window) is judged by
where it ends, as before.

One limit remains: the detector reads ground speed, so a track that is being
driven at the window end, on a retrieve, still looks airborne. Finding 4.1 of
the same review covers the detector's landing cut.

Engine code review 2026-10-20, finding 1.2.
