# FSDB Two-Way Regression Test Harness — Implementation Plan

**Date:** 2026-07-11
**Status:** Plan (pre-implementation)
**Scope of this iteration:** Tests and command-line tools only. **No UI, no worker HTTP endpoints, no D1 schema changes.** All FSDB code is a pure library + CLIs + `bun test` suites.

---

## 1. Goal

Give GlideComp the ability to **import** (and later **export**) FSDB — the FS/AirScore competition XML format — and use real post-2020 competition FSDB files as a regression corpus that validates GlideComp's scoring against known-good official results.

The immediate payoff is **Mode B**: import an FSDB's task + formula + roster, associate the IGC tracks, run GlideComp's engine, and diff the computed scores against the official `FsResult` values embedded in the FSDB. Any divergence is a precise, localised bug signal for GlideComp's scoring.

This plan follows the brief (`glidecompfsdbregressionbrief.md`) but is re-shaped around what the GlideComp codebase actually is (findings in §3).

---

## 2. Decisions for this iteration

Two shaping decisions were defaulted (flagged for confirmation in §11):

- **D1 — First cut = Reader + Mode B.** Build the FSDB parser and the headline rescore-from-IGC harness. Defer the writer and Mode A (structural round-trip) to a follow-up, and Mode C (AirScore oracle) further out. Rationale: Mode B is the "headline" in the brief and delivers the regression value; the writer is only needed for export/round-trip/sanctioning, which are explicitly future.
- **D2 — Corpus = bundled samples + ≥1 real FSDB.** A real hand-downloaded FSDB is *required* to test the parser against real-world schema drift. Mode B breadth then rides on the **existing bundled AirScore sample comps** (`web/samples/comps/*`), which already ship `task.xctsk` + IGC tracks + `airscore-result-raw.json` (the official-scored baseline). This keeps CI green from day one without waiting on manual civlcomps downloads.

Decisions taken outright (documented, not blocking):

- **D3 — Code lives in a new `web/fsdb/` workspace package** that depends on `@glidecomp/engine`, not inside the engine. Keeps the engine dependency-free (it must stay Workers-bundle-lean) while letting FSDB code reuse `XCTask`, `GAPParameters`, `PilotFlight`, and the scoring entrypoints.
- **D4 — XML via `fast-xml-parser`.** Pure-JS, Workers-compatible, well-maintained, preserves attributes and CDATA, and round-trips (has a builder for the future writer). No XML lib exists in the repo today. It goes in `web/fsdb/`, so the engine gains no dependency.
- **D5 — Clean-room only.** Repo license is **MIT**; AirScore is GPLv2. We derive the schema from the FAI-Airscore FSDB module + a real sample and reimplement. No GPL source is copied. The existing `transformAirScoreTask` (`web/workers/airscore-api/src/transforms/task.ts`) is our clean-room precedent to mirror.
- **D6 — Earth model: WGS84-only initially.** GlideComp's scorer always uses WGS84 (`web/engine/src/geo.ts`); `XCTask.earthModel` is parsed but never consumed. AirScore-scored fixtures are WGS84, so this does not block the initial corpus. FSDB tasks declaring `FAI_SPHERE` are **skipped with a clear reason** by the Mode B alignment guard. Threading a real FAI-sphere model through `geo.ts`/`task-optimizer.ts`/`turnpoint-sequence.ts` is a separate, later engine task (see §10).

---

## 3. Phase 0 survey findings (the map)

### Language / build / test
- TypeScript monorepo, Bun + Vite + Cloudflare. Engine (`web/engine`) and `airscore-api` use **`bun test`** (`import from 'bun:test'`, auto-discovered `*.test.ts`); competition-api/auth-api/frontend use vitest. `bun run test` runs the engine suite + typecheck.
- CLIs are hand-rolled `process.argv.slice(2)` scripts (no commander/yargs) in `web/engine/cli/` and `web/scripts/`, registered as npm scripts in root `package.json`. `score-task` is the closest analogue to what we're building.

