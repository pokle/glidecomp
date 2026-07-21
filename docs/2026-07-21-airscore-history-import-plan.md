# Plan: faithful AirScore formula import + competition history back to 2020

**Date:** 2026-07-21 · **Status:** workstreams 1–2 implemented (same PR); 3–4 in progress · **Context:** PR #398

PR #398 compared the GAP engine against the FAI S7F PDFs (2018/2020/2024
editions) and the AirScore source ([biuti/airscore-app]) and documented the
differences on `/scoring/gap`. Two actionable gaps fell out, and the comp
owner wants a history of real competitions loaded into GlideComp going back
to ~2020. This plan covers four workstreams:

1. carry the formula AirScore actually used through the importer into
   `comp.gap_params`;
2. implement the missing S7F 2020–2022 paragliding weight generation;
3. add per-generation AirScore parity fixtures;
4. load the 2020→present back-catalogue.

Do them in the order **1 → 2 → 3 → 4** (2 can start in parallel with 1; 4
depends on all of them). One PR per workstream.

---

## Ground truth already verified (don't re-derive)

- **The engine's PG "GAP2020" mode is really the GAP2016/2018 formula**
  (leading = 0.35·(1−DW); 0.1·BestDist/TaskDist when nobody in goal). The
  real S7F 2020–2022 generation uses PWC-derived PG weights — distance
  weight **0.838** when nobody makes goal, else
  **0.805 − 1.374·GR + 1.413·GR² − 0.484·GR³**, leading fixed **0.162**,
  arrival 0, time = remainder (exactly 0 at GR=0) — verified in the
  S7F 2020 v2.0 PDF §10 and in AirScore's `gap2020.py`/`gap2021.py`/
  `gap2022.py`. GlideComp does **not** implement it (documented in the
  `/scoring/gap` table and in `gap-params.ts` comments as of PR #398).
- **HG weights are identical in every generation** — only PG is affected.
- **xc.highcloud.net runs the *legacy PHP* AirScore** (geoffwong lineage:
  `comPk`/`tasPk` keys, `get_all_comps.php`), *not* the Python
  FAI-Airscore. Its per-task result JSON (saved by our downloader as
  `airscore-result-raw.json`) includes a `formula` block, e.g. Corryong
  2021 open t1: `{"formula":"gap-2018","goal_penalty":"1","nominal_goal":
  "30%","minimum_distance":"5 km","nominal_distance":"35 km",
  "nominal_time":"90 mins","arrival_scoring":"place","departure":"off",
  "error_margin":0.0005,...}`. Unungra 2020 (PG!) shows the legacy
  vocabulary can diverge further: `"formula":"ggap-2018"`,
  `"departure":"Lkm"`, `"arrival_scoring":"timed"`.
- **The importer throws this away today.** `web/scripts/
  download-airscore-comp.ts` writes `comp.json` without any formula info,
  and `web/scripts/seed-sample-comp.ts` inserts the comp row without
  `gap_params` — every seeded comp scores under the current per-category
  defaults (`defaultsFor` in `web/engine/src/gap-params.ts`). Consequence:
  Corryong 2021 was scored by AirScore with `gap-2018` (2/3 time exponent)
  but GlideComp seeds it with today's default (5/6) — HG *time points* in
  the seeded history are already subtly unfaithful even though weights
  match.
- The comp table has a `gap_params` JSON column (read in
  `web/workers/competition-api/src/scoring.ts` →
  `resolveCompGapParams(category, stored, createdAtMs)`); stored values
  always win over defaults, so seeding explicit params is fully supported
  already.
- Existing parity fixture: `web/samples/comps/corryong-cup-2026-open-t1/`
  (`.curated` marker, `airscore-result.json` reference) tested by
  `web/engine/tests/airscore-parity.test.ts` — HG, `gap-2021`, departure
  OFF (so no leading-points reference).
- Scoring sources are fingerprint-guarded: any change under the hashed
  files requires bumping `SCORING_ENGINE_VERSION` +
  `SCORING_SOURCE_FINGERPRINT` in `web/engine/src/scoring-version.ts`
  (currently **v23**; the failing test prints the new hash).

---

## Legacy vocabulary inventory (1a — DONE, 2026-07-21)

Scanned all 59 `web/samples/comps/*/airscore-result-raw.json` files and
verified the semantics against the legacy Perl scoring source
([geoffwong/airscore]: `Gap.pm`, `GGap.pm`, `get_task_result.php`) — the
codebase xc.highcloud.net actually runs — plus empirical checks against
published points. Findings that reshaped the design:

- **`formula` values on disk:** `gap-2021` (21 tasks), `gap-2018` (17),
  `gap-2007` (13), `gap-hg2013` (4), `ggap-2018` (4). The string is
  `forClass-forVersion` from `tblFormula`.
- **The block varies per CLASS and per TASK inside one GlideComp comp** —
  not per comp as the original plan assumed. Every Corryong year runs
  different nominal distances per class (open 35 km, floater 20–25 km);
  2017 and 2023 score the classes under *different formula generations*
  (2023 open `gap-2021` vs floater `gap-2007`); departure/arrival flip
  between tasks of one class (2024 open t1 vs t2–4; 2025 floater t3).
  Consequence: **`gap_params` became per-task** (migration 0021,
  `task.gap_params` merged over the comp's in every scoring read path);
  the manifest stores the shared base at comp level and per-task diffs.
- **`goal_penalty` = `forGoalSSpenalty` = the fraction of speed AND
  arrival points LOST by an ESS-but-not-goal pilot** (`Pspeed -= Pspeed *
  sspenalty` in Gap.pm) → GlideComp `essNotGoalFactor = 1 − goal_penalty`.
  Values on disk: `"1"` (keep 0% — every comp since 2018, including HG)
  and `"0.2"` (keep 80% — Corryong 2017 open, gap-hg2013). Question
  resolved.
- **`departure`** (per task): `off` | `Dpt` (classic time-delay departure
  points — unimplemented) | `Ldo` (lead-out; maps to leading points, but
  legacy uses the LINEAR-area LC for version ≤ 2022 — `select_coeff`
  switches to `tarLeadingCoeff2` only for > 2022) | `Lkm` (km-marker
  bonus — unimplemented).
- **`arrival`** (per task, on/off) is the real arrival switch;
  `arrival_scoring` (`place` | `timed`, per comp) only picks the curve.
  Unungra 2020's `timed` is therefore harmless — its arrival is **off**
  (open question 3 mostly evaporates). The published `height_bonus` is a
  PHP publishing bug (copies the arrival flag); the real ESS-height-bonus
  flag is the task block's `hbess`.
- **Time-points curve verified empirically:** Corryong 2021 (gap-2018)
  published speed points reproduce exactly under the classic
  `1 − (Δt/√(Tmin/3600))^(2/3)` curve (e.g. 492.8 computed vs 492.8
  published), and the corryong-2026 fixture already proves gap-2021 → 5/6.
  So: version < 2020 → `'2/3'`, ≥ 2020 → `'5/6'`. The published distance
  weight + goal ratio also reproduce `Adistance` to 0.1 pt.
- **Legacy PG weights are knob-driven** (`points_weight` uses the
  published start/arrival/speed weights for non-HG), not the spec's PWC
  generation — so a highcloud PG comp under gap-2020+ may still differ
  from `'s7f2020'`; the mapping warns and the parity report decides.
- **`ggap-*` is GGap, Geoff Wong's own variant** (median-based distance
  validity, LINEAR distance quality, `√(Tmin/1800)` 2/3 time curve, flat
  `weightstart × 1000` leading off the top): not reproducible, warned
  loudly. This is Unungra 2020's formula.
- **`error_margin`** (0.0005 = 0.05% everywhere on disk) is the cylinder
  tolerance; GlideComp's xctsk carries it natively
  (`XCTask.cylinderTolerance`), so the importer now embeds it per task
  (GlideComp's club default is 0.5% — 10× looser than what these comps
  were scored with).
- `start_weight`/`arrival_weight`/`speed_weight` always sum to 1 on disk;
  for HG the Perl hardcodes 1.4/8 + 1/8 anyway. `scale_to_validity` is
  always "0"; `stop_glide_bonus` is "5" only on Unungra (PG — spec says
  4:1; warned, matters only for stopped tasks).
- **Every pre-2026 bundled task's xctsk had a BROKEN speed section** —
  found while curating the gap-2018 fixture. `download_task.php` exports
  tawType `start`→TAKEOFF / `speed`→SSS / `endspeed`→ESS, which is right
  only when a separate `speed` turnpoint exists (the 2026 comps). Every
  earlier task has no `speed` waypoint: its `start` (the big exit ring the
  start gates apply to) IS the SSS, but the export labels it TAKEOFF, so
  the xctsk had no SSS and the engine's fallback (first turnpoint) timed
  the speed section from the wrong cylinder. The downloader now repairs
  turnpoint types from the published result's `tawType` roles
  (`repairTaskXctsk`; 2017/2021/2022 xctsks regenerated and committed).
  With the repair, engine speed-section times match the published elapsed
  times to the second.
- **Legacy `speedrun` tasks are ELAPSED-TIME, not races** — published
  per-pilot start times are arbitrary seconds (16:16:37), so each pilot is
  timed from their own start crossing. 35 of the 59 bundled tasks are
  `speedrun` and were previously built as xctsk RACE (timed from the
  window-open gate — floater-task means in the parity report dropped ~3×
  after the fix). The downloader now maps task_type → sss.type
  (`speedrun-interval`→RACE+gates, `speedrun`→ELAPSED-TIME, `race`→RACE)
  and repairs the on-disk xctsks.
- **Systematic legacy-scorer deviations remain** (documented and bounded
  in the gap-2018 parity fixture; candidates for follow-up engine
  variants if closer history parity is wanted):
  1. *Time validity from the second-fastest time* — Gap.pm's `tqtime`
     feeds time validity, the spec (and GlideComp) use the fastest.
     Scales every published point by ~1% on tasks where the two differ.
  2. *Legacy km-difficulty curve* — `calc_kmdiff` counts each pilot a
     full look-ahead before their landing slot and normalises by the
     landed-out count; more generous at low distances than S7F 2024
     §11.1.1 (a minimum-distance pilot published 120.8 vs spec-2024 ~92
     on the fixture task). Goal pilots are unaffected.
  3. *Track-less pilots deflate published validity vs ours* — AirScore's
     launched/distance-validity denominators count pilots whose tracks
     aren't in the download zip (they appear as min-distance rows or not
     at all); our field is tracks-only, so our distance validity can come
     out higher (e.g. 2026 floater t2: ours 0.60 vs published 0.39).
     Closing this needs importing track-less result rows (as manual
     flights or min-distance statuses) — owner decision.

