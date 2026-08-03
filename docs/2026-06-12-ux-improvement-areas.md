# UX Improvement Areas

Date: 2026-06-12

> **Reading note (added 2026-07-29):** this is a point-in-time snapshot of the
> *pre-React* frontend. The main UI has since been rebuilt as a React SPA under
> `web/frontend/src/react/`, so the vanilla-TS file/line citations below
> (`comp-detail.ts`, `comp.ts`, `settings.ts`, `dashboard.ts`, `feedback.ts`)
> no longer resolve — they are kept as the record of what was reviewed, with
> the current location annotated inline where it matters. The findings and
> reasoning are unchanged.

A review of the GlideComp UX based on the frontend code, the existing design
docs (`information-architecture.md`, `ux-inventory.md`, and the since-removed
`TODO.md`), and a full sweep of the UI surface.

**Summary:** The analysis page is polished, but the competition pages feel
like a different, rougher product — native browser `alert()` dialogs,
plain-text loading states, no aria coverage. The other big themes are
first-time discoverability (the command menu and sample flights are hidden),
missing feedback (no spinners, no quota visibility, silent state changes), and
the unfinished half of the information-architecture plan.

## 1. Finish the competition-side polish (highest impact)

- **Replace native `alert()`/`confirm()` with Basecoat dialogs/toasts.**
  There are ~30 call sites in `comp-detail.ts` (e.g. lines 332, 367, 2059),
  `comp.ts:153`, `settings.ts:104`, and `dashboard.ts:222`. The analysis page
  already has a proper status-alert system (`analysis/main.ts:1806`) — the
  comp pages should match it. This also violates the CLAUDE.md rule to use
  Basecoat components. *(✅ Done. Those pre-React modules are gone; the React
  SPA uses the app-wide confirm dialog `src/react/rac/confirm.tsx` and the
  `sonner` toaster `src/react/vendor/sonner.tsx`.)*
- **Execute IA migration steps 3–7** from `information-architecture.md`:
  restructure comp detail as a sectioned page, move "Comp Score"/"GAP Config"
  out of the analysis sidebar, add a "View on Map" bridge from task detail,
  and route analysis under `/u/{username}/`. Steps 1–2 shipped; the remaining
  steps address the documented "8-tab overload" and "disconnected competition
  flow" problems. *(✅ Superseded and done: `docs/information-architecture.md`
  now marks itself superseded by
  [Information Architecture v2](2026-07-08-information-architecture-v2.md),
  which is implemented — the comp page is the hub and navigation collapsed
  around it.)*
- **Add loading states.** Comp detail, profile, and settings show bare
  "Loading..." text. Skeleton placeholders would make slow networks feel less
  broken.

## 2. First-run discoverability

