# UI code quality review — 2026-08-06

A structural audit of `web/frontend/src` against the thermo-nuclear code quality
standard: the question is not "does it work" but "does the structure make the
behaviour inevitable". Correctness is assumed; what follows is about shape.

Snapshot: 259 TypeScript/TSX files, 67,612 lines, taken at `14dd816`.

**Verdict: changes requested.** Five presumptive blockers, all in the vanilla
analysis app. The React SPA is in materially better health — its problems are
duplication, not architecture.

**Status (2026-08-06).** Fixed: **B2**, **B4**, **B5**, **S1**, **S2**, **S3**,
**R1**, **R2**, and the file-size work on `PilotScoreDetail` and
`SubmitTrackForm`. Still open: **B1**, **B3**, **S4**, and the rest of
`RouteEditorDialog` — see "What is left, and why" at the end.

---

## Blockers

### B1. `createMapBoxProvider` is a 3,230-line function — OPEN

`web/frontend/src/analysis/mapbox-provider.ts:207`–`3436`.

The whole map provider is one function body: `new Promise(…)` wrapping a `try`
block that declares **52 mutable `let` bindings**, **40 nested functions**, and
finally a **940-line object literal** at `:2494` that closes over all of it.

```
createMapBoxProvider()            207
  new Promise(...) { try {        212
    52 × let ...                  ~233–300   scrub, 3D, camera, multi-track, HUD …
    40 × function ...             ~300–2490
    const renderer: MapProvider   2494–3436  ← the 940-line return value
  } catch (err) { reject(err) }   3431
```

This closure *is* a class that has not been written as one. Every `let` is a
field, every nested `function` is a method, and the object literal is the public
surface being hand-copied out of the private one. Nothing here is intrinsically
hard — the complexity is entirely incidental to the shape it was written in.

**The judo move**: `class MapboxProvider implements MapProvider`, with the
feature clusters that are already visually separated by comment banners (track
scrub, 3D/threebox, drone camera, multi-track, open-distance lines, HUD,
waypoint markers) extracted into their own modules taking a shared
`{ map, container }` context. `map-provider-shared.ts` already proves the pure
helpers extract cleanly; this is the same move applied to the stateful half.

Presumptive reject: a file this size is not a place where the next change can be
made safely, and the 52-variable shared mutable scope means no extraction is
locally verifiable today.

### B2. `resolve(renderer)` runs 884 lines before `renderer` exists — FIXED

`mapbox-provider.ts:1610` calls `resolve(renderer)` inside the
`map.on('load', …)` handler opened at `:1433`. `const renderer` is declared at
`:2494`.

This is a temporal dead zone the code walks past only because Mapbox's `load`
event happens to be asynchronous. A synchronously-fired `load` — a cached style,
a test double, a future Mapbox version — turns it into a `ReferenceError` at
startup with no static warning. It is also unreadable: the reader at `:1610` has
no way to know what is being resolved without scrolling nearly a thousand lines.

**Done.** The handler now records that the style is up and the resolve happens
at the bottom of the function, where the provider object demonstrably exists —
resolving immediately if `load` already fired. The ordering is no longer
load-bearing in either direction. The remaining forward references to `renderer`
are inside `restoreData()`, which runs on a basemap change: call-time, not
construction-time, and the ordinary way a helper and the object it serves refer
to each other.

### B3. `init()` in `analysis/main.ts` is 2,244 lines — OPEN

`web/frontend/src/analysis/main.ts:95`–`2338`, containing **44 nested function
declarations**.

The function opens with ~25 `document.getElementById` calls binding DOM
references as locals (`:105`–`:139`), and everything below is nested inside
purely so it can close over them. `applyTask`, `loadIGCFile`,
`computeCompetitionScore`, `loadAirScoreFromUrl`, `parseAirScoreUrl`,
`loadSampleComp`, `updateFlightInfo` — none of these are about initialisation,
and several (`parseAirScoreUrl` is a pure string parser) have no business being
inside a closure at all.

**The judo move**: DOM references belong to the module that uses them, not to a
shared preamble. Split by concern — `track-loading.ts`, `task-loading.ts`,
`comp-scoring.ts`, `settings-dialog.ts`, `feature-toggles.ts` — each exporting a
`mount(deps)` that resolves its own elements. `init()` becomes what its name
claims: a sequence of `mount` calls.

Note `react/pages/Settings.tsx` (847 lines, eight named `*Section` components)
as the counter-example already in the repository — it is large but every part is
addressable. Size is not the complaint; undifferentiated size is.

### B4. `MapProvider` declares 38 optional members for one implementation — FIXED

`web/frontend/src/analysis/map-provider.ts`. Of ~45 members, **38 are `?:`** —
`set3DMode?`, `setTaskVisibility?`, `setMultiTrack?`, `onWaypointClick?`,
`setBestProgressRoute?`, and so on. There is exactly one implementation
(`mapbox-provider.ts`), reached through one factory (`createMapProvider`,
`:290`).

