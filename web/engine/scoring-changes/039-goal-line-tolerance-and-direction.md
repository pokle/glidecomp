# Goal-line tolerance and crossing direction

Goal-line tolerance and crossing direction (issue #359, S7F §8.2,
§8.5.2). Two changes at a LINE goal, both at the margins of the line:

(a) §8.2 line tolerance — the goal line now carries the same
percentage band a cylinder gets (§8.1), with the same 5 m floor,
taken over the line's length. At a goal line what the band buys is
LENGTH: a crossing that lands up to the tolerance past an endpoint is
credited, flagged toleranceCredited so the report card says so. The
band never moves a crossing's time or position — a pilot who clipped
the end is credited where their track met the line's plane. §8.4's
other half (a fix closer to the line than the tolerance reaches it
without crossing) is deliberately NOT applied at goal: §8.5.2 requires
the goal line be crossed in flight, and that clause is the only part
of the band that could shift an ordinary goal TIME. The control
semicircle behind the line gets the §8.1 cylinder band too, which
§8.5.2 mandates in as many words ("the same tolerance calculations
apply as for full cylinders") — so its radius grows by max(0.5%, 5 m).

(b) §8.5.2 direction — a track segment crossing the goal line the
WRONG way (both fixes outside the control zone, the pilot leaving
across the line) no longer records a crossing. It used to emit an
instantaneous enter+exit pair, and the goal task position accepts the
first crossing of either direction, so flying out across the line
could credit goal to a pilot heading away from it.
Only tasks with a LINE goal can move, and only pilots within a few
metres of an endpoint or crossing the line backwards; every bundled
comp scores identically.
