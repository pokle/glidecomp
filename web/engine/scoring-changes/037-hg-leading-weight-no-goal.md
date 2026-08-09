# HG leading weight on a no-goal day

HG leading weight follows the S7F §10 HG box on a no-goal day (the
adjacent deviation found while fixing #583). The spec gives hang
gliding ONE formula, (1 − DistanceWeight) ÷ 8 × 1.4, with no GoalRatio
case; the "0.1 × BestDist ÷ TaskDist when nobody makes goal" rule is
the PARAGLIDING GAP2016/2018 legacy weight (stored as 'gap2020', kept
for AirScore parity). The branch testing it never tested the sport, so
it caught HG too — handing a no-goal HG day a leading weight that
scaled with how far the field flew, up to 0.1, where the spec offers
0.0175. It also made the weight JUMP discontinuously the moment the
first pilot reached goal.
This MOVES POINTS, unlike v35. Over the 211-comp archive: 184 GAP
tasks scored with their own stored formula, 9 affected (all HG, no
goal, leading enabled), 70 pilot totals changed, largest 82.4 points
— a Dalby Big Air 2022 sports-class leader whose available leading
points fall from 99.9 to 17.5. Every affected task also had nobody at
ESS, so under v35 those points are not redistributed: the day now caps
at the spec's 900 + 18 = 918. The 41 HG tasks with leading on and
pilots in goal, and all 30 PG tasks, are unchanged.
