# Field analysis readability — making the two pages approachable

Plan for `/comp/:id/analysis` and `/comp/:id/analysis/task/:id`. Sub-issue
material for [#450](https://github.com/pokle/glidecomp/issues/450) (Field
Analysis user experience issues), alongside the still-open
[#452](https://github.com/pokle/glidecomp/issues/452) and
[#458](https://github.com/pokle/glidecomp/issues/458).

**Status.** §A is shipped. §B, §C, §E, §F, §G, §H are untouched by anything
since. §D is half-answered by [#519](https://github.com/pokle/glidecomp/pull/519)
and [#520](https://github.com/pokle/glidecomp/pull/520) — see the note there.

## The problem, measured

Rendered against the bundled Corryong Cup 2026, Task 1 (Open) — 32 pilots, a
mid-sized field, not a worst case:

| | Task field analysis | Comp field analysis |
|---|---|---|
| Page height @1440px | **19,664 px** (~18 screens) | 7,515 px |
| Page height @400px (phone) | **24,489 px** (~28 screens) | — |
| Words | **8,998** | ~1,400 |
| Prose paragraphs over 12 words | **59** (3,588 words) | 6 |
| Tables / grids | 16 | 2 |
| Table cells | **1,985** | ~330 |
| ⓘ affordances | 48 | **0** |

Reproduce with `.claude/skills/run-glidecomp/` running and a headless page
measure; the numbers above came from `document.body.scrollHeight` and
`innerText` on the live page.

**These are a snapshot, not a fixed baseline — re-measure before and after any
phase.** They were taken on 2026-07-28; by 2026-07-31 the same page measured
**17,523 px / 9,081 words**, having absorbed §A's axis titles (taller charts,
+42 words), #519's Simplified-Technical-English rewrite of every caption and
legend, and #521's new thermals section. The shape of the problem has not
moved — the page is still the better part of twenty screens, and every word of
its reference material is still permanently on screen — but a phase that claims
a reduction has to prove it against a fresh measurement rather than this table.

The page is not badly designed — it is **fully explained at all times**. Every
legend, caveat, method note, provenance line and footnote is permanently
expanded, and all of it wears the same style: `text-xs`/`text-sm
text-muted-foreground`. A reader cannot tell the finding from the fine print
because they look identical, so the eye gives up on both. 3,588 words of prose
is a long magazine feature sitting in the gaps between 2,000 numbers.

Two specific consequences worth naming:

- **The figcaptions are doing the axes' job.** `RankScatter`'s caption opens
  "Each dot is a pilot: across is what was measured, up is a better rank" —
  that sentence exists because the x axis has no title and the y axis says
  `rank` in 10px grey at the top-left corner. Label the axes and the sentence
  becomes deletable. The two asks in this plan solve each other.
- **Nothing tells a casual reader what the page found.** The first thing under
  the H1 is a task diagram, then a basis box, then the weather, then a
  five-line paragraph about Spearman's ρ. A pilot who wants "what separated the
  field on Tuesday" has to read for two minutes before the answer appears.

## What is already right — do not break it

The mechanisms this plan needs mostly exist. This is an extension job, not a
redesign.

- **`MetricExplanation`** (`field-analysis/MetricExplanation.tsx`) — the ⓘ ghost
  button + popover pattern, 48 instances on the task page. `size-6` pointer
  target, real `aria-label`, `print:hidden`, links out to the glossary.
- **`MetricGlossary`** — the same prose rendered statically at the foot of the
  page, so print (and a reader who wants all 26 at once) still has it. Stable
  per-entry ids; the popovers link to them.
- **`Footnotes`** — the "consult once" chapter: excluded pilots, the method
  note, the glossary.
- **`MetricFamilySection`** — a `Disclosure` per family, with only the families
  holding a top-3 metric open by default, and the expansion state lifted to the
  page so `PageToc` can open a drawer before scrolling into it.
- **`PageToc`** — a real rail with scroll-spy (`aria-current="location"`) and a
  narrow-screen control.
- **`ConsistencyMap`** (comp page) — **the only chart here with proper axis
  titles**, and it also annotates its quadrants ("same direction every task",
  "strong but day-dependent"). It is the model every other chart should copy.
- **Print discipline** — `Disclosure` forces its panel open on paper
  (`print:block! print:[content-visibility:visible]!`), popovers are
  `print:hidden` with their prose mirrored in the glossary, interaction
  invitations are `print:hidden`, families break onto their own pages.

## Constraints any change must respect

1. **Explainability is a project rule.** Nothing here gets deleted — everything
   moves behind a visible affordance. "Less intimidating" must not become "less
   explainable".
2. **Print must still carry everything.** Follow the existing pattern:
   collapsed content is force-opened for print; popover content is duplicated
   statically in the footnotes.
3. **These pages are SSR'd** (`functions/comp/[[path]].ts` has `ROUTES` entries
   for both). So: no `localStorage` at module scope, a deterministic
   server-side default for any persisted preference, and the preference read in
   an effect after hydration — otherwise hydration mismatches.
   `bun run test:e2e:ssr` asserts clean hydration on both pages and is part of
   "done".
4. **Collapsing must not hide content from crawlers or from the TOC.** RAC's
   `Disclosure` keeps children in the DOM (`hidden="until-found"`), which is
   the right primitive; conditional rendering is not. TOC entries pointing
   inside a new collapsible need the same `onBeforeScroll` expand hook the
   families already use.
5. **Hiding a table column means removing the `Column`, not CSS-hiding it** —
   RAC's grid semantics have to stay coherent for keyboard and screen-reader
   navigation.
6. **Accessibility standard applies** (`docs/accessibility-standard.md`,
   per-PR checklist). New ⓘ triggers inherit `MetricExplanation`'s
   already-compliant shape.
7. **Metric labels live in the engine registry**, shared with the CLI, and are
   *stored inside* each cached report. Changing one means bumping
   `FIELD_ANALYSIS_VERSION` (currently 17, `web/engine/src/field-analysis/version.ts`)
   or cached rows keep serving the old text.

---

## A. Label every chart axis

The explicit ask, and the cheapest large win. Rule: **every plot states what
each axis measures and in which unit, in the plot — never only in the
caption.** `ConsistencyMap` already does this; the rest do not.

| Chart | Today | Add |
|---|---|---|
| `charts/RankScatter.tsx` | x: nice ticks with units, **no title**. y: `rank` in the top-left corner, ticks 1/10/20/30 | x title: `<metric label> (<unit words>)` centred under the ticks. y title: `rank — 1 = winner`, rotated up the left edge. Grow `MARGIN.left`/`.bottom`, raise `BASE_H` to match, and drop the now-redundant first clause of the figcaption |
| `charts/DistributionStrip.tsx` | min / median / max marks with units | Axis title naming the metric + unit. Matters most in the ⓘ popover, where the strip appears with no surrounding context |
| `charts/PercentileHeatmap.tsx` | 26 rotated 8-char abbreviations; row identity implicit | Explicit axis titles: `pilots — best placed first ↓` on the row header column, `behaviours — most explanatory → least` over the columns. See §D for the abbreviations themselves |
| `charts/HorseraceLines.tsx` | same `rank` corner label as the scatter | Same treatment as `RankScatter` |
| `charts/LegWaterfall.tsx` | per-leg labels, no axis title | y title naming the quantity + unit |
| `charts/day-profile/*` (`MetWindChart`, `MetThermalChart`, `ClimbHourlyChart`, `WindHourlyChart`) | y ticks carry units via `formatTickValue`; small lane labels (`direction`); **no y title**; shared x axis has **no title at all** | A y title per chart naming the quantity. The x title belongs to the *shared* axis — render it **once** from `DayProfilePanel`/`TimeAxisParts` (`time of day — <comp zone abbreviation>`), not per chart, or the stack repeats it five times |
| `charts/AirtimeSplitBar.tsx` | inline legend chips | Fine as is — it is a proportion bar, not a plot |

Implementation notes:

- Axis titles are `aria-hidden` like the tick labels — each chart's
  `role="img"` accessible name and its caption already carry the reading in
  words, and a screen reader does not need the visual furniture. Adding them to
  the accessible name would be duplication.
- Put a small `AxisTitle` helper in `charts/chart-utils` (or a tiny
  `charts/AxisTitle.tsx`) so the type size, colour and rotation transform are
  written once. `ConsistencyMap`'s existing `<text transform="rotate(-90 …)">`
  is the reference implementation.
- Every chart is drawn on a fixed viewBox and scaled by CSS, so the margins are
  a real budget — check each at phone width after growing them, and check the
  full-screen overlay (`MetricChartOverlay`) which passes a computed height.

**SHIPPED.** The helper is `web/frontend/src/react/charts/AxisTitle.tsx` —
promoted to the shared chart directory (beside `scale.ts`) rather than left in
`field-analysis/`, because the report card's score charts draw the same
furniture. `ConsistencyMap` now draws its titles from the helper too, so the
chart the pattern came from cannot drift from its own descendants.

Two things came out differently from the table above:

- **`DistributionStrip` got nothing.** The plan asked for a title on the
  premise that the strip appears in the ⓘ popover with no surrounding context.
  That was wrong: the popover prints the metric name and "Measured in
  kilometres per hour" immediately above it, and `MetricDetailPanel` does the
  same. A title would have been a third copy.
- **`AxisUnit` exists** for the corner stamp (`pts`, `m`) on the report card's
  charts, and converting those to rotated titles would have been the wrong read
  of consistency. A stamp says what the NUMBERS are; a title says what the AXIS
  is. Where a corner label was hiding a real ambiguity instead — which end of
  `rank` is good — naming the axis was a title's job and the corner form was
  the bug. `AxisTitle.tsx` documents which to reach for.

One instance is knowingly left alone: `field-analysis/thermals/ThermalsPanel.tsx`
(`ClimbProfile`) landed in #521 with its own inline x title, at 9px and
left-anchored rather than the helper's 10px centred — deliberate choices for a
320-unit panel that adopting the helper would silently overturn.

## B. One explanation affordance, extended from metrics to sections and charts

The ⓘ vocabulary exists and readers already meet it 48 times on this page. Do
not invent a second style — extend it upward.

**New: `field-analysis/Explain.tsx`.** A thin generalisation of
`MetricExplanation`'s trigger: same `size-6` ghost button, same
`print:hidden`, `aria-label="About <thing>"`, arbitrary children in the
popover, optional link to a footnote id. `MetricExplanation` should be
refactored to sit on top of it rather than duplicating the button.

Then move the following out of the reading flow and into a ⓘ on the nearest
heading or column header — the place the reader's question actually arises:

| Prose block | Today | Moves to |
|---|---|---|
| `VerdictLegend` (the \|ρ\| ≥ 0.5 / ≥ 0.3 / noise-floor thresholds) | Inline under both ranking tables, both pages | ⓘ on the **"What it means"** column header. Stays statically in `Footnotes` for print |
| "Rank 22 behaviours against one day's results and a few will look strong on luck alone…" | Inline paragraph | ⓘ on the section heading |
| "N behaviours were measured on fewer than 8 pilots…" | Inline paragraph | Same ⓘ, second paragraph |
| The 5-line Spearman intro under "Which behaviours went with better results" | Always visible | Keep **one** sentence visible ("Each row is one behaviour, compared against the published placings"); the rest into the heading's ⓘ |
| `StyleClusters`' method + silhouette paragraph | Inline, ends with `mean silhouette 0.16` | ⓘ on "Pilot style clusters" |
| `PercentileHeatmap`'s figcaption (6 sentences) | Inline | Keep the first sentence; rest into a ⓘ on the section heading |
| The weather panel's provenance/sampling block | Three paragraphs under the charts | **Careful:** the Open-Meteo CC BY 4.0 credit is a licence obligation and must stay visible. Keep a one-line visible credit, move grid-size / elevation / sampling detail behind ⓘ |
| Comp page: the "Across tasks / Day to day / Against comp standings" paragraph | One dense block below the table | Split into **three** ⓘs, one per column header — that is where each question is asked |

Net effect on the task page: roughly 1,400 of the 3,588 prose words leave the
default reading flow without leaving the page.

## C. Collapse the reference layer

Everything a reader consults once should start closed. Use `Disclosure`
(print-safe already) and add `onBeforeScroll` expand hooks to the affected
`PageToc` entries, exactly as the families do.

- **`Footnotes`** — excluded pilots + method note + the 26-entry glossary.
  This is the single largest block on the page. Collapse the section, keep the
  heading and a count ("Footnotes — 26 metric definitions, how the field is
  compared, 3 pilots not analysed").
- **"Outcome checks"** — both pages. Explicitly a sanity check on the analysis,
  not a finding; the copy says so. Collapse.
- **"Standings behind these figures"** (comp page) — a duplicate of the scores
  page. Collapse, with a link to `/comp/:id/scores`.
- **Family sections** — already correct (top-3 open). Leave alone.
- **`AnalysisBasis`** — leave open. It is four facts and a bar, and it
  qualifies everything below it.

## D. Fix the vocabulary in the heatmap and the family tables

**Half of this landed on master without us:**
[#519](https://github.com/pokle/glidecomp/pull/519) rewrote every metric's FULL
label to name the quantity ("Glide speed between climbs", "Share of lift turned
in that was kept as a climb"), and #520 renamed `decision.altitude_floor` to
match what it measures. `FIELD_ANALYSIS_VERSION` went 17 → 20 with them, so
cached reports carry the new text. That is a straight win for §A too, since the
scatter's x-axis title is built from `metric.label`.

**What is left is the SHORT labels**, which #519 did not touch, and they are
still the densest, least readable thing on either page: 26 rotated
abbreviations heading the percentile heatmap — `GlideSpd`, `TopOut%`,
`StartDly`, `GlideL/D`, `InGaggle%`, `LeaveWin%`, `km/climb`, `Kept%`,
`Core s`, `Spare m`, `LowSaves`, `Floor%`, `FinalGl` — with a `†` on the
no-direction ones that is explained only at the end of a six-sentence caption.
(At 10px rotated, that dagger reads as a `+`; an earlier draft of this document
misread it as one, which rather makes the point.) The same `shortLabel`s head
the per-family per-pilot tables.

- Audit every `shortLabel` in the engine registry for readability. They are the
  engine's, shared with the CLI text report, and **stored inside cached
  reports** — a change needs `FIELD_ANALYSIS_VERSION` bumped so stale rows
  expire (it is 21 as of #526, and moves often — read it, don't quote this).
- Where a short label cannot be made self-explaining in ~10 characters, prefer
  the full label rotated with a `max-height` truncation over a cryptic
  contraction, and rely on the existing hover readout for the rest.
- Give the `†` marker a visible key next to the band row rather than a footnote
  at the end of a six-sentence caption, or drop it in favour of the ⓘ.

## E. Say what the page found, at the top

The strongest anti-intimidation move available: **2–4 plain sentences under the
H1**, before the task diagram, so a casual reader can leave in 15 seconds with
the answer.

Everything needed is already computed. `field-analysis/debrief.ts` +
`TaskDebrief` already do exactly this shape of thing (derive sentences from the
report, render nothing when there is no evidence, unit-tested in
`debrief.test.ts`) — extend that machinery rather than starting a new one.

Content, all derived, all deterministic:

- The top-ranked behaviour and its verdict — "Glide speed between climbs
  separated this field most clearly (clear pattern, 29 of 32 pilots)".
- How many behaviours cleared their noise floor at all — "4 of 22 behaviours
  showed a clear pattern; the rest could be chance".
- One line on the day, from the day family / weather — "W wind 14–19 km/h,
  climbs averaging 2.1 m/s".
- The style-cluster count, when clusters formed.
- Existing `TaskDebrief` findings fold in here rather than sitting as a
  separate section.

Same treatment for the comp page: "Across 3 tasks, gliding speed between climbs
pulled the same way every day". Unit-test the sentence builder the way
`debrief.test.ts` does, so a change to the wording is a test diff and not a
screenshot review.

## F. A detail-level control — plain English by default

This is the direct answer to "hide stats columns until the user clicks". One
control, at the top of the page, next to the class select:

> **Detail:** [ Plain English ] [ With statistics ]

Default **Plain English**. Persisted per-viewer in `localStorage`, read in an
effect after hydration (SSR constraint #3), so the server always renders the
default. Print always renders the statistics form.

Implementation: a `StatsDetailContext` in `field-analysis/`, a `useStatsDetail()`
hook, and consumers deciding which `Column`s to build (never CSS-hiding —
constraint #5).

**Plain English hides:**

| | Task page | Comp page |
|---|---|---|
| Ranking table | the numeric ρ beside the Strength bar | numeric ρ beside the "Across tasks" bar |
| | | the `ρ −0.76 · 39 of 39 pilots` sub-line under each verdict badge |
| | | the numeric ρ in each per-task column (bars stay) |
| Prose | the ρ symbol wherever it survives in copy | same |
| Clusters | the silhouette number | — |

**Kept in both modes:** the bars, the verdict chips ("clear pattern", "could be
chance", "same way each task"), "29 of 32 pilots", and every ⓘ. The plain
reading is already the primary one in this design — this just removes the
second, numeric copy of it.

**With statistics** restores today's page exactly, so nothing is lost and the
existing e2e assertions have a mode to run in.

## G. Comp page specifics

- **Give it ⓘs.** It has none today, on the stated grounds that the aggregate
  carries no method descriptions — but the page *already imports* `ALL_METRICS`
  to build its glossary. Pass those descriptions to `MetricExplanation` in the
  first column and the table becomes self-explaining, matching the task page.
- Column-header ⓘs per §B.
- Collapse "Standings behind these figures" and "Outcome checks" per §C.
- The "Per task:" row is a bare list of underlined links. Turning each into a
  card with its own one-line finding is the natural home for §E's summary and
  is most of what [#452](https://github.com/pokle/glidecomp/issues/452) asks
  for — **flagged as a seam, not done here**, so the two changes don't collide.

## H. Narrow screens

24,489 px on a 400 px viewport is the same problem an order of magnitude worse,
and `PageToc`'s control only appears as a fixed bar after ~160 px of scroll — so
the first screen offers no way to skip ahead.

- The §E summary card is the fix for the first screen: an answer before any
  navigation is needed.
- Surface the TOC control in the initial view on narrow screens rather than
  only on scroll.
- §C's collapsing has outsized effect here; re-measure the height after it.

---

## Sequencing

Each phase is independently shippable and independently reviewable.

1. **Axis titles (§A)** — self-contained, no state, no SSR risk, deletes prose
   as a side effect. Ship first.
2. **Collapse the reference layer (§C)** — mechanical, uses an existing
   print-safe primitive. Biggest single height reduction.
3. **Summary card (§E)** — pure derivation, unit-testable, the biggest
   perceived-approachability win.
4. **`Explain` + moving the legends (§B)** — the largest diff; wants 1–3 landed
   first so it is reviewed against a shorter page.
5. **Detail-level control (§F)** — touches both pages' table construction and
   introduces the only persisted state; last of the core work.
6. **Vocabulary (§D)** — engine change plus a `FIELD_ANALYSIS_VERSION` bump;
   independent of the rest and can go any time.
7. **Comp-page ⓘs (§G)** — small, can ride with any phase.

## Verification

Per phase:

- `bun run test` and `bun run typecheck:all`.
- `bun run test:e2e` — plus new specs for: the detail toggle switching modes and
  persisting; a collapsed `Footnotes` opening when its TOC entry is clicked.
- **`bun run test:e2e:ssr`** — mandatory, both pages, clean hydration
  (constraint #3).
- **Print check** — `bun run build && wrangler pages dev web/frontend/dist`,
  print to PDF, confirm every collapsed section and every popover's prose is on
  paper.
- **Re-measure** page height, word count and prose-paragraph count against the
  table at the top of this document; record the numbers in the PR.
- Accessibility per-PR checklist from `docs/accessibility-standard.md`.

Target for the task page after phases 1–5: **under 8,000 px** and **under 1,500
words** in the default reading flow, with every one of today's 8,998 words still
reachable in one click.

## Out of scope

- [#452](https://github.com/pokle/glidecomp/issues/452) — reordering the comp →
  task entry path. §G notes the seam.
- [#458](https://github.com/pokle/glidecomp/issues/458) — per-family combined
  charts and a chart builder. Orthogonal; §D's label work helps it.
- [#407](https://github.com/pokle/glidecomp/issues/407) — surfacing
  directionality flips. New findings, not readability.
- Changing which metrics are computed, or any correlation maths.
