# Migrating GAP scoring to FAI S7F 2026 (single-edition strategy)

**Status: implemented, 2026-08-09** (same day, engine versions v40–v45 on
this branch). Point-in-time snapshot; the issues it spawns are the live
tracker. What shipped differs from the plan below in two scoped-down ways:

- **Phase 5**: the Vincenty inverse landed (`ellipsoidDistance`, §7.1.5
  compliance); the §7.1.3 PathFinder + LTM route optimisation did NOT — the
  corpus-verified optimiser stands in, documented as a deviation on
  `/scoring/gap`. Follow-up work.
- **Phase 4**: fixed tolerances and the optimised goal-line orientation
  landed; the §9.2.4 validation-time details stay tracked in #586/#587,
  which need re-reading against the 2026 text.
- **Phase 6** (Elevated Goal, altitude limits) was deferred entirely by
  owner decision — needs a follow-up issue.

GlideComp implements the 2024 edition of FAI Sporting Code Section 7F
([docs/reference/fai-s7f-xc-scoring-2024/](reference/fai-s7f-xc-scoring-2024/s7f-xc-scoring-2024.md)).
The 2026 edition V1.0 (effective 1 May 2026) is transcribed at
[docs/reference/fai-s7f-xc-scoring-2026/](reference/fai-s7f-xc-scoring-2026/s7f-xc-scoring-2026.md).
FAI's 2025 edition was never ingested; its changes are folded into the 2026
document's change history (§2.1.1.14), so the migration target is the **2025 +
2026 change lists combined**.

## Strategy: one edition, no formula archaeology

Owner decision: **GlideComp scores everything under the 2026 rules.** We do not
keep the 2024 formulas alongside, and we take the opportunity to delete the
pre-2024 formula variants the engine still carries. Transparency comes from
labelling, not from multi-edition support: the report card, scores pages and
`/scoring/gap` state plainly that scores are computed under S7F 2026.

Consequences accepted up front:

- **Historical comps and AirScore imports get rescored under 2026 rules**, so
  their GlideComp scores will differ (slightly, mostly) from the officially
  published results. The report card's edition label is what makes this honest.
- **The AirScore parity gate changes meaning.** `airscore-parity.test.ts` and
  `verify-airscore-parity.ts` assert value-identity with results computed under
  older formulas; that identity is no longer expected. See "Verification".
- The `ScoringPreset` extension point in `gap-params.ts:202` stays reserved and
  unused — exactly one preset, now meaning 2026.

## What actually changes, 2024 → 2026

### Section renumbering

The 2026 edition inserts §7 (algorithms) and §8 (flying a task), shifting most
of the sections the code cites by +1. Every citation in code is a string
literal, so this is a sweep, not a refactor:

| Topic | 2024 | 2026 |
|---|---|---|
| Task/flight distances | §6.4 + Annex A | §7 |
| Task evaluation (tolerances, crossings, flown distance, time) | §8 | §9 (validation rewritten as §9.2) |
| Task validity | §9 | §10 |
| Points allocation | §10 | §11 |
| Pilot score (distance/time/leading/arrival) | §11 | §12 |
| Special cases (ESS-not-goal, early start, stopped, penalties) | §12 | §13 |
| Task / competition ranking | §13 / §14 | §14 / §15 |
| FTV | §15 | §16 |

### Numeric and formula deltas