### Scoring engine (`web/engine/src/`)
- Entrypoints: **`scoreTask(task, pilots, params?, numPresent?)`** (`gap-scoring.ts:1382`) and the compact **`scoreFlights(...)`** (`gap-scoring.ts:1084`). Input `PilotFlight = { pilotName, trackFile, fixes: IGCFix[] }`.
- **One parameterized GAP**, not per-year modules. Version knob is `GAPParameters.leadingFormula: 'weighted'` (GAP2020+/current S7F, speed exponent 5/6) vs `'classic'` (GAP2016/18 & PWC≤2017, exponent 2/3), plus `scoring: 'PG'|'HG'` and `useLeading`/`useArrival` toggles. Defaults in `DEFAULT_GAP_PARAMETERS` (`gap-scoring.ts:110`).
- Components all present and diffable: launch/distance/time validity + task validity (`gap-scoring.ts:276–341`), weights (`:377`), distance (PG linear + HG difficulty) (`:421,:458,:547`), time/speed (`:590,:615`), leading (`:722,:838,:896,:922`), arrival (`:942`), jump-the-gun (`:1315`).
- **Rounding:** total and each component rounded to **0.1** (`roundToTenth`, `gap-scoring.ts:30, 1326–1343`), not integer. (FSDB GAP points are integers — the harness must account for this in tolerances.)
- Optimal distance: `task-optimizer.ts` (`calculateOptimizedTaskDistance` `:223`). Per-pilot best-valid-path: `turnpoint-sequence.ts` (`resolveTurnpointSequence` `:660`).
- **Earth model:** WGS84 hardcoded (`geo.ts` WGS84 constants; `andoyerDistance` `:40`, `destinationPoint` `:118`). `earthModel` referenced only in `xctsk-parser.ts` — never in the scoring path.
- Output: `PilotScore` (`gap-scoring.ts:172`) — plain JSON-serialisable struct with per-component breakdown, `flownDistance`, `speedSectionTime`, `madeGoal`, `reachedESS`, `rank`, `leadingCoefficient`, early-start fields. Container `TaskScoreResult` (`:232`).
- **Determinism guard:** `SCORING_ENGINE_VERSION` + `SCORING_SOURCE_FINGERPRINT` (`scoring-version.ts`), enforced by `tests/scoring-version.test.ts`. Our FSDB package must **not** touch scoring sources; if a future FAI-sphere change does, the fingerprint needs re-bumping.

### Domain model
- `XCTask` (`xctsk-parser.ts:41`): `turnpoints[]` of `Turnpoint{type?: 'TAKEOFF'|'SSS'|'ESS', radius, waypoint{name,lat,lon}}`; **goal is implicit = last turnpoint** (`getGoalIndex`). `sss: {type:'RACE'|'ELAPSED-TIME', direction:'ENTER'|'EXIT', timeGates[]}`, `goal: {type:'CYLINDER'|'LINE'}`, `takeoff: {timeOpen,timeClose}`, `earthModel?`, `cylinderTolerance?`.
- Pilots: global `pilot` + per-comp `comp_pilot` (with `registered_pilot_civl_id` etc.). **No nationality / sex / birthday** anywhere in the model. CIVL ID + several sporting-body IDs are present.
- Scores persisted as an opaque JSON blob in D1 `task_scores.response_json` (stale-first cache). Structured internally but not column-diffable. **The harness bypasses D1 entirely** and calls the engine directly (deterministic + versioned).
- **No stopped-task model** (no stop time, no score-back time, no ESS-altitude bonus).

### Existing building blocks to reuse (not rebuild)
- `parseIGC` (`igc-parser.ts:295`) → `IGCFile { header, fixes, ... }`.
- `parseXCTask`/`toXctskJSON`/`igcTaskToXCTask` (`xctsk-parser.ts`) — geometry conversion template.
- `transformAirScoreTask`/`extractFormulaInfo` (`airscore-api/src/transforms/task.ts`) — clean-room AirScore→XCTask precedent, directly analogous to FSDB→XCTask.
- `score-task.ts` CLI — the invocation + IGC-loading + JSON-output pattern to mirror.
- `airscore-parity.test.ts` — the existing "score a sample, diff against AirScore output" test; our Mode B harness is a generalisation of it.
- Sample comps: `corryong-cup-{2017,2021..2026}` (open+floater, real, WGS84, AirScore-scored), `unungra-cup-2020`, synthetic `big-chip`.

### Gaps to design around
1. **FAI-sphere ignored** (D6 handles: guard skips such fixtures for now).
2. **No pilot nat/sex/birthday** — parse from FSDB into the *OfficialResult / imported-model* structure held by the harness; do not attempt to persist into D1 this iteration.
3. **No stopped-task model** — FSDB `FsTaskState=STOPPED` fixtures are skipped by the Mode B guard with a reason.
4. **0.1 vs integer rounding** — tolerance design (§6) compares pre-round floats separately from integer points.

---

## 4. Package & file layout