- The analysis empty state ("Drop an IGC file on the map, or use Menu to load
  one") undersells the app. Make "Try a sample flight" a prominent,
  always-visible CTA and surface the command menu (`Cmd+K`) with a visible
  hint — power features like XContest import and map-provider switching are
  invisible to anyone who doesn't open the menu. *(✅ Done — both halves. The
  empty state carries a "Try a sample flight" button
  (`web/frontend/src/analysis/analysis-panel.ts:327`), and the map's Menu
  control renders a visible `<kbd>` beside its label showing `⌘K` on macOS and
  `Ctrl+K` elsewhere (`web/frontend/src/analysis/mapbox-provider.ts:1220-1221`).
  Correction to the 2026-07-29 annotation, which recorded the hint as still
  open: it had in fact shipped in
  [#93](https://github.com/pokle/glidecomp/pull/93) on 2026-03-12, before this
  review was written.)*
- **Multi-track / comparison mode is completely hidden.** Loading several
  IGCs silently enables the comp-score tab with no indication that this mode
  exists or is active. Add an explicit "compare flights" affordance and a
  visible state indicator when multiple tracks are loaded.
- Pilot filtering in the comp-score tab (`analysis/main.ts:973`) toggles
  tracks with no visual state — use checkboxes or highlighted rows so users
  know filtering is active.

## 3. Feedback for long or destructive operations

- **No progress indication during IGC parse/analysis.** A 5-hour track
  (~18k fixes) takes noticeable time; show a spinner or progress toast so
  users don't drop the file twice.
- ✅ **Storage quota is invisible until it errors** (`dashboard.ts:217-222`
  shows an `alert()` only on failure — pre-React path, since replaced by the
  React dashboard). Add a quota meter on the dashboard and warn before the
  limit. *(Shipped: `web/frontend/src/react/pages/Dashboard.tsx` renders a
  `ProportionMeter` from `src/react/rac/meter.tsx`, so the quota is readable
  before it bites.)*
- **Task editor has no undo** — accidentally hitting "Clear all" destroys the
  task with no recovery (`task-editor.ts`). Either add an undo stack (one
  already exists for annotations) or a confirm + toast-with-undo.
- Selecting an event clears all other map markers with no hint they'll come
  back — a subtle "showing selected event" cue would help.

## 4. Knock off the documented usability debt

Still open as of this review (`TODO.md` has since been removed; open work now
lives in [GitHub issues](https://github.com/pokle/glidecomp/issues)):

- ✅ Explain scores **on the map** — scoring decisions are explainable by
  design principle, but the explanation isn't surfaced where users look.
  *(Shipped: `web/frontend/src/react/comp/ScoreDetailMap.tsx` puts the map
  alongside the report card at `/comp/:id/task/:id/pilot/:id`.)*
- ✅ Glide segment visualization: bigger fonts, 1 km chevrons. *(Shipped, both
  halves, in `web/frontend/src/analysis/mapbox-provider.ts`: the glide speed
  labels are 20px and outrank the optimised-route leg labels, which the swap
  dropped to 16px; and `renderSpeedOverlay` spaces the chevrons by
  `getSegmentLengthMeters(config.getUnits().distance)`, so "1 km" is really one
  display distance unit — the spacing follows the unit the reader chose.)*
- "Clear all storage" has no standalone UI — only via Delete Account, which
  is a scary path for a routine action.
- The unclickable track segments bug is a real UX dead end — segments that
  respond to nothing feel broken even if event detection is technically the
  issue.
- ✅ Link the GAP explainer from the score surfaces — it exists but users
  analyzing a score can't find it ("what are leading points?" is one click
  too far away). *(Shipped, at a different URL than this line guessed: there
  is no `/scoring.html`; the guides are prerendered Astro pages —
  `web/frontend/static/src/pages/scoring/gap.astro` at `/scoring/gap` — and
  the report card deep-links them per section via each section's `docHref`.)*

## 5. Accessibility and mobile

- Aria coverage is good on `analysis.html` (52 attributes) but **zero** on
  onboarding, profile, scores, settings, scoring, and theme-editor pages.
  Forms there need labeled inputs, `role="alert"` on errors, and focus
  management in dialogs. *(Note: the theme-editor page no longer exists —
  `web/frontend/public/_redirects` sends `/theme-editor` to `/` with a 301, and
  the only theme code left is `src/react/lib/theme.ts`. The other five surfaces
  still stand as reviewed.)*
- The theme editor lets users pick any colors but doesn't validate contrast —
  a live WCAG contrast checker would prevent illegible shared themes. *(Moot:
  the theme editor has since been removed, so there is no palette for a user to
  choose and nothing for a contrast checker to check.)*
- On mobile, the sidebar auto-closes after selecting an event
  (`analysis/main.ts:908`), which can feel like a dead end; consider a
  partially-collapsed state or a more obvious reopen affordance.

## Suggested priority order

1. ✅ Dialogs/toasts on comp pages (small effort, removes the most jarring
   inconsistency) — originally implemented via `web/frontend/src/feedback.ts`;
   that file was removed with the React SPA rewrite and the job now belongs to
   `src/react/rac/confirm.tsx` (app-wide confirm) and
   `src/react/vendor/sonner.tsx` (toaster)
2. ✅ Loading/progress feedback (parse status, skeletons, quota meter) —
   implemented alongside item 1; the current loading family is
   `src/react/rac/progress.tsx`
3. ✅ Sample-flight + command-menu discoverability on the analysis empty state
   — the sample-flight half is `web/frontend/src/analysis/
   analysis-panel.ts:327`, which renders a "Try a sample flight" button in the
   empty state; the command-menu half is the Menu control's visible `⌘K` /
   `Ctrl+K` `<kbd>` hint in
   `web/frontend/src/analysis/mapbox-provider.ts:1220-1221` (shipped in
   [#93](https://github.com/pokle/glidecomp/pull/93))
4. ✅ IA migration steps 3–5 (comp detail restructure, move comp tabs, "View on
   Map") — delivered by IA v2, see §1
5. Task editor undo + clear-all-storage UI
6. Aria/contrast pass on the non-analysis pages — *largely superseded rather
   than done: the react-aria-components migration
   ([#483](https://github.com/pokle/glidecomp/issues/483), finished 2026-07-27)
   rebuilt those pages on a kit that carries the ARIA wiring, and
   [docs/accessibility-standard.md](accessibility-standard.md) now sets WCAG 2.2
   AA across the SPA, the static pages, the analysis map and the 3D replay, with
   a per-PR checklist. Measure against that standard rather than against this
   line*