Implementation (all in this PR): `web/scripts/lib/airscore-formula-map.ts`
(+ tests), `task.gap_params` migration 0021 + merge in
`mergeStoredGapParamsJson` (scoring.ts, visualization.ts,
manual-flight.ts), downloader formula capture + `--manifest-only` backfill
(all bundled manifests + xctsk tolerances committed), seed writes comp +
per-task params, engine `'s7f2020'` generation (v24).

[geoffwong/airscore]: https://github.com/geoffwong/airscore

---

## Workstream 1 — importer carries the AirScore formula into `gap_params`

**Goal:** every imported comp seeds with the parameters AirScore actually
scored it with, not today's defaults. Needed even for pure-HG history
(exponent + LC variant + leading/arrival on-off).

### 1a. Inventory the legacy vocabulary (first task, cheap)

Write a throwaway scan (or a `--inventory` flag on the downloader) that
prints the distinct `formula` blocks across every
`web/samples/comps/*/airscore-result-raw.json` already on disk. This
defines the mapping domain before any code is designed. Expect at least:
`gap-2018`, `gap-2021`, `ggap-2018`; `departure` ∈ {`off`, `on`?, `Lkm`,
…}; `arrival_scoring` ∈ {`place`, `timed`, `off`?}; `goal_penalty`,
`error_margin`, nominal params as strings ("30%", "5 km", "90 mins").
Record the inventory table in this doc when done.

