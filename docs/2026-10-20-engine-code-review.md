# Engine code review — algorithms and data science — 2026-10-20

A full review of `web/engine` (32k lines), with a lighter pass over the seams
where the competition-api worker feeds the engine and stores its results.
Eight parallel review passes — GAP scoring against S7F 2026, geodesy and task
geometry, IGC ingestion and track quality, event detection, task-analysis
statistics, task-analysis metrics, the report card and weather, and the worker
integration. Every finding below was reproduced with a script or a workerd test
unless it is marked otherwise. Reference values came from independent
implementations: GeographicLib for geodesics, a global dynamic-programming
shortest path for routes, exact enumeration and permutation tests for the
statistics, and the S7F 2026 transcription in `docs/reference/` for formulas.

This is a point-in-time snapshot at `516d052`. Nothing in the code was changed.
Baseline: `bun test ./web/engine` — **1521 pass, 0 fail** across 81 files.

Legend:

- **[C]** confirmed — reproduced with a script, a test, or the bundled data.
- **[P]** plausible — from a code read; the reason it was not reproduced is given.
- **✔** — re-verified by hand during collation (re-ran the repro, or re-read
  the code and the spec clause).

Severity:

- **High** — a wrong score, a wrong public statement about a score, or a
  crash, on a realistic input.
- **Medium** — wrong in a realistic edge case, or a methodological weakness
  that biases what the analysis tells a pilot.
- **Low** — minor, or reachable only from corrupt input or a developer tool.

---

## Fix first

| # | Area | Finding | Sev |
|---|---|---|---|
| 1.1 | Scoring | Stopped task: leading points use flying done after the stop | High ✔ |
| 1.2 | Scoring | Stopped task: a landed pilot whose logger keeps recording is "flying at stop" and gets the altitude bonus | High ✔ |
| 1.3 | Scoring | Start crossings are filtered by the declared SSS direction, which §6.2.1 says does not bind pilots; v1/v2 parsers default it differently | High ✔ |
| 1.4 | Scoring | 2024 Annex A ESS pin still applied — task distance +150 to +627 m on bundled tasks | High ✔ |
| 1.5 | Scoring | Time-trial tasks ignore their start gate | High ✔ |
| 2.1 | Worker | Deleting or reclassing a DNF-only pilot never marks scores stale | High ✔ |
| 2.2 | Worker | A header-only IGC removes the pilot from the scores and supersedes their manual flight | High |
| 2.3 | Worker | A withheld upload leaves the manual flight active (pilot listed twice) and drops a DNF from launch validity | High |
| 2.4 | Worker | The scores ETag omits `gap_params` — clients get 304 on stale scores | High ✔ |
| 2.5 | Worker | Published task ranks never share ties | Medium ✔ |
| 3.1 | Ingestion | One corrupt hour digit moves the rest of the flight by 24 h: winner 984 → 485 points, no finding raised | High ✔ |
| 4.1 | Events | `detectFlight` never cuts at landing — the analysis page analyses the ground time and the retrieve drive | High ✔ |
| 5.1 | Statistics | The comp-level ρ is confounded by uneven participation and is not measured against the official rank | High ✔ |
| 6.1 | Metrics | `glide.dolphin_fraction` measures weak circling, not dolphin flying — its published sign is inverted | High ✔ |
| 6.2 | Metrics | `race.final_glide_init` uses straight-line distance to goal, ignoring unreached turnpoints (37–43 % of values) | High ✔ |
| 7.1 | Report card | Stopped tasks: the "points left" ledger and winner headline give a false reason | High |
| 7.2 | Report card | Pilots with no penalty are shown a "Penalties −0.1 pts" row — 215 of 658 bundled cards | High ✔ |

---

## 1. Scoring path — engine

### 1.1 [C] High ✔ — Stopped task: leading points use flying done after the stop

`gap-leading.ts:202-205`, fed by `gap-scoring.ts:181-183` (and the worker at
`scoring/task-score.ts:371-374`).

`computeLeadingAggregate` scans the raw fixes and stops only at the pilot's ESS
time. The stop / scored-window clip is applied to the turnpoint sequence, never
to the leading scan. S7F §13.4.5: no pilot gets points from any part of the
flight after the task stop time.

Two pilots with identical tracks up to the stop, where only B keeps flying:

| | A (LC, leading pts) | B (LC, leading pts) |
|---|---|---|
| PG | 0.26927, 16.3 | 0.25027, 18.4 |
| HG | 0.58676, 3.2 | 0.63746, 2.7 |

They should be identical. Every stopped task with a pilot still airborne at the
stop is affected. The goal deadline has the same gap: §12.3.1 caps `taskTime`
at the deadline, but the scan uses each fix's raw time.

**Fix:** pass the clip time (window end / deadline) into
`computeLeadingAggregate` and break there; add it to the worker's per-track
cache key.

### 1.2 [C] High ✔ — Stopped task: "flying at stop" means "the tracklog reaches the window end"

`turnpoint-sequence.ts:143-147`.

The comment says a logger left running on the ground "can only earn a bonus
near zero". That is wrong: the §13.4.6 bonus is height above **goal**, not
above the landing field. HG, landed at minute 20 in a field 300 m above goal,
stop at minute 30:

- logger off: not flying at stop, 0 m bonus, 16.01 km scored;
- logger left on: flying at stop, **1500 m bonus, 17.51 km scored**, and the
  pilot drops out of the landed-before-stop count (2/2 → 1/2) that feeds
  stopped-task validity (§13.4.3).

**Fix:** decide "flying at stop" from `detectTakeoffLandingIndices`, not from
where the file ends.

### 1.3 [C] High ✔ — The declared SSS direction binds pilots

`turnpoint-sequence.ts:466-480` (`filterStartCrossingsByDirection`);
`xctsk-parser.ts:204` (v1 defaults to ENTER) and `:298` (v2 defaults to EXIT
when `d` is absent).

S7F 2026 §6.2.1: "The direction in which such a crossing occurs is irrelevant …
Task setters may still choose to indicate whether the start or subsequent
turnpoint cylinders are 'enter' or 'exit' … But pilots are not bound to those
indications." XCTrack also marks `sss.direction` obsolete. The same track over
an entered air-start:

- v1 with no direction (or ENTER): goal, 29.60/29.60 km, 1960 s;
- v1 with EXIT, or a v2 QR without `d`: **landed out at 12.80 km**, no time.

