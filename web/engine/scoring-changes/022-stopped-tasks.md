# Stopped tasks

Stopped tasks (issue #264, S7F §12.3). A task with a recorded stop
announcement time is now scored as stopped: the announcement is scored
back to the task stop time (§12.3.1 — PG minus the new scoreBackTime
comp parameter, default 300 s; HG minus one start-gate interval, or 15
minutes with a single gate); every pilot is scored only for the scored
time window (§12.3.4 — start→stop for single-gate races; the last
starter's duration for multi-gate/elapsed), with crossings after it
excluded; a pilot at/after ESS at the window end keeps their complete
flight (§12.3.5) and every goal pilot's time points are reduced by the
points of a hypothetical pilot reaching ESS exactly at the stop; pilots
still flying at the stop earn the §12.3.6 altitude bonus (GNSS height
above goal × 5.0 HG / 4.0 PG, folded into flown distance); a fourth
validity factor (§12.3.3) applies, and a stopped task that ran less
than min(1 h, nominalTime/2) after the start scores zero (§12.3.2).
Tasks without a stop announcement are scored exactly as before.
