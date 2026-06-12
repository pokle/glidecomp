# UX Improvement Areas

Date: 2026-06-12

A review of the GlideComp UX based on the frontend code, the existing design
docs (`information-architecture.md`, `ux-inventory.md`, `TODO.md`), and a full
sweep of the UI surface.

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
  Basecoat components.
- **Execute IA migration steps 3–7** from `information-architecture.md`:
  restructure comp detail as a sectioned page, move "Comp Score"/"GAP Config"
  out of the analysis sidebar, add a "View on Map" bridge from task detail,
  and route analysis under `/u/{username}/`. Steps 1–2 shipped; the remaining
  steps address the documented "8-tab overload" and "disconnected competition
  flow" problems.
- **Add loading states.** Comp detail, profile, and settings show bare
  "Loading..." text. Skeleton placeholders would make slow networks feel less
  broken.

## 2. First-run discoverability

- The analysis empty state ("Drop an IGC file on the map, or use Menu to load
  one") undersells the app. Make "Try a sample flight" a prominent,
  always-visible CTA and surface the command menu (`Cmd+K`) with a visible
  hint — power features like XContest import and map-provider switching are
  invisible to anyone who doesn't open the menu.
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
- **Storage quota is invisible until it errors** (`dashboard.ts:217-222`
  shows an `alert()` only on failure). Add a quota meter on the dashboard and
  warn before the limit.
- **Task editor has no undo** — accidentally hitting "Clear all" destroys the
  task with no recovery (`task-editor.ts`). Either add an undo stack (one
  already exists for annotations) or a confirm + toast-with-undo.
- Selecting an event clears all other map markers with no hint they'll come
  back — a subtle "showing selected event" cue would help.

## 4. Knock off the documented usability debt

Still open in `TODO.md`:

- Explain scores **on the map** — scoring decisions are explainable by design
  principle, but the explanation isn't surfaced where users look.
- Glide segment visualization: bigger fonts, 1 km chevrons.
- "Clear all storage" has no standalone UI — only via Delete Account, which
  is a scary path for a routine action.
- The unclickable track segments bug is a real UX dead end — segments that
  respond to nothing feel broken even if event detection is technically the
  issue.
- Link `/scoring.html` from the score/comp-score tabs — the GAP explainer
  exists but users analyzing a score can't find it ("what are leading
  points?" is one click too far away).

## 5. Accessibility and mobile

- Aria coverage is good on `analysis.html` (52 attributes) but **zero** on
  onboarding, profile, scores, settings, scoring, and theme-editor pages.
  Forms there need labeled inputs, `role="alert"` on errors, and focus
  management in dialogs.
- The theme editor lets users pick any colors but doesn't validate contrast —
  a live WCAG contrast checker would prevent illegible shared themes.
- On mobile, the sidebar auto-closes after selecting an event
  (`analysis/main.ts:908`), which can feel like a dead end; consider a
  partially-collapsed state or a more obvious reopen affordance.

## Suggested priority order

1. ✅ Basecoat dialogs/toasts on comp pages (small effort, removes the most
   jarring inconsistency) — implemented via `web/frontend/src/feedback.ts`
2. ✅ Loading/progress feedback (parse status, skeletons, quota meter) —
   implemented alongside item 1
3. Sample-flight + command-menu discoverability on the analysis empty state
4. IA migration steps 3–5 (comp detail restructure, move comp tabs, "View on
   Map")
5. Task editor undo + clear-all-storage UI
6. Aria/contrast pass on the non-analysis pages
