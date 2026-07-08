# Accessibility Standard

Date: 2026-07-08
Status: adopted. The baseline every UI change is measured against.

This is GlideComp's accessibility standard. It exists so "is this accessible?"
has a concrete, checkable answer instead of a judgement call. **All future UI
work is compared against this document** — new features, redesigns, and fixes
alike. If a change conflicts with the standard, either fix the change or amend
the standard in the same PR (with a reason), never silently diverge.

It is deliberately specific to *this* codebase and its four rendering
surfaces. Generic "follow WCAG" advice is not actionable; the rules below name
the components, tokens, and IA v2 conventions we actually ship.

---

## 1. Conformance target

- **Baseline: [WCAG 2.2](https://www.w3.org/TR/WCAG22/) Level AA** for all
  content pages and the main app UI. Every success criterion listed as A or AA
  applies unless explicitly exempted below.
- **AAA where cheap**: we adopt individual AAA criteria when they cost little
  (e.g. `2.4.9` link purpose, `1.4.6` enhanced contrast on primary text) but do
  not target full AAA.
- **No known regressions**: a change may not remove an accessible affordance
  that exists today (keyboard reachability, a label, a landmark) without a
  documented replacement.

"AA unless exempted" means: if you can't meet a criterion, that's a finding to
raise in the PR, not a default to accept.

---

## 2. The four surfaces (scope)

GlideComp renders UI four ways. The standard applies to all four, but the *how*
differs. Know which surface you're touching:

| Surface | Where | Foundation | Accessibility posture |
|---|---|---|---|
| **Main app (SPA)** | `web/frontend/src/react/` served from `src/app.html` | React + shadcn/ui on Base UI | Full AA. Use the primitives — they carry the ARIA. |
| **Content pages (static)** | `web/frontend/static/` (Astro, prerendered) | Semantic HTML, zero client JS | Full AA, and the *easiest* place to hit it — it's just HTML. No JS means no focus traps to manage. |
| **Analysis map** | `/analysis.html` (vanilla TS) | Imperative map app, `analysis.css` | AA for all controls/panels. The map canvas itself follows §9 (non-text-content rules for interactive graphics). |
| **3D replay** | `/replay` (vanilla TS + WebGL) | Own `replay.css` + inline theme | AA for the control chrome. The 3D scene follows §9. |

`lang="en"` is set on both `src/app.html` and `static/src/layouts/Base.astro`
— keep it on any new HTML entry point.

---

## 3. Perceivable

### 3.1 Colour & contrast (WCAG 1.4.3, 1.4.11)

- **Text contrast ≥ 4.5:1** (≥ 3:1 for large text ≥ 24px, or ≥ 18.66px bold),
  in **both** light and dark themes. Colour tokens live in
  `web/frontend/src/react/globals.css` (oklch) and are reused by the static
  Astro pages. When you introduce or restyle a token pairing
  (`--foreground`/`--background`, `--muted-foreground`/`--muted`,
  `--primary-foreground`/`--primary`, `--destructive`…), verify the ratio in
  both `:root` and `.dark`.
- **Non-text contrast ≥ 3:1** (WCAG 1.4.11) for UI component boundaries and
  states that convey meaning: input borders, the focus ring (`--ring`),
  checkbox/radio marks, chart/track lines and legends on the analysis and
  replay surfaces.
- **Never encode meaning in colour alone** (WCAG 1.4.1). Task status, pilot
  status, validated/errored fields, and score deltas must also carry a shape,
  icon, text label, or pattern. Red/green for gain/loss needs a `+`/`−` sign or
  arrow too.
- Respect the user's theme; do not hard-code colours that break in dark mode
  (the replay's inline theme included).

### 3.2 Text & zoom (WCAG 1.4.4, 1.4.10, 1.4.12)

- Layout must survive **200% zoom** and a **320px-wide viewport** with no loss
  of content or function and **no horizontal scrolling** of the page body.
  Wide content (score tables, the audit log, task turnpoint lists) scrolls
  inside its own container, not the page.
- Use relative units (`rem`, `em`, `%`, `ch`) for text and spacing that should
  scale. Do not disable pinch-zoom (no `maximum-scale`/`user-scalable=no` in
  any viewport meta).
- The comp page's print sections (`#tasks #scores #pilots #activity #admins`,
  each `break-before-page`) must remain legible when printed — briefings depend
  on it.

### 3.3 Images, icons & media (WCAG 1.1.1, 1.2.x)

- Every `<img>` has an `alt`. Informative images describe content; purely
  decorative images use `alt=""` (or CSS backgrounds). The hills background and
  similar chrome are decorative → empty alt.
- Icon-only controls (icon buttons, the account-menu avatar) MUST have an
  accessible name via `aria-label` or visually-hidden text. This already holds
  in `Shell.tsx` (`aria-label="Account menu"`, `aria-label="Main"`) — keep it
  for every new icon button.
- The QR code affordance (IA v2 §8) is presentational; the task URL it encodes
  MUST also be present as real text/link. A QR code is never the only path.
- Embedded video (YouTube) is third-party; when we host our own instructional
  media it needs captions (1.2.2).

---

## 4. Operable

### 4.1 Keyboard (WCAG 2.1.1, 2.1.2)

- **Everything works from the keyboard.** Every interactive element is
  reachable and operable with Tab / Shift-Tab / Enter / Space / arrow keys, and
  nothing traps focus (except a modal, which traps *intentionally* and releases
  on close — Base UI's `Dialog`/`AlertDialog` handle this; use them rather than
  rolling your own).
- **No click-only handlers.** Do not attach behaviour to a non-interactive
  element (`div`/`span` with `onClick`). Use `<button>`, `<a>`, or the shadcn
  primitive. If a design truly needs a custom widget, it needs `role`,
  `tabindex`, and key handlers to match — but reach for the primitive first.
- Map/replay: pan, zoom, layer toggles, and playback controls must have
  keyboard equivalents even where the primary interaction is pointer/drag. A
  drag-only control fails this.

### 4.2 Focus (WCAG 2.4.7, 2.4.11, 2.4.13)

- **Visible focus indicator on every focusable element.** shadcn buttons/inputs
  ship `focus-visible:ring-3 focus-visible:ring-ring/50` — do not strip it. Any
  custom focusable element gets an equivalently visible ring using `--ring`
  (which must keep ≥ 3:1 against its background, see §3.1).
- Never set `outline: none` without providing a replacement indicator.
- Focus must not be obscured (WCAG 2.4.11): sticky headers (the 60px chrome,
  the mobile anchor bar) and toasts (`sonner`) must not cover the focused
  element.
- **Focus order follows reading order** (WCAG 2.4.3). When a dialog opens, focus
  moves into it; when it closes, focus returns to the trigger. The route editor
  deep-link (`#edit-route`) and `#scores` redirect must land focus sensibly, not
  at the top of `<body>`.

### 4.3 Navigation & landmarks (WCAG 2.4.1, 1.3.1)

- **Skip link**: every page with the global chrome provides a "Skip to main
  content" link as the first focusable element, targeting the `<main>` landmark.
  *(Status: not present today — required for new/changed page shells and to be
  backfilled in `Shell.tsx` and `Base.astro`.)*
- **Landmarks**: one `<header>`, one `<nav aria-label="Main">` (already in
  `Shell.tsx`), one `<main>`, one `<footer>` per page. The full-screen tools
  (`/analysis.html`, `/replay`) use their top-center breadcrumb bar (IA v2 §3)
  as the nav landmark.
- **One `<h1>` per page**, and it is the current-page marker (IA v2 makes the
  H1-below-breadcrumbs the current page). Headings are hierarchical and not
  skipped (no h2 → h4). `SectionHeader` titles are real headings, not styled
  text.
- **Breadcrumbs** (`Breadcrumbs.tsx`) are parents-only and use the same label
  for the same destination everywhere ("Competitions"). Mark up as a `<nav
  aria-label="Breadcrumb">` with an ordered list.
- **Page titles** (WCAG 2.4.2): each SPA route sets a unique, descriptive
  `<title>`; static pages already do.

### 4.4 Motion (WCAG 2.3.3, 2.2.2)

- Honour `prefers-reduced-motion`: non-essential transitions, the 3D replay's
  auto-play camera moves, and any autoplaying animation must reduce or stop.
  *(Status: no `prefers-reduced-motion` handling exists today — required for any
  new animation and to be added where motion already ships, notably the replay
  and page transitions.)*
- No content flashes more than 3×/second (WCAG 2.3.1).
- Anything that auto-updates or auto-advances (toasts, live activity feed) is
  pausable/dismissable and does not steal focus.

### 4.5 Targets (WCAG 2.5.8)

- Pointer targets are **≥ 24×24 CSS px**, or have ≥ 24px spacing. The shadcn
  `xs`/`icon-xs` (24px) sizes are the floor — do not go below, and avoid
  crowding multiple sub-24px targets (e.g. per-row track actions in dense
  tables).

---

## 5. Understandable

### 5.1 Forms & inputs (WCAG 1.3.5, 3.3.1, 3.3.2, 3.3.3, 4.1.2)

- **Every input has a programmatically associated label** — use the shadcn
  `Field`/`Label` components (`for`/`id` wiring), not a bare placeholder.
  Placeholder text is not a label.
- Required fields, formats, and constraints are stated in text, not only by
  colour or a lone asterisk.
- **Errors** (3.3.1/3.3.3): identify the field in text, describe how to fix it,
  and wire it with `aria-invalid` + `aria-describedby` pointing at the message.
  The shadcn field styles already react to `aria-invalid`; supply the message
  and association.
- Autocomplete: use `autocomplete` tokens on identity/login fields (WCAG 1.3.5).
- The shared `SubmitTrackDialog` "Submitting for" row must remain a real,
  labelled control (select/combobox) — its auto-selection of a pilot from the
  IGC header must be announced (see §6) and correctable, per IA v2 §10.

### 5.2 Predictable (WCAG 3.2.1, 3.2.2, 3.2.3)

- No change of context on focus or on simple input. A `<select>` may not
  navigate on change without an explicit action; focusing a field may not open
  a dialog.
- Navigation (tabs, breadcrumbs, footer) is consistent across pages — IA v2
  already mandates identical chrome on SPA and static surfaces; keep it byte-for
  -byte consistent.

### 5.3 Language & clarity

- `lang="en"` on the root; mark any inline foreign-language content with `lang`.
- Link and button text describes its destination/action out of context (WCAG
  2.4.4/2.4.9). No bare "click here" / "read more"; "Download .xctsk" and
  "Edit route…" are the model.

---

## 6. Robust (WCAG 4.1.2, 4.1.3)

- **Prefer the primitive.** shadcn/Base UI components in `src/react/ui/` carry
  the correct roles, states, and keyboard behaviour. Add missing ones with
  `bunx shadcn@latest add <name>` before hand-rolling. A hand-rolled widget must
  expose the same name/role/value and states (`aria-expanded`, `aria-pressed`,
  `aria-selected`, `aria-current`) — the `aria-pressed`/`aria-current` usage in
  `Shell.tsx` is the reference.
- **The active tab** carries `aria-current="page"` (in addition to the visual
  underline).
- **Status messages** (WCAG 4.1.3): toasts (`sonner`), async save results,
  score-staleness/recompute notices, and the SubmitTrackDialog's auto-detected
  pilot must be announced via an appropriate live region (`aria-live="polite"`,
  or `role="alert"`/`aria-live="assertive"` for errors) without moving focus.
- Do not put interactive ARIA roles on the wrong element (no `role="button"` on
  an `<a>` that navigates).
- The analysis and replay surfaces are vanilla TS with no primitive library —
  their controls (`.btn*`, `.input`, `.command` in `analysis.css`) must set the
  ARIA attributes explicitly.

---

## 7. Motion, maps & data-viz specifics

The map and 3D surfaces are where "just use the primitive" doesn't apply, so
they get explicit rules:

- **Interactive graphics need a text alternative** (WCAG 1.1.1): the task map,
  glide/thermal charts, sparklines, and the 3D scene must convey their essential
  information in an adjacent accessible form too — the score explainer's numbers,
  the task turnpoint list, a data table. The visual is an enhancement, never the
  sole source of truth. This aligns with the project rule that *decisions must be
  explainable*: an accessible text explanation is the same artifact.
- Chart/track colours meet the 3:1 non-text-contrast bar and are
  distinguishable without colour (line style, direct labels, markers) — see the
  `dataviz` skill.
- Map interactions follow `docs/mapbox-interactions-spec.md`; any keyboard
  affordances added for accessibility become part of that single-source spec so
  all providers match.
- Reduced-motion (§4.4) applies to camera fly-throughs and auto-rotation.

---

## 8. Per-PR checklist

Copy into any PR that touches UI. A box you can't tick is a finding to raise,
not a box to skip.

```
Accessibility (docs/accessibility-standard.md)
- [ ] Keyboard: every new control is reachable + operable, no focus trap, focus returns on dialog close
- [ ] Focus: visible ring on every focusable element (didn't strip focus-visible)
- [ ] Contrast: text ≥4.5:1 and UI/borders ≥3:1, checked in BOTH light and dark
- [ ] Not colour-alone: status/state also has text/icon/shape
- [ ] Names: every input has an associated label; every icon button has an accessible name
- [ ] Semantics: correct element/primitive, one h1, headings not skipped, landmarks intact
- [ ] Errors announced + associated (aria-invalid + aria-describedby); status changes in a live region
- [ ] Zoom/reflow: works at 200% and 320px wide, no page-body horizontal scroll
- [ ] Reduced motion: honoured for any new animation
- [ ] Targets ≥24px
- [ ] Alt text on images (empty for decorative)
- [ ] Maps/charts: essential info also available as accessible text/table
```

---

## 9. How to test

Automated checks catch ~30–40% of issues; the rest is manual. Do both.

1. **Keyboard-only pass**: unplug the mouse. Tab through the whole flow. Can you
   reach and operate everything? Is focus always visible and never lost?
2. **Zoom/reflow**: browser zoom to 200%, then narrow to 320px. Nothing clipped,
   no horizontal scrollbar on the body.
3. **Screen reader smoke test**: VoiceOver (macOS, ⌘F5) or NVDA (Windows). Walk
   the landmarks and headings; confirm names, roles, and that status changes are
   announced.
4. **Contrast**: browser devtools contrast checker (or the `dataviz` validator
   for palettes) on new token pairings, in both themes.
5. **Automated**: run [axe DevTools](https://www.deque.com/axe/devtools/) /
   Lighthouse accessibility audit on changed pages. Wire `axe-core` into the
   Playwright e2e suite (`bun run test:e2e`) for changed routes where practical;
   a zero-violations axe run is necessary but **not sufficient** — it does not
   replace the manual passes above.

---

## 10. Known gaps to close

Backlog of standard-violations that exist in the codebase today, tracked so
they're closed deliberately rather than rediscovered:

1. **No skip link** on any page shell (§4.3) — add to `Shell.tsx` and
   `Base.astro`.
2. **No `prefers-reduced-motion` handling** anywhere (§4.4) — cover page
   transitions and the 3D replay camera.
3. **`aria-current="page"` on the active nav tab, static pages only** (§6) —
   the SPA gets it free from React Router's `NavLink` (`Shell.tsx`), but the
   static Astro header (`SiteHeader.astro`) marks the active tab with an
   underline only.
4. **Map/replay keyboard parity + text alternatives** (§4.1, §7) — audit needed;
   drag/pointer-only interactions likely fail.
5. **Live-region coverage** for toasts and the SubmitTrackDialog auto-detect
   (§6) — confirm `sonner` announces and add regions where missing.

New work should not add to this list; each item here is a candidate for its own
follow-up PR.
