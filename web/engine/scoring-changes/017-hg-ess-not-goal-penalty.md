# HG "ESS but not goal" penalty

HG "ESS but not goal" penalty (S7F §12.1, issue #256). A hang-glider
pilot who reaches ESS but lands before goal now keeps only the new
per-comp essNotGoalFactor share of their time AND arrival points
(default 0.8, the spec's recommended value; configurable by local
regulations). Previously such a pilot kept 100% of both. PG is
unchanged (the spec fixes its factor at 0 — no goal, no time points —
which the engine already enforced). The factor also selects the best
time source, matching AirScore's pilot_speed: factor > 0 → fastest
ESS pilot (the previous HG behaviour); factor 0 (and always PG) →
fastest pilot in goal per §11.2.1.
