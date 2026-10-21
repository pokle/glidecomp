# Hang-gliding Class 2 scores no arrival points

**No points move until an organiser marks a class as Class 2.** No stored
competition carries the new setting, so every result in the
[archive](https://github.com/pokle/glidecomp-archive) and the bundled comps is
scored exactly as before. A class that IS marked moves its arrival points into
time points, which shifts that field's totals: the first pilot to ESS keeps
about the same total, and every later ESS pilot closes on them.

## What changed

S7F 2026 §11 (a rule since the 2023 edition):

> HG Class ≠ 2 : ArrivalWeight = (1 − DistanceWeight) × 12.5%
> HG Class = 2 : ArrivalWeight = 0

with TimeWeight = 1 − DistanceWeight − LeadingWeight − ArrivalWeight, so the
time weight takes the arrival share. FAI Class 2 is rigid wings with movable
aerodynamic surfaces. The engine modelled only the HG/PG split, so a Class 2
field scored as hang gliding with arrival on got arrival points the
specification says it must not. The only workaround was to switch arrival off
for the whole competition, which also took it from every Class 1 and Class 5
field scored beside it.

GlideComp's pilot classes are the organiser's own results subdivisions
("Open", "Sport", "Rigid"…), so only the organiser knows which of them flies
Class 2. The competition's scoring settings now carry that list
(`gap_params.hgClass2Classes`). The scorer reads it per class: a listed class
is scored with `GAPParameters.hgClass2`, which sets ArrivalWeight to 0, and
publishes the flag in that class's `gap_params` so the report card can say why
the class has no arrival points. Every other class is scored as before, with no
new key in its payload.

The "nobody reached ESS" rule (§11) is unchanged: it already gives every HG
class zero time and arrival points.

Issue [#601](https://github.com/pokle/glidecomp/issues/601), a follow-up of the
single-edition strategy record [#602](https://github.com/pokle/glidecomp/issues/602).
