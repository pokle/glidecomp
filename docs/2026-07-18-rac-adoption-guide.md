# React Aria Components (RAC) adoption — status, gotchas, and continuation guide

**Audience:** agents/developers continuing the RAC exploration in later sessions.
**Status (2026-07-18):** the task detail page (`/comp/:id/task/:id`) and every
dialog it opens is fully converted to react-aria-components and verified
(typecheck, unit tests, production build, 12/12 SSR e2e with clean hydration,
headless admin drives with zero console errors). The route editor's turnpoint
grid has since been rebuilt as a **GridList card list** (2026-07-18, see that
section). The rest of the app still uses the shadcn/Base UI kit in
`src/react/ui/`. The decision so far: **keep going with RAC** — it earned its
keep everywhere except editable tables, where we built our own support (the
GridList card list is now the preferred pattern for editable collections; see
gotchas).

## What exists

- **The RAC kit: `web/frontend/src/react/rac/`** — styled with the existing
  Tailwind tokens to match the shadcn look. One component-family per file:
  `button` (Button/LinkButton/ToggleButton + buttonVariants), `dialog`
  (Modal/Dialog/DialogHeader/Title/Footer — auto ✕, dismissable by default,
  alertdialog role opts out of both), `field` (TextField/NumberField/
  SearchField/Label/Description/FieldError/Input), `select` (Select/SelectItem/
  SimpleSelect — string-in/out drop-in for the old comp/fields SimpleSelect),
  `checkbox` (Checkbox/CheckboxGroup), `table` (Table/TableHeader/Column/Row/
  Cell/CellEditZone), `grid-list` (GridList/GridListItem — vertical card list
  with `keyboardNavigationBehavior="tab"`, the editable-list alternative to
  Table; see the route editor), `list-box`, `menu`, `tooltip`, `tag-group`, `disclosure`,
  `breadcrumbs`, `badge` (static span — RAC has no presentational components),
  `confirm` (RacConfirmProvider — supplies the same ConfirmContext as
  lib/confirm.tsx so `useConfirm()` inside a wrapped subtree gets the RAC
  alertdialog), `router` (RacRouterProvider — bridges RAC `href` links to
  react-router; SSR-safe).
- **Converted files:** `pages/TaskDetail.tsx` (page + EditTaskDialog +
  turnpoints table), `comp/TaskStandings.tsx`, `comp/RouteEditorDialog.tsx`
  (Tabulator grid → RAC **GridList** card list, see below — was a RAC Table),
  `comp/SubmitTrackDialog.tsx`,
  `comp/ManualFlightDialog.tsx`, `comp/AddWaypointDialog.tsx`,
  `comp/TaskExportButtons.tsx`, `comp/ScoreFreshness.tsx` (button only).
  Note the last five are **shared** — CompDetail/CompWaypoints/Scores already
  render these RAC components today; RAC components work fine outside the
  converted page (no provider needed except for `href`-based client routing).
- **Not converted:** everything else. Tabulator remains in the comp-page
  pilots dialog only. The ui/ (shadcn) kit stays for unconverted pages.
- The date/time pickers (`ui/date-picker.tsx`) were already RAC and are used
  as-is by both kits.

## Conventions

- Style with the app's existing tokens; use RAC's **data attributes** for
  states (`data-hovered:`, `data-pressed:`, `data-focus-visible:`,
  `data-selected:`, `data-entering:`/`data-exiting:` for overlay animation) —
  not CSS pseudo-classes — so mouse/touch/keyboard behave identically.
- Kit components accept plain `className` strings (they wrap RAC's
  className-render-prop API).
- Buttons use `onPress`, fields use `isDisabled`/`isRequired`, dialogs use
  `isOpen`/`onOpenChange` on `Modal`. A `<Button slot="close">` anywhere in a
  Dialog closes it.
- Non-SPA URLs (`/analysis.html`, `/replay`, API download links) must be plain
  `<a className={buttonVariants(...)}>` — RAC Links inside RacRouterProvider
  client-route every relative href (links with `download` or `target=_blank`
  are exempt).
- Keep page visuals identical to the shadcn kit unless intentionally changing
  design — the exploration compares behavior/DX, not looks.

## Hard-won gotchas (read before touching RAC code)

1. **NumberField snaps values to `minValue + k·step`.** `minValue={1}
   step={100}` displayed stored 1000/5000/400 as 1001/5001/401. Keep `step={1}`
   (or align minValue to the step grid) whenever stored values are arbitrary.
   Use `formatOptions={{ useGrouping: false }}` for machine-ish numbers.
   Home/End in a NumberField set min/max — standard ARIA spinbutton behavior.