The optionality models a plugin boundary that does not exist, and the cost is
paid at every call site as `?.` guards that can never be false:

```ts
mapRenderer?.setMultiTrack?.(state.tracks, pilotScores);   // main.ts:586
mapRenderer.clearMultiTrack?.();                            // main.ts:613
renderer.setOpenDistanceLines?.(openDistanceLineData);      // mapbox-provider.ts:1097
```

Worse, it defeats the type checker precisely where it would help most: rename a
provider method and every call site silently becomes a no-op instead of a
compile error.

**The judo move**: make the members required. Genuinely optional capabilities
(`supports3D` already exists as an explicit flag) stay flags; the methods behind
them become required and no-op in a provider that does not support them. The
`?.` guards then delete themselves, and a second provider — if one ever
arrives — gets a compiler-enforced contract rather than a suggestion.

**Done.** All 33 optional methods were already implemented by the one provider,
so every `?` came off and the 44 `?.` guards went with them.

### B5. Dynamic dispatch by `keyof MapProvider` — FIXED

`main.ts:78`–`94` and `:284`–`:316`. The feature-toggle table stores a method
*name* and calls it reflectively:

```ts
providerMethod: keyof MapProvider;
// …
const method = mapRenderer[toggle.providerMethod];
if (typeof method === 'function') {
  (method as (v: boolean) => void).call(mapRenderer, enabled);
}
```

A string index, a runtime `typeof` check and a double cast, all to call a method
that is known at authoring time. This exists only to route around B4's
optionality. With required methods it is a plain function field —
`apply: (on: boolean) => mapRenderer.setSpeedOverlay(on)` — fully typed, no
casts, no runtime branch.

The reflection also hides a live inconsistency. In the click handler
(`:300`–`:311`), `updateUrlParam` sits **inside** the
`typeof providerFn === 'function'` guard, while `featureState` and the status
label are updated **outside** it. If the method is ever absent, the toggle
reports itself as on, records itself as on, and the URL disagrees. Nobody would
write that branch deliberately; it is an artefact of the indirection.

**Done.** `providerMethod: keyof MapProvider` became
`apply: (map: MapProvider, enabled: boolean) => void` and `supportsProp` became
`isSupported: (map) => boolean`. The string index, the runtime `typeof` and both
casts are gone, and `updateUrlParam` now runs outside the dead guard so the
address bar can no longer disagree with the label.

---

## Leaflet's shadow

The obvious way to shrink `mapbox-provider.ts` before refactoring it is to
delete the other provider. There isn't one: Leaflet went in
[#358](https://github.com/pokle/glidecomp/issues/358) — no `leaflet-provider.ts`,
no `leaflet` dependency in any `package.json`, nothing in `bun.lock`, nothing in
`node_modules`. The only surviving mentions are in point-in-time snapshots
(`docs/audit-2026-03-04.md`, `docs/security-review.md`,
`docs/dependency-review-log.md`), which record what was true when written and are
left alone.

What that removal did leave was its shape. B4 and B5 *are* the leaflet
provider — the optionality only ever meant "Mapbox does this, Leaflet doesn't",
and the reflective dispatch existed to tiptoe around it. Two comments still
described the vanished twin (*"Options shared by both provider factories"*,
*"Get the annotation layer (Mapbox only)"*). `createMapProvider` remains as the
dynamic-import seam that keeps the map in its own chunk — it is earning that
keep, not the abstraction.

So the removal the refactor needed had already happened in the file listing and
not yet in the types. It has now.

---

## Simplification opportunities

### S1. The SSR-seeded page-load effect is copy-pasted seven times, three ways — FIXED

Every SSR'd comp page repeats the same 25–70 line shape: `useInitialData` seed →
`useState` mirrors → effect with a `cancelled` flag → status branches →
`document.title` → cleanup. The `let cancelled = false` idiom appears in **27
files**.

`pages/CompScoresPage.tsx:71`–`93` and `pages/CompPilotsPage.tsx:45`–`67` are
the same code twice, differing only in the title string.

The duplication has already drifted into **three incompatible models of one
concept**:

| Model | Pages |
|---|---|
| `notFound: boolean` | `CompDetail`, `TaskDetail`, `CompWaypoints`, `CompScoresPage`, `CompPilotsPage` |
| `status: "loading" \| "ready" \| "notFound" \| "forbidden" \| "error"` | `CompFieldAnalysis`, `TaskFieldAnalysis` |
| `DetailState` discriminated union | `PilotScoreDetail` |

Three shapes for "did the page load" is a boundary problem, not a style one: a
reader cannot carry knowledge of one page to the next, and the weakest model
(`notFound: boolean`) cannot express the distinction the strongest one exists to
draw.

**The judo move**: one `useSeededResource<T>` hook in `react/lib/` owning the
seed, the fetch, cancellation, the retry policy and the canonical result union.
Pages keep their rendering; they stop re-deciding how loading works.

**Done** for the four pages that share the model — `CompDetail`, `TaskDetail`,
`CompScoresPage`, `CompPilotsPage` — 177 lines of page code down to 60.
`TaskDetail`'s comp fetch moved out to its own effect; it used to run only after
the task resolved, so a page that works without it waited for it anyway.

Three loaders deliberately keep their own, and this finding was wrong to imply
one hook should swallow all of them. The field-analysis pages answer with a
five-way status (`forbidden` for a hidden test comp, a synthetic body for the
422), `PilotScoreDetail` resolves four requests into one narrative and tells
"still computing" from "no such pilot", and `CompWaypoints` fetches two
resources in parallel to write five pieces of state. Those are different
questions, not the same question written differently.

### S2. The pending-poll effect is byte-identical in two files — FIXED

`pages/CompFieldAnalysis.tsx` and `pages/TaskFieldAnalysis.tsx` carry the same
~18-line backoff poll (3s → 10s, `document.hidden` check, give up at 120s). A
`diff` of the two blocks differs only in the predicate's name (`pendingTasks` vs
`pending`). Extract as `usePollWhile(active, tick)`.