### 1b. Mapping function

New module (suggested: `web/scripts/lib/airscore-formula-map.ts`, script-side
— the engine shouldn't know about legacy AirScore vocab):

`mapAirscoreFormula(block, category) → { gapParams: Partial<GAPParameters>, warnings: string[] }`

| Legacy field | GlideComp param | Mapping |
|---|---|---|
| `formula` gap-2016/gap-2018/ggap-2018 | `timePointsExponent` `'2/3'`, `leadingFormula` `'classic'`, `leadingWeightFormula` `'gap2020'` (correct for this generation — it *is* GAP2016/2018) | |
| `formula` gap-2020/gap-2021/gap-2022 | `timePointsExponent` `'5/6'`; PG: `leadingFormula` `'weighted'`, `leadingWeightFormula` `'s7f2020'` (new, workstream 2); HG: `leadingFormula` `'classic'` | |
| `formula` gap-2023+ | `'5/6'`, PG `'weighted'` + `'s7f2024'` | |
| `nominal_goal` "30%" | `nominalGoal` 0.3 | parse % |
| `nominal_distance` "35 km" | `nominalDistance` 35000 | pins the comp-wide value (replaces the backend's auto-70%) |
| `nominal_time` "90 mins" | `nominalTime` 5400 | |
| `minimum_distance` "5 km" | `minimumDistance` 5000 | |
| `departure` "off" | `useLeading` false | `Lkm` and any lead-out-ish value → true (verify against 1a inventory) |
| `arrival_scoring` "off" | `useArrival` false | `place` → true; **`timed` → warn** (time-based arrival not implemented; see open questions) |
| `goal_penalty` | `essNotGoalFactor`? | **semantics unverified** — legacy value "1" on an HG comp is suspicious (would mean keep 0%). Resolve during 1a by checking a published task where an HG pilot made ESS but not goal; until resolved, warn + leave category default |
| `error_margin` 0.0005 | per-task cylinder tolerance | optional fidelity: GlideComp tolerance is per-task; thread through task seeding if cheap, else warn |

Every unmapped/unknown value must produce a loud warning, not a silent
default. Keep the raw block verbatim in the manifest for provenance.

### 1c. Manifest + seed changes

- `download-airscore-comp.ts`: after fetching each task, extract the
  `formula` block; assert it's consistent across a comp's tasks (warn and
  record per-task if not); write into `comp.json` as both
  `airscore_formula` (raw, provenance) and `gap_params` (mapped). Add a
  **`--manifest-only`** flag that regenerates `comp.json` from the raw
  JSONs already on disk — the whole bundled back-catalogue can be
  backfilled without re-hitting the server. (Respect `.curated` folders as
  today.)
- `seed-sample-comp.ts`: when the manifest has `gap_params`, write the
  JSON into the comp row on insert *and* on the idempotent update path.
  Scores are stale-first so no extra invalidation is needed at seed time,
  but re-seeding an existing comp with changed gap_params must go through
  the same stale-marking the seed script already does for re-seeded tracks
  — verify that path touches `task_scores` (it should; if not, call
  `bumpScoreInputs`-equivalent SQL from the script).
- Backfill: run `--manifest-only` over all bundled comps and commit the
  regenerated manifests. **Check the parity impact before committing**: the
  curated corryong-cup-2026 fixture's published comp ran departure OFF —
  after backfill the seeded comp will too, which is *more* faithful but
  changes displayed scores; sanity-check a couple of tasks by hand.

**Done when:** `bun run seed` produces comps whose settings dialog shows
the AirScore-era parameters (e.g. Corryong 2021 → 2/3 exponent, leading
off), and the doc table in this file lists the vocabulary inventory.

---

## Workstream 2 — implement the S7F 2020–2022 PG weight generation

**Goal:** close the one remaining formula gap so PG comps scored by
AirScore's gap-2020/2021/2022 (and by the real S7F 2020–2022 spec) are
reproducible.

- `web/engine/src/gap-params.ts`: extend
  `LeadingWeightFormula = 'gap2020' | 's7f2020' | 's7f2024'`. Keep the
  stored `'gap2020'` value and its meaning untouched (no migration, no
  score shifts). Document that `'s7f2020'` — unlike the other two — also
  switches the **PG distance weight** to the PWC polynomial; the name of
  the param is now slightly too narrow, which the docblock should admit.
- `web/engine/src/gap-formulas.ts` `calculateWeights`: for
  `scoring === 'PG' && leadingWeightFormula === 's7f2020'`:
  `dw = gr === 0 ? 0.838 : 0.805 − 1.374·gr + 1.413·gr² − 0.484·gr³`;
  `lw = useLeading ? 0.162 : 0`; `aw = 0`; `tw = 1 − dw − lw` (comes out
  exactly 0 at gr = 0). HG path unchanged.
- `resolveCompGapParams` / `defaultsFor`: **no default changes** —
  `'s7f2020'` is only ever selected explicitly (settings dialog) or by the
  workstream-1 importer mapping.
- Settings UI (`web/frontend/src/react/comp/SettingsDialog.tsx`): third
  option "S7F 2020–2022 — PWC weights (AirScore gap2020/21/22)"; helper
  text gains one sentence. Hide the LeadingTimeRatio field for it (as for
  gap2020).
- Score explanation: wherever the weight formula is named
  (`score-explanation-sections.ts`, PilotScoreDetail) add the third name.
- `/scoring/gap` doc: update the PG-weights table cell + the prose
  subsection (both currently say "not implemented"), and the
  leading-weight bullet list.
- Tests: unit-test the exact weights at GR = 0, 0.3, 1.0 (expected DW at
  GR=1: 0.805 − 1.374 + 1.413 − 0.484 = 0.36); integration test that a PG
  field scored under `'s7f2020'` distributes 0.162·quality·1000 leading
  points.
- **Bump `SCORING_ENGINE_VERSION` to v24** + new fingerprint (behaviour
  addition; existing comps unaffected but the guard fires regardless).

**Done when:** typecheck + full `test:all` green, and workstream 1's
mapping can emit `'s7f2020'` without a warning.

---

## Workstream 3 — per-generation parity fixtures

**Status (2026-07-21):** fixture (1) is DONE — `corryong-cup-2021-open-t1`
is curated (`.curated` + trimmed `airscore-result.json`) and
`airscore-parity.test.ts` scores it under the importer-mapped gap-2018
params: goal count, weights, per-pilot 2/3-curve time points and
goal-pilot totals match the published numbers (quality-scaled for the
legacy tqtime rule; landed-out totals bounded around the legacy
difficulty-curve deviation — both documented above). PG coverage is
option (c) for now: the spec-derived `'s7f2020'` unit/integration tests
from workstream 2 — no gap-2020+ PG comp exists on disk (Unungra is
`ggap-2018`); revisit after workstream 4's enumeration (option a).

**Goal:** turn "we mapped the formula correctly" into regression tests
against real published AirScore totals, per generation.

- Today's coverage: HG `gap-2021` (corryong-cup-2026-open-t1, departure
  off). Add:
  1. **HG gap-2018** — any Corryong 2021 task; raw JSON with published
     per-pilot totals is already on disk. Curate it like the 2026 fixture
     (`.curated` marker + trimmed `airscore-result.json` reference with
     weights + per-pilot dist/time/total) and extend
     `airscore-parity.test.ts` (or a sibling test file) to score it under
     the workstream-1 mapped params (2/3 exponent!) and compare.
  2. **PG fixture** — Unungra 2020 is PG but was scored with legacy
     `ggap-2018` + `timed` arrival + `Lkm` departure, which we can't fully
     reproduce (timed arrival unimplemented). Options, in order of
     preference: (a) find a PG comp on xc.highcloud.net (or another public
     legacy-AirScore instance) scored with `gap-2020`/`gap-2021` — check
     `get_all_comps.php` during workstream 4's enumeration; (b) if none
     exists, a *weights-only* parity check: assert our `'s7f2020'` weights
     reproduce the `start_weight`/`speed_weight`/distance weight numbers
     published in PG task JSONs; (c) accept spec-PDF-derived unit tests
     from workstream 2 as the only PG coverage and say so in the doc.
- Parity tolerance: follow the existing test's tolerances (it compares
  dist/time points and totals; keep any relaxation explicit per-fixture
  with a comment saying why, e.g. route-optimizer differences).