| Item | 2024 (implemented) | 2026 | Engine anchor |
|---|---|---|---|
| Launch validity linear coefficient | 0.027 | **0.028** (typo fix) | `gap-formulas.ts:41` |
| Nominal Launch | comp parameter, default 96% | **fixed 96%**, no longer a parameter | `gap-params.ts` |
| Nominal Goal | comp parameter (raw default 0.2, `defaultsFor` 0.3) | **fixed 30%**, no longer a parameter | `gap-params.ts` |
| Leading Time Ratio | PG parameter 0–50% (default 26%); HG hard-wired (1−dw)/8·1.4 = 17.5% | **both disciplines settable 0–26%**; defaults PG 26%, HG 17.5% | `gap-formulas.ts:284-319`, `validators.ts:65` |
| PG leading coefficient | 2024 area formula (truncated in the source PDF) | **new integral form**: leadingArea = Σ minToESS·taskTime·∫weight over the done-fraction interval; missingArea likewise | `gap-formulas.ts:637,710` |
| Speed-section score-back | parameter, default 5 min | **fixed**: HG 15 min, PG 5 min | `gap-stopped.ts:36,73` |
| Stopped-task minimum duration | min(1 h, NomTime/2) | **HG only**; PG none — instead stopped PG tasks with task validity < 0.05 are excluded from competition ranking (§15) | `gap-stopped.ts:105`, `ftv.ts` |
| Stopped: pilots between ESS and goal | scored for their complete flight, past stop time | **scored only to stop time**; timePointsReduction taken from a defined reference pilot; the reduction is **added to available distance points** (§13.4.5, all-new) | `gap-scoring.ts:356,651` |
| Stopped: altitude bonus glide ratio | HG 5.0 / PG 4.0 | HG 5.0 / **PG 2.5** | `gap-stopped.ts:24-25` |
| Stopped: bonus distance | best over every track point | **only the position at task stop time**, capped at task distance | `gap-scoring.ts` stopped path |
| Cylinder tolerance | 0.1% (Cat 1) / 0.5% (Cat 2), min 5 m | **0% relative, 5 m absolute** | `turnpoint-sequence*.ts` |
| Line tolerance | derived from line geometry, min 5 m | **flat 5 m** | goal/line handling |
| Goal line orientation | perpendicular to previous *turnpoint centre* | perpendicular to the **optimised route point** on the last control zone | `goal-line.ts` |
| Distance/route algorithms | prose + Annex A pseudocode | **normative**: LTM projection, PathFinder (Ding et al. 2018), ProjectionCorrection, geodesics via Karney/Thomas/Vincenty; scoring must use InverseGeodesic distance (§7.1.5) | `geo.ts`, `task-optimizer.ts` |
| FTV factor, FAI Cat 1 | parameter | HG 0%, **PG fixed 25%**; Cat 2 free | `ftv.ts:80` |
| Competition results rounding | (2024: once) | **one decimal place** at comp level too (§15) | `ftv.ts` |
| Task types | Race to Goal / Elapsed Time; Open Distance and ground starts in scope | **Race / Time Trial** only; Open Distance and ground starts removed from GAP | naming only for us |
| Best time (PG) | pilots reaching goal | unchanged | — |
| Time validity cubic, distance weight cubic, speed fraction 5/6, arrival cubic, HG difficulty | unchanged | unchanged | — |

### New 2026 features (no 2024 counterpart)

1. **Elevated Goal** (§6.2.3.2, §9.2.3.2, §13.1): goal line or cylinder
   declared elevated (default 300 m above goal altitude, up to 1000 m);
   implicitly serves as ESS; any-altitude crossings validate, but crossings
   below the set elevation reduce time points by a GoalAltitudeFactor cubic
   (0.8 floor → 1.0 at full elevation).
2. **Control-zone altitude limits** (§6.2.1, §6.2.2, §9.2.1, §9.2.2): optional
   upper/lower AMSL limits on cylinders and lines; a crossing validates only
   within limits ± the 5 m absolute tolerance.
3. **Control-zone validation rewritten** (§9.2): direction-free crossings
   (inner *or* outer tolerance boundary), the 120 km/h go-around test for line
   crossings, explicit validation-time rules — single-start races take the
   *first* crossing after the gate; multi-gate races and Time Trials pick the
   flight segment with the longest distance and take the *last* qualifying SSS
   crossing within it. Re-starting (§8.1): scored for the start giving the
   biggest distance; if several reach goal, the last such start.

## The work, in phases

Each phase is a PR-sized unit that leaves the suite green and bumps
`SCORING_ENGINE_VERSION` + `SCORING_SOURCE_FINGERPRINT`
(`scoring-version.ts:513,520` — the closure test forces this). Run
`audit-scoring-change.ts` per phase and file the movement report on the PR:
under a rules change the diff is *documentation of expected movement*, not a
no-op gate.

### Phase 1 — Parameter model simplification + constant deltas

The cheap, wide phase; mostly deletion.

- `gap-params.ts`: remove `nominalLaunch`, `nominalGoal`, `scoreBackTime` from
  `GAPParameters` (they become spec constants); remove
  `LeadingWeightFormula` (`'gap2020' | 's7f2020' | 's7f2024'`) and the
  `S7F2024_PG_DEFAULT_SINCE_MS` date-switch machinery entirely; remove the
  `SpeedExponent` `'2/3'` option. `resolveCompGapParams` keeps accepting and
  *ignoring* removed fields in stored JSON — old `comp.gap_params` /
  `task.gap_params` rows and stale cached `ClassScore` payloads must not fail.
- `gap-formulas.ts`: launch validity 0.027 → 0.028; delete the s7f2020 PWC
  weight variant (0.838 / 0.162 / 0.805…), the GAP2016/2018 no-goal branch and
  the 1.4 / 2.8 leading multipliers; HG leading weight becomes
  `(1−dw)·leadingTimeRatio` (default 0.175 — numerically identical to today's
  hard-wired value, but now settable).