**Done — and the extraction found a bug both copies shared.** `startedAt` and
`delay` were locals of the effect, and the effect listed the refetch counter in
its deps, so every tick rebuilt it with the clock back at zero. The backoff never
grew past its first step and the two-minute deadline never arrived: an analysis
that stayed pending was refetched every three seconds for as long as the tab was
open, under a comment describing a backoff that could not happen. Both values now
live in refs that survive the re-run.

### S3. `formatKm` duplicates the engine's unit formatting — and ignores the user's units — FIXED

`comp/submit-track.ts:502` hard-codes kilometres:

```ts
export function formatKm(metres: number | null): string {
  if (metres === null) return "—";
  return `${(metres / 1000).toFixed(1)} km`;
}
```

The same `(metres / 1000).toFixed(1)` appears at `comp/route-editor.ts:151`,
`comp/ForgeIgcDialog.tsx:300` and `charts/ScoreCurve.tsx:116`. Meanwhile
`react/lib/units.ts` re-exports the engine's `formatDistance`, which honours the
signed-in pilot's distance preference and is what the rest of the app uses.

So a pilot who has chosen miles is shown kilometres on the track submission
confirmation — a behavioural inconsistency created purely by the duplicate
helper. Route these through `formatDistance` and delete `formatKm`.

**Done.** `formatMetres` one line below had the same defect for altitude and went
with it. Both are replaced by unit-aware equivalents whose only remaining job is
the em dash for a figure the IGC file did not carry.

### S4. `(await res.json()) as unknown as T` — 33 occurrences — PARTLY FIXED

Hono's RPC client types force a double cast at every page load
(`pages/CompDetail.tsx`, `TaskDetail.tsx`, `CompWaypoints.tsx`, `comp/csv.ts` ×5
…). It is friction from the client, not a defect, but 33 hand-written double
casts is 33 places where the wrong `T` compiles silently. One
`async function json<T>(res: Response): Promise<T>` helper puts the cast in a
single reviewable line. Folding it into `useSeededResource` (S1) removes most of
them outright.

**Partly done**: the four converted pages no longer cast — `useSeededResource`
does it once, in one place. The rest are in the loaders that keep their own
fetch, and in `comp/csv.ts`.

---

## Rule compliance

### R1. The field-analysis pages bypass `fetchWithRetry` — FIXED

`CLAUDE.md` — *"A failure to ask is not an answer"* — requires comp/task page
loads to go through `fetchWithRetry` (`react/comp/types.ts:397`) so a transient
failure is not recorded as a fact.

`pages/CompFieldAnalysis.tsx:87` and `pages/TaskFieldAnalysis.tsx:141` use a
bare `fetch`. Both are public, SSR'd pages. On a dropped request or a 5xx they
land in `status: "error"`, which renders a dead-end alert
(`TaskFieldAnalysis.tsx:435`–`446`) with no retry affordance — and the
pending-poll that would otherwise re-fetch is gated on `status === "ready"`, so
nothing recovers it. A millisecond blip becomes a broken page until manual
reload, which is precisely the failure the rule was written for.

**Done** — both now go through `fetchWithRetry`.

### R2. `fetchWithRetry` retries 4xx responses — FIXED

`comp/types.ts:410` returns early on `res.ok || res.status === 404` and retries
everything else — including 400, 401, 403 and 429. `CLAUDE.md` states a 4xx is a
real answer and must not be retried, citing `/api/auth/me` answering 429 for a
rate-limited API key.