**Fix:** accept start crossings in both directions (keep "the last crossing
before continuing"); stop defaulting a missing `d` to EXIT.

### 1.4 [C] High ✔ — The 2024 Annex A ESS pin is still applied

`task-optimizer.ts:51-54`, `:95`, `:173`.

A mid-route ESS is pinned (its tag is the nearest point to the previous tag)
for the task distance and for every pilot's remaining route. The comment cites
§7.2, but the 2026 §7.2 treats the ESS as an ordinary route element — the pin
was 2024 Annex A §3.2.4, which no longer exists. `/scoring/gap` does not list it
as a deviation.

| Task | Engine | 2026 (no pin) | Excess |
|---|---|---|---|
| unungra-cup-2020-open-t1 | 67.356 km | 66.729 km | +627 m |
| kosci-loop-t3 | 17.431 km | 17.281 km | +150 m |

Landed-out pilots move by −18 to +157 m (distance fraction by up to 0.8 pp).
The launch→ESS slice is unaffected (equals `launchToESSDistance` to 0.0 m).

The pin also breaks the best-progress search's 5 m guarantee
(`turnpoint-sequence-path.ts:519-526`): its skip proof assumes remaining
distance changes ≤ 1 m per metre moved, but a pinned tag swinging round the
ESS ring changes it by up to ~2 m/m. **37 of 292 real tracks** exceed 5 m; the
worst under-credits a pilot by 39.8 m (136.6 m synthetic). Without the pin the
worst is 4.0 m.

**Fix:** drop the pin and compute launch→ESS as its own route. Fix 1.11 first —
without the pin, an ESS identical to the goal cylinder deadlocks the optimiser.

### 1.5 [C] High ✔ — Time-trial tasks ignore their start gate

`time-gates.ts:125` (`if (task.sss?.type !== 'RACE') return null`); leading
clock at `gap-scoring.ts:407-414`.

§6.3.2: a time trial's start is "a single start gate … Pilots are free to start
any time after this start gate". §12.3.1 starts the leading clock at the gate.
The bundled ELAPSED-TIME tasks carry their gate.

- A pilot leaving at 09:52 with the gate at 10:00 gets a valid start, full time
  points and 88.9 leading points (HG). They should be scored as a jump-the-gun
  (HG) or launch-to-SSS distance (PG).
- With every start after the gate, the leading clock begins at the first
  crossing (10:42:54), not 10:00 — a later, faster pilot gets 42.8 leading
  points instead of 53.4.

**Fix:** resolve the time-trial gate; use it to validate starts and to anchor
the leading clock, while still timing each pilot from their own crossing.

### 1.6 [C] Medium — Tasks whose first turnpoint is the SSS mix up launch and start

`gap-scoring.ts:120-123`, `:283-287`; `gap-leading.ts:169`.

Same task written with and without a radius-0 TAKEOFF at the start centre:

- speed-section length includes the start radius — a late, fast HG pilot gets
  22.2 leading points instead of 28.9 (PG 75 vs 81.9);
- PG early start: launch-to-SSS distance is 0, so a 10 km exit start scores
  minimum distance (5 km) instead of 10 km;
- distance origin `start` does not remove the start radius (68.53 km both ways;
  the code's own docs say 63.53 km).

**Fix:** treat an SSS-first task as having an implicit TAKEOFF at the SSS centre.

### 1.7 [C] Medium — No tolerance on the approach side of the goal line

`goal-line.ts:254-272`.

2026 §9.1.3 (new in 2025) puts a tolerance line l′ one `toleranceDistance`
(5 m) in front of the goal line. The engine requires the line itself. A pilot
who stops 0.5, 3 or 4.9 m short gets `madeGoal=false` and loses goal, ESS and
time points. Note 039 rejected this under the 2024 text; `/scoring/gap` claims
§9.1.3 compliance.

### 1.8 [C] Medium — No start crossing scores 0 distance

`turnpoint-sequence.ts:265-280`.

§9.3 measures remaining distance from every flying fix with the SSS still to
reach. The engine returns `flownDistance: 0` for any pilot without a start
crossing. Air start 20 km out, pilot lands 3 km short of its ring: engine 0 m,
§9.3 14 000 m. Compounds 1.3.

### 1.9 [C] Medium — Best progress ignores fixes before the last turnpoint reached

`turnpoint-sequence-path.ts:402`.

§9.3 takes the minimum over all flying fixes, each routed through the
turnpoints it had not yet reached. A pilot who misses TP1 by 30 m on the goal
side, flies round and tags it from the far side: engine 12 667 m, spec
14 587 m (−1.92 km).

### 1.10 [C] Medium — `already_outside` credits an EXIT cylinder with no crossing

`turnpoint-sequence-path.ts:134-153`.

B is treated as EXIT because the route's tag on A lies inside B, so a pilot who
tags A on the part of A outside B is credited B immediately. A pilot who never
came closer than 5 798 m to B's centre (radius 5 000 m) is credited
`3:already_outside` and `madeGoal: true`. §9.2 needs a crossing, or a fix in
the band, after the previous turnpoint.

### 1.11 [C] Medium — Route optimiser stalls on identical consecutive cylinders and can settle on a local minimum

`route-optimizer.ts:307-319`, `:410-440`.

- Two identical consecutive unpinned cylinders lock both tags onto the
  tie-break point (due east). With the ESS untyped: corryong-cup-2026-floater-t2
  19.473 → 20.237 km (+764 m). Today only the ESS pin (1.4) hides this.
- Against a global DP on 400 random tasks, 17 are > 1 m long — exit start plus
  a 10 km turnpoint around launch +573 m; two overlapping 20 km cylinders
  +11.6 km. All 14 bundled tasks match the DP.

**Fix:** merge identical consecutive elements; seed tags on the centre-to-centre
line or from several starts.

### 1.12 [C] Medium — An HG pilot entered manually in goal gets no arrival points

`gap-scoring.ts:696-699` with `manual-flight.ts:236-243`.

A manual flight counts as reaching ESS but has no ESS time, so it never gets an
arrival position, while the field is scored as if it had. Fastest pilot entered
manually: 309.3 time points, **0 arrival points** (§12.4 guarantees ≥ 20 %).

### 1.13 [C] Medium — A logger left running after landing stretches everyone's leading tail

`gap-scoring.ts:440-446`, `gap-leading.ts:263`.

The field's last-outlanding time (§12.3.1) is the last fix of any file, not the
last landing. No-deadline task, one landed pilot's logger runs 3 h more: the
tail moves 12:05 → 13:39 and another pilot (landed 50 km out) drops 28.6 → 17
leading points. Note 038 relies on the deadline/stop caps, which an ungated
task does not have. **Fix:** use detected landing times.

### 1.14 [C] Medium — Leading coefficient lags one fix (logger-interval dependent)

`gap-leading.ts:222-252`.

Progress made at fix i−1 is timed at fix i (AirScore parity). The same flight
logged at 10 s loses 4.2 of 111.8 leading points against its 1 s log; the
spec's own timing loses 2.0. This conflicts with the "seconds, not fixes"
stance the repo takes everywhere else.

### 1.15 [C] Low — Available points not rounded to whole points

`gap-scoring.ts:584-606`. §11: `round(1000·TV·W, 0)`. 27 bundled task/category
runs publish non-integer pools; an HG nobody-at-ESS day shows 17.5 leading
points where the spec's own example says 18.

### 1.16 [C] Low — Goal-line orientation uses the spherical bearing at p, not the geodesic direction at c

`goal-line.ts:162`. Rotated 0.47° at 46°N on a 50 km E–W leg (−1.2 m); 1.56°
at 60° on 100 km (−12.4 m). **Fix:** `inverseGeodesic(c, p).azimuth + π`.

### 1.17 [C] Low — Goal-line cache goes stale after an in-place edit

`goal-line.ts:96-97`. Keyed on task identity; the analysis page's task editor
mutates in place (`task-editor.ts:186`). After an edit: half-width stays 200 m
(should be 1 000 m), bearing 88.9° (should be 0.6°).

### 1.18 [C] Low — v2 QR turns radius 0 into 400 m and altitude 0 into "unknown"

`xctsk-parser.ts:249`, `:271`. The 2026-07-12 review believed this preserved;
it does not. Altitude 0 → undefined breaks the "zero is never missing" rule.

### 1.19 Low — Stale tolerance wording

`/scoring/gap` "Smaller details", `LINE_TOLERANCE_NOTE` (`sections/flight.ts:43`)
and `docs/optimized-task-line-spec.md` still describe a configurable 0.5 %
tolerance. The code applies the 2026 fixed ±5 m (correct per §9.1.1).

---

## 2. Scoring path — worker seams

### 2.1 [C] High ✔ — Removing or reclassing a DNF-only pilot never marks scores stale

`score-store.ts:162-177` (`taskIdsForPilots`), used by `routes/pilot.ts:624`,
`:910`, `:985`.

The query unions `task_track` and `task_manual_flight` only. A DNF pilot with
no track counts in `numPresent` and so in launch validity. Delete them (single
or bulk) or change their class, and nothing is bumped: before and after,
`stale:false`, `num_present` 3, launch validity 0.775. A forced rescore gives 2
and 1.0 — every pilot was ~22 % low.

**Fix:** add `UNION SELECT task_id FROM task_pilot_status WHERE comp_pilot_id IN (…)`.

### 2.2 [C] High — A header-only or unparseable IGC deletes the pilot from the scores

`track-upload.ts:173`, `:567`; `scoring/track-store.ts:116`, `:194-195`;
`scoring/task-score.ts:228-229`, `:420-421`.

Validation accepts any file with an `A` record and `HFDTE`. With zero fixes,
`assessUploadedTrack` returns null (`hard_failed:false`), the pilot is marked
Landed and their manual flight superseded; at scoring time `fetchIgcFile`
returns null and the pilot is silently dropped. Before: `[Admin Two 114.5,
Test Pilot 40.4]`; after: `[Admin Two 221]`. This breaks "a withheld pilot is
never deleted from the scores" and changes everyone's `numFlying`.

**Fix:** treat zero fixes / parse failure as a hard finding at upload and in
`openTrackForScoring`; seat the pilot with a reason.

### 2.3 [C] High — A withheld upload leaves the pilot's other evidence active

`track-upload.ts:342-357`, `:566-568`; `scoring/config.ts:220-241`;
`scoring/task-score.ts:155`, `:452`.

- A pilot with a manual flight uploads a wrong-day file: the task scores list
  the same `comp_pilot_id` twice (rank 2 at 40.4 from the manual flight, rank 3
  at 0 `track_excluded`). The comp total counts two entries for one task, which
  also skews FTV.
- A DNF pilot's withheld upload makes the "no active track" DNF query drop
  them: `num_present` 3 → 2, launch validity 0.775 → 1.0, the others' scores
  775.1 → 1000 and 322 → 415.4 — contradicting the blast-radius guarantee
  documented at `task-score.ts:170-185`.

**Fix:** store a hard-failed upload inactive when other evidence exists, or
have the DNF and manual-flight queries ignore withheld tracks.

### 2.4 [C] High ✔ — The scores ETag omits scoring inputs

`scoring/state-key.ts:22-37`, `:102-135`; `routes/score.ts:224-233`; comp ETag
`:376-384`; analysis ETag `analysis.ts:163`.

The key omits comp and task `gap_params`, `task_class`, `penalty_reason` and a
manual-flight pilot's name. After a `gap_params` PATCH and recompute, totals go
`[1000, 479.5, 209.7]` → `[1000, 422.1, 209.7]` while the ETag stays
`"score:v9:1:2180dbb0b5b8b26e"`, so `If-None-Match` returns **304**.

**Fix:** hash what the body depends on — simplest is a hash of `response_json`.

### 2.5 [C] Medium ✔ — Published task ranks never share ties; comp ties use whole points

- `scoring/class-score.ts:202-205`: `rank: i + 1` overwrites the engine's
  shared ranks. Three pilots tied at 13.9: engine #2, #2, #2; API #2, #3, #4.
  Every task has ties at minimum distance.
- `class-score.ts:47-60`: comp ranks tie when totals round to the same
  **integer**. S7F 2026 §15 gives competition scores to one decimal (2025
  change); 812.4 and 811.6 share rank 1. The AirScore-parity comment predates
  that change.

### 2.6 [C] Medium — Worker-side scoring code is outside the engine fingerprint

`web/scripts/scoring-fingerprint.ts:54-62`; `scoring-source-closure.ts:212-219`.

`scoring/class-score.ts` (penalties, rounding, ranking), `scoring/config.ts`
(70 % nominal distance, DNF/numPresent, class filtering, quality partition),
`scoring/task-score.ts` and `manual-flight-store.ts` decide published numbers,
but changing them neither rolls the generation nor requires a change note.
Existing rows stay "fresh" with the old behaviour. `@turf/*` (`geo.ts:15-17`)
is likewise unhashed, so a weekly dependency upgrade can change scoring
silently.

### 2.7 [C] Medium — CI scoring-change-note check never runs on branches

`deploy.yml:49-51` (default `fetch-depth: 1`), `:96-99`;
`check-scoring-change-note.ts:49-63`. In a depth-1 checkout,
`git merge-base HEAD origin/master` fails even after a `--depth=100` fetch of
master; the script prints "skipped" and exits 0. Simulated with an
actions/checkout-style shallow clone. **Fix:** `fetch-depth: 0`, or fail
rather than skip under CI.

### 2.8 [C] Medium — `taskIdsForPilots` exceeds D1's 100-parameter cap above 50 pilots

`score-store.ts:166-175` binds 2×N parameters unchunked; the bulk roster route
passes every deleted, renamed or reclassed pilot. A large CSV import returns
500 in production. Miniflare does not enforce the cap, so tests pass. The
project already chunks for this at `track-files.ts:34`.

### 2.9 [C] Medium — A transient task-analysis failure is stored as a permanent answer

`task-analysis-store.ts:428-441`; `routes/analysis.ts:189-205`. An R2/D1 blip is
stored as `error` at the current revision and served non-stale with a growing
public max-age, never retried. Breaks the #481 rule. `weather-store.ts:102-104`
already has the backoff pattern to copy.

### 2.10 [P] Medium — Two handlers bump before their own write

- Track upload bumps at `track-upload.ts:539`, before
  `applyStatusOnTrackUpload` supersedes the manual flight (`:567`); the comment
  at `pilot-status.ts:533` says otherwise. A recompute that wins the race
  stores a double-counted pilot as fresh.
- Setting a route bumps (`task.ts:280-281`, `:509-527`) before
  `deriveCompTimezone` writes `comp.timezone` — a scoring input (quality hash,
  state key). The comp's other tasks are never bumped; the comment at
  `task.ts:56` ("purely presentational") is stale.

Not lost in three local D1 runs; `scheduleTaskRevalidation` runs immediately, so
the window is real.

### 2.11 [C] Medium — The default nominal distance is 70 % of each task's own distance

`scoring/config.ts:115-117`. Documented, but §2.2/§5 make nominal distance a
competition parameter set once, whose purpose (§5.1, §10.2) is to devalue
tasks that are short for the site. Same field (best 20 km, nobody at ESS):
task validity 0.871 on a 25 km task, 0.090 on a 90 km task; with a fixed
70 km both are 0.070. The default rewards setting short tasks.

### 2.12 Medium (design) — A pilot can record a goal manual flight for themselves

`routes/manual-flight.ts:246-253`; `validators.ts:267`. The pilot (or any buddy
when `open_igc_upload` is on) may record goal with `duration_seconds` as low as
1, which becomes the field's `bestTime` (`gap-scoring.ts:233`) and cuts every
other pilot's time points. Audited, but no email and no organiser approval.

### 2.13 [P] Low–Medium — Score recomputes are unbounded in memory and CPU

`score-store.ts:219-220`; `scoring/task-score.ts:442`. Every task revalidates
concurrently and per-track analyses are saved only at the end; ~1.2 MB per
parsed track against 128 MB and 30 s CPU. A killed run saves nothing and the
comp endpoint retries the same batch. The cold path takes no lease.

---

## 3. Track ingestion and quality

### 3.1 [C] High (corrupt input) ✔ — A bad hour field shifts the rest of the flight by 24 h

`igc-parser.ts:210-211` (`B(\d{6})`), `:302` (E records), `:459-471`
(`dayOffsetFor`).

"Validated" means six digits, so hours 18–99 pass and arm the
`prevHours >= 18` midnight rule. One character changed in the Corryong 2026 T1
winner's real track (`B0518…` → `B2518…`): **984 pts, rank 1 → 485 pts,
rank 12**; speed-section time 5 875 s → 92 275 s. `assessTrackQuality` reports
**no findings**. Note 050 states this is impossible; its regression test uses a
line rejected for other reasons. Australian flights legitimately cross UTC
midnight, so the rollover rule is exercised constantly.

**Fix:** range-check `([01]\d|2[0-3])([0-5]\d){2}`; roll the day only when the
step from the last kept fix, modulo 24 h, is small (< 1 h).

### 3.2 [C] Medium ✔ — `never-airborne` fires on honest coarse and >1 Hz logs

`track-quality.ts:763-771`, `:784-791`, `:750`.

Both windows advance `lo` while the span exceeds the window, then require span
≥ window — so a window is measured only when the span is **exactly** 120 s
(90 s). A logger whose interval divides neither never measures one. Separately
a dt = 0 pair gets speed 0, so a >1 Hz log's minimum glide speed is always 0.

- Real false positives in the bundle: `corryong-cup-2021-open-t1/holtkamp_…`
  (11 s logging, 3 h to 2 586 m) and `meechan_…` (180 s) — "Nothing in this
  track looks like flying". `audit-track-quality.ts` never sees them because
  that comp has no `comp.json`.
- Thinning 214 honest tracks: fires on 1 at 1 s, **125 at 7 s**, 0 at 9–10 s,
  **165 at 11 s**, **172 at 13 s**.

SOFT, so annotates only. **Fix:** keep `lo` at the latest index with span ≥ W;
skip when no window was measurable; take speed from the previous fix with
dt > 0.

### 3.3 [C] Medium — An impossible HFDTE becomes a real date and the track is HARD-withheld

`igc-parser.ts:183-192`. `Date.UTC` rolls bad fields: `HFDTE000000` → 1999-11-30,
`HFDTE320126` → 2026-02-01, both `hardFailed: true`. The soft "no date header"
path exists for exactly this. **Fix:** validate day/month and round-trip.

### 3.4 [C] Medium — The cross-channel altitude cleaner always blames GNSS

`altitude-cleaning.ts:172-179`. Baro reads +400 m for three fixes with GNSS
correct: `fixAltitude` = 1 749 against a truth of 1 349 — a spike invented by
cleaning. Only 2 of 248 real files have both channels alive (AirScore exports
strip the baro), so real-data tests barely exercise this path, but instrument
uploads in production take it. **Fix:** repair only when GNSS moved
implausibly against its own neighbours.

### 3.5 [C] Low–Medium — A GNSS dropout over 2 min is repaired only near its edges

`altitude-cleaning.ts:168`. A 10-minute GNSS-zero outage with a −200 m baro
offset: 120 fixes repaired, 480 silently read uncorrected baro, and the
cleaned series steps 1 500 → 1 300 → 1 500. **Fix:** carry or interpolate the
baseline across the gap.

### 3.6 [C] Medium (analysis only) — Takeoff detection counts fixes

`takeoff-landing-detector.ts:127` (three fixes inside a 10 s window), `:88`
("last 5 fixes"), `:29-30` (dt = 0 → speed 0).

| Thinned to | Median shift | > 60 s | p90 |
|---|---|---|---|
| 5 s | 4 s | 0 | — |
| 10 s | 49 s | 71 of 200 | 159 s |
| 15 s | 59 s | 90 of 200 | 224 s |

### 3.7 [C] Low (HARD check) — `wrong-place` can fire with its evidence under the threshold

`track-quality.ts:568`: `boxRadius` is measured to the (maxLat, maxLon) corner,
the farthest only in the southern hemisphere; the firing branch (`:594-626`)
never re-checks `best.meters > threshold`. Northern-hemisphere track: HARD with
`nearestApproach=95000 threshold=100000`.

### 3.8 [C] Low (HARD check) — `wrong-day` measures from the first fix when the track is before the window

`track-quality.ts:469-470`. A 6 h track ending 23 h before the window → HARD
(offset −29 h); the mirrored case measures from the nearest fix.

### 3.9 [C] Low — Smaller ingestion defects

- Two consecutive forward-stamped fixes discard the real flight
  (`igc-parser.ts:476-502`; 3 599 good fixes dropped, both bad kept).
- No HFDTE → stamped with the parse day (`igc-parser.ts:418`), so the verdict
  depends on when the file is scored.
- The rate cleaner never repairs a spike on a >1 Hz single-channel track
  (`altitude-cleaning.ts:197-201`, dt = 0 skipped; +900 m spike kept).
- `forge-igc.ts:156-161`, `:695-703`: HFDTE pinned to the task date while the
  local start can fall on another UTC day.
- `units.ts:106`: `in` accepts prototype keys; unvalidated localStorage
  preferences throw on an unknown value.

---

## 4. Event detection and flight phases

### 4.1 [C] High ✔ — `detectFlight` never cuts at the landing it detects

`event-detector.ts:367` (`fixes.slice(takeoffIndex)`), versus
`analysis/context.ts:132`, which slices to `landingIndex + 1`.

Rowntree T1 with 25 min of ground time appended (landing still detected at fix
7 784): the last glide goes 6.2 min / 61.3 km/h → 31.2 min / 12.9 km/h, and
**68 phantom `circle_complete` events** appear on the ground ("r=1m"). With a
retrieve drive appended, the minimum altitude comes from the car and the last
"glide" is 46 km at L/D 47.5. The bundled samples are trimmed at landing, so
no test sees it. **Fix:** slice to `landing.fixIndex + 1`.

### 4.2 [C] Medium — A fractional "count" threshold crashes every `detectFlight`, and persists

`event-detector.ts:243-244`; `threshold-parser.ts:315`. `'2.5'` passes the 2–50
range check, then `fixes[i - 2.5]` is undefined and throws. Settings persist in
localStorage and cloud sync, and `main.ts` does not catch, so every track load
on every device fails until reset. **Fix:** integers only — better, seconds (4.6).

### 4.3 [C] Medium — Circling segments end ~16 s after the turning stops

`circle-detector.ts:288-299` (`endIndex` set when the hysteresis timer expires).
Downstream:

- `phase-partition` turns 5.3 h of 149 h of non-climb time from glide into
  search; per pilot the search share rises median +1.9 pp, p90 +4.1, max +9.4.
  This feeds `decision.search_fraction` — the strongest metric (median |ρ| 0.72).
- `climb.selectivity`: 216 of 1 948 (11 %) qualifying bouts qualify only
  because of the straight tail.

**Fix:** keep the hysteresis for the state machine; emit the last turning fix.

### 4.4 [C] Medium — Coarse loggers produce aliased circles the fix gate does not stop

`circle-detector.ts:443-448`. At 5–10 s per fix a 20–25 s circle turns
150–180° per step and `normalizeBearingDelta` aliases it. Over 18 pilots who
circle one way ≥ 90 % of the time, wrong-direction circles go **3.5 % at 1 Hz
→ 11.3 % at 5 s → 33.1 % at 10 s**. They leak into the turn-direction summary,
`day.wind` (`day-profile.ts:101`) and the final-glide-through-air table
(`racecraft.ts:574`) — none gated; per-thermal wind differs from the 1 Hz
estimate by median 0.75–1.0 m/s, p90 2.2–2.6 m/s. **Fix:** reject a circle
with any |Δheading| > ~120° or lasting > ~60 s.

### 4.5 [C] Medium — The circle fit is not drift-compensated

`circle-detector.ts:331-401`. Kasa is algebraically right but fits the ground
track, which in wind is a trochoid. A perfect 60 m circle in 4 m/s wind fits as
r = 68.5–71.5 m, rms/r 0.13–0.32. Over 6 501 real circles, removing the
centre-drift wind first lowers median rms/r 0.175 → 0.131 and median radius
53.7 → 46.4 m: about a quarter of `climb.circle_smoothness` is wind and tempo.
**Fix:** translate fixes by −wind·(t − t_mid) before fitting.

### 4.6 [C] Medium — The gaggle start-cylinder exclusion is purely spatial

`cluster-detector.ts:277-283`; `analysis/context.ts:200-209` (and
`frontend/src/replay/gaggles.ts`). In corryong-cup-2026-open-t1 the ESS sits
inside the 5 km start radius, so 8.0 % of racing pilot-frames (the run-in to
ESS) are excluded. For an ENTER start the logic inverts [P — no bundled
example]. Feeds `gaggle.affinity`, `gaggle.departure_winrate`. **Fix:** exclude
a pilot only before their own start reaching.

### 4.7 [C] Low — Remaining fix-count windows

- `minGlideGapIndices = 10` (`flight-phase-detectors.ts:206,215`): drops 12.6 %
  of glides at 5 s, 30.2 % at 10 s.
- `varioWindowSize = 10` fixes (`event-detector.ts:234`): max climb 6.2 → 4.5
  m/s at 10 s logging.
- `THERMAL_EXIT_WINDOWS = 3` (`flight-phase-detectors.ts:125`) only binds at
  > 1 Hz, where it exits on three weak windows within a second (18 → 22
  thermals at 2 Hz).

### 4.8 [C] Low — Smaller detection defects

- A repeated position inside a circle gives `calculateBearing(p,p) = 0` and
  corrupts the heading sum (`circle-detector.ts:429-444`); 15 of 220 tracks
  change circle count when zero-length steps are skipped.
- A turn reversal inside one circling segment produces a mixed figure-8
  "circle" and loses a lap.
- `track-packer.ts:21-22` claims sub-metre accuracy over 100 km; the
  equirectangular projection is −197 m at 100 km (0.8 % scale), ~80 m on a
  10 km cylinder edge in the 3D replay.

---

## 5. Task and comp analysis — statistics

### 5.1 [C] High ✔ — The comp-level ρ is confounded by uneven participation

`analysis/aggregate.ts:40-59`, `:121-142`; UI claim at
`frontend/src/react/analysis/ReadingNotes.tsx:98` ("correlates it against their
overall rank").

Each pilot's raw metric is averaged across tasks with no per-task
standardisation, then correlated against a rank summed only over the tasks
that pilot was analysed in. Missing a task both lowers the rank and changes
which day-level offsets enter the mean, so any metric whose level varies by day
correlates with comp rank.

- Synthetic: metric unrelated to score within every task, one fast day, 30 %
  skip it — mean comp ρ = −0.35; **42.7 % of runs clear the noise floor**
  (nominal 5 %), 28 % "strong".
- Real: ρ(tasks flown, comp rank) is −0.65 / −0.58 / −0.86 on the bundled comps.
  `race.ess_margin` comp ρ +0.59 "strong" falls to 0.21 on within-task
  percentiles; `glide.dolphin_fraction` 0.55 → 0.27.
- The rank ignores FTV and drops tasks where a pilot was scored from a manual
  flight or withheld (`totals` holds analysed pilots only,
  `task-analysis.ts:286`). Tied totals get consecutive ranks (`aggregate.ts:58`).

**Fix:** rank-transform within each task before averaging (or a stratified
ρ), correlate against the official comp ranking, and report participation
imbalance.

### 5.2 [C] Medium–High — Tiny-n tasks vote on the sign

`aggregate.ts:100`; `CompAnalysis.tsx:509`; `analysis/debrief.ts:47`. None gate
on `MIN_CORRELATION_N`. Exact chance of clearing the floor under no effect:
**33.3 % at n=3**, 8.3 % at n=4–5, 5.8 % at n=6 — at n=3–4 no α=0.05 test
exists, as `2026-09-02-metric-evidence.md` itself warns. 10 of 61 informative
votes come from n < 8. `decision.altitude_floor` on the Corryong floaters
"depended on the day" entirely from a 3-pilot task (ρ=+1.00) and a 5-pilot
task (ρ=−0.90).

### 5.3 [C] Medium — No multiple-comparison control; "Winning strategies" asserts without caveat

`evaluate.ts:250-254`; `TaskAnalysis.tsx:69,114-117`. ~21 behaviours each at
α = 0.05. Shuffling GAP ranks over the real metric columns, the box names at
least one behaviour in **54–62 % of shuffles** (~1.0 false pattern per task).
On the real tasks 22 of 25 named behaviours survive Benjamini–Hochberg at
q < 0.10, only 9 survive a family-wise max-|ρ| threshold. Ordering by |ρ|
favours low-n metrics (winner's curse). **Fix:** BH q-values or a max-T
permutation threshold; order by evidence.

### 5.4 [C] Medium — Shared-thermal clustering chains into multi-kilometre "thermals"

`analysis/shared-thermals.ts:124-136`, `:201-214`. Single linkage at 800 m /
120 s is transitive: Corryong T3 has one "thermal" with 328 uses by 32 pilots,
8.6 km across, 82 min long, 1.9 km entry-altitude spread. 64–71 % of ranked uses
on Corryong (47 % Unungra) sit in clusters > 2 km wide. So
`climb.shared_percentile` — which claims to isolate centring from selection —
mixes selection, timing and altitude band again. `thermal-shape.ts:185-197`
already splits oversized clusters, but only for drawing. **Fix:** split before
ranking, and compare within an altitude band.

### 5.5 [C] Medium — Style clusters are always produced and named

`clustering.ts:458-473` (k searched 2–6; k = 1 never tested), `:513-528`. On pure
noise 92–97 % of groups get a nickname, and group median ranks are ≥ a third of
the field apart in 39–59 % of runs. Floater T3 (10 pilots) does not beat a
column-shuffled baseline (silhouette 0.159 vs 0.177, P = 0.75) yet shows three
named groups, and the UI says the rank spread "shows where that style paid".
**Fix:** test k = 1 (gap statistic or permutation silhouette); test the rank
spread (Kruskal–Wallis) before claiming a payoff.

### 5.6 [C] Medium — The similarity noise floor ignores that the list is sorted

`similarity.ts:386,418`; `similarity-noise-floor.ts`;
`TaskPilotSimilarity.tsx:682-686`. The floor is a 5 % test for one pair; the
sheet sorts N−1 neighbours. With no real similarity the top row clears it in
61 % of 30-pilot sheets, 80 % at 40. It was also simulated from N(0,1) vectors
while the sheet uses within-field z-scores, so per-row it is conservative
(1.5–3.3 %). Rows below the floor say "too little data to tell" even with 20+
shared behaviours. **Fix:** simulate the null of the maximum; rebuild from
within-field z-scores; relabel (UI wording — propose first).

### 5.7 [C] Medium ✔ — The resample grid is anchored to the earliest takeoff and capped at 14 h

`analysis/resample.ts:83-98`. One track stamped a day early — kept SOFT by
design (`track-quality.ts:100-120`) — becomes `t0`, and the 14 h cap ends the
grid before anyone else flew: every other pilot gets 0 grid samples, silently
emptying gaggle, race-craft and day-profile metrics. **Fix:** anchor to the
field's median takeoff and drop pilots outside a robust window.

### 5.8 [C] Low–Medium — Smaller statistical defects

- The consistency map (`ConsistencyMap.tsx:74,82`) has no chance baseline for
  mean |ρ| (≈ √(2/(π(n−1))), 0.15–0.25); 21–49 % of pure-noise metrics get a
  direct label and 21–36 % read as "depended on the day".
- Count metrics correlate with rank partly through airtime (`evaluate.ts:381-406`):
  `decision.low_saves` — the #1 "winning strategy" on Corryong T3 and Unungra T1 —
  falls from ρ −0.60 to partial −0.29 given airtime (−0.71 → −0.46 on Unungra
  T1). Express counts per airborne hour.
- The t-approximation floor (`stats.ts:110-126`) is 5.4–6.1 % rather than 5 %
  for n = 8–16 (n = 9: 0.666 vs exact 0.700). Documented as approximate.

---

## 6. Task analysis — metric definitions

Measured over every real comp in the bundle and in `glidecomp-archive`
(78 HG and 33 PG tasks), recomputing each suspect the way its explanation
describes it.

### 6.1 [C] High ✔ — `glide.dolphin_fraction` measures weak circling, not dolphin flying

`analysis/metrics/gliding.ts:375-388` (explanation at `:355`).

The explanation says "height gained outside of circling"; the code counts gain
outside a detected **thermal**. `detectThermals` is a vario test with no
circling test, so straight lift above 0.5 m/s for 20 s is a "thermal", while
circling in weak lift, at thermal edges, or in the 20 s `minThermalGap` after a
mid-climb dip counts as "dolphin".

- **84 % (HG) / 76 % (PG)** of the gain counted as dolphin was made inside
  circling segments.
- Per task, ρ between the coded value and the described value has median
  −0.04 HG / −0.06 PG: the two are unrelated.
- Against GAP rank the coded value gives ρ +0.50 / +0.37 (more "dolphin" goes
  with a **worse** result); the described quantity gives −0.35 / −0.25 (more
  goes with a better result, as soaring theory predicts). The published archive
  finding has the opposite sign to the behaviour the name describes.

**Fix:** count gain only on fixes outside circling segments, then re-run the
evidence sweep.

### 6.2 [C] High ✔ — `race.final_glide_init` uses the straight line to goal and ignores unreached turnpoints

`analysis/metrics/racecraft.ts:663-674` (gate `:635-637`, window end `:647`).

The "glide ratio committed to" divides straight-line distance to the goal
**centre** by height above goal; the 1.5× distance gate is straight-line too,
so a pilot on an early leg of a task returning towards launch passes it.

- **37 % (HG) / 43 % (PG)** of published values come from a last climb taken
  before an unreached turnpoint more than 1 km from goal. For those, the real
  remaining route is a median 2.7× / 1.8× the straight line (p90 ~9×).
- Corryong 2026 T1: published 2.1:1, 9.0:1 by route (4.2 km straight, 17.8 km
  via a turnpoint). Unungra T1: 1.9:1 against 47:1.
- Using the route raises median ρ against rank 0.49 → 0.72 (HG), 0.29 → 0.47 (PG).
- When ESS is not at goal the window ends at ESS: on Bright 2023 T1, 31 of 49
  ESS pilots climbed > 100 m after ESS, so the "final" climb was not final.

**Fix:** use `optimizeRemainingRoute` from the exit fix through unreached
turnpoints to the goal edge; gate on it; run the window to goal.

### 6.3 [C] High (PG) / Medium (HG) — `climb.shared_percentile` mostly compares climbs in different thermals

`climbing.ts:66`, reading `shared-thermals.ts:201`. The same root cause as 5.4,
measured from the metric's side. The explanation promises the "SAME thermal …
a pilot who only found better air gets no higher value".

- 85 % (HG) / 93 % (PG) of ranked uses sit in clusters longer than 1 km on their
  axis (median 2.7 / 3.9 km) — the size at which `thermal-shape.ts` itself
  splits a cluster.
- A use is ranked against a median of **34 (HG) / 397 (PG)** others, of which
  only 6 / 24 are within 800 m and 120 s of it.
- `gaggle.marker_usage`: 15–19 % of "markers" are > 800 m away, linked only
  through the chain.

**Fix:** rank against direct neighbours, or after `splitOversizedCluster`.

### 6.4 [C] Medium — `race.ess_margin` is meaningless when ESS is not at goal; an absent goal altitude is read as 0

`racecraft.ts:482-493`; `gap-stopped.ts:107` (`altSmoothed ?? 0`).

- Bright 2023 T1–T3 (ESS cylinders up to 16 km): median margins −2 447, −964 and
  −736 m — **100 % of ESS pilots read "short"**, yet 45 of 49 made goal on T1.
  The 5:1 / 4:1 ratios are the §13.4.6 stopped-task constant, not the glide a
  wing needs.
- 13 of 196 tasks have no goal altitude and use 0 m. Corryong 2026 T2 goal
  pilots landed at ~302 m, so the margin is inflated ~300 m and
  `final_glide_init` understated 20–30 %. This breaks the "zero is never
  missing" rule, and `resolveGoalAltitude` is shared with stopped-task scoring.

**Fix:** null (or route-based) when ESS ≠ goal; treat an absent goal altitude
as unknown, or estimate it from goal pilots' landing altitude.

### 6.5 [C] Medium — `climb.selectivity` counts circling after ESS as rejected lift

`climbing.ts:283` — no ESS bound. 83 % (HG) / 93 % (PG) of ESS pilots circle
≥ 30 s after ESS (burning height over goal); 81 % / 72 % of those bouts count
as "not kept". ESS pilots lose a median 4–4.5 points (worst −56); Corryong 2026
floater T3, rank 2: 43 % against 75 % before ESS. It penalises the better-placed
pilots (ρ −0.54 coded vs −0.61 bounded, HG). **Fix:** bound to `[SSS, ESS]` as
`search_fraction` does.

### 6.6 [C] Low–Medium — Smaller metric defects

- `climb.time_to_core` (`climbing.ts:110-111`): the first 30 s use 1–29 s
  windows; in 21 % of 80 632 climbs the "peak" comes from a short window and
  16 % record ≤ 5 s. Median 39 s → 29 s with full windows; no change in signal.
- `decision.search_fraction` (`phase-partition.ts:136`): a 60 s window touching
  any circling becomes search; 21 % (HG) / 24 % (PG) of "search" is non-circling
  flight at ≥ 8 m/s. +7 points per pilot median; ranks barely move (ρ 0.96).
  Compounds 4.3.
- `thermal-shape.ts` `buildBand`: re-centring on the core removes drift between
  bands, not within one; a true 60 m circle in 5 m/s wind reports a 93–156 m
  working radius. On real data the pooled radius barely moves (144 vs 147 m), so
  the fix is the claim in `docs/thermal-shapes.md:30` ("normalised for … drift
  by construction").
- `gaggle.departure_winrate` (`gaggle.ts:252`) drops stayers who never reach the
  turnpoint (16–32 % of departures; flips ~2 % of verdicts).
- `glide.speed` has no ESS bound (4–7 % of glide time after ESS; −0.4 km/h).
- `decision.km_between_climbs` includes pre-start distance (~4 %; ρ 1.00).
- `decision.low_saves`: ρ 0.36 with time on course; on hard days ρ −0.38 falls
  to −0.29 per hour on course (see 5.8).

---

## 7. Report card

### 7.1 [C] High — Stopped tasks: the ledger and winner headline give a false reason

`sections/comparison.ts:308-318` (`offerLedger`), `:449-461`, `:532-547`;
`sections/validity.ts:305-321`; `sections/time.ts:270-283`.

The ledger assumes the four component offers sum to the day's total. Under
§13.4.5 (`gap-scoring.ts:599-606`) they do not: with nobody in goal at the stop,
available time points are 0; with someone in goal, the reduction moves to
`available_points.distance` while `available_points.time` keeps the
pre-reduction amount.

- HG, two pilots at ESS, nobody in goal: the leader reads "**nobody reached the
  end of the speed section**, so of the 920.6 points … only 856.2 could be won"
  directly above "Reached the end of the speed section 1st of 2"; weights show
  "time 7.0 %", the split "time 0".
- Two pilots in goal: the split sums to 1 113 on a 920.6-point day and the
  leader is told "with nobody in goal the GAP weights overshoot slightly".

**Fix:** subtract `time_points_reduction` when `classContext.stopped`; name
§13.4.5 separately from §11; add validity and time rows for the zeroing.

### 7.2 [C] High ✔ — Pilots with no penalty are shown a "Penalties" row

`sections/comparison.ts:143`, `:293-295`, `:422`. `netPenalty` (components −
total) carries up to ±0.25 of rounding drift plus float noise
(485.6 + 420.1 − 905.6 = 0.10000000000002274 > 0.1). Rohan Holtkamp,
corryong-cup-2026-open-t1, no penalty: "Penalties −0.1 pts — you −0.1, the
leader 0". Leaders read "See the penalty section above" where there is none.
**215 of 658** bundled cards mention penalties; none carries one. **Fix:** show
a penalty only when `penalty_points !== 0 || jump_the_gun_penalty > 0`.

### 7.3 [C] Medium — Explainer text that contradicts the score

- §13.4.5 text names "the best pilot caught between ESS and goal" when none
  existed and the engine used a hypothetical one (`sections/time.ts:357`).
- PG time validity says "Nobody completed the speed section" when pilots
  reached ESS but none made goal (`sections/validity.ts:209-215`).
- The arrival equation omits the §13.2 0.8 factor and then says "the full
  available arrival points" (`sections/arrival.ts:271-298`) — breaks rule (a).
- The leading-weight sentence appears on comps with leading off, and prints
  17.5 % as "18 %" (`sections/shared.ts:120-126`, `validity.ts:340-346`).
- A manual flight in goal with no duration is told time points need ESS/goal
  (`sections/time.ts:272-283`).
- Open-distance total prints "1234 − 2000 penalty = 0" without the §13.5 floor
  (`score-explanation.ts:346-351`) [Low].

---

## 8. Weather

### 8.1 [C] Medium — The weather cache key misses inputs the stored answer depends on

`weather/task-query.ts:264-271`. `weatherQueryKey` omits `elevationM`, which
`flyingHeightLevel` reads — an altitude-only correction (the OziExplorer ×3.28
case) keeps the key, so a settled past task keeps its stale elevation (700 vs
800 hPa). The key rounds hours while the fetch floors/ceils: moving the
deadline 06:50Z → 07:20Z keeps the key but should add the 08:00Z hour.
**Fix:** key on rounded elevation and the floored/ceiled window; bump
`WEATHER_SCHEMA_VERSION`.

### 8.2 Low — Smaller weather defects

- [C] The window is anchored at 12:00Z of the task date, so an AEDT morning
  launch window (23:30Z the previous day) moves 24 h forward
  (`task-query.ts:212-222`).
- [P] `precipitation`, `shortwave_radiation`, `wind_gusts_10m` are
  preceding-hour values in Open-Meteo but labelled as t → t+1h
  (`open-meteo.ts:296-316`); all-null rows are dropped though documented as kept.
- [C] `sunTimes` returns the next day for any `dayMs` ≥ 12:00Z (`sun.ts:49`); no
  current caller affected.
- Missing elevation falls back to sea level in `derive.ts:216`, contrary to its
  doc and to `MetWindChart.tsx:106`.
- [P] `beyondForecastHorizon` checks only the window start
  (`open-meteo.ts:381-383`).

---

## 9. Decisions for the owner

These are spec-interpretation calls rather than bugs.

1. **Stopped-task validity formula** (`gap-formulas.ts:188-191`). The engine
   computes `sqrt(A · sqrt(stdev/5))` (the AirScore form); the 2026
   transcription prints `sqrt(A) · sqrt(stdev/5)`. 40 pilots spread 5–45 km:
   0.913 vs 1.000. The change is not in the §2.1.1.15 list and not marked red,
   so it may be typesetting — check the PDF raster and record the decision in a
   scoring-changes note.
2. **Final turnpoint nested inside the ESS/goal ring.** The 2026-07-12 review's
   §1.1 is marked fixed, but note 015's EXIT inference now scores a finisher who
   never leaves the ring as landed out (29 589/31 589 m). Strict §9.2 supports
   it; the earlier review did not.
3. **FTV discard default** (`ftv.ts:80-82`): 0.2 or 0.25 by task count; §5.4.1
   fixes 25 % PG and 0 % HG for Category 1.
4. **The §13.4.3 duration rule when someone reached ESS** — the formula gives 1,
   the prose's minimum-duration rule still zeroes the task.
5. **Equal ESS times** get different arrival positions by input order [P].

---

## Test-coverage gaps behind these findings

- **Bundled tracks are trimmed at landing** — 4.1, 1.2 and 1.13 are invisible to
  every real-data test.
- **226 of 248 real tracks have a dead baro channel** — the cross-channel
  cleaner (3.4, 3.5) is barely exercised.
- **No ENTER start, SSS-first, time-trial-with-early-start or goal-line-near-miss
  fixtures** — 1.3, 1.5, 1.6, 1.7, 4.6.
- **Miniflare does not enforce D1's 100-parameter cap** — 2.8.
- **`corryong-cup-2021` has no `comp.json`**, so `audit-track-quality.ts` skips
  the two files 3.2 misfires on.
- **No null-hypothesis tests for the analysis** — 5.2, 5.3, 5.5, 5.6 are all
  about how often noise is reported as signal; a permutation fixture would pin
  each rate.

## Checked and clean

- **Geodesy.** Vincenty inverse/direct agree with GeographicLib to 5e-6 m at task
  scale (equator, meridian, poles, dateline, 1 cm). Near-antipodal error is
  irrelevant at task scale. Projection-corrected tags lie within 4e-6 m of their
  boundary. All 14 bundled tasks match a global DP optimum apart from 1.4.
- **GAP formulas.** Launch/distance/time validity, HG and PG weights, PG linear
  distance, HG difficulty (bar a 30- vs 31-slot look-ahead where prose and
  formula disagree), speed fraction (5/6), best-time rules, 0.8 ESS-not-goal,
  arrival curve, leading factor and both leading integrals, jump-the-gun,
  score-back times, scored window, §13.4.5 reduction, penalty floor, FTV
  algorithm. No NaN on degenerate fields.
- **IGC parsing.** B-record layout and I-record independence, negative
  altitudes, hemispheres, both HFDTE forms, CRLF/LF, E-record validation, the
  one-midnight cap, duplicate seconds. `SlidingMedian` fuzzed 3 000 trials
  against brute force with zero mismatches.
- **Event detection.** dt ≤ 0 guarded in every rate; vario uses cleaned
  altitude; thermal windows are seconds-based at ≤ 1 Hz; heading wrap correct;
  centre-drift wind exact on synthetic data; glide L/D is a ratio of sums;
  cluster union-find and bridging correct; 50k fixes in 93 ms.
- **Statistics.** Spearman with average-rank ties matches hand values; missing
  data dropped per metric, never imputed; no non-finite values stored; sign
  convention consistent; no `Math.random` — the analysis is deterministic.
- **Metrics.** `climb.exit_decay`, `climb.departure_band`, `glide.ld_vs_field`,
  `glide.extra_distance`, `decision.altitude_floor`, `race.start_delay`,
  `race.time_behind`, `day.climb_by_hour`, `day.airtime_quality`, the lean fit
  and sector maths of the thermal shapes, and the `coarseLoggerGate` thresholds
  all match their explanations.
- **Report card.** Explainers call the scorer's own functions; rule (b) holds;
  429 bundled cards' distance/time/leading equations add up; old payloads
  degrade; formatting is SSR-deterministic.
- **Weather.** Sun times within 0.5 min of NOAA/Meeus at mid latitudes; wind is
  averaged and interpolated on u/v components; ISA conversions consistent.
- **Worker.** Revalidation lock and guarded write are sound (no stale result is
  marked fresh); task `gap_params` merge over the comp's; the routes that were
  checked write → bump → audit in order.
