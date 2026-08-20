# React Aria Components (RAC) adoption — status, gotchas, and continuation guide

**Audience:** agents/developers working on the SPA's UI.

**Status (2026-07-27): the migration is FINISHED.** Every page and dialog in
the SPA is react-aria-components, `src/react/ui/` is deleted, and
`src/react/one-kit.test.ts` fails if anything imports from it again — but note
that guard only runs under the **frontend** vitest suite, which is
`bun run test:all` (or `bun run test:frontend`), **not** `bun run test`; see the
verification playbook.
There is no `components.json` any more either, so `bunx shadcn add` is not the
route to a missing component — add it to `rac/`. A static styled element is a
perfectly good kit member when there's no behaviour to own (`rac/badge.tsx`,
`rac/alert.tsx`). Thin wrappers over third-party widgets RAC doesn't provide
live in `src/react/vendor/`: today the `input-otp` sign-in field and the
`sonner` toaster.

*Loose end, stated neutrally because nobody has decided anything about it:*
`web/frontend/package.json` still declares `@base-ui/react` and `shadcn` as
dependencies even though no app code imports Base UI at all, and `globals.css`
still does `@import "shadcn/tailwind.css"` for the token layer. So "the kit is
gone" is true of the *code* and not yet of the *manifest*.

Read the **gotchas** section before touching kit code — twenty-one of them, each
one something that cost real debugging. The rest of this doc is history: how
the migration went, what was decided and why. It is worth keeping because the
reasoning still applies to new UI.