- While curating the gap-2018 fixture, use it to **resolve the
  `goal_penalty` semantics question** from workstream 1b.

**Done when:** at least fixtures (1) and one of (2a/2b) run in CI.

---

## Workstream 4 — load the competition history (2020 → present)

**Status (2026-07-21):** the tooling is DONE — `history: true` registry
entries flow into the manifest and `bun run seed` skips them unless named
or `--history` is passed; `bun web/scripts/verify-airscore-parity.ts
<slug>` prints the per-task parity report (formula, warnings, matched
pilots, mean/max |Δtotal|, thresholds ±2 mean / ±10 max). The
enumeration is done (one polite `get_all_comps.php` request,
2026-07-21): **145 race comps with tasks since 2020-01-01** on
xc.highcloud.net. Highlights by lineage (comPk in parens):

- **Corryong Cup** (HG): already bundled 2021–2026.
- **Forbes Flatlands** (HG): 2020 (283), 2022 (333 + sports 334),
  2023 (365/366), 2024 (396/398), 2025 (434/435), 2026 (462/463).
- **Dalby Big Air** (HG): 2021 (316), 2022 (343/347), 2023 (375/376),
  2024 (407/408), 2025 (446), 2026 (493/494).
- **NSW HG State Titles**: 2020 (288), 2021 (314), 2022 (342),
  2023 (373/374), 2024 (405), 2025 (440/441), 2026 (486/487).
