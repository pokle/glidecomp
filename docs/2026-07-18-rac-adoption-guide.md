# React Aria Components (RAC) adoption — status, gotchas, and continuation guide

**Audience:** agents/developers continuing the RAC exploration in later sessions.
**Status (2026-07-21):** the task detail page (`/comp/:id/task/:id`) and every
dialog it opens is fully converted to react-aria-components and verified
(typecheck, unit tests, production build, SSR e2e suite green with clean
hydration, headless admin drives with zero console errors). The route
editor's turnpoint grid has since been rebuilt as a **GridList card list**
(2026-07-18, see that section). RAC has since spread beyond the exploration
page: the two field-analysis pages were built RAC-native, the comp list page
converted (PR #401), **the comp detail page `/comp/:id` and every section and
dialog it owns converted (2026-07-21** — sortable score tables, tabs, setup
guide, Create Task, Settings, pilots section; new kit pieces `rac/tabs` and
`rac/progress`; retired `ui/select` + `ui/combobox`), `rac/breadcrumbs` is
the app-wide breadcrumb, `RacRouterProvider` is mounted globally in `Shell`,
and shared chrome (`PageToc`, `Timestamp`) and the Dashboard's flights `Tree`
use rac/ components. The waypoints page `/comp/:id/waypoints` converted
(2026-07-21): RAC chrome + read-only table, and its hand-rolled editable
grid **replaced with an inline Tabulator grid** per the policy below. The
remaining pages still use the shadcn/Base UI kit in `src/react/ui/` — see
the conversion map at the end of this doc. The decision so far: **keep going
with RAC** — it earned its keep everywhere except editable tables, which are
Tabulator's job (see the policy below).

**Tabulator policy (2026-07-21, owner preference): editable tables are
Tabulator, full stop.** The project owner prefers Tabulator for every
editable table/grid — don't reinvent spreadsheet editing in RAC. The pilots
editor's grid (comp page → Pilots → Edit) works really well — frozen
columns, spreadsheet-style cell editing, list editors — and replacing
Tabulator with RAC has repeatedly been the most painful part of this
exploration (see gotcha #2 and the route-editor history). This cuts both
ways: existing Tabulator grids stay, and a hand-rolled editable table being
converted should become a **Tabulator grid**, not a RAC Table/GridList (the
waypoints page did exactly this — see gotcha #16 for the wiring pattern).
The GridList card list stays where it's already built (the route editor) and
remains the answer for *card-shaped* editable collections, but don't plan
new RAC editable tables. Converting a page means converting the chrome
*around* the grid (dialog shell, buttons, read-only tables) and using
Tabulator for the grid itself. It coexists happily inside a RAC Modal: give
the kit `Dialog` an `id` and point Tabulator's `popupContainer` at it so
editor popups render above the dialog, and keep the lazy
`import("tabulator-tables")` so it stays out of the public bundle. The
shadcn-token theme lives in `comp/tabulator-grid.css` (shared, `gc-grid`
container class). Do NOT plan a GridList/Table rewrite of the pilots grid.

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
  Table; see the route editor), `combo-box` (ComboBox/ComboBoxItem — text input
  + floating filtered suggestions; **use this, not SearchField + list-box**,
  whenever typing filters a list: it owns the ARIA combobox contract that a
  searchbox beside a detached listbox doesn't provide — see gotcha #12),
  `list-box` (standalone option list; no callers today), `menu`, `tooltip`, `tag-group`, `disclosure`,
  `meter` (Meter/DivergingMeter — a **measurement**, `role="meter"`; NOT
  ProgressBar, which means task completion. `DivergingMeter` draws a signed
  value from a centred zero axis for the field-analysis ρ bars: sign is which
  side it grows toward, never colour alone, and the signed number is always
  printed beside it), `popover` (standalone DialogTrigger+Popover+Dialog,
  reusing `popoverClass` from select.tsx — **use this, not tooltip, whenever
  the content is prose**: tooltips are hover-only, so touch users never see
  them, and they dismiss before a sentence can be read),
  `breadcrumbs` (ARIA-native trail — parent links + current page as
  `aria-current="page"`; see gotcha #11), `radio-group` (RadioGroup/Radio —
  label part of each Radio, same slot pieces as field.tsx), `tree` (Tree/
  TreeItem/TreeItemContent/TreeChevron — hierarchical rows with
  expand/collapse; first consumer is the Dashboard's competition-flights
  grouping), `tabs` (Tabs/TabList/Tab/TabPanel — styled like ui/tabs' default
  pill variant; controlled via `selectedKey`/`onSelectionChange`, panels pair
  with tabs by `id`, and tab keys can't be `""` — map an "All" filter through
  a sentinel key, see ActivitySection), `progress` (ProgressBar — **task
  completion**, role="progressbar"; the mirror of `meter`'s "measurement"
  distinction. Label row + thin track like ui/progress; pass a heading node
  as `label` and point `aria-labelledby` at it), `badge` (static span — RAC
  has no presentational components), `confirm` (RacConfirmProvider — supplies
  the same ConfirmContext as lib/confirm.tsx so `useConfirm()` inside a
  wrapped subtree gets the RAC alertdialog), `router` (RacRouterProvider —
  bridges RAC `href` links to react-router; SSR-safe).
- **Converted files:** `pages/TaskDetail.tsx` (page + EditTaskDialog +
  turnpoints table), `comp/TaskStandings.tsx`, `comp/RouteEditorDialog.tsx`
  (Tabulator grid → RAC **GridList** card list, see below — was a RAC Table),
  `comp/SubmitTrackDialog.tsx`,
  `comp/ManualFlightDialog.tsx`, `comp/AddWaypointDialog.tsx`,
  `comp/TaskExportButtons.tsx`, `comp/ScoreFreshness.tsx` (button only),
  `pages/TaskFieldAnalysis.tsx` + `pages/CompFieldAnalysis.tsx` and all of
  `react/field-analysis/` (built RAC-native from the start — 2026-07-19),
  `pages/Competitions.tsx` (2026-07-21 — list cards are RAC Links, create
  dialog on the kit, plus a client-side SearchField filter over the loaded
  list; see gotcha #13), and — 2026-07-21 — the whole comp detail page:
  `pages/CompDetail.tsx` (hero LinkButtons, Create Task dialog on
  Form/TextField/CheckboxGroup, RacConfirmProvider wrapper),
  `comp/SettingsDialog.tsx` (kit Modal/Dialog; numeric GAP params became
  NumberFields holding numbers with NaN-as-blank), `comp/CompScoresSection.tsx`
  (rac tabs + sortable RAC-grid tables), `comp/ScoresSection.tsx` (onRowAction
  + AriaLink rows), `comp/ActivitySection.tsx` (rac tabs),
  `comp/CompSetupProgress.tsx` (rac ProgressBar; the Card became a plain
  styled div), `comp/PilotsSection.tsx` (RAC read-only table + dialog shell
  around the kept Tabulator grid), and `comp/fields.tsx` is now **fully** RAC:
  SimpleSelect re-exports rac/select's, and SearchableSelect is a select-like
  kit ComboBox (menuTrigger="focus", controlled selectedKey+inputValue, "at
  rest shows the selected label → list everything; edited → filter",
  onSelectionChange(null) restores the label — the gotcha #12 rules applied
  to a value-holding picker). That retired `ui/select` and `ui/combobox`
  entirely (files deleted).
  Also converted: `pages/PilotScoreDetail.tsx` (mostly bespoke map/narrative
  markup; the kit pieces it uses are rac), `components/PageToc.tsx` (rac
  Select for the mobile section jump), `components/Timestamp.tsx` (rac
  Tooltip), and `rac/tree.tsx` in `pages/Dashboard.tsx` (the flights Tree —
  the rest of the Dashboard is still ui/).
  And — 2026-07-21 — the waypoints page: `pages/CompWaypoints.tsx` (RAC
  buttons/FileTrigger/ToggleButton, read-only RAC table for non-admins,
  RacConfirmProvider; the editable grid became an **inline Tabulator grid**
  per the Tabulator policy — gotcha #16), `comp/WaypointDeviceExport.tsx`
  (rac Menu with href/onAction download items, ToggleButton QR toggle, rac
  Checkbox — retired `ui/checkbox`, file deleted), and `comp/FullScreenQR.tsx`
  (was a bare `fixed inset-0` div with hand-rolled Esc/scroll-lock listeners;
  now RAC ModalOverlay/Modal/Dialog primitives, so focus trap/restore, Esc
  and scroll-locking come from react-aria).
  Note that dialogs like SubmitTrackDialog/AddWaypointDialog are **shared** —
  unconverted pages (CompWaypoints) already render these RAC components today;
  RAC components work fine outside converted pages (`RacRouterProvider` is
  global in `Shell`, so `href`-based client routing just works).
- **Not converted:** see the conversion map at the end of this doc. Tabulator
  remains in the comp-page pilots dialog **by design** (see the Tabulator
  policy at the top — it is kept, not pending). The ui/ (shadcn) kit stays
  for unconverted pages.
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
10. **SSR:** all converted components hydrate clean (`test:e2e:ssr` green).
    RAC Table renders native `<table>` markup. Keep the CLAUDE.md SSR rules
    (no window at module scope, deterministic dates, identical trees); heavy
    admin-only stuff (map) stays behind `lazy()`.
11. **Breadcrumbs follow the ARIA-native pattern — the last crumb IS the
    current page.** `rac/breadcrumbs.tsx` uses RAC's `Breadcrumbs`/`Breadcrumb`
    collection: parent crumbs are RAC `Link`s (client-routed via the
    RouterProvider), and the current page is the final crumb rendered as plain
    text with `aria-current="page"` (per the WAI-ARIA breadcrumb pattern). API:
    `<Breadcrumbs items={[{label,to},…]} current="This page" />`. **Gotcha:** RAC
    hard-codes the LAST `Breadcrumb` (`node.nextKey == null`) as current — it
    disables that item's `Link` and sets `aria-current`. So you must pass the
    current page as the last item; if you (wrongly) end the trail on a parent
    link, RAC disables it (this was the original task-page bug — the comp crumb
    was last and came out disabled). This is now the app's ONLY breadcrumb
    component: the older parents-only `components/Breadcrumbs.tsx` (react-router
    `<Link>`s, no current-page crumb, relied on the H1 below) has been deleted
    and its three pages converted. Pass `items` from `lib/crumbs.ts`. RAC's
    `Breadcrumbs` renders a bare `<ol>`, so the kit wraps it in a
    `<nav aria-label="Breadcrumb">` landmark. Verified live (comp crumb
    navigates, current crumb carries `aria-current="page"`) + clean `:task`
    hydration.

12. **Type-to-filter lists belong in a `ComboBox`, and a fully-controlled one
    makes you own the resets.** RAC's `Autocomplete` is built for *inline*
    filtering inside an already-floating surface (searchable menu, command
    palette) — it renders no popover, so a list under it is in normal flow.
    Two consequences bit the route editor's waypoint picker:
    - **In flow, inside a `flex flex-col` dialog body, it collapsed to ~6px on a
      phone.** `overflow-y-auto` sets an element's automatic minimum size to 0,
      so it was the one flex item that could absorb the overflow. A floating
      popover sidesteps the whole class of bug (it's out of flow, and can't be
      clipped by the dialog's scroll container either).
    - **A `searchbox` next to a detached `listbox` isn't the ARIA combobox
      pattern** — no `role="combobox"`, no `aria-expanded`/`aria-controls`.
      `rac/combo-box.tsx` gets these for free.

    When you control **both** `selectedKey` and `inputValue`, react-stately
    hands syncing back to you (`useComboBoxState`: *"it's the user's
    responsibility to update inputValue in onSelectionChange"*). It calls
    `onSelectionChange(null)` on the Esc/blur revert — **if you ignore the null
    case, Esc silently does nothing and the popover can never be dismissed.**
    Pin `selectedKey={null}` when picking should copy values elsewhere rather
    than leave the field holding a selection (it also lets the same item be
    re-picked). Keep the empty query mapping to an *empty* list so the popover
    stays shut at rest — if an empty query lists everything, Esc's revert
    reopens it immediately. Gate `allowsEmptyCollection` on having a query so
    "No matches" still shows while searching.

    **Don't put a toggle/clear button in the field.** react-aria's
    `ariaHideOutside` aria-hides everything except the input and the popover
    while the list is open — including RAC's *own* trigger button — so any
    button there is invisible to AT exactly when it's on screen. Esc dismisses;
    blur and picking both clear.

    **Testing gotchas:** that same `ariaHideOutside` makes Playwright *role*
    locators fail for the rest of the dialog while the list is open (CSS
    locators still work — role locators respect `aria-hidden`); measure boxes
    only after the `zoom-in-95` entrance animation settles or everything reads
    ~5% small; and don't "blur by clicking the field below" — the popover now
    covers it, so the click selects an option instead.

13. **Playwright can't `.click()` a RAC Checkbox by role.** RAC visually hides
    the real `<input type=checkbox>` (1px, clipped) inside the wrapping
    `<label>`, so `getByRole("checkbox").click()` fails actionability forever —
    the label/box "intercepts pointer events". Click the visible label text
    like a user (`getByText("Hidden?").click()`) and assert with
    `expect(getByRole("checkbox")).toBeChecked()`. (Bit comp-creation.spec.ts
    when the create-comp dialog converted.) A page-content *filter* (narrowing
    an already-visible list) is a plain `SearchField` — gotcha #12's
    "use ComboBox" rule is about *picking one item* from floating suggestions,
    not filtering page content in place; the kit SearchField skips its sr-only
    fallback label when you pass `aria-label`.

14. **Flex-centering an overlay clips the TOP of an oversized dialog.** The
    kit Modal originally centred the panel with `items-center` on the
    scrollable overlay; a panel taller than the viewport (Competition
    Settings with Advanced open) then overflows *above the scroll origin* —
    `scrollTop` can't go negative, so the title and first fields are
    unreachable. Fixed in rac/dialog.tsx the canonical way: no `items-center`
    on the overlay; the panel carries `my-auto` instead (cross-axis auto
    margins centre a fitting panel and collapse to 0 on overflow, making the
    whole panel scrollable). Don't re-add `items-center` to the overlay, and
    don't give tall dialogs their own `max-h`/`overflow-y-auto` unless you
    specifically want an inner scroll region (the pilots dialog does, for its
    fixed-height grid).

15. **RAC Table sorting always starts a new column ascending — override it in
    `onSortChange` when scores should read best-first.** With a controlled
    `sortDescriptor`, clicking an unsorted column always yields
    `direction: "ascending"`; CompScoresSection's SortableTable keeps the old
    per-column first-click direction by replacing the descriptor when the
    column *changes* (same column = RAC's toggle is already right). Also:
    RAC Columns filter non-ARIA DOM attributes, so a `title` tooltip must
    ride on a span *inside* the Column, and every sortable/interactive
    Column still needs exactly one `isRowHeader` column beside it.

16. **Inline Tabulator on a page (not in a dialog) — the waypoints pattern.**
    When an editable grid lives on the page beside other React-driven UI (the
    waypoints map), keep React state as the source of truth and let the grid
    mirror into it: build Tabulator once in an effect gated on
    `isAdmin && !loading` (NEVER depending on the rows state — that would tear
    the grid down per keystroke), reading the current rows through a ref; wire
    `cellEdited`/`rowDeleted` → `setRows(table.getData()...)` so the map/dirty
    check/save all read state; push *external* changes (file upload, add
    dialog) into the grid imperatively (`setData`/`addRow`) beside the
    `setRows` call. Cell formatters must build DOM nodes and assign
    `textContent` — a string return is innerHTML, and grid values come from
    user-supplied waypoint files. Static icon markup (the pin/✕ buttons) as
    HTML strings is fine. `columnDefaults: { headerSort: false }` unless you
    actually want sorting (saved row order vs sorted view is a trap). SSR:
    the admin variant server-renders an empty container div and the grid
    builds client-side; the anonymous/crawler variant stays a real RAC
    `<table>` so the page keeps its SSR content (the ssr.spec.ts waypoints
    test asserts a waypoint code appears in the raw HTML).

## Verification playbook (all part of "done" for RAC work)

```bash
bun run typecheck:all
bun run test                       # engine + workers unit tests
bun run build                      # Vite + SSR bundle + Astro
bun run test:e2e:ssr               # needs no other servers running
bun run test:e2e                   # full suite (one known flaky dev-login test; rerun)
```

- **`waitUntil: "networkidle"` never settles on a page with a freshness
  poller** (field analysis, and any scores surface showing a stale banner) —
  `ScoreFreshness` deliberately keeps a conditional request in flight. Wait on
  the DOM (`waitUntil: "domcontentloaded"` + a role locator) instead, or the
  drive times out on a page that rendered fine.
- SSR-suite gotcha: its `discover()` takes the **first non-test comp**; cruft
  comps left by other e2e runs (e.g. "API Doc Comp …") break it with "Sample
  comp has no scored pilots". Delete the cruft row from local D1 (`comp`
  table) or reseed.
- **Headless driving of admin UI:** start `bun run dev`, seed
  (`bun run seed`), then in Playwright: goto an SPA page, dev-login as
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
0 console errors) + typecheck + unit + build + SSR e2e. What shipped:

- **Layout:** the list is at the **top** of the dialog and never scrolls
  internally (every turnpoint visible; the dialog itself scrolls). The map
  preview sits **full-width below** it; the waypoint picker is no longer on
  this dialog at all (it moved into `TurnpointDetailsDialog` — see below).
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
  parent's `onSave` appends (add) or `updateRow`-patches (edit). "Load from a
  waypoint" is the kit **`ComboBox`**: matches float in a popover over the
  fields below, so they can't be clipped or squashed by the dialog's scroll
  container and they flip above the field when there's no room (phone with the
  keyboard up). Type to filter, arrow/Enter to pick via virtual focus, which
  fills the draft and clears the query. Filtering is done at the call site
  (`useFilter().contains` over `code + name`, also each item's `textValue`)
  because RAC doesn't filter a controlled `items`; an empty query yields an
  empty list so the popover stays shut at rest — and so Esc can close it, see
  gotcha #12.
  Then every field: code, name, Type (SimpleSelect), Radius (preset chips
  **400 / 1 km / 2 km / 3 km / 5 km** + custom NumberField, step 1,
  `useGrouping:true` — gotcha #1), coordinates (`validate` → inline FieldError),
  altitude. Save is gated on a non-empty code + valid coords.
- **The route-editor dialog no longer carries the waypoint picker** (it moved
  into the details dialog). Start (SSS) / Goal Disclosures are **collapsed by
  default** (defaults suit most comps). The map preview is full-width below the
  list. Its **"Add from map"** toggle still creates a *competition waypoint*
  (the tap seeds `AddWaypointDialog` with coordinates + terrain elevation +
  nearest place label + peak-snap, all from `mapbox-provider.ts` `onMapClick`
  → `MapPickDetails`; the `queryRenderedFeatures` label lookup means code/name
  only pre-fill where the style renders a label — rural taps get coords +
  elevation only). The old **"New point"** button was removed (redundant with
  "Add turnpoint"). `AddWaypointDialog` now shows a **"Filled … from the map"**
  call-out so the non-peak prefill is visible.
- **Tapping a turnpoint row pans the map to it** (GridList `onAction` →
  `RouteMap` `focus={{lat,lon,key}}` → `provider.panTo`; the key bumps each tap
  so re-tapping re-centres). The Edit/Remove buttons and drag handle are
  separate targets and don't trigger the row action.
- **Footer holds only Cancel / Save.** Import .xctsk, Load from XContest,
  Export .xctsk/.csv moved up into the Add-turnpoint toolbar row. **Load from
  XContest** is now its own small pop-up (code input + Load) instead of an
  inline field, controlled by `xcImportOpen`; `importXContest` closes it on a
  successful load.
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

1. `RacRouterProvider` is already mounted globally in `components/Shell.tsx` —
   nothing to wrap for routing. Add `RacConfirmProvider` around the page only
   if it uses `useConfirm` (TaskDetail and CompDetail do; the global
   ConfirmProvider in `lib/confirm.tsx` is still the ui/ alert-dialog).
   Providers are SSR-safe.
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
5. **Editable grids are Tabulator** (policy at the top of this doc): convert
   the shell around an existing grid and keep it; convert a hand-rolled
   editable table TO Tabulator (gotcha #16 for the inline-on-page wiring).
   Inside a dialog, give the kit `Dialog` an `id` and point Tabulator's
   `popupContainer` at it — editor popups (e.g. the class list) render fine
   inside the RAC modal, and focus containment doesn't fight the grid's
   dynamically-created cell editors. The shared shadcn-token theme is
   `comp/tabulator-grid.css` (`gc-grid` container class).
6. Suggested order: Settings (its two API-key dialogs; last consumer of
   `ui/radio-group`), Dashboard's remaining tabs/progress (rac/tabs and
   rac/progress already exist), then the auth/onboarding/admin pages and the
   app chrome (Shell user menu, global confirm). CompDetail and CompWaypoints
   are done (2026-07-21), Competitions is done (PR #401); `/scores` is
   retired (a redirect to `/comp/:id/scores` — nothing to convert). See the
   conversion map below for the full inventory.

## Conversion map (2026-07-21)

Which SPA pages are on which kit, and the dialogs/popups each still owns.
"rac breadcrumbs only" means the page body is still ui/.

> **Update (2026-07-23, comp/task page UX rework):** the components below are
> unchanged kit-wise, but several moved host page — the map's "who owns what"
> is stale where it disagrees with this note:
>
> - New `pages/CompScoresPage.tsx` `/comp/:id/scores` (fully RAC) now hosts
>   `CompScoresSection`'s score views (`ScoresViews`/`useCompScores`) and the
>   embedded `ScoresSection`; the comp page keeps only the new
>   `CompScoresSummary` (RAC LinkButton + lists).
> - New `pages/CompPilotsPage.tsx` `/comp/:id/pilots` (admin-only) now hosts
>   `PilotsSection` — Tabulator grid still kept by policy.
> - `pages/Scores.tsx` redirect target is `/comp/:id/scores`, not the comp
>   page.
> - Task page: new RAC `comp/TaskResults.tsx` (public top-3 podium +
>   your-submission line); `TaskStandings` is now the admin-only "Manage
>   pilots & tracks" grid. `TaskExportButtons` gained an `asMenu` variant
>   (rac Menu) used by the comp featured card.

**Converted (RAC):**

| Page | Notes |
|---|---|
| `pages/TaskDetail.tsx` `/comp/:id/task/:id` | Fully RAC, incl. every dialog it opens (EditTaskDialog, RouteEditorDialog + TurnpointDetailsDialog + XContest pop-up, SubmitTrackDialog, ManualFlightDialog, TaskExportButtons, AddWaypointDialog). Only ui/ import left is `date-picker` (itself RAC under the hood). |
| `pages/Competitions.tsx` `/comp` | RAC since PR #401 — Link cards, create-comp dialog on the kit, SearchField filter. |
| `pages/CompFieldAnalysis.tsx`, `pages/TaskFieldAnalysis.tsx` + `field-analysis/` | RAC-native from the start (table, meter, popover, disclosure, select, checkbox, badge). Residual `ui/alert` is presentational. |
| `pages/PilotScoreDetail.tsx` | Bespoke narrative/map markup; kit pieces (breadcrumbs, Timestamp tooltip) are rac. No dialogs. Done. |
| `pages/Scores.tsx` | Retired — pure redirect, nothing to convert. |
| `pages/CompDetail.tsx` `/comp/:id` + its sections (2026-07-21) | Fully RAC: hero LinkButtons (the `/replay` link stays a plain `<a className={buttonVariants(...)}>` — non-SPA entry), Create Task dialog, `SettingsDialog` (NumberFields, rac SimpleSelect + select-like SearchableSelect), `CompScoresSection` (rac tabs + sortable RAC-grid tables), `ScoresSection`, `ActivitySection` (rac tabs), `CompSetupProgress` (rac ProgressBar), `PilotsSection` (RAC table + dialog shell). The pilots editor's **Tabulator grid is kept by policy** — only its chrome converted. Only ui/ import left is `date-picker` (itself RAC under the hood). |
| `pages/CompWaypoints.tsx` `/comp/:id/waypoints` (2026-07-21) | RAC chrome (FileTrigger upload, ToggleButton add-from-map, RacConfirmProvider) around an **inline Tabulator grid** for admins (the hand-rolled editable `<table>` became Tabulator per the policy — gotcha #16); non-admins/crawlers get a read-only RAC table (SSR content preserved). `WaypointDeviceExport` → rac Menu/Checkbox/ToggleButton (retired `ui/checkbox`); `FullScreenQR` → RAC modal primitives. AddWaypointDialog was already RAC. |

**Not converted (ui/shadcn) — with their dialogs/popups:**

| Page / surface | ui/ usage | Dialogs & popups still on ui/ |
|---|---|---|
| `pages/Settings.tsx` | card, dialog, field, input, radio-group, table, button | **"Create API key" dialog**; **"API key created" dialog**. Last consumer of `ui/radio-group` (rac/radio-group exists). |
| `pages/Dashboard.tsx` (partial — rac Tree) | tabs, progress, button | No dialogs. Tabs/progress remain ui/. |
| `pages/Onboarding.tsx`, `pages/SignIn.tsx` | button, field, input (+ input-otp on SignIn) | No dialogs. |
| `pages/AdminUsers.tsx`, `pages/AdminCache.tsx` | table / button | No dialogs. |
| `components/Shell.tsx` (app chrome) | button, dropdown-menu, separator | **User account DropdownMenu** → rac `menu`. |
| `lib/confirm.tsx` (global ConfirmProvider in routes.tsx) | alert-dialog, button | The global confirm is still ui/; `rac/confirm.tsx` exists and serves the TaskDetail subtree. Swapping the global one retires `ui/alert-dialog`. |

Shared ui/ leaf modules that only die with their last consumer:
`ui/tabs` + `ui/progress` (Dashboard), `ui/table` (Settings, AdminUsers),
`ui/card` (Settings), `ui/dropdown-menu` (Shell only), `ui/alert`
(ScoreFreshness, field-analysis — could become a rac/ static component like
badge). `ui/select` and `ui/combobox` died with the CompDetail conversion
(deleted 2026-07-21); `ui/checkbox` died with the CompWaypoints conversion
(deleted 2026-07-21).

## Reference

- Branches: `explore/rac-task-detail` (the original conversion, worktree
  `.claude/worktrees/explore-rac`), then `explore/rac-route-editor-list`
  (PR #374 — the GridList route editor + ARIA-native breadcrumbs). All
  merged (PRs #373, #374, #378, and #401 for the comp list).
- RAC version in web/frontend: `^1.19.0` (a caret range, currently resolving to
  1.19.0 — not a hard pin). Upgrades: re-run the drives — `CellEditZone` and
  `dependencies` behavior are the fragile seams.
- Docs: react-aria.adobe.com (RAC), react-spectrum.adobe.com (Spectrum 2 —
  same behavior engine, Adobe-styled; its TableView `EditableCell` popover
  pattern is a good future model for *occasional*-edit tables).