**How it went.** The exploration converted the task detail page first
(2026-07-18), then the route editor's turnpoint grid to a **GridList card
list**, then the field-analysis pages (built RAC-native), the comp list
(PR #401), and — 2026-07-21 — the comp detail page with all its sections and
dialogs, plus the waypoints page (whose hand-rolled editable table became an
inline Tabulator grid per the policy below). That left the remaining work
planned as six waves in
[#483](https://github.com/pokle/glidecomp/issues/483), all landed 2026-07-27:

1. **Shared chrome.** The global confirm became the RAC alertdialog — the
   provider lives in `rac/confirm.tsx`, mounted app-wide by routes.tsx, which
   leaves `lib/confirm.tsx` as context and types with no UI import at all.
   That split is what lets any page call `useConfirm()` without importing a
   kit, and it deleted the `RacConfirmProvider` wrappers three pages had been
   carrying. `Shell` followed: account menu → `rac/menu` (Settings is a real
   `href` anchor now, not a div calling navigate), sign-in buttons and the
   super-admin preview pill → rac Button/ToggleButton. New: `rac/alert`,
   `rac/separator`.
2. **AdminCache, AdminUsers, Onboarding.** Small, no dialogs, no SSR. The
   users table gained a `scrollLabel` focusable scroll region — seven columns
   that a keyboard-only admin previously could not reach.
3. **SignIn.** `input-otp` stayed (RAC has no one-time-code field) and moved
   to `vendor/`.
4. **Dashboard.** Tabs, `FileTrigger` for the hidden file inputs, and the
   storage bar became a **`ProportionMeter`, not a ProgressBar** — quota used
   is a measurement, not a task running to completion.
5. **Settings.** The last two ui/ dialogs, both radio groups, the API-key
   table. `ui/card` had exactly one consumer, so it became a local
   `SettingsCard` helper rather than a kit component.
6. **Teardown.** Fourteen dead files deleted, `date-picker` moved to `rac/`
   (it was already RAC inside), `input-otp` + `sonner` to `vendor/`, the guard
   test added, `components.json` removed.

**The decision, in hindsight: RAC earned its keep.** The conversions kept
finding real accessibility defects rather than just moving code — unreachable
table columns, `title` attributes standing in for tooltips, focus dumped to
the body mid-action by `disabled` swaps, a `role="progressbar"` on something
that was never a task. The one place it did not earn its keep is editable
tables, which are Tabulator's job.

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
The GridList card list has **no consumer today** — the route editor that was
its one caller went back to a RAC `Table` (see the superseded section below) —
but it stays in the kit as the answer for *card-shaped* editable collections.
Either way, don't plan new RAC editable tables. Converting a page means
converting the chrome
*around* the grid (dialog shell, buttons, read-only tables) and using
Tabulator for the grid itself. It coexists happily inside a RAC Modal: give
the kit `Dialog` an `id` and point Tabulator's `popupContainer` at it so
editor popups render above the dialog. The
shadcn-token theme lives in `comp/tabulator-grid.css` (shared, `gc-grid`
container class). Do NOT plan a GridList/Table rewrite of the pilots grid.

**Always go through `comp/TabulatorGrid.tsx`** — the in-repo React wrapper —
rather than calling `new TabulatorFull(...)` in an effect. It owns the lazy
`import("tabulator-tables")` (so Tabulator stays out of the public bundle and
the SSR bundle), the build/destroy lifecycle, row cloning,
stale-handler-proof event binding, and turning off browser autofill on the
editor inputs Tabulator builds (Safari was offering saved email addresses over
the pilots grid); grids just declare
`initialColumns`/`initialData`/`options`/`events` and take a `tableRef` for the
imperative calls. It is **not** the `react-tabulator` npm package the Tabulator
docs point at (that one pins `tabulator-tables@5.6.1` — we're on 6.x — and
peers at React <= 17, and we're on 19), and it does not copy that package's
API. Read the header comment in that file before using it — notably the grid is
**uncontrolled**: `initialColumns`/`initialData` are thunks called once at
build (remount via `key` to rebuild, push updates through `tableRef`), and the
instance only exists a tick after mount, so gate anything that drives it on
`onReady`.

## What exists

- **The RAC kit: `web/frontend/src/react/rac/`** — styled with the existing
  Tailwind tokens to match the shadcn look. One component-family per file:
  `button` (Button/LinkButton/ToggleButton + buttonVariants), `dialog`
  (Modal/Dialog/DialogHeader/Title/Footer — auto ✕, dismissable by default,
  alertdialog role opts out of both), `field` (TextField/NumberField/
  SearchField/Label/Description/FieldError/Input), `select` (Select/SelectItem/
  SimpleSelect — string-in/out drop-in for the old comp/fields SimpleSelect),
  `checkbox` (Checkbox/CheckboxGroup), `choice-list`
  (ChoiceList/CheckList/SearchableChoiceList — the settings-page field family:
  full-width 44px rows in flow, replacing a Select or RadioGroup wherever the
  value is part of a form that gets Saved; see the Conventions section for
  which control to reach for), `table` (Table/TableHeader/Column/Row/
  Cell/CellEditZone), `grid-list` (GridList/GridListItem — vertical card list
  with `keyboardNavigationBehavior="tab"`, the editable-list alternative to
  Table. **No current consumer**: its one caller, the route editor, is a RAC
  Table again. Kept as the kit's answer for *card-shaped* editable
  collections), `combo-box` (ComboBox/ComboBoxItem — text input
  + floating filtered suggestions; **use this, not SearchField + list-box**,
  whenever typing filters a list: it owns the ARIA combobox contract that a
  searchbox beside a detached listbox doesn't provide — see gotcha #12),
  `list-box` (standalone option list; one caller — `comp/QuickTaskField.tsx`
  renders the "Enter task" field's inline waypoint suggestions as a
  `ListBox`/`ListBoxItem`, deliberately *in flow* under the textarea rather
  than a ComboBox popover, because on a phone the keyboard would cover a
  floating list), `menu`,
  `priority-nav` (PriorityNav — a navigation row that never wraps: the links
  that fit stay in the row and the rest fold into a "More" menu. Used by the
  app header and the comp page's section bar, issue #639. Its vanilla twin,
  for the prerendered pages, is in `static/src/components/SiteHeader.astro`),
  `tooltip`, `tag-group`, `disclosure`,
  `meter` (DivergingMeter/ProportionMeter — a **measurement**, `role="meter"`;
  NOT ProgressBar, which means task completion. RAC's own `Meter` is imported
  inside the file as `AriaMeter` and is not exported. `DivergingMeter` draws a
  signed value from a centred zero axis for the field-analysis ρ bars: sign is
  which side it grows toward, never colour alone, and the signed number is
  always printed beside it. `ProportionMeter` is the part-of-a-whole reading —
  deliberately plainer (thinner, no axis) — used by the Dashboard's storage bar
  and the field-analysis coverage bars),
  `popover` (standalone DialogTrigger+Popover+Dialog,
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
  a sentinel key, see ActivitySection. The strip **scrolls sideways** once it
  outgrows its container, with a fade at whichever end still has tabs behind
  it, and it keeps the selected tab in view; consumers do nothing. Unlike
  `table`'s `scrollLabel` it takes **no** tab stop of its own — every item in
  this scroller is already focusable and RAC drags the strip along with
  arrow-key focus, so the off-screen tabs are keyboard-reachable without one), `progress` (ProgressBar/Spinner/
  Loading — **task completion**, role="progressbar"; the mirror of `meter`'s
  "measurement" distinction. Label row + thin track like ui/progress; pass a
  heading node as `label` and point `aria-labelledby` at it. Also the app's
  **loading-state family** — see the section below), `badge` (static span — RAC
  has no presentational components), `alert` (static panel — `role="alert"`,
  overridable to `role="status"` for a standing notice; the old ui/alert),
  `separator` (RAC Separator + the ui/separator styling), `confirm`
  (**ConfirmProvider — the app's only confirm provider**, mounted once in
  routes.tsx; it supplies lib/confirm.tsx's ConfirmContext, so every
  `useConfirm()` anywhere gets this RAC alertdialog), `menu` (Menu/MenuItem/
  MenuSection/MenuHeader/MenuSeparator — a Header must sit inside a
  MenuSection to name the group, and `placement` forwards to the popover),
  `router` (RacRouterProvider — bridges RAC `href` links to react-router;
  SSR-safe), `full-screen-sheet` (FullScreenSheet — the **full-bleed** modal,
  `dialog`'s Modal being a centered panel whose overlay
  padding/background/centering are not overridable. Render it when open and
  not when closed: there is no `isOpen`, so a closed sheet costs nothing and a
  lazily-imported one stays unimported. `dismissOnPress` makes the whole sheet
  a close target and is **only** for content that is a picture — anything
  interactive inside would dismiss on the way to being pressed; without it,
  give the sheet an `autoFocus` Close button, since Escape alone isn't a
  discoverable affordance. Callers: the waypoint QR, the task route glyph, the
  field-analysis metric chart), `nav-list` (NavList/NavRow/NavActionRow — the
  grouped tappable-row list for hierarchical settings screens: each row is a
  RAC Link (or Button, for `NavActionRow` actions like "Delete competition")
  showing a label, a muted current-value summary and a chevron, on a minimum
  44px target. First consumer: the comp settings pages
  (`comp/settings/CompSettingsIndex.tsx`), which replaced the old
  Competition Settings dialog with routed pages —
  `/comp/:id/settings[/:group]` — one pattern at every viewport size),
  `choice-list` (ChoiceList/SearchableChoiceList — **"pick one of N" without an
  overlay**: full-width rows with a checkmark on the chosen one, on RAC's
  RadioGroup/Radio so the ARIA contract, roving focus and the real
  `<input type="radio">` are unchanged. It replaces BOTH desktop controls on
  the settings pages — the radio group's 16px dot and `SimpleSelect`'s floating
  popover. `SearchableChoiceList` is the same row collapsed, expanding **in
  flow** to a search box over a filtered `ListBox`; use it past a dozen or so
  options — the ~400 IANA timezones are what it was built for. `radio-group`
  stays as the compact form for dense dialogs),
  `switch` (SwitchField/SwitchList — **an on/off setting as a phone-style row**:
  label and hint on the left, the control on the RIGHT, the whole row tappable
  at 44px. On RAC's Switch, so the control is a real focusable input with
  `role="switch"` — semantically an on/off setting rather than a form checkbox,
  which is what these are. `SwitchList` groups consecutive rows onto one card
  with dividers, as a phone's settings app does. Used by the settings pages'
  booleans (Access's three, the Scoring page's GAP toggles); **dialogs keep
  `rac/checkbox`**, whose 16px leading box suits a dense panel — so a dialog
  boolean still answers to `role="checkbox"` in tests while a settings-page one
  answers to `role="switch"`).
- **Converted files:** `pages/TaskDetail.tsx` (page + EditTaskDialog +
  turnpoints table), `comp/TaskScores.tsx`, `comp/RouteEditorDialog.tsx`
  (Tabulator grid → RAC Table → GridList card list → **RAC Table again**, via
  the shared read-only `comp/TurnpointsTable.tsx` the task page also renders —
  see the superseded section below for how that went),
  `comp/SubmitTrackDialog.tsx`,
  `comp/ManualFlightDialog.tsx`, `comp/AddWaypointDialog.tsx`,
  `comp/TaskExportButtons.tsx`, `comp/ScoreFreshness.tsx` (button only),
  `pages/TaskFieldAnalysis.tsx` + `pages/CompFieldAnalysis.tsx` and all of
  `react/field-analysis/` (built RAC-native from the start — 2026-07-19),
  `pages/Competitions.tsx` (2026-07-21 — list cards are RAC Links, create
  dialog on the kit, plus a client-side SearchField filter over the loaded
  list; see gotcha #13), and — 2026-07-21 — the whole comp detail page:
  `pages/CompDetail.tsx` (hero LinkButtons, Create Task dialog on
  Form/TextField/CheckboxGroup),
  `comp/SettingsDialog.tsx` (kit Modal/Dialog; numeric GAP params became
  NumberFields holding numbers with NaN-as-blank — since replaced by the
  routed settings pages in `comp/settings/`, 2026-08), `comp/CompScoresSection.tsx`
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
  the rest of the Dashboard followed in the 2026-07-27 waves; it is now rac
  tabs/meter/button/tooltip throughout).
  And — 2026-07-21 — the waypoints page: `pages/CompWaypoints.tsx` (RAC
  buttons/FileTrigger/ToggleButton, read-only RAC table for non-admins;
  the editable grid became an **inline Tabulator grid**
  per the Tabulator policy — gotcha #16), `comp/WaypointDeviceExport.tsx`
  (rac Menu with href/onAction download items, ToggleButton QR toggle, rac
  Checkbox — retired `ui/checkbox`, file deleted), and `comp/FullScreenQR.tsx`
  (was a bare `fixed inset-0` div with hand-rolled Esc/scroll-lock listeners;
  now RAC ModalOverlay/Modal/Dialog primitives, so focus trap/restore, Esc
  and scroll-locking come from react-aria).
  Note that dialogs like SubmitTrackDialog/AddWaypointDialog are **shared** —
  which is why they could be converted ahead of every page that renders them:
  RAC components work fine outside converted pages (`RacRouterProvider` is
  global in `Shell`, so `href`-based client routing just works).
- **Nothing is left unconverted** — the six waves finished on 2026-07-27 and
  `src/react/ui/` is gone. For where each kind of code lives now, see
  [Where the UI lives](#where-the-ui-lives-2026-07-27-post-migration) at the
  end of this doc. Tabulator remains in the comp-page pilots dialog and the
  waypoints admin grid **by design** (see the Tabulator policy at the top —
  it is kept, not pending).
- The date/time pickers were already RAC before the migration and moved across
  unchanged; they live at `rac/date-picker.tsx` (lazy-loaded via
  `date-picker.impl.tsx` so they stay out of the SSR bundle).
  - `DatePicker` takes an **`inline`** prop (2026-08): the month grid renders
    in the page under the segments, with 44px day cells, instead of behind an
    "Open calendar" trigger. That is the settings-page form — nothing to open,
    nothing a phone keyboard can cover. Dialogs keep the dropdown (32px
    cells), where an always-open calendar would outgrow the panel. Both share
    one `CalendarBody`; the overlay is presentation, not plumbing, since the
    grid reads its state from the DatePicker's CalendarContext either way.

## Loading and in-flight states (2026-07-27)

Anything waiting on an API response gets visible feedback, and the shape of
the wait picks the component — all three live in `rac/progress.tsx`:

| The wait | Use | What it renders |
| --- | --- | --- |
| A page **section** is fetching | `<Loading>Loading scores…</Loading>` | `role="status"` (polite live region) + the sentence + a decorative spinner |
| An **action** is in flight | `<Button isPending pendingLabel="Saving">` | Spinner before the unchanged label |
| A **known background job** is running | `<ProgressBar isIndeterminate>` | The travelling stripe (ScoreFreshness's re-score/pending alerts) |

Points worth knowing before you reach for one:

- **Indeterminate IS the ARIA answer to "busy".** A progressbar with no
  `aria-valuenow` is what says "working, duration unknown"; the spinner is a
  circular skin over the same thing, not a separate concept. That's why
  `Spinner` is an `AriaProgressBar` whenever it carries a label.
- **`isPending` beats `isDisabled={saving}` + a "Saving…" label swap** and has
  replaced it at every converted call site (task/settings/route/pilots Save,
  Submit-track Upload, Record flight, Recompute scores). RAC keeps the button
  **focusable** while refusing presses — a plain `disabled` drops focus to the
  body mid-action — flips `type="submit"` to `"button"` so Enter can't
  double-submit, and announces the transition assertively. Keeping the visible
  label also keeps the button's width, so the footer doesn't jump.
- **`pendingLabel` is a real accessible name, not decoration.** RAC publishes a
  `ProgressBarContext` id around the button's children and folds a nested
  progressbar's label into the button's `aria-labelledby` while pending — that
  label is the text it announces. A bare `<svg>` there announces nothing.
- **Spinner has two modes and picking wrong is the bug.** With a `label` it's
  an announced progressbar; without one it's `aria-hidden` decoration. Inside
  `Loading` it must be decoration — the sentence is already in the live
  region, and a labelled spinner would read it twice. Same reason
  ScoreFreshness's bar is `aria-hidden`: those Alerts already carry deliberate,
  hand-written copy (see the COPY note in that file).
- **Reduced motion is designed, not inherited.** globals.css collapses every
  animation app-wide under `prefers-reduced-motion`, which would park the
  travelling stripe mid-track and read as "stuck at 40%". So
  `.gc-progress-indeterminate` has an explicit fallback: a static striped fill
  across the whole track (striped, because a solid full bar reads as "100%,
  done"). The spinner simply stops, and its ring gap keeps it legible as an
  indicator — in both modes a label or adjacent sentence carries the meaning.
- Contracts are covered by `rac/progress.test.ts` (the absence of
  `aria-valuenow`, the absence of a second accessible name, aria-disabled
  without `disabled`) — the failure modes all render identically.

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
- **Picking a "choose one of these" control: is it a form field, or a view
  control?** A **form field** — a value in a form the user will Save — belongs
  in `rac/choice-list.tsx`: `ChoiceList` (one of N), `CheckList` (any of N),
  `SearchableChoiceList` (one of N, collapsed to a row, with a search box past
  `searchThreshold`), plus `SwitchList` in `rac/switch.tsx` for booleans. They
  are lists **in flow**: no overlay to open over what you were reading, nothing
  a phone keyboard can cover, and the whole 44px row is the target.
  A **view or filter control** — choosing what to look at, sitting above the
  content it acts on — stays a `Select`/`SimpleSelect`. Converting those makes
  the app worse: a filter rendered as a card of rows pushes the thing you are
  filtering off the screen. `rac/select.tsx` carries the rule and names the
  surviving call sites. `rac/checkbox.tsx` and `rac/radio-group.tsx` remain the
  compact forms for dense dialogs.
- **Admin editors are routed pages, not centred modals** (#636, #637). Comp
  settings, task settings, the weather notes, the route editor and the
  manual-flight recorder each have a URL, built from `components/SettingsPage`
  + `components/SettingsForm` + `rac/nav-list`, guarded by
  `lib/use-unsaved-changes-guard`. A form taller than the viewport inside a
  centred modal is the desktop-most thing an app can do, and this app is used
  on phones on the hill. What stays a dialog: **create** flows (there is no
  entity yet, so nothing for a URL to name), short single-purpose forms over an
  editor (the turnpoint and waypoint editors), and dialogs that are an action
  or a notice rather than an editor.
- **44px on a coarse pointer.** A control below 44px on a phone gets there via
  a `pointer-coarse:` size utility, or — where growing it would re-flow its
  neighbours — the `touch-target` utility in `react/globals.css`, which widens
  the hit area without painting anything. See the accessibility standard §4.5;
  `rac/nav-list.tsx` rows are the precedent.
- **The app runs edge to edge** (`viewport-fit=cover`, issue #642), so any kit
  surface that touches a viewport edge holds its CONTENT clear of the notch and
  the home indicator while its background stays full-bleed. The `pt-safe` /
  `pb-safe` / `p-safe` / `px-gutter-safe` / `px-page-safe` / `pb-gutter-safe`
  utilities in `react/globals.css` are the vocabulary; `rac/full-screen-sheet.tsx`
  already applies `p-safe` for every sheet, so callers need nothing. `env()` is
  0px everywhere else, so none of it costs the desktop anything.

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
   `renderDropIndicator` with `data-drop-target:outline-*` classes. **Caveat
   (why the route editor dropped it, 2026-07-23):** row dragging is **native
   HTML5 drag**, which does not start on touch without a long-press — unusable
   on a phone. For touch-first reorder, prefer explicit up/down arrow buttons
   over DnD — though the route editor now has neither, since typing the route in
   "Enter task" makes word order the row order. No component uses these hooks now.
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
   per-keystroke. This is the RAC analogue of Tabulator's `cellEdited`. (The
   worked example was `EditableCell` in RouteEditorDialog.tsx; that dialog's
   list is read-only now, so the code is gone — the pattern still stands for the
   next in-grid editor.)
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
    "No matches" still shows while searching. **Every sentence in this paragraph
    assumes the items are a local array that is already in hand — for a remote
    collection all three pieces of advice are wrong. See gotcha #21.**

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
    mirror into it: render `<TabulatorGrid>` only where the grid belongs
    (`isAdmin && !loading` — mount/unmount replaces the old effect gating, and
    `initialColumns`/`initialData` are thunks the wrapper calls once at build,
    so passing them inline can't tear the grid down per keystroke or recompute
    per render); wire
    `cellEdited`/`rowDeleted` → `setRows(table.getData()...)` so the map/dirty
    check/save all read state; push *external* changes (file upload, add
    dialog) into the grid imperatively via `tableRef` (`setData`/`addRow`)
    beside the `setRows` call. `initialData` rows are cloned by the wrapper
    (Tabulator edits row objects in place), so returning React state is safe.
    Cell formatters must build DOM nodes and assign
    `textContent` — a string return is innerHTML, and grid values come from
    user-supplied waypoint files. Static icon markup (the pin/✕ buttons) as
    HTML strings is fine. `columnDefaults: { headerSort: false }` unless you
    actually want sorting (saved row order vs sorted view is a trap). SSR:
    the admin variant server-renders an empty container div and the grid
    builds client-side; the anonymous/crawler variant stays a real RAC
    `<table>` so the page keeps its SSR content (the ssr.spec.ts waypoints
    test asserts a waypoint code appears in the raw HTML).

17. **`isPending` does NOT set `data-disabled` — style `data-pending`
    separately.** RAC reports `isDisabled: props.isDisabled || isPending` to
    the *render props* but writes the DOM attribute from `props.isDisabled`
    alone, so the kit's `data-disabled:opacity-50` never fires on a pending
    button. `rac/button.tsx` carries its own `data-pending:opacity-70` for
    exactly that reason — don't "fix" it by passing `isDisabled` as well,
    which would take the button out of the tab order and undo the whole point
    of `isPending`. Press/hover ARE already neutralised by RAC, so only the
    visuals are yours. Also note `isPending` renders `aria-disabled="true"`
    with **no** `disabled` attribute, so a test that asserts on the `disabled`
    property will read the button as enabled. Assert `aria-disabled` and that
    the press handler never fired (what `rac/progress.test.ts` does).

18. **A server-rejected value must be cleared on change, or the form can
    never be submitted again.** RAC's default `validationBehavior` is
    `"native"`, so `isInvalid` on a TextField is not merely an ARIA state —
    RAC calls `setCustomValidity()` on the real input. The browser then blocks
    `submit` outright, and your `onSubmit` handler (where you'd normally clear
    the error) never runs. Onboarding hit this exactly: enter a taken
    username, get "Username is already taken", type a free one — and Continue
    silently does nothing, forever. Clear the server error in the field's
    `onChange`, not in the submit handler:

    ```tsx
    onChange={(value) => { setUsernameValue(value); setUsernameError(null); }}
    isInvalid={usernameError !== null}
    errorMessage={usernameError ?? undefined}
    ```

    The Base UI version had no such trap — its `<FieldError>` was inert
    markup — so this is a hazard the conversion *introduces*, and it is
    invisible to typecheck, unit tests and a first-attempt click-through.
    Drive the retry path. (The alternative, `validationBehavior="aria"`, drops
    the native `required` enforcement too — only reach for it on a field with
    no native constraints.)

19. **RAC's `Button` has no `title` prop — that's the library refusing the
    attribute, not an oversight.** A `title` hint is invisible to keyboard
    users, unreliable for screen readers, and unreachable on touch, so RAC
    simply doesn't type it. TypeScript catches every one at conversion time
    (four on the Dashboard's row actions), and the fix is a `TooltipTrigger`
    wrapper from `rac/tooltip.tsx`:

    ```tsx
    <TooltipTrigger>
      <Button variant="outline" size="sm" onPress={…}>Download</Button>
      <Tooltip>Download IGC</Tooltip>
    </TooltipTrigger>
    ```

    Only for *supplementary* hints on a control that already has a visible
    label. If the hint is the only name the control has, it belongs in the
    accessible name (`aria-label`), and if it's prose, use `rac/popover` —
    tooltips are hover-only and dismiss before a sentence can be read.

20. **An external URL in a RAC `href` is mangled by the router bridge.**
    `RacRouterProvider` hands RAC react-router's `useHref`, and RAC writes
    whatever comes back into the anchor — so `useHref("https://sheets.new")`
    resolved that against the current path and rendered
    `/comp/<comp>/scores/https:/sheets.new`. A 404 nobody sees until they click
    it, because the anchor *looks* fine in the source. `rac/router.tsx` now
    passes anything with a scheme (`https:`, `mailto:`, `tel:`) or a
    protocol-relative `//` straight through, on both the `useHref` and
    `navigate` sides, so a RAC `Link` / `LinkButton` / `MenuItem` may hold an
    external href like any other. If you see a route that has swallowed a URL,
    this is why. (Plain `<a>` elements were never affected — the provider only
    touches RAC's own components, which is why the app's other outbound links
    survived.)

21. **An ASYNC ComboBox inverts gotcha #12's advice, because RAC decides
    everything from the collection it can see *at that instant* — and for a
    remote list, that is empty.** Found building `comp/PlaceSearchField.tsx`
    (Mapbox place search); the three rules that changed:
    - **`allowsEmptyCollection` cannot be gated on having a query.**
      `useComboBoxState.open()` refuses to open a menu whose collection is
      empty unless the flag is set, and it runs *inside the keystroke*, when
      the request hasn't returned and the gate is still reading the PREVIOUS
      query. The open is swallowed and the results land with nowhere to go.
      Leave it on, and let `renderEmptyState` carry the states a local list
      never has: below the minimum query length, in flight, and **failed** —
      a search that 500s must not read as "no matches".
    - **Pinning `selectedKey={null}` leaves the popover open over a map that
      has already moved.** The close-on-selection path is *"the display value
      changed"*, so with nothing committed there is nothing to close on.
      Control `selectedKey` for real, and drop it back to null when the user
      next edits the field — which is also what lets the same item be re-picked.
    - **Even then it stays open when the picked label equals what was typed**
      (search "Corryong", pick "Corryong" — the display value never changed).
      Emptying the collection on the settled render is the deterministic close:
      RAC shuts a menu whose collection went empty *and* whose
      `allowsEmptyCollection` is off, so turn both off together for exactly
      that render. Writing the fuller label back (`"Corryong, Victoria,
      Australia"`) is worth doing anyway — six places are called Manilla.

    Debounce (300 ms) plus an `AbortController` per keystroke; ignore
    `AbortError` in the catch or your own cancellation renders as an error.
    And do not retry a failed search — the next keystroke is already a fresh
    request, and each one is billed.
22. **RAC popover positioning is only correct against a `position: static`
    body — never reposition the popover, and never position the body.** RAC
    portals popovers to `<body>` and positions them with an inline
    `position: absolute` whose numbers assume the initial containing block:
    `top` is emitted in document coordinates, and when a popover flips
    UPWARDS (trigger low on screen) it emits `bottom` computed against the
    *viewport-sized* ICB. Any other containing block breaks one case or the
    other, and both failures shipped:
    - `body { position: relative }` (a Base UI quick-start requirement that
      outlived the Base UI kit) made the document-height body box the
      containing block, displacing every upward-flipped popover by
      `scrollHeight - innerHeight` — found by the CIVL ranking picker, which
      sits low in a tall dialog on the 64-pilot roster page and so flipped
      every time.
    - The `fixed!` class patched over that by anchoring popovers to the
      viewport — which broke the *other* emission: `top` is document
      coordinates, so every downward popover opened `scrollY` px below the
      viewport once the page was scrolled. Found by the manual-flight
      dialog's turnpoint select, ~2,500 px down the task page.
    Both symptoms look identical: the control "does nothing", yet
    `aria-expanded="true"` and every option is in the DOM. **Diagnose by
    rect, not by eye** — the popover is open, just off-screen. The fix is to
    leave both ends alone: body stays static (globals.css says why) and
    `popoverClass` (rac/select.tsx, reused by ComboBox/Menu/Popover), the
    date picker's calendar and the Tooltip carry no `position` class.

    **Neither control that found this exists any more, and the rule is
    unchanged by that.** The CIVL picker dissolved when `CivlFillDialog`
    became a sentence and a button; the manual-flight form is a routed page
    with a `ChoiceList` since #637/#638. What they were is history that
    explains the rule — keep it — but do not read the rule as being about
    dialogs. It is about where RAC puts a body-portalled popover on a
    scrolled document, which is a property of the kit and the page, not of
    whatever opened it. Every surviving popover is subject to it.

    Coverage: `e2e/popover-position.spec.ts`, which drives the manage
    table's per-row pilot-status select — same page and same scroll depth as
    the manual-flight case, without a dialog in between — and asserts the
    open listbox lands inside the viewport. Asserting visibility would pass
    either bug; Playwright's visibility check does not require the element
    to be on-screen.

23. **A Menu is named by its TRIGGER, and a MenuItem cannot carry
    `aria-current`.** Two separate limits, both found building the
    priority+overflow nav (`rac/priority-nav.tsx`, issue #639), and both quiet:
    - `MenuTrigger` wires `aria-labelledby` from the button onto the menu, and
      `aria-labelledby` beats `aria-label`. An `aria-label` on the Menu is
      therefore inert — the comp page's two "More" menus were BOTH named
      "More", which is exactly the ambiguity a label was meant to remove. Name
      the **trigger** instead (`aria-label="More sections"`), keeping the
      visible word inside it (WCAG 2.5.3, label in name); the menu inherits it.
    - RAC runs an item's props through `filterDOMProps`, which passes `data-*`
      and the four labelling `aria-*` and drops everything else —
      `aria-current` included. Marking the current page in a menu therefore
      takes `data-current` for the ink plus a visually hidden phrase for AT. A
      hand-written `role="menuitem"` anchor (SiteHeader.astro) keeps the real
      attribute, so the two implementations differ here on purpose.

24. **A dialog opened from inside a `FullScreenSheet` opens BEHIND it unless
    it is told not to.** The sheet's overlay is `z-[100]`; `Modal`
    (`rac/dialog.tsx`) is `z-50`, and both are portalled to the body, so
    z-index decides and the sheet wins — the dialog is mounted, focused and
    invisible. `Modal` therefore takes one stacking knob, `elevated`, which
    lifts its overlay to `z-[110]`; pass it through from whatever opened the
    dialog (`AddWaypointDialog`'s `elevated` prop, set while the waypoints
    editor's map is maximised). Nothing else about the overlay is
    overridable, deliberately — the same reasoning as the thermal rose's
    legend popover, which carries `z-[110]` for exactly this reason.

## Verification playbook (all part of "done" for RAC work)

```bash
bun run typecheck:all
bun run test                       # engine + workers unit tests — NOT the frontend's
bun run test:all                   # adds the workspaces, incl. the frontend vitest suite
bun run build                      # Vite + SSR bundle + Astro
bun run test:e2e:ssr               # needs no other servers running
bun run test:e2e                   # full suite (one known flaky dev-login test; rerun)
```

- **`bun run test` does not run any of this guide's own tests.** The root
  `test` script runs `bun test` over `.`, `web/engine`, the airscore-api and
  dev-router workers and `web/scripts` — `web/frontend` is not in that list, so
  `src/react/one-kit.test.ts`, `rac/progress.test.ts` and `rac/router.test.ts`
  are all skipped by it. They run under the frontend's own `vitest run`, which
  is reached by `bun run test:all` (via `test:workspaces`) or directly by
  `bun run test:frontend`. Run one of those two for RAC work, or the kit guard
  passes by never executing.

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

## Route editor: how it works now (2026-08)

The route editor is **`comp/RouteEditorDialog.tsx`**, and the turnpoint list in
it is no longer a GridList of editable cards. Three pieces:

- **`comp/QuickTaskField.tsx` — "Enter task" — is where the route is edited.**
  You type the route the way you'd say it (`ell 400m ell 5k mitta cudg ncor 1k`)
  and the whole set of turnpoints falls out: names fuzzy-match the competition's
  waypoints, and a distance after a name is that cylinder's radius (grammar in
  `quick-task.ts`). So turnpoint **order** is the order of the words, and there
  is nothing to reorder with buttons. The start settings ride the same line
  (`mitta sss enter 13:15`, #436), so direction and gates are text you can see
  and edit rather than defaults applied silently in a collapsed panel. The line
  and the route are one thing seen two ways — the text round-trips exactly
  (`quickTaskText`), so the field shows the loaded task as text and editing the
  text rebuilds the route. It is a growing `TextArea`, not one line, and its
  suggestions are an **inline** kit `ListBox` under the field — mobile first, no
  overlays, because a phone keyboard can't cover what isn't floating.
- **`comp/TurnpointsTable.tsx` is a read-only listing, shared with the task
  page.** Its header comment states the reasoning: it is *"Shared by the task
  detail page (read-only, server-rendered) and the route editor, which renders
  it over the route being edited so the editor shows exactly what the task page
  will. Read-only by design: it's a listing, not a grid — editing happens in the
  editor's Enter task field and dialogs."* It is a RAC `Table` in XCTrack's
  compact FLY-tab shape (role column with the Exit badge, turnpoint with radius
  and altitude under it, optimised leg on the right, closed by the optimised
  total), and it resolves the day's wind against each leg. SSR-safe: no
  browser-only imports, and every number formatted deterministically from the
  unit preferences.
- **`TurnpointDetailsDialog` still lives inside `RouteEditorDialog.tsx`** and is
  unchanged in the way that matters here: it edits a local `TurnpointDraft` and
  commits only on Save, and "Load from a waypoint" is the kit **`ComboBox`**,
  applying gotcha #12 exactly as written (controlled `selectedKey` +
  `inputValue`, filtering at the call site with `useFilter().contains`, an empty
  query yielding an empty list so the popover stays shut at rest and Esc can
  close it). Today the only thing that opens it is **Add turnpoint** — the
  per-row **Edit** entry point went away with the cards, so its `mode="edit"`
  branch currently has no call site.
- **`comp/RouteMap.tsx` carries a second ComboBox — and it obeys the opposite
  rules.** `comp/PlaceSearchField.tsx` (#540) sits above the map so you can find
  the valley before there is a waypoint to fit to. It is remote (Mapbox place
  search), so every piece of gotcha #12's advice inverts: see **gotcha #21**
  before touching it. Two ComboBoxes in one dialog following contradictory rules
  is not an inconsistency to tidy up — it is what local and async collections
  each require.

## Route editor list view (BUILT — 2026-07-18) — SUPERSEDED

**Superseded 2026-08** — the list became `TurnpointsTable` (a RAC Table)
again, so the specifics below are no longer true of the code: there is **no**
GridList in the route editor, **no** per-row up/down reorder control, **no**
`onAction` → `RouteMap` `focus={{lat,lon,key}}` map-pan, and **no**
`dependencies={[rows, derived]}` on a GridList. Kept for the reasoning, which
still applies to any card-shaped editable collection; read "Route editor: how it
works now" above for the current shape.

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
  (contrast the Table, gotcha #2). `selectionMode="none"`.
- **Reorder is per-row up/down arrow buttons, NOT drag-and-drop** (changed
  2026-07-23). The row was `useDragAndDrop`'d with a `slot="drag"` handle, but
  that handle is `pointer-events:none` (gotcha #4) so the drag lives on the
  whole row via **native HTML5 drag** — which never fires on touch without a
  long-press. Since the route is set on a phone on the hill, a normal
  press-drag did nothing. Replaced with `moveRow(id, ±1)` (swap with neighbour)
  behind two kit `Button`s per row, disabled at the ends — reliable on mouse,
  touch AND keyboard, the pattern XCTrack itself uses. The `useDragAndDrop`
  hooks, `slot="drag"` handle, `DropIndicator` and `GripVerticalIcon` are gone
  from this dialog; gotcha #4 stays as general RAC knowledge but has no consumer
  now.
- **Each row is an XCTrack-style flight-plan row** (no inline edit controls):
  up/down arrows · role (TAKEOFF/SSS/ESS/GOAL) with an Exit badge beneath · code
  · name with radius (and altitude) stacked under it · right-aligned optimized
  leg km · Edit / remove. Matches the read-only task-page turnpoint table.
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
  so re-tapping re-centres). The reorder/Edit/Remove buttons are separate
  targets and don't trigger the row action.
- **Footer holds only Cancel / Save.** Import .xctsk, Load from XContest,
  Export .xctsk/.csv moved up into the Add-turnpoint toolbar row. **Load from
  XContest** is now its own small pop-up (code input + Load) instead of an
  inline field, controlled by `xcImportOpen`; `importXContest` closes it on a
  successful load.
- Reused unchanged: rows state + `derived` memo, `dependencies={[rows,
  derived]}` on the GridList (gotcha #3 — legs/dirs would otherwise stale on
  reorder; verified: an up/down move recomputes legs), FileTrigger.
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

## Adding or changing UI (recipe)

The migration is over, so this is now "how to build a page with the kit"
rather than "how to convert one".

1. Nothing to wrap: `RacRouterProvider` is mounted globally in
   `components/Shell.tsx` and the global `ConfirmProvider` (`rac/confirm.tsx`,
   mounted in routes.tsx) means `useConfirm()` already resolves to the RAC
   alertdialog anywhere. Both are SSR-safe.
2. Reach for the kit piece, not the DOM element: Button (`onPress`,
   `isDisabled`, `isPending`), Modal/Dialog, TextField (self-labelling — no
   `useId` plumbing), Select/SimpleSelect, CheckboxGroup, RadioGroup,
   FileTrigger for file inputs, TooltipTrigger instead of `title=` (RAC's
   Button has no `title` prop at all — see gotcha #19).
3. Tables: read-only ones are Table/TableHeader/Column/Row/Cell — give the
   Table an `aria-label`, one column `isRowHeader`, rows an `id`, and a
   `scrollLabel` if it can overflow. Row-click navigation = `onRowAction` plus
   a real AriaLink in the name cell (keeps a crawlable anchor).
4. **Editable grids are Tabulator** (policy at the top of this doc). Inside a
   dialog, give the kit `Dialog` an `id` and point Tabulator's
   `popupContainer` at it. The shared theme is `comp/tabulator-grid.css`
   (`gc-grid` container class).
5. Measurement vs completion: `rac/meter` for a reading within a range,
   `rac/progress` for a task running to completion. They document the split
   from both sides.
6. Verify per the playbook; SSR pages additionally must pass `test:e2e:ssr`
   before "done".

## Where the UI lives (2026-07-27, post-migration)

| Directory | What's in it |
|---|---|
| `src/react/rac/` | **The kit.** One component family per file. Includes `date-picker` (RAC under the hood, lazy-loaded so it stays out of the SSR bundle) and two behaviour-free static pieces, `badge` and `alert`. |
| `src/react/vendor/` | Thin wrappers over third-party widgets RAC doesn't provide: `input-otp` (the sign-in code field) and `sonner` (the toaster). Not a kit — don't grow it without a reason of that kind. |
| `src/react/comp/`, `pages/`, `field-analysis/`, `weather/` | Feature code. Uses the kit; owns no primitives. Local one-page helpers are fine (`SettingsCard` in Settings.tsx, which is all `ui/card` ever was). |
| Tabulator grids | Editable grids only, per the policy above: the comp pilots editor and the waypoints admin grid, both through `comp/TabulatorGrid.tsx`. |
| `src/analysis/`, `src/replay/` | Vanilla TS entries — own styling, no React, deliberately outside all of this. |
| `web/frontend/static/` | The prerendered Astro content pages. No framework by design. |

`src/react/one-kit.test.ts` enforces the first rule of this table: no
`src/react/ui/` directory, and nothing importing from one.

## Reference

- Branches: `explore/rac-task-detail` (the original conversion, worktree
  `.claude/worktrees/explore-rac`), then `explore/rac-route-editor-list`
  (PR #374 — the GridList route editor + ARIA-native breadcrumbs). All
  merged (PRs #373, #374, #378, and #401 for the comp list).
- RAC version in web/frontend: `^1.20.0` (a caret range, currently resolving to
  1.20.0 in `bun.lock` — not a hard pin). Upgrades: re-run the drives —
  `CellEditZone` and `dependencies` behavior are the fragile seams.
- Docs: react-aria.adobe.com (RAC), react-spectrum.adobe.com (Spectrum 2 —
  same behavior engine, Adobe-styled; its TableView `EditableCell` popover
  pattern is a good future model for *occasional*-edit tables).