```
web/fsdb/                          # NEW workspace package, depends on @glidecomp/engine
  package.json                     # deps: fast-xml-parser; devDeps: bun types
  src/
    index.ts                       # public exports
    schema.ts                      # TS types for the FSDB subset we read (Fs* shapes)
    reader.ts                      # parseFsdb(xml: string): FsdbDocument
    model-map.ts                   # FsdbDocument -> { task: XCTask, params: GAPParameters,
                                    #                   pilots: FsParticipant[], official: OfficialResults }
    official-results.ts            # OfficialResult / OfficialResults types (kept SEPARATE from engine output)
    formula-map.ts                 # FsScoreFormula id + attrs -> GAPParameters + leadingFormula
    track-association.ts           # match IGC files to FsParticipant/@id (fsdb_igc normalisation rules)
    tolerances.ts                  # per-field tolerance config for Mode B
    compare.ts                     # score-comparison + diff-report builder (Mode B)
    fixtures.ts                    # fixture loader + meta.yaml parsing/classification
  cli/
    fsdb-inspect.ts                # parse an FSDB, print comp/task/formula/roster summary (+ --json)
    fsdb-rescore.ts               # Mode B on demand: FSDB (+ tracks) -> rescore -> diff report
  tests/
    reader.test.ts                 # parses every fixture; asserts hand-verified fields from 1 reference
    formula-map.test.ts            # formula-id -> params mapping
    mode-b.test.ts                 # rescore vs official within tolerance, across the corpus
  SCHEMA-NOTES.md                  # concise FSDB schema note (derived from source + real sample)
  README.md                        # how to add a fixture (manual civlcomps download), run modes

fixtures/fsdb/                     # NEW corpus root (real FSDBs are git-tracked; big IGC bundles noted)
  <comp-slug>/
    comp.fsdb
    tracks/task-N/*.igc            # optional; Mode B needs it
    meta.yaml                      # provenance + classification (§7)
```

Root `package.json` gains scripts: `fsdb:inspect`, `fsdb:rescore`, and the `bun test` glob is extended to include `./web/fsdb`.

---

## 5. Mode B pipeline (headline)

```
comp.fsdb ──parseFsdb──► FsdbDocument
                           │
              ┌────────────┼─────────────┐
              ▼            ▼             ▼
        task: XCTask  params: GAP   official: OfficialResults   (per pilot, per task — SEPARATE struct)
              │            │
   associate IGC bundle by FsParticipant/@id  ──►  PilotFlight[]
              │
        scoreTask(task, pilots, params) ──► TaskScoreResult (GlideComp computed)
              │
        compare(official, computed, tolerances) ──► DiffReport
```

**Alignment guards (fail loudly / skip with reason):**
- Earth model: if FSDB task declares `FAI_SPHERE` → **skip** ("FAI sphere not implemented in scorer; WGS84 only").
- Formula: map `FsScoreFormula/@id` → `GAPParameters`. If the id needs a variant GlideComp can't express (e.g. an unsupported PWC year, a stopped-task rule) → **skip/xfail** with the specific reason.
- Stopped task (`FsTaskState=STOPPED`) → **skip** ("stopped-task scoring not modelled").
- Missing embedded `FsResult` or missing IGC bundle → **skip** (not a Mode B fixture).

The separation of `official` from `computed` is deliberate (brief §5.1): we never compare GlideComp against its own output.

---

## 6. Tolerances & diff report (Mode B)

Compare at two levels so rounding drift is distinguishable from algorithmic error:

| Quantity | Tolerance |
|---|---|
| Total points, each point component (distance/time/leading/arrival) | integer compare with **±1** absorb for rounding-order; note GlideComp rounds to 0.1, FSDB to integer — round GlideComp to int before comparing |
| Pre-round floats: flown distance, ss distance, ESS time, leading coefficient, validities, day quality | relative tol **1e-3** + absolute floor **~5 m** for distances |
| Rank | exact |
| Time (ss time / ess time) | exact seconds |

**Diff report** (emitted on mismatch, and always in `--json`): per-pilot × per-task × per-component table of *official / GlideComp / delta*, sorted by largest delta, with intermediate quantities dumped (flown distance, leading coefficient, validities) so a divergence localises itself — e.g. "distances match but leading points diverge" points at the leading integral, not the optimiser. Written by `compare.ts`; the `fsdb-rescore` CLI prints it as a text table (default) or JSON (`--json`).

---

## 7. Fixture corpus & `meta.yaml`

`meta.yaml` per fixture: `source_url`, `formula` (e.g. `GAP2020`), `discipline` (`hg`|`pg`), `task_types`, `earth_model` (`WGS84`|`FAI_SPHERE`, per task if they differ), `has_tracks` (bool), `trust` (`verified`|`cross_checked`|`suspect`).

Rules the loader enforces:
- Mode B uses only `verified`/`cross_checked` fixtures; `suspect` (e.g. GAP-2021-bug-affected events) are excluded from Mode B and reserved for the future Mode C oracle.
- `has_tracks: false` → Mode B skips (parser test still runs).

