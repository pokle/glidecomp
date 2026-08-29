# Task analysis: the overview block

**Status:** planned, not built. Copy and structure are signed off by the owner
(2026-08-29); the implementation is open.

**Page:** `/comp/:id/analysis/task/:id` —
`web/frontend/src/react/pages/TaskFieldAnalysis.tsx`.

---

## 1. The problem

The task field-analysis page is **21,184 px — 31.9 phone screens** (measured on
an iPhone 13 viewport, 390×664, against Corryong Cup 2026 Task 1 Open with 14
analysed pilots; a 60-pilot comp is longer). Its sections carry very uneven
weight:

| Section | Share of scroll |
|---|---|
| Title + findings digest | 6% |
| What the weather did | 6% |
| The day's thermals | 5% |
| Behaviour ranking | 10% |
| Field at a glance | 4% |
| Pilot style clusters | 7% |
| The metrics in detail | 26% |
| Footnotes (the metric glossary alone is 35%) | 36% |

The page already has a table of contents — `PageToc`
(`src/react/components/PageToc.tsx`) — but it cannot solve discovery, because
it is a **scroll artefact**: on narrow screens nothing appears until 160 px of
scroll, and what then appears is a closed `SimpleSelect` showing the section you
are *in*, never the sections that *exist*. At scroll 0, where a reader decides
what to do, there is no index at all. The rail only appears at `xl` (1280 px),
so 768–1279 px gets 18 screens and the same select.

## 2. What the block is for

> The point of the blocks is to organise information in a single view so that
> people get a quick overview and are able to navigate quickly to the details.
> — the owner, 2026-08-29

Two jobs, in this order:

1. **Overview.** A reader who looks at it for four seconds and scrolls no
   further should know what this report contains and what the day was.
2. **Navigation.** A reader who wants one section should reach it in one tap.

It is deliberately **not a sequence**. A reader enters wherever they like, in
any order. The stages group related destinations; they do not prescribe a
reading path.

`PageToc` keeps its job unchanged — it is the *where am I* device, and this
block is the *what is here* device. Do not delete or replace the TOC.

## 3. Signed-off decisions

Three calls were put to the owner and confirmed. Do not relitigate them; if the
implementation makes one look wrong, raise it rather than quietly changing it.

1. **The findings digest becomes the block's centrepiece**, at its current size.
   Not a small tile among others. `FindingsDigest`'s own comment says the card
   exists to *shout* those three lines; demoting them to 11 px tiles would
   un-shout them. The block frames the digest rather than replacing it.
2. **Stage labels are not numbered.** `1 ·` `2 ·` reads as *steps to complete*,
   and this is a report, not a workflow. Vertical order carries the grouping.
3. **"Analysis basis" keeps its name.** It is the one node whose label is
   system-ish rather than reader-ish, and *Who flew, and when* is plainer — but
   the section heading it points at says "Analysis basis", and a map that
   renames its destinations is a map you cannot check.

## 4. The block

Rendered directly below the page's `<h1>` / subtitle / action row, and **above**
the task route figure (`TaskDiagram`). It replaces the standalone
`FindingsDigest` card that currently sits in that slot, by absorbing it.

```
Breadcrumbs                      Competitions › Corryong Cup 2026 › Field analysis
h1                               Task 1 (Open)
subtitle                         How the field flew this task, and which behaviours separated it.
[View task]  [Recompute]

▼ THE BLOCK

figure                           The optimised route — radii, leg distances and start
                                 times are on the task page.
```

### Phone (below `md`) — four labelled stacks