The predicate encodes "success is ok-or-404" when the intent is "retry only
network failures and 5xx". Inverting it to `if (res.status < 500) return res`
states the actual rule and stops the helper hammering an endpoint that has
already said no.

**Done**, with a test for each of the 400, 401, 403 and 429 cases that were
being retried.

---

## File size

Eight UI files exceeded the 1,000-line threshold at the time of the review.
Three have come down:

| Then | Now | File | Assessment |
|---:|---:|---|---|
| 3,437 | 3,460 | `analysis/mapbox-provider.ts` | B1 — still one function |
| 2,433 | 2,434 | `analysis/main.ts` | B3 — still one function |
| 1,889 | 1,889 | `analysis/analysis-panel.ts` | One `createAnalysisPanel` from `:277` |
| 1,445 | **1,161** | `react/comp/RouteEditorDialog.tsx` | Turnpoint dialog + draft vocabulary split out; body still 25 `useState` |
| 1,431 | **964** | `react/pages/PilotScoreDetail.tsx` | Sub-components moved to `react/score-detail/` |
| 1,345 | 1,345 | `replay/main.ts` | Same shape as `analysis/main.ts` |
| 1,172 | **648** | `react/comp/SubmitTrackForm.tsx` | Steps and outcomes moved to `SubmitTrackSteps.tsx` |
| 1,049 | 1,049 | `analysis/map-provider-shared.ts` | Cohesive pure helpers — lowest concern |

`mapbox-provider.ts` grew by 23 lines: the B2 fix trades a one-line
`resolve(renderer)` for a latch and the comment explaining why it exists. The
file gets smaller when B1 lands, not before.

## What is in good shape

Worth stating plainly, because it constrains the recommendations above:

- **CSS discipline is exemplary.** `react/globals.css` is 267 lines with **two**
  custom classes; everything else is Tailwind utilities and design tokens. The
  one-kit rule is holding — `react/rac/` has 30 components and
  `one-kit.test.ts` guards the boundary.
- **Type hygiene is strong.** Two occurrences of `any` in 67k lines. The
  `as unknown as` casts (S4) are third-party friction, not loose typing.
- **Comments explain *why*.** The codebase consistently records the reasoning
  behind non-obvious choices — the `cancelled`-flag rationale, why
  `SubmitTrackForm` fetches open comps even when prefilled, why dates pin
  `en-GB`. This is rare and should survive any refactor; carry the comments with
  the code they explain.
- **`react/lib/` is a real canonical home.** `slug.ts`, `crumbs.ts`, `retry.ts`,
  `format.ts`, `units.ts` are properly factored — which is why the duplication in
  S1–S3 reads as oversight rather than as an absent convention.

---

## What is left, and why

Four things are open. Two are open on purpose.

**B1 (`MapboxProvider` class) and B3 (splitting `analysis/main.ts`) are not
blocked on effort — they are blocked on evidence.** Between them they are 5,700
lines of stateful browser code, and this repository has no automated coverage of
either: `/analysis.html` is not driven by any e2e spec, and the one map spec
(`e2e/lazy-map-in-view.spec.ts`) says in its own header that it asserts the
component mounts, not that anything paints — deliberately, so it needs no Mapbox
token. A `tsc` pass over a rewritten `createMapBoxProvider` would prove almost
nothing about a 52-variable mutable scope, event ordering, or object lifetimes.

So the honest sequence is coverage first: a spec that loads a track and a task
on `/analysis.html` and asserts the panel, the turnpoint list and the score
render; then the extraction, one feature cluster at a time, against it. Doing it
the other way round produces a green typecheck and an unverified map.

B4 and B5 were the part of this that could be done blind, and they were worth
doing first for exactly that reason: the provider contract is now checked, so
the extraction the compiler could not previously verify, it now can.

**`RouteEditorDialog` stops at 1,161 lines** for the same reason at smaller
scale. Its remaining bulk is the component body — 25 `useState` hooks and the
SSS, goal, grid and import panels inline — and breaking those out means lifting
state in a dialog nothing in e2e drives.

**S4** is partly done and the remainder is not worth a dedicated pass; it will
fall out of whatever touches those loaders next.

## Suggested order for what remains

1. **Cover the analysis page.** One e2e spec that loads a track and a task and
   asserts what renders. This is the prerequisite for the two blockers, and it
   is worth having regardless — the largest surface in the app currently has
   none.
2. **B1** — `MapboxProvider` class plus feature-module extraction, one cluster
   at a time against that spec.
3. **B3** — split `analysis/main.ts` by concern; then the same move for
   `replay/main.ts` and `analysis-panel.ts`.
4. **`RouteEditorDialog`** — a reducer for the 25 hooks, and the panels out to
   their own components.
