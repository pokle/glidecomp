# S7F 2026 phase 5 — geodesic distances

FAI S7F 2026 edition, phase 5 — geodesic distances (§7.1.4, §7.1.5).
The engine's one inverse-distance function is now the Vincenty
(1975) inverse — one of §7.1.4's three sanctioned InverseGeodesic
algorithms — replacing Andoyer-Lambert, which §7.1.5 relegates to
navigation devices ("scoring software shall calculate this distance
by using the InverseGeodesic algorithm"). andoyerDistance is gone;
ellipsoidDistance (the spec's own name) is the export, with Andoyer
retained only as the non-convergence fallback that task-scale
geometry cannot reach. Every distance in the engine moves by up to
~2 ppm (centimetres at task scale); snapshot values corrected to the
published Vincenty references (e.g. the 1° meridian arc is now
110 574.39 m, exact). Best-progress eligibility also changed from
strictly-after to at-or-after the last reaching time: a crossing
that interpolates exactly onto a fix (a fix landing precisely on a
cylinder's nominal radius — now possible, since Vincenty inverse
round-trips Vincenty direct exactly) no longer costs that fix its
measurement.
The §7.1.3 PathFinder route optimisation (LTM projection + Ding et
al. 2018) is NOT yet adopted: the existing corpus-verified optimiser
stands in, as a documented deviation on /scoring/gap.