```
THE DAY THEY FLEW
┌──────────────────────────┬──────────────────────────┐
│ Analysis basis           │ What the weather did     │
│ 32 pilots · 13:46–18:33  │ 19 km/h W · climbs       │
│                          │ 1.3 m/s                  │
│                          │ From the pilots' tracks  │
├──────────────────────────┴──────────────────────────┤
│ The day's thermals                                  │
│ 82 thermals shared by two or more pilots            │
└─────────────────────────────────────────────────────┘

WHAT SEPARATED THE FIELD
┌─────────────────────────────────────────────────────┐
│ Top 3 winning behaviours          ← FindingsDigest,  │
│  [Fast glides · clear pattern]      full size        │
│  [Staying high between thermals · clear pattern]     │
│  [Leaving thermals near the top · clear pattern]     │
├─────────────────────────────────────────────────────┤
│ Behaviour ranking                                   │
│ All 21 behaviours, strongest correlation first      │
└─────────────────────────────────────────────────────┘

WHERE EACH PILOT SAT
┌──────────────────────────┬──────────────────────────┐
│ Field at a glance        │ Style clusters           │
│ Every pilot against      │ 2 groups — high leavers, │
│ every behaviour, as      │ bold leavers             │
│ percentiles              │                          │
└──────────────────────────┴──────────────────────────┘

HOW IT WAS MEASURED
┌──────────────────────────┬──────────────────────────┐
│ The metrics in detail    │ Footnotes                │
│ 6 families · 26 metrics, │ 2 pilots not analysed ·  │
│ with their charts        │ 26 metric definitions    │
└──────────────────────────┴──────────────────────────┘
```

### `md` and up

The same four groups as columns, with the digest spanning full width above or
across them — the digest must not be squeezed into a quarter-width column. Use
a CSS grid; connector rules between stages are optional decoration and must not
be load-bearing.

**Build it as layout, not as SVG.** A grid of linked cards stays a real
`<nav>` of anchors at every width, reflows to the stacked list above, needs no
parallel text alternative, and is deterministic under SSR. An SVG diagram buys
prettier arrows and costs an accessibility contract you then have to keep in
sync.

## 5. Copy, sources and fallbacks

Every state line must be derivable from data the page already holds. **Never
invent a figure to fill a slot** — degrade to the descriptive line instead.

| Node | Links to | State line | Source | If the source is absent |
|---|---|---|---|---|
| Analysis basis | `#analysis-basis` | `{n} pilots · {from}–{to}` | `report.basis.pilotCount`, `report.basis.analysisWindow` | `{n} pilots analysed` |
| What the weather did | `#weather-heading` | see §5.1 | see §5.1 | see §5.1 |
| The day's thermals | `#thermals-heading` | `{n} thermals shared by two or more pilots` | `report.basis.multiPilotThermalCount` | node not rendered (see §6) |
| *(digest)* | — | unchanged: `Top {n} winning behaviour{s}` + names + verdict chips | `FindingsDigest` | its own empty state: `What separated the field? / Can't say — no clear pattern` |
| Behaviour ranking | `#separation-heading` | `All {n} behaviours, strongest correlation first` | `rankMetrics(report.metrics).length` | `All behaviours, strongest correlation first` |
| Field at a glance | `#heatmap-heading` | `Every pilot against every behaviour, as percentiles` | static | — |
| Style clusters | `#clusters-heading` | `{n} groups — {label}, {label}` | `clusterPilotStyles(report)` | `Too few pilots to group by style` |
| The metrics in detail | `#families-heading` | `{f} families · {m} metrics, with their charts` | `grouped` (families with ≥ 1 metric), `report.metrics.length` | — |
| Footnotes | `#footnotes-heading` | `{n} pilots not analysed · {m} metric definitions` | `active.excluded.length`, `report.metrics.length` | `How the field is compared, and every metric defined` |
| Task debrief *(conditional)* | `#debrief-heading` | `What this task did differently from the rest of the comp` | — | node not rendered (see §6) |

Node labels are the register of an index, not a copy of the headings — the two
long section names shorten (`Which behaviours went with better ranks` →
`Behaviour ranking`, `The whole field at a glance` → `Field at a glance`),
exactly as `PageToc`'s rail labels already do. The headings themselves do not
change.