- **Bright Open** (PG): 2020 (281), 2021 (310), 2022 (317), 2023 (370),
  2024 (402), 2025 (431), 2026 (464) — prime candidates for the PG
  gap-2020+ parity fixture (workstream 3 option a).
- **Flow Corryong PG Open**: 2020 (287), 2021 (311), 2022 (337),
  2023 (369), 2025 (430), 2026 (476).
- **QLD Champs / Canungra** (PG): 2021 (300), 2022 (328), 2023 (367),
  2024 (400), 2025 (445), plus Canungra Cups.
- Plus NZ comps (NZ PG Opens, NZ HG Champs, Auckland/Otago leagues),
  Barraba Big Toe 2020 (299, HG 7 tasks), Paint It Black (289), Wings
  Out West (340), and European comps from 2025 on (Dutch Open Laragne
  450, Liga Canaria 455, Copa Niviuk 473, El Peñon 482).

The full 404-comp catalogue is one `get_all_comps.php` fetch away; the
owner picks which lineages to load (open question 1 below still applies
for repo-size policy). Verify-report learnings from the bundled comps:
the known legacy deviations (tqtime validity, difficulty curve,
track-less pilots — see the inventory section) put real comps at mean
|Δtotal| ~20–90 unscaled, so thresholds need the quality-ratio treatment
or the follow-up engine variants before they can be tightened to ±2/±10.

