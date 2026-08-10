# Official per-category default GAP parameters

Official per-category default GAP parameters (issue #343). A comp that
hasn't saved its scoring settings is now scored from defaultsFor(category)
— the current FAI S7F formula: leading (departure) points on for both PG
and HG, arrival on for HG, distance difficulty on for HG, nominal goal
30% — instead of the raw HG-shaped engine baseline (leading/arrival off,
nominal goal 20%). A PG comp with no saved params is now scored as PG
rather than HG. Comps with saved gap_params are unaffected (the stored
values still win); the version bump invalidates cached scores for the
null-params comps whose effective formula changed.