Task debrief sits in **What separated the field**, after the digest.

### 5.1 The weather node, and why it carries a provenance tag

The weather section stacks two sources under headings the page already uses —
*From the weather model* and *From the pilots' tracks*. A node quoting a wind
figure must say which, or it turns a forecast into a record. That is the
`docs/weather.md` rule ("a prediction can never be read as a record") applied at
a glance, and it is also the degrade path:

1. **`19 km/h W · climbs 1.3 m/s`**, tagged **From the pilots' tracks** — the
   measured whole-task figures. This is the only variant that renders
   server-side, because both come from the stored report rather than the
   separate weather fetch.
2. **`22 km/h W`**, tagged **From the weather model** — when there was too little
   circling to estimate wind (`wholeTask` is null on a glide-heavy task, and on
   reports stored before the series carried it). Model surface wind for the task
   window.
3. **`How the wind, climbs and cloudbase moved through the day`** — neither
   available. Descriptive, no number.

**Wind.** `day.wind` → the `wind-hourly` series → `wholeTask: { speedKmh,
directionDeg, n }`. Render with `windLabel(speed, unit, directionFromDeg)` from
`src/react/field-analysis/charts/day-profile/shared.ts`, which produces exactly
`"19 km/h W"` — do not write a new formatter, and do not write a new
compass-point function (`degToCompass` is in the same file). Convert with
`unitDisplay("km/h", units)` from `src/react/field-analysis/units.ts`.