**Goal:** real comps from ~2020 onward, seeded and publicly visible.

1. **Enumerate** what xc.highcloud.net actually hosts:
   `get_all_comps.php` (the downloader's comment says comPks come from
   there). Build a candidate list (name, year, class HG/PG, formula,
   task/pilot counts, tracks available) and get the comp owner's pick.
   Politeness rules as today (`REQUEST_DELAY_MS` ≥ 3500 ms, UA string,
   idempotent re-runs).
2. **Repo-size policy — decide before downloading** (open question below):
   the bundled set is already ~1,600 IGCs. Recommended split:
   - *bundled in git*: only parity fixtures and comps we want in every dev
     seed (`bun run seed`);
   - *history*: committed `COMPS`-registry entries (small) + a one-off
     `download → seed --remote` run into prod D1/R2, with the IGC folders
     kept out of git (e.g. a `web/samples/comps/.history/` path in
     `.gitignore`, or a `--dir` override). Reproducible because the
     registry + downloader are committed; re-runnable if prod is ever
     reseeded.
3. **Extend the `COMPS` registry** with the chosen comps (use the
   `corryongCup()`-style helpers; set `compName`, `category`, and — new —
   let a registry entry mark itself `history: true` so `bun run seed`
   skips it unless asked (`bun run seed --history` or explicit slugs).
4. **Import order per comp:** download → manifest with mapped
   `gap_params` (workstream 1) → seed locally → **parity report** → seed
   `--remote`. The parity report is a small script (suggested:
   `bun web/scripts/verify-airscore-parity.ts <slug>`) that scores each
   seeded task with the engine and prints per-task mean/max absolute
   total-point difference vs the `airscore-result-raw.json` published
   totals, flagging tasks above a threshold (start at ±2 pts mean / ±10
   max, tighten from experience). Comps that can't be reproduced (legacy
   formulas like `ggap-2018` timed-arrival) get seeded anyway but their
   report is recorded in the comp description or this doc — transparency
   over silent wrongness.
