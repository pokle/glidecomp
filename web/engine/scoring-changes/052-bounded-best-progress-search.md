# A work budget on the best-progress search

**No points move.** Checked directly: every track the comp loader reads from
the bundled comps and the 211-comp
[archive](https://github.com/pokle/glidecomp-archive) (5,220 tracks, 2,695 of
them landed out) was resolved before and after this change. Each one's best
progress (the fix it names, and the distance to goal from there) is
byte-identical. The budget engaged on none of them. Scoring every GAP task
the same way (`web/scripts/audit-scoring-change.ts`, 13 bundled and 184
archive tasks) gives byte-identical output too. The engine generation
still rolls, so every competition recomputes; the recompute is harmless.

## What changed

A pilot who lands out is credited to their best progress. S7F §9.3 defines it
as the point from which "the shortest distance to goal" is least, measured as a
fresh route optimisation from every remaining track point (note 047). The
engine does not optimise from every fix: it searches, skipping any fix that
provably cannot beat the best found by more than 5 m.

One of those proofs only works for a fix that lies close to one already
measured. A track that keeps finding new points at about the same distance
from goal, such as a long walk along a contour round a big cylinder, defeats
it. Each such fix then cost a route optimisation and a comparison with every
fix measured before it. For 60,000 fixes (the most the 2 MiB upload limit
allows), that took 147 seconds. The search runs on the server after every
upload, including anonymous ones, so one such file could keep a task's scores
from updating. This was security finding SEC-45.

Two changes fix it:

- **The comparisons got cheaper, with no change in outcome.** Before the exact
  Vincenty distance between two fixes is computed, their straight-line
  distance through the earth is checked. That is never longer than the surface
  distance, so when it alone shows the fix is out of reach, Vincenty could not
  have said otherwise. Every comparison reaches the same decision as before.
- **The search now has a budget.** Route optimisations cost more the longer
  the route still to fly, so each is weighted by the square of the number of
  turnpoints remaining. The budget allows 100,000 such units and 20 million
  comparisons. The most any real flight used was about 6,000 units (239
  optimisations with 5 turnpoints to go) and 693,390 comparisons. The 60,000-fix
  contour track now takes under a second.

## When the budget runs out

The search stops and keeps the best point it has found. That point's distance
is still exact, really measured from a real fix, so a pilot is never credited
with more than they flew. Because the search works through the most promising
fixes first, it can also say how much it might have missed: no fix it never
checked can be closer to goal than a stated bound. The result records both
(`BestProgress.searchCapped`), and the pilot's report card says so in the
landed-out explanation.

Only a track with an extraordinary number of points about equally far from
goal can reach this, and no track in the archive does.
