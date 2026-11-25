# Interaction guide

Status: adopted 21 November 2026. This is the one document that says how
GlideComp's interface behaves, and why.

Read it before you design or change anything a person sees or touches. If a
change conflicts with it, change the code or amend this guide in the same pull
request, with the reason. Do not diverge silently.

It replaced the interaction rules in `CLAUDE.md`, the accessibility standard
(now Part 3) and the "design language" of the information architecture
document. Those were written one incident at a time, in three places, and
they drifted apart.

## Rules at a glance

Each line is a rule. The number is the section that explains it.

**Moving between pages**

- A screen is a page with a URL. No sheets and no full-screen modals. ([2.1](#21-a-screen-is-a-page))
- Never catch Back. Only the router touches the history. ([2.2](#22-back-is-the-browsers))
- Leave a page through `useLeave()`: a real Back if the reader came from the app, else up by a replace. ([2.3](#23-leaving-a-page))
- After a save, leave. After a delete or a create, replace. ([2.3](#23-leaving-a-page))
- Put what the reader chose to look at in the URL. ([2.4](#24-the-url-holds-the-view))
- A reload and a shared link show the same page. Unsaved work that must survive is a draft. ([2.5](#25-reload-a-shared-link-and-drafts))
- Anything that opens a page is a real link, built with the path helpers. ([2.6](#26-links-are-links))
- Nothing is fixed to an edge of the screen, and nothing sticks to the bottom. ([2.8](#28-the-keyboard-and-the-screens-edges))
- Nothing needs a hover or a drag. ([2.9](#29-the-pointer))
- An organiser's page sends anyone else on to the public page. ([2.10](#210-a-page-the-reader-may-not-use))

**The bar and its actions**

- One bar on every page: the way out on the left, the title in the centre, the action on the right. ([5.3](#53-one-bar-no-tab-bar))
- A page's actions go in ⋯, each with its icon from the table. ([5.4](#54-actions-go-in-), [5.5](#55-every--row-has-an-icon))
- A form's commit button is in the bar, is live only when there is something to commit, and says Save, Create, Add or Done. A commit that sends, imports or fetches is named for that act. ([5.6](#56-forms))

**Forms, lists and waiting**

- Build a form on `rac/form.tsx`. A refusal lands under its field or in the banner, never in a toast. ([5.6](#56-forms))
- A value to save is a list in flow. A control that chooses what to look at is a select. ([5.6](#56-forms))
- An editable collection is a list of rows that each open a page. There is no grid. ([5.7](#57-lists))
- More than three columns is a list of records, not a table. ([5.7](#57-lists))
- Anything that waits says so, with the component for that kind of wait. ([5.8](#58-waiting))
- A typed altitude is in the reader's unit. A cylinder radius is always metric. ([5.9](#59-units))

**A phone first**

- Design for a phone. One layout at every width. One way to do a thing. ([5.1](#51-mobile-first-and-one-layout-at-every-width))
- A target is 44px on a coarse pointer and in the bar. Measure it; do not read its classes. ([3.9](#39-targets))
- No sideways scroll at 320px wide, and the page works at 200% zoom. ([3.3](#33-text-and-zoom))

**Accessibility**

- Use the kit component. It carries the role, the state and the keys. ([3.12](#312-name-role-value-and-status))
- Everything works from the keyboard, with a visible focus ring that the bar does not cover. ([3.5](#35-keyboard), [3.6](#36-focus))
- Text is 4.5:1 and marks are 3:1, in both themes. Colour as text is a token. Never colour alone. ([3.2](#32-colour-and-contrast))
- One `<h1>`, which is the bar's title. Headings in order. Every input labelled, every icon button named. ([3.7](#37-landmarks-headings-and-titles), [3.10](#310-forms-and-inputs), [3.4](#34-images-icons-and-media))
- A status change is announced without moving focus. ([3.12](#312-name-role-value-and-status))
- Honour reduced motion. ([3.8](#38-motion))
- A chart states its reading in words, with a table beside it. Labels are painted at 11px or more. Nothing says "hover". ([3.13](#313-charts-maps-and-the-3d-scene))

**When the answer is not here**

- Do what the Apple HIG says for iOS. ([Part 4](#4-the-apple-human-interface-guidelines))
- A new pattern gets one owner in code, or a test, and a row in Part 6. ([1.2](#12-the-rules-of-this-guide))

## Contents

1. [Order of authority](#1-order-of-authority)
2. [The web platform](#2-the-web-platform)
3. [Accessibility: WCAG 2.2 AA and the WAI-ARIA Authoring Practices](#3-accessibility-wcag-22-aa-and-the-wai-aria-authoring-practices)
4. [The Apple Human Interface Guidelines](#4-the-apple-human-interface-guidelines)
5. [Where we diverge, and what is ours](#5-where-we-diverge-and-what-is-ours)
6. [Who owns each pattern](#6-who-owns-each-pattern)
7. [Checklist for a pull request](#7-checklist-for-a-pull-request)
8. [How to test](#8-how-to-test)
9. [Known gaps](#9-known-gaps)

---

## 1. Order of authority

We do not write down standard interaction patterns. We follow three outside
sources, in this order, and write down only how they apply here and where we
chose differently.

| | Source | What it decides |
|---|---|---|
| 1 | **The web platform**: what a browser does with pages, links and forms | Navigation, Back, reload, URLs, the keyboard, scrolling, focus |
| 2 | **[WCAG 2.2](https://www.w3.org/TR/WCAG22/) Level AA** and the **[WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)** (APG) | What every reader must be able to perceive and operate, and how each control behaves with a keyboard and a screen reader |
| 3 | **The [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines)** (HIG) | Everything else: layout on a phone, lists, buttons, confirmations, feedback |
| 4 | **Our divergences** (Part 5) | Where we chose differently from the HIG, and the patterns it does not have because it is written for native apps |

To answer a question about behaviour:

1. Does the browser already do it? Then that is the answer. We never imitate
   the browser and never contradict it.
2. Does WCAG or the APG say how? Then do that.
3. Is it in Part 5? Then Part 5 is the answer.
4. If not, do what the HIG says for iOS.

Part 5 can override the HIG. It cannot override the platform or WCAG.

### 1.1 Why this order

- **The platform is first** because the app is a website. A competition is
  shared as a link and left with the browser's Back. The HIG says nothing
  about URLs, reload or shared links.
- **WCAG and the APG are second** because they are testable and they are the
  web's own. On iOS a standard control gets its screen-reader and keyboard
  behaviour from the system. On the web we must build it.
- **The HIG is third** because a competition is run from a hill, on a phone.
  A reader's expectations of a list, a back control and a confirmation come
  from their phone's own apps, and the HIG is the most complete written
  account of those. The mobile review in #860 measured the app against it.

### 1.2 The rules of this guide

- **One document.** A rule about how the interface behaves goes here and
  nowhere else. A feature's own document cites a pattern from here. It does
  not state the pattern again.
- **A pattern has an owner or a test.** A rule that every page must remember
  will be forgotten. Each pattern is owned by one component or hook that
  every page uses, or held by a test that fails when a page departs from it.
  Part 6 lists them and marks the ones that have neither.
- **State the principle before the mechanism.** Until #901 the rule for the
  back control was a mechanism: the link that opened a page marked its
  history entry. About half the links did not, and the principle (the two
  back buttons never disagree) was written nowhere.
- **An owner's decision carries its date**, and only the owner changes it.
- **Wording is proposed before it is changed.** That rule is in `CLAUDE.md`.

### 1.3 The four surfaces

| Surface | Where | Built with |
|---|---|---|
| **Main app** | `web/frontend/src/react/` | React and the kit in `src/react/rac/`. Use the kit: its components carry the ARIA and the keyboard behaviour |
| **Content pages** | `web/frontend/static/` (Astro, prerendered) | Semantic HTML and vanilla JavaScript. Anything interactive carries its own ARIA and key handling, written to the APG pattern |
| **Analysis page** | `/analysis.html` (vanilla TypeScript) | `analysis.css` |
| **3D replay** | `/replay` (vanilla TypeScript and WebGL) | `replay.css` and an inline theme |

The map canvas and the 3D scene follow
[3.13](#313-charts-maps-and-the-3d-scene).

### 1.4 Documents that stay separate

Each describes one surface or one mechanism. They follow this guide and do
not restate it.

| Document | What it holds |
|---|---|
| [mapbox-interactions-spec.md](mapbox-interactions-spec.md) | What the map draws and how it answers the pointer and the keyboard |
| [3d-flight-replay-notes.md](3d-flight-replay-notes.md) | The 3D replay's controls and camera |
| [2026-07-18-rac-adoption-guide.md](2026-07-18-rac-adoption-guide.md) | How to build with the kit |
| [drafts.md](drafts.md) | How unsaved work is stored |
| [ssr.md](ssr.md) | Which pages are server-rendered, and how |

---

## 2. The web platform

Each rule here says the same thing: let the browser do it.

### 2.1 A screen is a page

**Anything that takes over the screen is a page with its own URL**: an
editor, a review, a picker with fields, a figure at full size. The reader
reaches it by a link and leaves it with Back. (Owner's decision, 2 November
2026.) Code comments call this the overlays rule, or "No full-screen
overlays".

Why: a sheet is a fixed layer over a scrolled page. On an iPhone, after the
keyboard had come and gone, Safari drew the pilot sheet in one place and
hit-tested it in another. Everything that made sheets usable imitated
something a page does by itself.

- **Small overlays are fine**: a confirmation, a menu, a combo box's list, a
  date picker. Nothing that fills the screen, and nothing with text fields.
  One layer does cover the screen: "Drop files to upload" on My Flights,
  only while a file is dragged over the page. It takes no input, and a phone
  never shows it. `no-overlays.test.ts` names it and fails on another.
- **A page fetches what it needs.** State goes in the URL or is fetched. It
  is never handed over in memory from the page underneath.
- Worked example: the pilot editor, `pages/CompPilotPage.tsx`.
- `src/react/no-overlays.test.ts` fails if a full-screen overlay comes back.

### 2.2 Back is the browser's

**Back always navigates, and nothing catches it**, with unsaved edits and
with a dialog open too.

- An editor with a draft loses nothing to Back
  ([2.5](#25-reload-a-shared-link-and-drafts)). A page without one leaves the
  edits behind, as any web form does.
- A small dialog holds no history entry. It closes with the page it was over
  (`rac/dialog.tsx`).
- The unsaved-changes guard (`lib/use-unsaved-changes-guard.ts`) asks before
  a reload, a tab close or a link inside the app. It never asks on Back.
- Only the router pushes or walks history. `no-overlays.test.ts` fails on
  code that does it by hand.

### 2.3 Leaving a page

**The bar's back control and the browser's Back never disagree.** (Owner's
decision, 21 November 2026.)

The page asks the history where the reader came from. No link marks anything.
`useLeave()` in `lib/leave.ts` owns this, and it is the only `navigate(-1)` in
a page.

| The reader | Came from a page of this app | Arrived directly (shared link, bookmark, the installed app's first screen) |
|---|---|---|
| Presses the bar's back, or Cancel | A real Back | To the page above, by a replace |
| Saves, and the page closes itself | A real Back | To the page above, by a replace |

On a direct arrival a real Back would leave the site, so the control goes up.

- **The control is named for where it goes**: "Back to Comp analysis" for the
  page behind, "Back to <the page above>" on a direct arrival. The name
  survives a reload.
- **A delete replaces**, to the page above. The page the reader was on no
  longer exists.
- **A create goes to the thing it made, by a replace**, so Back does not
  return to an empty form.
- **The last step of a page with steps goes to the list, by a replace.** "Copy
  pilots" has a choice and then a review at one path. Back from the review
  goes to the choice, so finishing cannot be a Back.
- **Every page that is not top-level has a back control.** The installed app
  has no browser Back.
- **In the markup the back control is a link to the page above**, so it works
  without JavaScript.

### 2.4 The URL holds the view

**What a reader chose to look at is in the URL**: a search, a sort order, a
class, a tab. Back then returns a list as it was left, and a shared link
shows the same view.

- A view control writes the URL with a replace, so five changes of a filter
  are not five history entries.
- Build every link with the path helpers in `lib/slug.ts`, so that a hidden
  competition's share key stays in it.
- A page corrects its own address to the canonical slug by a replace
  (`lib/use-canonical-path.ts`).

### 2.5 Reload, a shared link and drafts

**A reload shows the same page**, and so does its URL in another tab.

Work that is not saved yet, and that another page, a reload or Back must find
again, is a **draft** (`lib/draft-store.ts`, [drafts.md](drafts.md)). It
lives in this tab's session storage, keyed by what it edits, and may always
come back empty.

- A draft edited over several pages (a route, a waypoint file) is one stored
  draft that every page reads and writes (`lib/draft-editor.ts`).
- Save is on the draft's list page, live only while the draft differs.
  "Discard changes" is in ⋯, shown only while there are changes.

### 2.6 Links are links

**Anything that opens a page is an `<a href>`.** A reader can open it in a new
tab, copy it, and follow it without JavaScript.

- A closed menu puts no link in the markup, so the bar also renders its
  links in hidden navs ([3.7](#37-landmarks-headings-and-titles)).
- The public competition pages are server-rendered. The content pages carry
  every word and image in the prerendered HTML.

### 2.7 Scroll and focus follow the navigation

A browser restores scroll on Back and moves focus when a document loads. A
single-page app must give both back.

- **Scroll**: Back returns a page to where it was left
  (`lib/scroll-restoration.ts`).
- **Focus**: arriving on a page focuses its `<h1>`, unless the page focused
  something itself. Back returns focus to the control the reader left from
  (`lib/route-focus.ts`).

### 2.8 The keyboard and the screen's edges

**Nothing is fixed to an edge of the screen.** A fixed bar must be moved
around the on-screen keyboard by hand, and that is where the bottom bars
broke on an iPhone.

- The page bar is `sticky` at the top of the page's flow, never `fixed`.
- An iPhone pans the screen when the keyboard opens. The bar follows the pan
  with one transform (`useKeepOnScreen` in `rac/page-bar.tsx`). That is the
  only place the app positions anything from script. Do not add a second.
- **Nothing sticks to the bottom.**
- The app runs edge to edge. A surface that touches an edge keeps its content
  clear of the notch with the `pt-safe`, `pb-safe` and `px-gutter-safe`
  utilities in `react/globals.css`.

### 2.9 The pointer

- **Nothing needs a hover.** A phone has none.
- **A coarse pointer and a fine pointer get different sizes**, through
  `(pointer: coarse)`, never through the screen's width
  ([3.9](#39-targets)).
- **A drag is never the only way to do a thing.** HTML drag does not fire on
  touch without a long press. Reordering a route is a mode with Move up and
  Move down on each row (`comp/TurnpointList.tsx`).

### 2.10 A page the reader may not use

**An organiser's page sends anyone else on** to the public page it belongs
to, with a line that says why and, signed out, offers sign-in
(`components/OrganisersOnly.tsx`, owner's decision 3 November 2026).

A dead link under `/comp` offers the pages that carry its words now. That
rule is in `CLAUDE.md` ("A dead link is a searchable one").

---

## 3. Accessibility: WCAG 2.2 AA and the WAI-ARIA Authoring Practices

This part was `docs/accessibility-standard.md` (adopted 8 July 2026). It
names the components and tokens we ship, because "follow WCAG" is not
something a person can act on.

### 3.1 Conformance target

- **WCAG 2.2 Level AA** for every page. Every A or AA criterion applies
  unless this part exempts it. Single AAA criteria where they are cheap
  (2.4.9, 1.4.6).
- **No regressions**: a change may not remove a keyboard path, a label or a
  landmark without a documented replacement.
- A criterion you cannot meet is a finding to raise in the pull request.
- `lang="en"` is set on every HTML entry point. Mark inline text in another
  language with `lang`.

### 3.2 Colour and contrast

WCAG 1.4.1, 1.4.3, 1.4.11.

- **Text is 4.5:1 or more** (3:1 at 24px, or 18.66px bold), in **both**
  themes. Check a new pairing in `:root` and in `.dark`.
- **Marks are 3:1 or more**: input borders, the focus ring, checkbox marks,
  chart lines.
- **Each accent is two tokens, a fill and a text colour. Never use the fill
  as text.** A colour light enough to fill a button is too light to read.

  | | Fill or mark | As text |
  |---|---|---|
  | Accent | `--primary` (label: `--primary-foreground`) | `--link` |
  | Red | `--destructive` | `--danger` |
  | Amber | `--warning` | `--caution` |
  | Green | `--success` | `--positive` |

- **A colour that carries text is a token in `react/globals.css`.** No
  Tailwind palette colour (`text-amber-500`), and no chart tone as text
  (`text-chart-2`).
- **Text dimmed by opacity is a new colour.** `text-foreground/60` fell under
  4.5:1 on every tab strip. Use `text-muted-foreground`.
- **A wash under coloured text must not change with what is behind it.** Mix
  the fill with the card:
  `color-mix(in srgb, var(--success) 20%, var(--card))`.
- **Never carry meaning in colour alone.** A status also has a shape, an
  icon or a label. Gain and loss need a `+` or `−` sign too.
- `src/react/accent-text.test.ts` holds all of this for both themes. It lists
  each exemption (inactive text, as WCAG 1.4.3 allows) with its reason. The
  3D replay has its own theme and is outside the test.

### 3.3 Text and zoom

WCAG 1.4.4, 1.4.10, 1.4.12.

- A layout survives **200% zoom** and a **320px-wide viewport** with **no
  sideways scrolling of the page**. Wide content scrolls inside its own
  container.
- **A tab strip fits its box where it can** (#804). Where it cannot (a
  panel dragged narrow, a long class name), it scrolls sideways with its
  scrollbar hidden, a fade at each end that still has tabs behind it, and
  the selected tab scrolled into view. Never centre it: centred overflow
  spills off both ends, and the first tab can no longer be reached.
- Use relative units for text and spacing. Never disable pinch-zoom.
- The comp page's print sections stay legible on paper: `#tasks` and
  `#activity` each start a fresh page. Scores are not a print target; the
  paper copy is the results record (`CLAUDE.md`).

### 3.4 Images, icons and media

WCAG 1.1.1, 1.2.x.

- Every `<img>` has an `alt`, empty for decoration.
- An icon-only control has an accessible name.
- A QR code is never the only path. Its URL is also on the page as a link.
- Media we host needs captions.

### 3.5 Keyboard

WCAG 2.1.1, 2.1.2.

- **Everything works from the keyboard.** Nothing traps focus except a modal,
  which releases on close (`rac/dialog.tsx`, `rac/confirm.tsx`).
- Escape, the ✕ or the dialog's own buttons close a dialog.
- **No click-only handlers.** Use `<button>`, `<a>` or the kit component, not
  a `div` with `onClick`. A custom widget needs the role, the `tabindex` and
  the keys of its APG pattern.
- **In a list or a tree of rows, the arrow keys move between rows and Tab
  moves through the links and buttons in a row.** The next Tab after the last
  one leaves the list. A reader never needs the Right arrow to reach a link
  they can see. `rac/grid-list.tsx` and `rac/tree.tsx` set this.
- On the map and the replay, pan, zoom, layer toggles and playback have
  keyboard equivalents.

### 3.6 Focus

WCAG 2.4.3, 2.4.7, 2.4.11.

- **Every focusable element shows a focus ring.** The kit's controls have
  one. Do not strip it, and never set `outline: none` without a replacement.
  A focus border is never translucent (`accent-text.test.ts`).
- **Focus is not hidden under the bar.** The bar is 60px and the safe-area
  inset, or about 120px with a second layer. Rows under it carry a
  `scroll-mt-*` at least that tall. A refused Save moves focus to the field,
  and the field comes to rest below the bar (`e2e/page-bar.spec.ts`). A
  toast must not cover the focused element either.
- **Focus order follows reading order.** A dialog takes focus when it opens
  and returns it to its trigger when it closes. A page gives focus to its
  `<h1>` ([2.7](#27-scroll-and-focus-follow-the-navigation)).

### 3.7 Landmarks, headings and titles

WCAG 1.3.1, 2.4.1, 2.4.2, 3.2.3.

- **Skip link**: "Skip to main content" is the first focusable element, in
  `Shell.tsx` and in `Base.astro`. Keep the two the same.
- **Landmarks**: one `<main>` and one `<footer>`. The bar is a `<header>`
  inside `<main>`, because it holds the `<h1>` that takes focus.
- **One `<h1>`, and it is the bar's title.** Headings are in order.
  `SectionHeader` is a real `<h2>`.
- **The trail** uses one label for one destination. A reader sees it as the
  tree in the title's menu. The bar also renders it as a visually hidden
  `<nav aria-label="Breadcrumb">` in the APG breadcrumb pattern, for
  assistive technology, crawlers and structured data. Its links are out of
  the Tab order, because a hidden link must not take focus.
- **Every ⋯ row that opens a page is also a link** in a hidden
  `<nav aria-label="Page actions">`.
- Each route sets a unique `<title>`. The active tab carries
  `aria-current="page"`.

### 3.8 Motion

WCAG 2.2.2, 2.3.1, 2.3.3.

- **Honour `prefers-reduced-motion`.** A blanket rule in `react/globals.css`
  covers the app, the content pages and the analysis page. `replay.css` has
  its own copy.
- A component whose meaning **is** its motion needs a designed reduced state.
  The indeterminate progress bar becomes a static striped fill, because a
  solid bar would read as "done".
- Motion driven by JavaScript must check the setting itself (`easeMs()` in
  `replay/terrain-backend.ts`).
- Nothing flashes more than three times a second. Anything that updates by
  itself can be dismissed and does not take focus.

### 3.9 Targets

WCAG 2.5.8, and the HIG's 44 points.

- **24×24 CSS px is the floor at every pointer.** The kit's smallest button
  is 28px.
- **44px in the page bar and its menus, at every pointer.**
- **44px on a coarse pointer** for the kit's own controls. Two ways to get
  there, both `(pointer: coarse)` only:
  - Where the control can grow, grow it with a `pointer-coarse:` size
    utility.
  - Where growing would move its neighbours (a small button in a dense row,
    a clear button, the ⓘ in a heading), use the `touch-target` utility in
    `react/globals.css`. It widens only where a finger may land.
- **A tap target is the whole area that does nothing beside it.** The
  waypoints list's locate pin is the row's whole left strip. Read-only, the
  whole row flies the map.
- **Measure a target in the e2e, not by its classes.** tailwind-merge does
  not resolve `size-*` against `h-*` and `w-*`, so a class check can pass
  over a 28px box.
- A chart's dots and lines are not sized as targets. The chart chooses the
  nearest mark ([3.13](#313-charts-maps-and-the-3d-scene)).

### 3.10 Forms and inputs

WCAG 1.3.5, 3.3.1, 3.3.2, 3.3.3.

- **Every input has a label tied to it in code** (`rac/field.tsx`). A
  placeholder is not a label.
- A required field, a format and a limit are stated in text.
- **An error names its field and says how to fix it.** Render it as
  `FieldError` and the kit wires `aria-invalid` and `aria-describedby`. What
  a refused save does is in [5.6](#56-forms).
- Use `autocomplete` tokens on identity and sign-in fields.

### 3.11 Predictable and clear

WCAG 2.4.4, 3.2.1, 3.2.2.

- **Nothing changes context on focus or on simple input.** A select does not
  navigate when its value changes.
- **A link or a button says where it goes or what it does**, out of context:
  "Download .xctsk", not "click here".
- No interactive role on the wrong element.

### 3.12 Name, role, value and status

WCAG 4.1.2, 4.1.3.

- **Prefer the kit**, and add what is missing to `rac/`. A hand-written
  widget exposes the same name, role, value and states.
- **A status message is announced without moving focus**: a toast, a save's
  result, a recompute notice. Use `aria-live="polite"`, or `role="alert"`
  for an error.
- The analysis page and the replay have no kit. Their controls in
  `analysis.css` set their ARIA attributes explicitly.

### 3.13 Charts, maps and the 3D scene

- **An interactive graphic has a text alternative** beside it: the numbers,
  the turnpoint list, a table.
- **A chart is a `role="img"` whose accessible name states its reading in a
  sentence, with the exact values in a table beside it.** Both are always
  rendered. The axis furniture (`charts/AxisTitle.tsx`) is `aria-hidden` but
  required: a sighted reader consults an axis continuously.
- **Labels are painted at 11px or more at every width.** An inline SVG scales
  its type with its width, so `text-[10px]` can be painted at 5.7px on a
  phone.
  - A new chart uses `charts/use-chart-box.ts`: one viewBox unit is one
    pixel, and labels are 13px.
  - A chart with a fixed viewBox uses `charts/use-chart-label-size.ts`.
  - A static SVG on a content page is drawn on a narrow viewBox with 13-unit
    labels and a capped width.
  - Measure labels as painted, in the e2e. A label with no room is moved, cut
    short or left out. It is never made smaller.
- **A mark is chosen by pointing near it, and no instruction says "hover"**
  (`charts/use-nearest-pointer.ts`). A tap chooses the nearest mark, however
  far. A mouse chooses within 32px. Choosing moves focus to the mark. The
  chosen mark is named in the line **above** the plot, because a hand covers
  what is below a finger.
- Chart colours meet 3:1 and can be told apart without colour.
- Map interactions follow
  [mapbox-interactions-spec.md](mapbox-interactions-spec.md).
- What a report-card chart may claim is in `CLAUDE.md`, under "The report
  card".

---

## 4. The Apple Human Interface Guidelines

For anything Parts 2, 3 and 5 do not decide, do what the HIG says for iOS.
Read the page itself, because Apple revises it. The pages below were read on
21 November 2026.

### 4.1 What we take as written

| HIG page | What it gives us here |
|---|---|
| [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) | 44×44 pt as the size of a control; spacing counts as much as size |
| [Typography](https://developer.apple.com/design/human-interface-guidelines/typography) | 11 pt as the smallest text anywhere |
| [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons) | One prominent button for the most likely action; never the prominent style on a destructive action |
| [Alerts](https://developer.apple.com/design/human-interface-guidelines/alerts) and [Action sheets](https://developer.apple.com/design/human-interface-guidelines/action-sheets) | Confirm only what is uncommon and cannot be undone; button titles are verbs, never "Yes" and "No"; "Cancel" is always called Cancel; the likely button is last; a destructive choice is drawn as one |
| [Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars) | Leading edge, centre and trailing edge always mean the same thing; a concise title; the standard back symbol with no "Back" text; one primary action, trailing |
| [Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets) | Cancel leading, the commit trailing. We apply this to a form's page |
| [Lists and tables](https://developer.apple.com/design/human-interface-guidelines/lists-and-tables) | Short text in rows; a row opens a detail view; reordering is a mode |
| [Entering data](https://developer.apple.com/design/human-interface-guidelines/entering-data) | Choices before text entry; prefill what we know; the commit is available only when the required data is there |
| [Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback) | Status sits near what it describes; say when a command cannot be carried out, and why |
| [Loading](https://developer.apple.com/design/human-interface-guidelines/loading) | Show something as soon as possible. The bar renders before the data |
| [Launching](https://developer.apple.com/design/human-interface-guidelines/launching) | Restore the previous state. Here that is the URL and the draft |
| [Menus](https://developer.apple.com/design/human-interface-guidelines/menus) and [Pull-down buttons](https://developer.apple.com/design/human-interface-guidelines/pull-down-buttons) | Group related rows; a destructive row is red and is confirmed |
| [Layout](https://developer.apple.com/design/human-interface-guidelines/layout), [Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode), [Motion](https://developer.apple.com/design/human-interface-guidelines/motion) | Safe areas; both themes; motion that can be reduced |

### 4.2 What the HIG has that the web does not

| HIG | Here |
|---|---|
| Points | CSS pixels |
| Dynamic Type | Browser zoom and relative units ([3.3](#33-text-and-zoom)) |
| SF Symbols | Lucide, the app's one icon set |
| Haptics | None |
| System gestures (swipe back, pull to refresh) | The browser's own. We add no gesture |
| VoiceOver from the system's controls | The kit, built to the APG |

---

## 5. Where we diverge, and what is ours

Each section says what the HIG does, what we do and why.

### 5.1 Mobile first, and one layout at every width

**HIG**: an iPad or Mac version may use a different layout.

**Here**: a phone is the shape a surface is designed **for**, not a width it
must survive. Where the two conflict, the phone wins. There is one layout, at
every width. (Owner's decision, 19 September 2026.)

Why: a competition is run from a hill. Two layouts are two code paths, and a
reviewer at a desk then sees something the author never tested on a phone.

- Worked example: `/comp/:id/waypoints` was an eight-column grid that
  scrolled sideways. It is a list whose rows each open a page
  (`comp/WaypointList.tsx`). The grid is gone, not hidden behind a
  breakpoint.
- **An organiser's view and a visitor's view are the same component.**
  `WaypointList` with no `onOpen` is the read-only mode. When a surface has
  two views, fixing one is half the job.
- **One way to do a thing.** A second way is a thing to keep working, to
  explain and to test.

### 5.2 Pages, not sheets

**HIG**: a sheet for a scoped task; a full-screen modal for a complex one.

**Here**: a page with a URL ([2.1](#21-a-screen-is-a-page)). A small dialog
is the only modal.

### 5.3 One bar, no tab bar

**HIG**: a tab bar at the bottom for top-level sections, and a toolbar for
the current view.

**Here**: one bar at the top of every page, `PageBar` in
`src/react/rac/page-bar.tsx`, and nothing at the bottom. The owner's
principle: **the page is for information, and every action goes in the
bar.** People learn to look in one place for what they can do. (Owner's
decision, 15 November 2026, #863.)

| Slot | Holds |
|---|---|
| **Left: the way out** | Back ([2.3](#23-leaving-a-page)). Cancel on a form. The main menu on a top-level page |
| **Centre: where you are** | The page's title, which is its `<h1>`, over a menu drawn as one tree: up to the pages above, across or down to the pages beside or under this one, and out to the top-level places |
| **Right: what you can do** | A form's commit button. Or ⋯ for the page's actions, with + and a status beside it |

- **The top-level places** (Competitions, My Flights, Submit track, Settings)
  are in the main menu and in every title menu.
- **The title is one line.** It may be cut short. The menu prints every level
  in full.
- **The menu is for the pages around this one, not for a search.** Where a
  page has many siblings (a pilot's report card has one for every pilot),
  the menu has one row that opens a page with a search field and the
  siblings as rows (`pages/TaskPilotsPage.tsx`, #870).
- **A page whose name is a sentence is an action.** The sentence is the ⋯ row
  that opens it. The page has a short `title` and the sentence as
  `fullTitle`.
- **The trail is where a page belongs, not where the reader came from.**
  Build it with the helpers in `src/react/lib/crumbs.ts`, never inline. A
  task's analysis belongs to the task. The comp analysis is a sibling link on
  it, not its parent.
- **A second layer may stick with the bar** (`below`): a search field, tabs
  or a class picker. Nothing else sticks. A class picker filters the whole
  page, so it goes there.
- **A mode changes the bar.** In Reorder the title names the mode and the
  right slot holds Done.
- **The content pages, the analysis page and the 3D replay have the same
  bar** in plain markup. Sign in, Onboarding and the OAuth consent page have
  none.
- On the analysis page the title and the ⋯ rows that open it name what it
  shows: "Climbs and glides" for one pilot's track, "All tracks" for a
  task's field. "Analysis" stays the task's and the comp's word.

### 5.4 Actions go in ⋯

**HIG**: "Try to include all actions in the toolbar if possible, and only add
this [More] menu if you really need it."

**Here**: a page's actions go in ⋯, so there is one place to look.

- Rows are grouped by rules. Rare rows go behind one row.
- "Submit your track" is the first row of ⋯ on the competition and task
  pages.
- Pass the bar only the actions this reader may use.
- **An action stays on the page only when its place says something**: "Add
  turnpoint" under the list, and the one destructive action at the foot of a
  form. `SectionHeader` carries an action on the same condition.
- **A page whose content is its actions keeps them on the page**, as rows
  with a line each (`rac/nav-list.tsx`), and its bar has no ⋯. One pilot on
  one task, for the organiser, is the example (`pages/TaskPilotPage.tsx`).
  (Owner's decision, 20 November 2026.)
- Every Submit-track entry point links to the one form on `/submit`, with
  `submitTrackPath()`. It never opens in a dialog.

### 5.5 Every ⋯ row has an icon

**HIG**: "Use menu item icons sparingly and with purpose", and within a group
give every item an icon or none.

**Here**: every ⋯ row carries a line icon from Lucide, and one icon means one
thing everywhere.

| Icon | Means |
|---|---|
| `MapIcon` | Opens tracks on a map, the 3D replay included |
| `ChartColumnIcon` | Task analysis and comp analysis, and nothing else |
| `ShareIcon`, `QrCodeIcon` | Sharing |
| `CloudUploadIcon` | Submit your track |
| `PlusIcon` | Make a new one |
| `CopyIcon` | Copy between competitions |
| `SettingsIcon` | Settings |
| `ImportIcon` | Bring a file in |
| `DownloadIcon` | Take a file out. Or the file's own kind where that is the point: `FileSpreadsheetIcon` for any CSV, `FileTextIcon` for the results record, `FileArchiveIcon`, `SheetIcon` |
| `MountainIcon` | Anything about altitudes |
| `MapPinPlusIcon`, `MapPinXIcon` | Start and stop placing on the map |
| `FlaskConicalIcon` | Test data |
| `RefreshCwIcon` | Recompute or rebuild |
| `Trash2Icon` | Clear |
| `Undo2Icon` | Discard changes |
| `RotateCcwIcon` | Reset to defaults |

- The table above is the part a reader needs. Every icon, with each row that
  carries it, is in `src/react/interaction-guide.test.ts`, which fails when an
  icon is put on a row it does not list. Ten more icons have one row each
  there (the route, weather notes, a manual flight, Quick entry, Reorder and
  others).
- A destructive row's icon is red with its label.
- A row with no icon keeps an empty slot, so the labels line up. A list of
  formats behind one row keeps empty slots, not one icon repeated.

### 5.6 Forms

**HIG**: Cancel and Done on a sheet; an alert for a problem.

**Here**: a form is a page. Its commit button is in the bar's right slot and
Cancel is on the left. A failed save is never a toast and never an alert.

**The commit button**

- **It is live only when there is something to commit**: a change, on a form
  that edits; the required fields, on a form that makes something new.
- Cancel asks before it throws a change away. A top-level form (Submit
  track) keeps the main menu on the left.
- The one destructive action for the thing being edited is at the foot of
  the form.
- Where the commit produces a result (Submit track, a new API key), the
  result appears on the page.
- On a page with no bar and in a dialog's footer, the primary button is
  last.

**Button wording**

| Word | Means |
|---|---|
| **Save** | Writes to the server. No other word does |
| **Create** | Makes something new: a competition, a task, a key |
| **Add** | Makes a new member of a list |
| **Done** | Only closes, or finishes one part of a draft that its page will save later. Always live. In the bar it is drawn as Save is |

There is no Done where Back does the same thing.

**A commit that sends, imports or fetches is named for that act**: Submit
(a track, to the organiser), Import (a CSV's rows), Fill (from the CIVL
rankings) and Load (a route from XContest). Nothing of the reader's own is
being saved there, or the act can fail in its own way, and Save or Done
would hide that. (Owner's decision, 24 November 2026.)
`interaction-guide.test.ts` lists the eight words and fails on a ninth.

**When a save does not work** (`rac/form.tsx` owns all of this)

- An error about a field goes **under that field**, which is focused and
  scrolled into view.
- An error about no field goes in the form's one banner, the first thing
  under the bar, focused the same way.
- One submit at a time. A dropped connection keeps what was typed.
- The server answers every refusal with `{ error, field }`.
- An action that is not a form's submit follows the same rules: `useAction`
  beside a control, `useFormAction` inside a form.

Why: every form did this by hand, and on an iPhone the reason for a failed
save was at the top of a body the reader had scrolled past.

**Choosing one of several**

- A value in a form the reader will Save is a **list in flow**
  (`rac/choice-list.tsx`, `rac/switch.tsx`). Nothing opens over what they
  were reading, and the whole 44px row is the target.
- A control that chooses what to **look at** stays a popover select. A
  filter drawn as a card of rows pushes what it filters off the screen.

### 5.7 Lists

**HIG**: lists, multicolumn tables, swipe actions and an edit mode.

**Here**: a list of rows that each open a page. No swipe actions, and no
editable grid.

- **A row's body is `RowContent`** in `rac/grid-list.tsx`, not something
  each list writes out.
- **A row that opens a page is a target across its whole width**, with a
  chevron. A row that opens nothing has no chevron.
- **There is no editable grid.** An editable collection is a list of rows
  that each open a page: pilots, waypoints, a task's pilots. Work shaped
  like a spreadsheet goes to a real spreadsheet through CSV export and
  import, so that round trip must lose nothing (the export's `glidecomp_id`
  column). Do not bring a grid back for the desktop alone: that is two
  editors.
- **A list of readings is a card for each row** (`rac/reading-list.tsx`,
  owner's decision 19 November 2026). Where every row has a name, a figure
  and a mark on a shared axis (`rac/meter.tsx`), each row is its own card
  with its name in bold. Rows divided by a hairline left a scrolling reader
  unsure which name a track belonged to. One mark a row, and counts as
  words. The heading and the axis sit above the cards. Where a row has more
  to say than fits, it opens a page.
- **A row of one line keeps a hairline** in its section's card
  (`analysis/PerPilotMetricList.tsx`).
- **A table of more than three columns is a list of records**
  (`analysis/ReportTableView.tsx`): a box a row, its first cell as its name.
- The comparison table on `/scoring/gap` stays a table. That page is a
  document, not an interface. (Owner's decision, 20 November 2026.)

### 5.8 Waiting

**HIG**: show that content is loading.

**Here**: the same, with one component for each kind of wait
(`rac/progress.tsx`).

| The wait | Use |
|---|---|
| A section of a page is fetching | `<Loading>`: a `role="status"` region with a sentence |
| An action is in flight | `<Button isPending pendingLabel="Saving">`. Never `isDisabled` with a changed label: that drops focus mid-action |
| A known background job is running | `<ProgressBar isIndeterminate>` |

### 5.9 Units

**HIG**: nothing specific.

**Here**: three rules. Code comments call the first one the altitude rule.

- **An altitude a reader types is in the reader's own unit, and the label
  says which** (#662). Every altitude the app prints honours the unit
  preference, so an input fixed to metres disagreed with the list beside it.
  Use `AltitudeField` in `src/react/comp/fields.tsx`. Metres remain what is
  stored, exported and scored.
- **A cylinder radius is always metric**, read and typed. The FAI, the
  `.xctsk` and the briefing all state it in metres. Print one with
  `formatCylinderRadius()`.
- **The waypoints editor is metric throughout**, because it is the waypoint
  file edited in place, and its labels say so. A read-only waypoint row
  honours the preference.

What a zero altitude means, and the one action that checks altitudes, are in
[waypoint-altitudes.md](waypoint-altitudes.md).

---

## 6. Who owns each pattern

A pattern is safe when one place in the code owns it or a test holds it.
"None" means it depends on each page remembering. Close those first.

| Pattern | Owner | Test |
|---|---|---|
| A screen is a page ([2.1](#21-a-screen-is-a-page)) | The router | `src/react/no-overlays.test.ts` |
| Back is never caught ([2.2](#22-back-is-the-browsers)) | `rac/dialog.tsx`, `lib/use-unsaved-changes-guard.ts` | `no-overlays.test.ts`, `use-unsaved-changes-guard.test.ts`, `e2e/comp-settings-pages.spec.ts` |
| The bar's back is the browser's Back ([2.3](#23-leaving-a-page)) | `useLeave()` and `useBackLabel()` in `lib/leave.ts` | `lib/leave.test.ts`, `e2e/comp-analysis.spec.ts`, `e2e/page-bar.spec.ts` |
| A save leaves by Back ([2.3](#23-leaving-a-page)) | `useLeave()`, called by each page | `e2e/comp-creation.spec.ts`, `e2e/task-settings-pages.spec.ts`. No test finds a page that forgets |
| A delete and a create replace ([2.3](#23-leaving-a-page)) | Each page | `e2e/task-new-page.spec.ts` for create, `e2e/page-bar.spec.ts` for delete. No test finds a new delete that forgets |
| The view is in the URL ([2.4](#24-the-url-holds-the-view)) | Each page | `e2e/comp-detail.spec.ts` for the scores views. None in general |
| Drafts ([2.5](#25-reload-a-shared-link-and-drafts)) | `lib/draft-store.ts`, `lib/draft-editor.ts` | `lib/draft-store.test.ts`, `e2e/comp-waypoints.spec.ts` |
| Links in the markup ([2.6](#26-links-are-links)) | `rac/page-bar.tsx` | `e2e/page-bar.spec.ts`, `bun run test:e2e:ssr` |
| Scroll on Back ([2.7](#27-scroll-and-focus-follow-the-navigation)) | `lib/scroll-restoration.ts` | `lib/scroll-restoration.test.ts`, `e2e/task-thermal-map.spec.ts` |
| Focus on arrival ([2.7](#27-scroll-and-focus-follow-the-navigation)) | `lib/route-focus.ts` | `e2e/page-bar.spec.ts` |
| Nothing fixed to an edge ([2.8](#28-the-keyboard-and-the-screens-edges)) | `rac/page-bar.tsx` | `e2e/page-bar.spec.ts` |
| Colour as text ([3.2](#32-colour-and-contrast)) | The tokens in `react/globals.css` | `src/react/accent-text.test.ts` |
| No sideways scroll ([3.3](#33-text-and-zoom)) | Each page | The `mobile` Playwright project, for the pages in `e2e/fixtures/mobile.ts` |
| A tab strip that does not fit ([3.3](#33-text-and-zoom)) | `rac/tabs.tsx`; on the analysis page, `analysis/tab-overflow.ts` | `e2e/analysis-bar.spec.ts` for the analysis page. None for the kit's fades |
| 44px in the bar ([3.9](#39-targets)) | `rac/page-bar.tsx` | `e2e/page-bar.spec.ts`, `e2e/replay-bar.spec.ts`, `e2e/analysis-bar.spec.ts` |
| 44px in the kit on a coarse pointer ([3.9](#39-targets)) | The kit components | Partly: the specs that measure a target. No test finds a new control that is too small |
| Chart labels at 11px ([3.13](#313-charts-maps-and-the-3d-scene)) | `charts/use-chart-box.ts`, `charts/use-chart-label-size.ts` | `e2e/analysis-charts.spec.ts`, `e2e/task-weather-charts.spec.ts`, `e2e/data-cleaning-charts.spec.ts` |
| A mark is chosen by pointing near it ([3.13](#313-charts-maps-and-the-3d-scene)) | `charts/use-nearest-pointer.ts` | `e2e/analysis-charts.spec.ts` |
| One bar, three slots ([5.3](#53-one-bar-no-tab-bar)) | `rac/page-bar.tsx`, `SiteHeader.astro` | `e2e/page-bar.spec.ts` |
| The trail ([5.3](#53-one-bar-no-tab-bar)) | `lib/crumbs.ts` | `src/react/interaction-guide.test.ts`: no page starts a trail by hand |
| Actions in ⋯ ([5.4](#54-actions-go-in-)) | `rac/page-bar.tsx` | `src/react/interaction-guide.test.ts`, for the files in `pages/`: it records every button a page draws for itself. A component under `comp/` is found only in review |
| One icon, one meaning ([5.5](#55-every--row-has-an-icon)) | The table of icons, labels and meanings in `src/react/interaction-guide.test.ts` | `src/react/interaction-guide.test.ts` |
| The commit button and its words ([5.6](#56-forms)) | `components/SettingsForm.tsx` | `e2e/comp-settings-pages.spec.ts` for "live only when changed". `src/react/interaction-guide.test.ts` for the words |
| A refused save ([5.6](#56-forms)) | `rac/form.tsx` | `rac/form.test.ts`, `e2e/forms.spec.ts` |
| One kit ([3.12](#312-name-role-value-and-status)) | `src/react/rac/` | `src/react/one-kit.test.ts` |
| A row's body ([5.7](#57-lists)) | `RowContent` in `rac/grid-list.tsx` | `src/react/interaction-guide.test.ts` |
| Tab reaches a row's controls ([3.5](#35-keyboard)) | `rac/grid-list.tsx`, `rac/tree.tsx` | `e2e/user-files-upload.spec.ts` for the tree |
| No editable grid ([5.7](#57-lists)) | No component exists to build one, and no grid library is installed | `src/react/interaction-guide.test.ts`: no grid library is installed or imported |
| Waiting ([5.8](#58-waiting)) | `rac/progress.tsx` | `rac/progress.test.ts` |
| Typed altitudes ([5.9](#59-units)) | `AltitudeField` in `comp/fields.tsx` | `lib/units.test.ts` |

---

## 7. Checklist for a pull request

Copy this into any pull request that touches the interface. A box you cannot
tick is a finding to raise, not a box to skip.

```
Interaction (docs/interaction-guide.md)
- [ ] Platform: a new screen is a page with a URL; a reload and a shared link show it
- [ ] Back: nothing catches it; the page leaves through useLeave(); a save leaves, a delete and a create replace
- [ ] URL: what the reader chose to look at is in it
- [ ] Bar: the page's actions are in ⋯ with an icon from the table; the commit button is in the right slot and says Save, Create, Add or Done (or Submit, Import, Fill, Load for those acts)
- [ ] Forms: built on rac/form.tsx; a refusal lands under its field or in the banner, never in a toast
- [ ] Phone: designed at phone width first; no sideways scroll; one layout at every width
- [ ] Keyboard: every new control is reachable and operable; no focus trap; focus returns when a dialog closes
- [ ] Focus: a visible ring on every focusable element; nothing focused sits under the bar
- [ ] Contrast: text 4.5:1 and marks 3:1, in BOTH themes; colour as text is a token
- [ ] Not colour alone: a status also has text, an icon or a shape
- [ ] Names: every input has a label; every icon button has an accessible name
- [ ] Semantics: the kit component or the right element; one h1; headings in order
- [ ] Status: errors are tied to their fields; a status change is in a live region; a wait says so
- [ ] Zoom: works at 200% and at 320px wide
- [ ] Motion: reduced motion is honoured
- [ ] Targets: 24px or more, 44px on a coarse pointer and in the bar, measured, not read from classes
- [ ] Images: alt text, empty for decoration
- [ ] Charts and maps: the reading is also text or a table; labels painted at 11px or more; nothing says "hover"
```

---

## 8. How to test

Automated checks find about a third of the problems. Do the manual passes
too.

1. **On a phone, or the `mobile` Playwright project.**
   `bunx playwright test --project=mobile` runs the specs in
   `e2e/fixtures/mobile.ts`. It proves those journeys work on a phone. It
   does not check this guide.
2. **Back and reload.** Open the page from inside the app. Press the
   browser's Back, then the bar's back: they go to the same place. Reload.
   Open the URL in a new tab.
3. **Keyboard only.** Tab through the whole flow. Is focus always visible?
4. **Zoom.** 200%, then 320px wide. Nothing is clipped.
5. **Screen reader.** VoiceOver or NVDA. Walk the landmarks and headings, and
   confirm that status changes are announced.
6. **Contrast.** The browser's contrast checker on new pairings, in both
   themes.
7. **axe or Lighthouse, by hand**, on the changed pages. There is no
   automated accessibility check yet ([9](#9-known-gaps)). A clean axe run
   is necessary and not sufficient.

---

## 9. Known gaps

Places where the code does not meet this guide today. New work must not add
to the list.

1. **Keyboard parity and text alternatives on the map and the replay**
   ([3.5](#35-keyboard), [3.13](#313-charts-maps-and-the-3d-scene)). Nobody
   has confirmed that every pan, zoom, layer and playback control has a
   keyboard equivalent, or that the scene's essential content is available
   as text.
2. **Live regions are partial** ([3.12](#312-name-role-value-and-status)).
   The sentence on the Submit-track form that names the pilot found in the
   IGC file appears silently. Confirm that `sonner` announces its toasts.
3. **No automated accessibility check runs.** Closing this means
   `@axe-core/playwright` and a spec that sweeps one route for each surface.
4. **Patterns a test holds only in part.** Part 6 says where: a save or a
   delete on a new page that forgets how to leave, a view that is not in the
   URL, a new kit control under 44px, the kit tab strip's fades, and a button
   drawn by a component outside `pages/`.
