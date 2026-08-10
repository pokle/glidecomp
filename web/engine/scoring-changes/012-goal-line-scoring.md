# Goal LINE scoring

Goal LINE scoring (S7F §6.3.1) — a task whose goal is configured as
`goal.type: 'LINE'` is now scored against a goal line perpendicular to
the final leg (length = 2 × the goal turnpoint's radius) with its
control semicircle behind it, instead of being treated as a cylinder.
Goal is achieved by a track segment crossing the line or a fix inside
the semicircle; the optimised route ends at the closest point on the
line; land-out remaining distance is measured to the nearest point on
the line. Goal crossings credited by a semicircle fix (no line
crossing in the tracklog) are flagged goalSemicircleCredited so the
score explanation can say why. Cylinder goals and tasks where no line
can be constructed (single turnpoint, zero radius) are unchanged.