2. **Table is a navigation/selection grid, not an edit grid.** Cells attach a
   **capture-phase** keydown handler (`useGridCell`) that steals
   Arrow/Left/Right for cell navigation — bubble-phase `stopPropagation` on an
   inner input can never win, so carets can't move in inline editors. Fix:
   wrap inline editors in `CellEditZone` (rac/table.tsx), which flips
   `TableState.setKeyboardNavigationDisabled` while focus is inside (same flag
   RAC's column resizer uses) and restores nav on blur. Keyboard reorder path
   still works: focus row → ArrowRight → drag handle → Enter. Note GridList
   has `keyboardNavigationBehavior="tab"` for this; **Table does not**.
   Spectrum 2's answer (`EditableCell` in @react-spectrum/s2) is a popover
   editor — no live inputs in the grid at all; there is no RAC equivalent yet.
3. **RAC collections cache each item's render by object identity.** Row props
   derived from *outside* the item (row number from index, legs/dirs computed
   from the whole route) go stale on reorder or when another row's edit shifts
   them. Fix: `dependencies={[...]}` on TableBody/ListBox/Menu (documented
   cache-invalidation prop on all collection components).
4. **Drag-and-drop:** the `slot="drag"` button is `pointer-events: none` BY
   DESIGN — mouse/touch drag the row itself (`tr[draggable]`); the button is
   the keyboard/AT path. The default DropIndicator is invisible — pass
   `renderDropIndicator` with `data-drop-target:outline-*` classes.
5. **Grid focus management redirects programmatic `.focus()`** to the cell's
   cached child — Playwright drives must navigate like a user (click a cell,
   then arrow keys), not `.focus()` + key events.
6. **Dialog defaults differ from Base UI:** RAC has no built-in ✕ and is not
   outside-click dismissable by default. The kit's Modal/Dialog add both;
   `role="alertdialog"` opts out (decisions get explicit buttons only).
7. **Table Column `width`/`minWidth` props** require ResizableTableContainer —
   use className widths in a plain Table.
8. `spellCheck` is a **string** (`"false"`) in RAC types.
9. Commit-on-blur/Enter pattern for inline cell editors (local draft state,
   Escape reverts) keeps expensive derived recompute per-edit, not
   per-keystroke — see `EditableCell` in RouteEditorDialog.tsx. This is the
   RAC analogue of Tabulator's `cellEdited`.
10. **SSR:** all converted components hydrate clean (12/12 `test:e2e:ssr`).
    RAC Table renders native `<table>` markup. Keep the CLAUDE.md SSR rules
    (no window at module scope, deterministic dates, identical trees); heavy
    admin-only stuff (map) stays behind `lazy()`.

## Verification playbook (all part of "done" for RAC work)

```bash
bun run typecheck:all
bun run test                       # engine + workers unit tests
bun run build                      # Vite + SSR bundle + Astro
bun run test:e2e:ssr               # 12 tests; needs no other servers running
bun run test:e2e                   # full suite (one known flaky dev-login test; rerun)
```

- SSR-suite gotcha: its `discover()` takes the **first non-test comp**; cruft
  comps left by other e2e runs (e.g. "API Doc Comp …") break it with "Sample
  comp has no scored pilots". Delete the cruft row from local D1 (`comp`
  table) or reseed.
- **Headless driving of admin UI:** start `bun run dev`, seed
  (`bun run seed:sample`), then in Playwright: goto an SPA page, dev-login as
  the super-admin **tushar.pokle@gmail.com** via
  `fetch('/api/auth/dev-login', {method:'POST', body: JSON.stringify({name, email}), credentials:'include'})`
  from `page.evaluate`, then navigate to the task page. Drive dialogs by role
  (`getByRole("dialog")`, `getByRole("grid", { name: "Turnpoints" })` —
  scope selectors, several listboxes/dialogs can coexist). FileTrigger renders
  a hidden `input[accept=…]`, still driveable with `setInputFiles`.
- `bun run kill-dev` clears stale servers (port-in-use crashes on dev start).

## Route editor list view (BUILT — 2026-07-18)

The cramped-table problem (horizontal scroll broke row context on small
screens) is solved: the turnpoint Table is now a **vertical list of cards**
(`rac/grid-list.tsx` → RAC GridList/GridListItem), replacing the Table
entirely (no table+list in parallel — the list wins on desktop too, and its
narrow column frees width for the map). Verified live (headless admin drive,
0 console errors) + typecheck + unit + build + 12/12 SSR e2e. What shipped:

- **Layout:** the list is at the **top** of the dialog and never scrolls
  internally (every turnpoint visible; the dialog itself scrolls). The map
  preview + waypoint picker sit **below** it in a two-column block.
