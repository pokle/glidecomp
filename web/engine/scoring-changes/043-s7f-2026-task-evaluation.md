# S7F 2026 phase 4 — task evaluation

FAI S7F 2026 edition, phase 4 — task evaluation (§9.1, §6.2.3.1).

(a) Tolerances are the fixed 2026 values: 0% relative + 5 m absolute
for cylinders (§9.1.1, decided at the 2025 Plenary), a flat 5 m
for lines and the goal-line band (§9.1.2, §9.1.3). A task file's
declared `cylinderTolerance` is now IGNORED by scoring (owner
decision, 2026-08-09 — supersedes issue #580's behaviour); the
field still parses and round-trips, and the route editor no
longer edits it. Tasks that scored under the old 0.5% default
(or a declared value) get narrower bands, so tolerance-credited
reachings at band edges can change.

(b) Goal line orientation (§6.2.3.1, changed by the 2025 edition):
the line is perpendicular to the OPTIMISED route's previous
point p on the last control zone before goal — computed from a
route with the goal treated as its centre — instead of the
previous turnpoint centre. Angled final legs rotate the line by
the difference between the centre-to-centre bearing and the
optimised approach.
