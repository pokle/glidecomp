# Engine test fixtures

Real files kept verbatim (apart from trimming) because a hand-typed
approximation cannot prove the parser and the checks agree on real bytes.

## `mckirdy-wrong-day-nz.igc`

The track that prompted `track-quality.ts`. Submitted to **Corryong Cup 2025,
task 4** (flown 11 Jan 2025 at ELLIOT, Victoria, Australia), it is actually a
**New Zealand** flight from **21 Jan 2025** — `HFDTE210125`, first fix
41°43′S 172°30′E in the Nelson Lakes, 2,186 km from the nearest task
turnpoint. AirScore scored it 0 km / 0 points; GlideComp awarded it the S7F
§5.3 minimum distance and let its hour buckets stretch the field-analysis
day-profile axis from 5 hours to 262.

Trimmed to the headers plus the first and last 100 B-records (11,158 in the
original) — every property the checks read survives: the date header, the
fix instants, the coordinates, and the all-zero pressure channel that makes
this a GNSS-only track. The source lives in
[pokle/glidecomp-archive](https://github.com/pokle/glidecomp-archive) at
`comps/corryong-cup-2025-open-t4/`.