- **`GridList` with `keyboardNavigationBehavior="tab"`** — arrows move between
  cards, Tab reaches focusable children, so **no CellEditZone** is needed here
  (contrast the Table, gotcha #2). `selectionMode="none"`; reorder via the same
  `useDragAndDrop` hooks + `slot="drag"` handle as the Table (unchanged).
- **Each row is a compact, single-line flight-plan summary** (no inline edit
  controls): position badge · code · name · type badge, with a right-aligned
  recap (radius grouped as `50,000 m` · Enter/Exit badge · optimized leg km).
- **`TurnpointDetailsDialog`** — a controlled kit `Modal`/`Dialog` (nested
  inside the route-editor Modal) that both **Add turnpoint** and a row's **Edit**
  open. It edits a **local draft** (`TurnpointDraft`) and only commits on Save —
  so adding is draft-first (**nothing joins the route until Save**, Cancel adds
  nothing) and editing is atomic (Cancel keeps the turnpoint as it was); the
  parent's `onSave` appends (add) or `updateRow`-patches (edit). It carries a
  **"Load from a waypoint"** SearchField + ListBox at the top (picking fills the
  draft), then every field: code, name, Type (SimpleSelect), Radius (preset
  chips **400 / 1 km / 2 km / 3 km / 5 km** + custom NumberField, step 1,
  `useGrouping:true` — gotcha #1), coordinates (`validate` → inline FieldError),
  altitude. Save is gated on a non-empty code + valid coords.
- **The route-editor dialog no longer carries the waypoint picker** (it moved
  into the details dialog). Start (SSS) / Goal Disclosures are **collapsed by
  default** (defaults suit most comps). The map preview is full-width below the
  list; its "Add from map" / "New point" still create *competition waypoints*.
- Reused unchanged: rows state + `derived` memo, `dependencies={[rows,
  derived]}` on the GridList (gotcha #3 — position #/legs/dirs would otherwise
  stale on reorder; verified: drag renumbers and recomputes legs), FileTrigger.
- **Design evolution** (all on request): inline Type+Radius on the card →
  compact row + per-row edit **popover** (live edits, snapshot-revert) →
  the current draft-on-save **Modal** shared by Add and Edit. The popover's
  live-apply/`snapshotRef` revert is gone; the draft model is simpler and gives
  a clean "Add nothing until Save".

New gotchas learned building it:
- **`keyboardNavigationBehavior` typechecks** (it's on `AriaGridListProps`,
  inherited by `GridListProps`) even though it isn't spelled out in
  `GridList.d.ts`'s own body. It defaults to `'arrow'`; `layout="grid"` forces
  `'tab'` regardless.
- **The task page and the editor both render a grid `aria-label="Turnpoints"`**
  (the read-only page table sits behind the open dialog). Scope drives/queries
  to the dialog, or disambiguate on a marker only the editor has (e.g. a
  `Custom radius` input), or the first match is the read-only page table.
- The turnpoint editor now edits a **local draft** and commits on Save, so it
  never re-runs the route `derived` memo per keystroke (an earlier popover
  iteration did, to live-update the map). Draft-on-save also sidesteps the
  commit-on-blur pattern the Table's in-cell editors needed.

Not done (follow-ups): a true full-width bottom sheet for the edit popover on
mobile (today it's a fitted floating panel). The map now sits below the list
(so it never obscures it), which made the earlier "collapsible map preview"
idea unnecessary.

## Converting other pages (recipe)

1. Wrap the page component in `RacRouterProvider` (+ `RacConfirmProvider` if it
   uses `useConfirm`). SSR pages: providers are SSR-safe.
2. Swap imports ui/ → rac/ mechanically: Button (`onClick`→`onPress`,
   `disabled`→`isDisabled`), Dialog→Modal/Dialog (drop DialogClose for
   `slot="close"`), Input+Field+useId→TextField (self-labelling), Base UI
   Select→rac Select/SimpleSelect, checkbox groups→CheckboxGroup, hidden file
   inputs→FileTrigger, `title=` hints→TooltipTrigger.
3. Tables: read-only ones convert 1:1 (add `aria-label`; `isRowHeader` on one
   column; row `id`s). Row-click navigation = `onRowAction` + a real AriaLink
   in the name cell (keeps a crawlable anchor). Editable ones: prefer the
   GridList card pattern above; if it must be a Table, use CellEditZone and
   read gotchas #2/#3 first.
4. Verify per the playbook; SSR pages additionally must pass `test:e2e:ssr`
   before "done".
5. Suggested order: CompDetail (mostly shared, already-converted dialogs),
   CompWaypoints (second editable grid — apply the list pattern), Scores,
   Competitions, then the auth/profile pages. The pilots dialog is the last
   Tabulator user.

## Reference

- Branch: `explore/rac-task-detail` (worktree `.claude/worktrees/explore-rac`).
- RAC version pinned in web/frontend: 1.19.0. Upgrades: re-run the drives —
  `CellEditZone` and `dependencies` behavior are the fragile seams.
- Docs: react-aria.adobe.com (RAC), react-spectrum.adobe.com (Spectrum 2 —
  same behavior engine, Adobe-styled; its TableView `EditableCell` popover
  pattern is a good future model for *occasional*-edit tables).