**Coverage matrix to fill over time** (each row exercises different turnpoint-validation / best-path / GAP paths): race-to-goal vs elapsed-time; cylinder vs line goal; ESS==goal vs separate; single vs multiple start gates; SSS enter vs exit; stopped (skipped for now); HG vs PG; small vs large field; each formula variant GlideComp implements (weighted / classic).

Because a real FSDB must be downloaded manually (civlcomps blocks scraping), `README.md` documents the drop-in procedure. The initial real fixture(s): target a post-2020 AirScore-scored, WGS84, race-to-goal event so it aligns cleanly (candidates from the brief: a French Open / Trophées des Cimes Cat 2, or a 2022–2025 Worlds/Europeans task). The bundled `corryong-cup-*` comps back the broader Mode B breadth immediately, using `airscore-result-raw.json` as the official baseline while FSDB fixtures accumulate.

---

## 8. Phased breakdown (this iteration)

**Phase 0 — scaffolding** *(small)*
- Create `web/fsdb/` package (package.json, tsconfig wiring, add to root test glob + typecheck:all).
- Create `fixtures/fsdb/` + `fixtures.ts` loader + `meta.yaml` schema + `README.md` "how to add a fixture" stub.

**Phase 1 — FSDB reader** *(core)*
- `SCHEMA-NOTES.md`: concise FSDB schema derived from the FAI-Airscore FSDB module + one real sample.
- `schema.ts` + `reader.ts`: `parseFsdb(xml) → FsdbDocument`. Key on `FsParticipant/@id`. Lenient about unknown elements (version drift), handle CDATA / optional / missing.
- `official-results.ts`: `OfficialResults` struct, kept separate from engine output.
- `model-map.ts` + `formula-map.ts`: FSDB → `XCTask` + `GAPParameters` (mirror `transformAirScoreTask`).
- `fsdb-inspect` CLI.
- Tests: every fixture parses without error; assert hand-verified field values from one reference fixture; formula-map unit tests.

**Phase 2 — Mode B rescore harness** *(headline)*
- `track-association.ts` (IGC ↔ `@id`, `fsdb_igc` filename normalisation).
- `tolerances.ts` + `compare.ts` (two-level tolerances + diff reporter).
- Alignment guards (earth model / formula / stopped / missing data → skip with reason).
- `fsdb-rescore` CLI.
- `mode-b.test.ts`: run across the corpus (real FSDB fixtures + bundled AirScore comps adapter).
- **Acceptance:** GlideComp reproduces official results within tolerance for every in-scope `verified` fixture; each remaining discrepancy is either an explained rounding/tolerance case or a filed issue with a localised diff.

**Phase 3 — CI + docs** *(small)*
- Ensure `bun run test` covers `web/fsdb`; wire fixtures so CI is green with the checked-in corpus.
- Doc: adding a fixture, tolerance rationale, formula-version coverage, known-suspect list.

**Deferred to follow-ups (out of scope now):** FSDB **writer** + Mode A round-trip contract; **Mode C** AirScore Docker oracle; **FAI-sphere** scoring in the engine; any UI / worker / D1 exposure.

---

## 9. Testing strategy

- Unit: reader field extraction, formula mapping, track-association normalisation, tolerance/compare logic (synthetic inputs).
- Integration (Mode B): full pipeline per fixture under `bun test`, using `.skip` with a printed reason for guard-failed fixtures so the suite stays green and honest.
- Determinism: no changes to engine scoring sources this iteration → `scoring-version.test.ts` stays untouched.

---

## 10. Future work (named, not built here)
- **FSDB writer + Mode A** structural round-trip (contract + canonical normalise + semantic compare); smoke-open an exported FSDB in AirScore/FS.
- **FAI-sphere earth model** threaded through `geo.ts` / `task-optimizer.ts` / `turnpoint-sequence.ts`, selectable at score time (unlocks FAI-sphere fixtures; requires `SCORING_ENGINE_VERSION` bump).
- **Mode C** AirScore Docker oracle for `suspect`/disputed cases and independent export validation.
- Model gaps if ever needed for export: pilot nat/sex/birthday, stopped-task scoring.

---

## 11. Open questions (please confirm — defaults assumed)
1. **First cut (D1):** defaulted to *Reader + Mode B*. Prefer instead *Reader + Mode A* (writer/round-trip first) or *Full A+B*?
2. **Corpus (D2):** defaulted to *bundled samples + ≥1 real FSDB*. OK to check a real FSDB (and, if licensing-clear, its IGC bundle) into the repo under `fixtures/fsdb/`? Any specific event you want as the first real fixture?
3. Confirm `web/fsdb/` as a **new package** (vs `web/engine/src/fsdb/`) and `fast-xml-parser` as the XML dependency.
4. Confirm **FAI-sphere fixtures are skipped** for now rather than blocking on engine earth-model support.