**Climb.** `day.climb_by_hour` → the `climb-hourly` series → `wholeTask`
(`ClimbQuantiles`: `p10/p25/median/p75/p90/n`), added in
`FIELD_ANALYSIS_VERSION` 25 (PR #671). Quote the **median**. Convert with
`unitDisplay("m/s", units)` so it honours the climb-rate preference (m/s,
ft/min, knots) and format with the engine's `formatMetricValue`. `wholeTask` is
optional — a stored v24 row has none — so the clause drops out rather than
printing `NaN`.

Both figures are pooled over the whole task, so they describe the same day as
the hourly rows beneath them. See the v25 entry in
`web/engine/src/field-analysis/version.ts` for why the climb figure is pooled
rather than averaged from the hourly medians.

### 5.2 Two readings deliberately left out

- **Cloudbase.** It is modelled (`cloudBaseAglM`), it is AGL metres and so takes
  the altitude preference, and putting it beside tracks-derived wind mixes a
  forecast and a record inside one line.
- **The working band.** `934–2580 m` is a reader-unit altitude and belongs in
  the basis card, where the altitude conventions already hold. A node quoting it
  would be the one place on the page ignoring the unit preference (issue #662).

## 6. Conditional nodes

An anchor to an id that does not exist scrolls nowhere. Three sections are
conditional, and their nodes must be gated on **exactly the same flags the
sections are** — the page already computes all three, and `PageToc` already
gates its entries on them:

| Node | Flag in `TaskFieldAnalysis.tsx` |
|---|---|
| What the weather did | `hasWeatherSection` |
| The day's thermals | `hasThermalsSection` |
| Task debrief | `hasDebrief` (set via `TaskDebrief`'s `onRenderedChange`) |

A stage whose every node is gated out renders nothing — no empty stage label.
*The day they flew* can lose two of three nodes and still has Analysis basis.

## 7. Implementation notes

### Files

- **New:** `src/react/field-analysis/OverviewBlock.tsx` (component), and its
  test.
- **Changed:** `src/react/pages/TaskFieldAnalysis.tsx` — render the block where
  `FindingsDigest` is rendered today, and pass it what it needs.
- **Changed:** `src/react/field-analysis/FindingsDigest.tsx` — add a `nested`
  prop.

### The digest, nested

`FindingsDigest` currently renders its own `Card`. Inside the block that would
be a card in a card. Follow the precedent already in the codebase:
`MetricGlossary` takes a `nested` prop and swaps its `Card` for a plain
`<section>` when it is inside someone else's panel. Do the same here. The
digest keeps its `h2 id="findings-digest-heading"`, its full type size, its
`onPickMetric` behaviour and its empty state.

### Data the block needs

All of it already exists in the page's render scope:

- `report` (`active.report`) — basis, metrics, thermals.
- `active.excluded` — the not-analysed count.
- `grouped` — the family map (`useMemo`, line ~291).
- `dayMetrics` — `grouped.get("day")`, where both wind and climb series live.
- `weather.data?.weather`, `weatherPending` — the model fallback only.
- `comp?.timezone` — for `formatTimeRange`.
- `hasWeatherSection` / `hasThermalsSection` / `hasDebrief`.
- `setSelectedBehaviour` — the digest's `onPickMetric`.

**`clusterPilotStyles(report)` is computed at read time and `StyleClusters`
already calls it.** Do not call it a second time from the block: lift it into a
`useMemo` in the page and pass the result to both, or pass a precomputed count.

### Navigation behaviour

Nodes are anchors (`<a href="#…">`) inside a `<nav>`. `PageToc` already uses
`aria-label="On this page"`, so this one needs a distinct name — e.g.
`aria-label="Report contents"` — or a screen-reader user meets two navigation
landmarks called the same thing.

A bare anchor jumps but does not move focus to a non-focusable heading, which
strands keyboard users. `PageToc.go()` already solves this — smooth scroll,
then focus the target (or its first focusable child), setting `tabindex="-1"`
where needed. **Extract that into a shared helper** (e.g.
`src/react/lib/scroll-to-section.ts`) and use it from both, so the two devices
cannot drift apart in behaviour. Keep the anchors real `href`s so
middle-click, copy-link and no-JS all still work.

The block itself stays **out of the TOC**, for the reason the digest already
is: the TOC lists destinations, not signposts.

### SSR safety

This block sits at the top of one of the eight server-rendered comp pages
(`docs/ssr.md`). Non-negotiable:

- No `window` / `document` / `localStorage` at module scope.
- Times render deterministically — use `formatTimeRange` from
  `src/react/lib/time` with the comp's IANA zone (`comp?.timezone`), exactly as
  `AnalysisBasis` does. Never the runtime's zone or locale.
- `useUnits()` is safe here: its `getServerSnapshot` returns `DEFAULT_UNITS`, so
  the server emits km/h and m/s and the client re-renders in the reader's
  preference without a hydration mismatch. That is the established pattern; do
  not work around it.
- The weather-model fallback (§5.1 case 2) arrives from a client-side fetch, so
  the node's content may change after hydration. That is fine and matches the
  existing weather section — but the server-rendered variant must be case 1 or
  case 3, never a loading skeleton.
- Verifying is part of "done": dev serves the SPA shell with no SSR, so run
  `bun run test:e2e:ssr`.

### Accessibility

Measured against `docs/accessibility-standard.md` (WCAG 2.2 AA), per-PR
checklist included:

- Stage labels are real headings or a labelled group — not styled `<div>`s
  floating above a list. The block is a `<nav>` of grouped links.
- Each node is one link with an accessible name that makes sense out of context
  ("Style clusters", not "2 groups").
- Minimum 44 px touch targets (`navRowClass` in `rac/nav-list.tsx` already
  encodes this).
- Visible focus ring on every node; the whole card is the target, not just the
  label.
- The state line must not be the only way the information is conveyed — it is
  a summary of a section that still says everything itself.

### Kit

`rac/card.tsx`, `rac/badge.tsx` for the provenance tag and counts, and
`rac/nav-list.tsx` (`NavRow`, or the exported `navRowClass` if the block wants
its own element). Read `docs/2026-07-18-rac-adoption-guide.md` before touching
kit code. Do not add a component library; do not reach for `bunx shadcn add` —
the kit is react-aria-components only and `src/react/one-kit.test.ts` fails the
build if the old kit returns.

## 8. Tests

**Unit** — `src/react/field-analysis/OverviewBlock.test.ts`. Follow the
directory's established pattern (see `FindingsDigest.test.ts`,
`AnalysisBasis.test.ts`): vitest, `renderToStaticMarkup` from `react-dom/server`
over `createElement`, asserting on the markup. Note that this renders through
the **server** path, so these tests also guard the SSR contract in §7 — a
`window` reference at module scope fails them.

- Each state line renders from its source, and falls back correctly when the
  source is absent — in particular a report with no `analysisWindow`, no
  `wholeTask` on either series, and no clusters.
- The three conditional nodes are absent when their flags are false, and no
  empty stage label is left behind.
- The weather node's tag follows its source: tracks when the tracks figure
  exists, model when only the model does, and neither line-nor-tag invents a
  number when both are missing.
- Node counts match the report (families, metrics, excluded pilots).

**e2e** — extend `e2e/field-analysis.spec.ts`:

- The block is present at scroll 0 on a phone viewport, before any scrolling.
- Tapping a node lands on the matching section heading.
- No node points at an id that is not in the DOM. This is worth asserting
  generically: collect every `href^="#"` in the block and assert each target
  exists — it is the failure mode the conditional gating exists to prevent.

**Regression check**: `report-card.spec.ts` and `not-found-suggestions.spec.ts`
are unaffected, but `field-analysis.spec.ts` and `ssr.spec.ts` are not.

## 9. Definition of done

- [ ] `bun run typecheck:all` clean.
- [ ] `bun run test` green.
- [ ] `bun run test:e2e` green (mind the worktree port rule in
      `docs/local-dev.md` if you are not on a clean checkout).
- [ ] `bun run test:e2e:ssr` green — the block is server-rendered.
- [ ] Accessibility checklist from `docs/accessibility-standard.md` completed.
- [ ] Checked at 390, 768, 1024 and 1440 px.
- [ ] Checked with a stale report shape: no `wholeTask` on either series, no
      `analysisWindow`. The store is stale-first and serves pre-change bodies,
      so every consumer degrades rather than throws.
- [ ] Branch preview URL from `bun run preview-url` in the PR body and in chat.

## 10. Out of scope

Deliberately not part of this change, though they came out of the same review:

- **Collapsing the metric glossary and footnotes.** ~12 phone screens for two
  `Disclosure` wrappers, and the single biggest reduction available.
  `rac/disclosure.tsx` already forces panels open in print (`print:block!`), so
  collapsing on screen costs nothing on paper. Independent of this block — do it
  separately, it needs no copy decisions.
- **The sticky bar rework** — `SimpleSelect` → a `MenuTrigger` labelled
  *Contents* with grouped `MenuSection`s (retiring the `"· · "` prefixes that
  fake indentation), sitting under the app header rather than over it at
  `z-50`, with a reading-progress rule, and the rail dropped from `xl` to `lg`.
- **Metric families as a chip/tab switcher below `md`.** Real trade-off against
  the deliberate choice of `Disclosure` over `Tabs` (several families open side
  by side for comparison); worth measuring only after this block and the
  glossary collapse land.
- **Splitting the page into routed chapters.** Considered and rejected: it
  breaks the one-URL share, the single printable document, and the argument
  order the page depends on (the weather has to sit above the ranking).

## 11. Background

- `docs/2026-07-18-field-analysis-plan.md` — what the page is and how the
  metrics work.
- `docs/2026-07-08-information-architecture-v2.md` — design language, section
  headers, breadcrumbs.
- `docs/ssr.md` — the server-rendering contract.
- `docs/weather.md` — why the provenance tag is not decoration.
- `web/engine/src/field-analysis/version.ts` v25 — the whole-task climb figure
  and why it is pooled.
