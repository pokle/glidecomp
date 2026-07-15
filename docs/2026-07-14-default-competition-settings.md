# Default competition scoring settings — research & recommendation

Addresses [#343](https://github.com/pokle/glidecomp/issues/343) — Tom Pavlič's
scoring feedback:

> The UI & Scoring Settings: There are a lot of scoring settings available,
> which can be a bit overwhelming. […] I think the "right" (current official)
> scoring settings should be the default, and any modifications should be
> walled off. Maybe an "Advanced Settings" button that opens a window with a
> big disclaimer stating these shouldn't be changed unless there's a very
> specific, technical reason.

This is a **research doc** — it recommends *what* the defaults should be for
the four `(HG | PG) × (GAP | open distance)` combinations and *which* knobs
should move behind an "Advanced" wall. It does not change code.

---

## 1. Current state

### The engine default (`DEFAULT_GAP_PARAMETERS`, `web/engine/src/gap-scoring.ts`)

| Parameter | Current default | Notes |
|---|---|---|
| `nominalLaunch` | `0.96` | FAI standard ✅ |
| `nominalDistance` | `70000` (engine) / **blank → auto 70 % of task** (UI) | UI leaves it blank so the scorer auto-computes per task |
| `nominalGoal` | `0.20` | ⚠️ lower than the FAI/AirScore norm of 0.30 |
| `nominalTime` | `5400` (90 min) | FAI standard ✅ |
| `minimumDistance` | `5000` (5 km) | FAI standard ✅ |
| `scoring` | `'HG'` | Single global default; **does not change when the organiser picks PG** |
| `useLeading` | `false` | ⚠️ not the official FAI formula (see §2) |
| `useArrival` | `false` | ⚠️ comment says *"default true for HG"* but the value is `false` |
| `leadingFormula` | `'weighted'` | GAP2020+ / current S7F ✅ |
| `leadingWeightFormula` | `'gap2020'` | PG leading↔time split. AirScore parity by default; `'s7f2024'` opts into the FAI S7F 2024 §10 LeadingTimeRatio formula (issue #257). No effect on HG |
| `leadingTimeRatio` | `0.26` | PG S7F-2024 only: fraction (0–0.5) of the non-distance weight given to leading when someone makes goal |
| `distanceOrigin` | `'takeoff'` | FAI CIVL GAP / PWCA ✅ |
| `useDistanceDifficulty` | `true` | HG-only; ignored for PG ✅ |
| `jumpTheGunFactor` | `2` | FAI S7F §12.2 default ✅ |
| `jumpTheGunMaxSeconds` | `300` | FAI S7F §12.2 default ✅ |

### Two real problems this surfaces

1. **The default is not "the official formula", and it's not category-aware.**
   There is one global default (`HG`, leading off, arrival off). Choosing
   *PG* in the Category radio flips `scoring` to `'PG'` on save but changes
   none of the other constants — a PG organiser inherits HG-shaped defaults
   (e.g. `useDistanceDifficulty: true`, which is silently ignored for PG, and
   arrival wiring that only matters to HG).

2. **`SettingsDialog.tsx` shows all ~13 scoring constants as one flat list**
   with no basic/advanced separation — exactly the "overwhelming" surface
   Tom describes. There is no disclaimer and nothing signals "don't touch
   these unless you know why."

> **Related (out of scope for the values themselves):** Tom also couldn't
> find how to trigger a rescore. There is no manual rescore button by design —
> scores are stale-first and auto-revalidate after any scoring-input change
> ([docs/score-caching-stale-first-plan.md](score-caching-stale-first-plan.md)).
> The fix there is UI affordance/messaging, not a setting. Tracked separately.

---

## 2. What "official" means

Two authorities matter, and the app already mirrors both:

- **FAI Sporting Code Section 7F (CIVL GAP)** — the officially sanctioned
  formula, cited throughout `gap-scoring.ts`. In the current S7F formula
  **leading points are part of the standard score for *both* PG and HG**, and
  **arrival points apply to HG only** (PG arrival weight is 0). The weight code
  already encodes this: `aw = (scoring === 'HG' && useArrival) ? (1-dw)/8 : 0`
  and the PG leading multiplier is doubled (`1.4 * 2`) to absorb the missing
  arrival share (`gap-scoring.ts` `calculateWeights`).

- **PWCA** — the de-facto paragliding standard: GAP2020/weighted leading on,
  no arrival (PG), nominal goal ≈ 0.30.

- **The app's own AirScore parity fixture** (`corryong-cup-2026-*`, a real
  Australian HG comp) was scored with `formula: gap-2021`, **departure off,
  arrival off**, `nominal_goal 30%`, `nominal_distance 35 km`,
  `nominal_time 90 min`, `minimum_distance 5 km`
  (`web/samples/comps/corryong-cup-2026-open-t2/airscore-result-raw.json`).

**The tension:** the strict FAI formula turns leading (and HG arrival) *on*;
common Australian HG practice (SAFA, and the app's own reference comp) turns
them *off*. #343 asks for "the current official settings" as the default, so
the recommendation below defaults to the **full FAI formula** and lets an
organiser switch to the simplified variant behind the Advanced wall.

---

## 3. Recommended defaults

The one change that fixes most of #343: **make defaults a function of Category
(HG/PG) and Scoring format**, seeded when the comp is created, rather than one
global blob. Recommended values:

### GAP · Paragliding (PG)

| Parameter | Recommended | Change vs today |
|---|---|---|
| `scoring` | `PG` | — |
| `nominalLaunch` | `0.96` | — |
| `nominalGoal` | `0.30` | ⬆ from 0.20 |
| `nominalDistance` | `null` (auto 70 % of task) | — |
| `nominalTime` | `5400` (90 min) | — |
| `minimumDistance` | `5000` (5 km) | — |
| `useLeading` | **`true`** | ⬆ official PG GAP uses leading points |
| `useArrival` | `false` | — (PG has no arrival) |
| `useDistanceDifficulty` | `false` | irrelevant for PG (always pure-linear); keep off to avoid implying otherwise |
| `leadingFormula` | `weighted` | — |
| `leadingWeightFormula` | `gap2020` | — (AirScore parity; Advanced can switch to `s7f2024`) |
| `leadingTimeRatio` | `0.26` | S7F-2024 only; unused under the `gap2020` default |
| `distanceOrigin` | `takeoff` | — |
| jump-the-gun | n/a for PG | stored `2` / `300` but unused (PG early start = launch→SSS) |

### GAP · Hang gliding (HG)

| Parameter | Recommended | Change vs today |
|---|---|---|
| `scoring` | `HG` | — |
| `nominalLaunch` | `0.96` | — |
| `nominalGoal` | `0.30` | ⬆ from 0.20 |
| `nominalDistance` | `null` (auto 70 % of task) | — |
| `nominalTime` | `5400` (90 min) | — |
| `minimumDistance` | `5000` (5 km) | — |
| `useLeading` | **`true`** | ⬆ to match FAI S7F (Advanced can turn off for SAFA-style) |
| `useArrival` | **`true`** | ⬆ HG scores arrival under FAI S7F (Advanced can turn off) |
| `useDistanceDifficulty` | `true` | — (FAI S7F §11.1.1) |
| `leadingFormula` | `weighted` | — |
| `distanceOrigin` | `takeoff` | — |
| `jumpTheGunFactor` | `2` | — |
| `jumpTheGunMaxSeconds` | `300` | — |

> If we'd rather the HG default match the app's own AirScore reference comp
> (Australian practice) instead of strict FAI, set `useLeading: false` and
> `useArrival: false`. That is the *only* judgement call in this doc — flagged
> for @pokle. Recommendation stands at **full FAI** because #343 literally asks
> for "the current official settings."

### Open distance · HG or PG

Open-distance scoring (`web/engine/src/open-distance-scoring.ts`) measures
straight-line metres from the take-off cylinder edge to the furthest fix. It
**uses none of the GAP constants** — no nominal values, no leading/arrival, no
difficulty. So there is nothing to default here beyond the format itself.

Recommendation: when `scoring_format = open_distance`, **hide the entire GAP
parameter block** (the dialog already does this) and don't surface an Advanced
scoring section at all. Category (HG/PG) stays as metadata only; it does not
affect the metres measured.

---

## 4. Recommended UI split (the "Advanced" wall)

Everything scoring-formula-shaped moves behind a single **Advanced scoring
settings** disclosure with a disclaimer. Correct per-category defaults mean an
organiser should never *need* to open it.

**Basic (always visible):** Name · Category (HG/PG) · Scoring format · Pilot
classes · Default class · Close date · Timezone · Test flag · Open-upload flag
· Admin emails.

**Advanced (collapsed, behind a disclaimer):** nominal launch / goal /
distance / time · minimum distance · leading (departure) points · arrival
points · distance difficulty · leading-coefficient formula · distance origin ·
jump-the-gun factor & max.

Suggested disclaimer copy:

> **These are the official CIVL GAP defaults for your competition category.**
> Changing them will make your scores differ from a standard FAI/AirScore
> result. Only edit these if your competition runs under local rules (e.g.
> SAFA) that specify different values, or you have a specific technical reason.

This is the "Advanced Settings button + big disclaimer" Tom asked for, with the
added guarantee that the *starting point* behind the wall is already the
official formula for the chosen category.

---

## 5. Implementation status

Landed on this branch:

1. **`defaultsFor(category, preset = 'fai')`** in `web/engine/src/gap-scoring.ts`
   (exported from the engine) returns the official per-category FAI defaults
   above. `DEFAULT_GAP_PARAMETERS` stays as the raw partial-param merge target;
   its docstring now says so. The `preset` arg is where a future **Australian
   (SAFA)** variant slots in without touching call sites.
2. **Category-aware scoring** (`web/workers/competition-api/src/scoring.ts`): a
   comp with no saved `gap_params` is now scored from `defaultsFor(category)`
   instead of the HG-shaped baseline — fixing the latent bug where a PG comp
   with null params scored as HG. Saved `gap_params` still win unchanged.
   `SCORING_ENGINE_VERSION` bumped 12 → 13 to invalidate affected cached scores.
3. **Advanced-settings wall** (`SettingsDialog.tsx`): the ~13 GAP constants now
   live behind a collapsed "Advanced scoring settings" `<details>` disclosure
   with the disclaimer from §4; a new comp's fields seed from
   `defaultsFor(comp.category)`. Hidden entirely for open distance (unchanged).
4. **"Review settings" is now optional** in the setup-progress guide
   (`CompSetupProgress.tsx`): it still shows (marked *(optional)*) but no longer
   gates the progress count or the guide's auto-hide — correct now that defaults
   are official out of the box.
5. **Manual re-score affordance** (Tom's second point): admin-only
   `POST /api/comp/:comp_id/rescore` (`routes/score.ts`) bumps every scoreable
   task stale and revalidates (audit-logged); a **"Recompute scores"** button on
   the comp scores page (`CompScoresSection.tsx`, admins only) triggers it and
   drives the existing `ScoreFreshness` "re-scoring… / finished" notice.
6. **Docs + discoverability**: the `/scoring/gap` page gained a **Default
   Competition Settings** section (per-category `#defaults-hg` / `#defaults-pg`
   anchors) and its stale "defaults to off" copy is corrected; the create-comp
   dialog's category selector deep-links to those anchors; the Settings dialog's
   Advanced section has a **Reset to defaults** button (`defaultsFor(category)`).