- `gap-stopped.ts`: score-back constants HG 900 s / PG 300 s;
  `STOPPED_GLIDE_RATIO_PG` 4.0 → 2.5; PG minimum duration → 0.
- `validators.ts`: `leadingTimeRatio` range 0–0.26; drop removed fields from
  `gapParamsSchema` (accept-and-strip, don't reject, for old clients).
- `ftv.ts`: PG Cat 1 FTV 25% default; one-decimal comp rounding; the §15
  stopped-task validity ≥ 0.05 exclusion.
- Frontend `SettingsDialog.tsx`: delete the leading-weight-formula dropdown and
  its help text; remove nominal-launch/goal/score-back inputs if exposed.
  (Wording changes go to the owner first, per CLAUDE.md.)
- AirScore importer `airscore-formula-map.ts`: collapse — every import scores
  under the one preset.
- No D1 migration needed: `gap_params` are JSON text columns; removed keys are
  simply ignored. The engine-version bump invalidates the stale-first stores.

### Phase 2 — PG leading coefficient (§12.3.1)

Verify `lcContribution` / `computeLeadingAggregate` (`gap-formulas.ts:637,710`)
against the 2026 integral form (the 2024 PDF's formula was truncated, so what
the engine implements today needs line-by-line comparison, not assumption).
Implement the new leadingArea/missingArea; the envelope functions
(`weightRising`/`weightFalling`) are unchanged up to the done-fraction
normalisation. HG LC is unchanged. Unit tests keyed to §12.3.2's worked
example.

### Phase 3 — Stopped tasks (§13.4)

The §13.4.5 rewrite is the substantive item: pilots between ESS and goal are
truncated at stop time like everyone else; timePointsReduction comes from the
defined reference pilot (earliest ESS crossing in single-gate races, smallest
start→ESS time otherwise), computed via the standard §12.2 formula; the
reduction is credited to the available distance points pool. Bonus distance
moves from per-track-point to the single position at stop time,
`min(taskDistance, distanceAtStop + altitudeBonus)`. Rework
`resolveStoppedTaskScore` and the two-pass in `scoreTask`; extend
`stopped-task.test.ts` with 2026 cases and delete the 2024 §12.3.5 ones.

### Phase 4 — Task evaluation (§9)

- Tolerances: fixed 0% relative + 5 m absolute for cylinders; flat 5 m for
  lines; goal-line straight-portion band re-derived from the fixed values.
  Decision below on declared xctsk tolerances.
- Validation: implement §9.2.4's validation-time rules, including the
  multi-gate/Time-Trial longest-segment rule and the §8.1 restart rule; confirm
  the line-crossing 120 km/h test matches what #359 built.
- Goal line orientation from the optimised route point (task-optimizer already
  produces it).
- Re-read the open deviation issues against the 2026 text: [#587][587]
  (single-start SSS crossing — §9.2.4 now says *first* crossing after the
  gate, which changes the issue's conclusion), [#586][586] (one-second
  granularity — still §9.4, still applies), [#265][265] (penalties — now
  §13.5, still applies), [#588][588] (S7F open-distance tasks — **moot**:
  removed from GAP; GlideComp's own `open-distance-scoring.ts` format is
  deliberately non-GAP and unaffected).

### Phase 5 — Distance algorithms (§7) — the big one

2026 makes the route algorithm normative: LTM projection (with the
latitude-dependent scaling), PathFinder (Ding et al. 2018 — transcribed at
[docs/reference/ding-2018-touring-n-circles/](reference/ding-2018-touring-n-circles/ding-2018-touring-n-circles.md)),
ProjectionCorrection back onto zone boundaries, FindTaskAreaCentre, and
geodesic distances from one of Karney / Thomas / Vincenty. §7.1.5 explicitly
requires *scoring software* to use InverseGeodesic — **`geo.ts`'s
Andoyer-Lambert inverse is a navigation-device-grade approximation and no
longer qualifies.**

Plan: implement §7 as specified (PathFinder in Cartesian space is simpler and
faster than iterating on the ellipsoid, which is presumably why CIVL chose
it); swap the scoring-path distance function to a sanctioned inverse
(recommendation: Vincenty inverse in-house beside the existing Vincenty
direct, avoiding a new dependency; `geographiclib-geodesic` (MIT) is the
fallback if Vincenty's antipodal non-convergence ever bites — it can't in
task-scale geometry). Keep Turf for bearings/bbox (display only). Validate
against `spec-distances.test.ts` reworked for §7, the Annex A PROJ constants,
and the distance corpus. Everything downstream of `geo.ts` (task analysis,
flown distances) moves by metres; the audit run documents it.

### Phase 6 — New features: altitude limits and Elevated Goal

Extend the internal task model (`xctsk-parser.ts` types) with optional
upper/lower limits per control zone and the elevated-goal declaration +
elevation; enforce in `turnpoint-sequence` validation (limits ± 5 m); implement
the §13.1 GoalAltitudeFactor cubic as a time-points reduction with its own
report-card section (inputs + substituted arithmetic, per the report-card
rule). Route editor: expose in the Advanced panel. **Blocked question:** the
`.xctsk` format has no fields for these yet — see decisions.

### Phase 7 — Transparency and copy (the user-visible half)

- **Edition label.** Add `rulesEdition: 's7f-2026'` into the published
  `ClassScore.gap_params` (or a sibling field). Report card
  (`PilotScoreDetail.tsx`) and scores pages render a "Scored under FAI S7F,
  2026 edition" line linking to `/scoring/gap`. Stale-first rule: cached
  payloads without the field degrade to the plain "FAI S7F" wording — never
  fail, never guess an edition.
- **§ citation sweep.** ~60 literal citations across `sections/*.ts`,
  `gap-scoring.ts`, `gap-formulas.ts`, `score-explanation*.ts`, tests and the
  CLI get renumbered per the table above. While in there, give
  `ExplanationItem` a structured `specRef?: string` field so the *next*
  edition is a data change — populated alongside, not instead of, the prose.
- **`SpecRef.astro`**: point at the 2026 PDF and regenerate the 34-entry
  `SPEC_DESTS` page/y-coordinate table from the ingestion pipeline's annot
  JSON (`extract_s7f.py` already records per-page geometry).
- **`/scoring/gap`**: update coefficients (0.028), formulas (KaTeX), edition
  prose, the deviations section (re-audited per Phase 4), and the source
  links; `about.astro` and the engine docblock links likewise.
- Copy that changes user-facing wording (edition badge, "Race" / "Time Trial"
  naming, settings help) is proposed to the owner in a message before editing,
  per CLAUDE.md.

### Phase 8 — Tests and verification tooling

- Update pinned constants (`gap-scoring.test.ts` legacy-formula blocks get
  deleted with their formulas; the arrival-cubic *string* assertion in
  `score-explanation.test.ts:1778` survives — formula unchanged).
- **AirScore parity**: retire value-identity assertions against old-formula
  fixtures. Repurpose: (a) keep the fixtures as *self*-golden files regenerated
  under 2026 (regression protection), and (b) keep
  `verify-airscore-parity.ts` output as a labelled "difference vs official
  historical results" report rather than a gate.
- `audit-scoring-change.ts` base-vs-HEAD over the archive per phase, attached
  to each PR (per the established scoring-change verification practice).

## Decisions (settled with the owner, 2026-08-09)

1. **Declared xctsk cylinder tolerance**: **always the spec values — 0%
   relative + 5 m absolute.** Declared tolerances in task files are ignored;
   this supersedes [#580](https://github.com/pokle/glidecomp/issues/580)'s
   behaviour.
2. **Geodesic implementation**: **in-house Vincenty inverse** beside the
   existing Vincenty direct in `geo.ts`; no new dependency.
3. **Elevated goal / control-zone altitude limits**: **deferred entirely** to
   a follow-up issue. No task in the wild can declare them yet (`.xctsk` has
   no fields); this migration is formula compliance only.
4. **Edition label wording**: the short badge **"FAI S7F 2026"**, linking to
   `/scoring/gap`; stale cached payloads without the field degrade to plain
   "FAI S7F".

Still open (not blocking implementation):

- **Issue [#588][588] / open distance**: close as moot for GAP once the
  in-flight open-distance test work lands; GlideComp's own open-distance
  format continues as a deliberately non-GAP `scoring_format`.
- **HG Class 2** (no arrival points, since 2023): the engine models `hg`/`pg`
  only. Pre-existing gap, unchanged by 2026 — track as its own issue rather
  than folding into this migration.

## Suggested sequencing

Phases 1–3 are independent of 4–6 and deliver the headline formula compliance;
7 lands last but its edition-label piece can ship with Phase 1 (label first,
then make it true — no: **make it true first**; the label ships when Phase 3
lands, at which point the formulas §10–§13 are all 2026). Phase 5 is the long
pole and can proceed in parallel on its own branch; until it lands, `/scoring/gap`
keeps a single documented deviation: "distances still use Andoyer-Lambert,
§7 adoption in progress".

[586]: https://github.com/pokle/glidecomp/issues/586
[587]: https://github.com/pokle/glidecomp/issues/587
[588]: https://github.com/pokle/glidecomp/issues/588
[265]: https://github.com/pokle/glidecomp/issues/265