5. Housekeeping per comp: `hidden` **false** (real public comps — they're
   the SEO content), correct `category`, timezone from task data as today,
   and the D1 `creation_date` note: `resolveCompGapParams` uses creation
   date for the PG leading-weight *default*, but every imported comp gets
   **explicit** `gap_params`, so the date-based default never applies —
   no backdating needed.

**Done when:** owner-approved comp list is live in prod, each with a
recorded parity report.

---

## Decisions (owner, 2026-07-21)

1. **Repo-size policy — DECIDED: separate archive repo.** The history
   lives in **pokle/glidecomp-comp-archive** (`comps/<slug>…`, same layout
   as `web/samples/comps/`). GlideComp keeps only each competition's most
   recent year bundled (Corryong 2026 + Unungra 2020, its only year) plus
   the curated parity-fixture task folders CI scores
   (`corryong-cup-2021-open-t1`, `corryong-cup-2026-open-t1`); Corryong
   2017 & 2021–2025 moved to the archive. All comp scripts take
   `GLIDECOMP_COMPS_DIR=<archive>/comps`; archive comps are
   `history: true` in the registry, so the default `bun run seed` skips
   them. First tranche downloaded into the archive: Forbes Flatlands
   2020–2026, Dalby Big Air 2021–2026, Bright Open 2020–2026 (PG).
2. **Track-less result rows — DECIDED: import them (option A).** The seed
   now synthesizes every published result row that has no (or an empty)
   IGC: `dnf` rows become a DNF pilot status (launch validity, §9.1);
   flown rows become an S7F §8.4 manual flight landed at the published
   distance along the optimised route plus a "landed" status — so the
   seeded field matches the field AirScore scored. Bare `lo` rows land at
   the start (scored at minimum distance). ~19 such rows exist across the
   Corryong catalogue, plus the empty-IGC pilots the seed previously
   dropped silently (e.g. Corryong 2026 floater t1: 7 tracked + 15
   synthesized = the published 22).
3. **Legacy scorer variants — DECIDED: don't implement (option B).** The
   `tqtime` second-fastest time validity and the legacy km-difficulty
   curve stay documented deviations (bounded in the gap-2018 fixture),
   not engine knobs. Revisit only if future parity reports make the
   noise floor unworkable.

## Resolved earlier

- ~~`goal_penalty` semantics~~ — fraction of speed+arrival points lost at
  ESS-without-goal (`essNotGoalFactor = 1 − goal_penalty`), verified in
  Gap.pm and empirically (see the inventory section).
- ~~Timed (OzGAP) arrival for Unungra~~ — mostly moot: Unungra's arrival
  is off (`arrival_scoring: timed` is just the stored method); timed
  arrival only actually applies to Corryong 2024 open t2–4 (warned).
  Unungra remains unreproducible anyway (GGap).
- ~~Which PG comps exist~~ — Bright Opens / Flow Corryong / QLD Champs
  2020–2026 (see workstream 4 status); check their formula blocks in the
  archive downloads for a gap-2020+ PG fixture.

[biuti/airscore-app]: https://github.com/biuti/airscore-app
