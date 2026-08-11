# Exit turnpoints

Exit turnpoints (issue #347). A turnpoint whose cylinder the optimized
route reaches from inside (its boundary contains the previous tag
point — e.g. the big ring of a concentric out-and-return) is now an
EXIT cylinder: reached at the first OUTWARD boundary crossing at/after
the previous reaching (or credited 'already_outside' when the pilot
tagged the previous turnpoint beyond it), detected against the inner
tolerance edge (§8.1) like the EXIT start. Previously it was credited
'already_inside' at the previous reaching — on the concentric task
every starter was instantly credited the ring AND the enclosing ESS,
zeroing every speed section and scoring never-exited pilots near full
distance. Land-out distance now routes to an un-reached exit
cylinder's boundary from inside (radius − distance-to-centre), and to
the nearest edge of the ENTER turnpoint right after a reached inferred
exit cylinder (the optimizer's tag bearing is arbitrary on a
rotationally symmetric task); measurement after the declared-EXIT
start is unchanged (AirScore parity). The SSS keeps its declared
direction; the goal (a destination) is always ENTER. Manual flights
route with the same rules.
