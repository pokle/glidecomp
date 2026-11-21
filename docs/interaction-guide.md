# Interaction guide

Status: adopted 21 November 2026. This is the one document that says how
GlideComp's interface behaves, and why.

Read it before you design or change anything a person sees or touches. If a
change conflicts with it, change the code or amend this guide in the same pull
request, with the reason. Do not diverge silently.

It replaced the interaction rules that were in `CLAUDE.md`, the accessibility
standard (`docs/accessibility-standard.md`, folded in as Part 3) and the
"design language" sections of the information architecture document. Those
rules were written one incident at a time, in three places, and they drifted
apart. The bug that caused this guide (#901) was a rule about the back control
that every link had to remember. About half the links forgot it.

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
sources, in this order, and we write down only how they apply here and where
we chose differently.

| | Source | What it decides |
|---|---|---|
| 1 | **The web platform**: what a browser does with pages, links and forms | Navigation, Back, reload, URLs, the keyboard, scrolling, focus |
| 2 | **[WCAG 2.2](https://www.w3.org/TR/WCAG22/) Level AA** and the **[WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)** (APG) | What every reader must be able to perceive and operate, and how each control behaves with a keyboard and a screen reader |
| 3 | **The [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines)** (HIG) | Everything else: layout on a phone, lists, buttons, confirmations, feedback, wording of controls |
| 4 | **Our divergences** (Part 5) | Where we chose differently from the HIG, and the patterns the HIG does not have because it is written for native apps |

How to answer a question about behaviour:

1. Does the browser already do it? Then that is the answer. We never imitate
   the browser and never contradict it.
2. Does WCAG or the APG say how? Then do that. Nothing below overrides it.
3. Is it in Part 5? Then Part 5 is the answer, because it is a decision the
   owner made with the HIG in view.
4. If not, do what the HIG says for iOS.

Part 5 can override the HIG. It cannot override the platform or WCAG. If a
decision in Part 5 conflicts with Part 2 or Part 3, the decision is wrong.

### 1.1 Why this order

- **The platform is first** because the app is a website. A competition is
  shared as a link, opened in a browser and left with the browser's Back. The
  HIG says nothing about URLs, reload or shared links.
- **WCAG and the APG are second** because they are testable and they are the
  web's own. On iOS a standard control gets its VoiceOver and keyboard
  behaviour from the system. On the web we must build it, and these two say
  what to build.
- **The HIG is third** because the people who run a competition do it from a
  hill, on a phone. Their expectations of a list, a back control and a
  confirmation come from their phone's own apps, and the HIG is the most
  complete written account of those. The mobile review in #860 already
  measured the app against it.

### 1.2 The rules of this guide

- **One document.** A rule about how the interface behaves goes here and
  nowhere else. `CLAUDE.md` points here. A feature's own document (track
  submission, waypoint altitudes, drafts) describes that feature and cites a
  pattern from here. It does not state the pattern again.
- **A pattern has an owner or a test.** A rule that every page must remember
  will be forgotten. Each pattern is therefore owned by one component or hook
  that every page uses, or held by a test that fails when a page departs from
  it. Part 6 lists them. A pattern with neither is a risk, and Part 6 says so.
- **State the principle before the mechanism.** "The bar's back and the
  browser's Back never disagree" is a principle. "The opener marks the entry
  it pushed" was a mechanism, and it hid the principle for three weeks.
- **An owner's decision carries its date.** A dated decision can be changed
  only by the owner.
- **Wording is proposed before it is changed.** That rule is in `CLAUDE.md`
  ("Propose UI wording before you change it"), because it is about how we
  work.

### 1.3 The four surfaces

GlideComp draws its interface four ways. This guide applies to all four.

| Surface | Where | Built with | Notes |
|---|---|---|---|
| **Main app** | `web/frontend/src/react/`, served from `src/app.html` | React and the react-aria-components kit in `src/react/rac/` | Use the kit. Its components carry the ARIA and the keyboard behaviour. |
| **Content pages** | `web/frontend/static/` (Astro, prerendered) | Semantic HTML and hand-written vanilla JavaScript | Anything interactive here carries its own ARIA and key handling. Write it to the APG pattern and test it with the keyboard. |
| **Analysis page** | `/analysis.html` (vanilla TypeScript) | `analysis.css` | The map canvas follows [3.13](#313-charts-maps-and-the-3d-scene). |
| **3D replay** | `/replay` (vanilla TypeScript and WebGL) | `replay.css` and an inline theme | The scene follows [3.13](#313-charts-maps-and-the-3d-scene). |

### 1.4 Documents that stay separate

These describe one surface or one mechanism. They follow this guide and do
not restate it.

| Document | What it holds |
|---|---|
| [mapbox-interactions-spec.md](mapbox-interactions-spec.md) | What the map draws and how it answers the pointer and the keyboard. The one specification for every map provider. |
| [3d-flight-replay-notes.md](3d-flight-replay-notes.md) | The 3D replay's controls and camera. |
| [2026-07-18-rac-adoption-guide.md](2026-07-18-rac-adoption-guide.md) | How to build with the kit: the components, their props and the gotchas. |
| [drafts.md](drafts.md) | How unsaved work is stored so that a reload or Back finds it. |
| [ssr.md](ssr.md) | Which pages are server-rendered and how. |

---

## 2. The web platform

The browser is the most tested software a reader has. Each rule here says the
same thing: let the browser do it.

### 2.1 A screen is a page

**Anything that takes over the screen is a page with its own URL.** An editor,
a review, a picker with fields and a figure at full size are all pages. The
reader reaches one by a link and leaves it with Back. (Owner's decision,
2 November 2026.) Code comments call this the overlays rule, or "No
full-screen overlays".

Why: a full-screen sheet is a fixed layer over a scrolled page. On an iPhone,
after the keyboard had come and gone, Safari drew the pilot sheet in one place
and hit-tested it in another. Taps on Name fell through to the page behind,
and nothing reported an error. Everything that made sheets usable (a scroll
lock, a history entry for each open sheet, a scroll reset, a bottom bar lifted
over the keyboard by hand) imitated something a page does by itself, and each
part grew its own iOS bug.

- **Small overlays are fine**: a confirmation, a menu, a combo box's list, a
  date picker. Nothing that fills the screen. Nothing with text fields that
  bring up the keyboard.
- **A page fetches what it needs.** State goes in the URL or is fetched by the
  page. It is never handed over in memory from the page underneath, because a
  reload or a shared link does not have that memory.
- The worked example is the pilot editor: `/comp/:id/pilots/:pilotId` and
  `/pilots/new` (`pages/CompPilotPage.tsx`).
- `src/react/no-overlays.test.ts` fails if a full-screen overlay comes back.

### 2.2 Back is the browser's

**Back always navigates, and nothing catches it.** No code holds a history
entry in order to intercept Back. That is true with unsaved edits and with a
dialog open.

- An editor that has a draft loses nothing to Back. Back means "not now", and
  the draft is there on return ([2.5](#25-reload-a-shared-link-and-drafts)).
- A page with no draft (the settings pages, the pilot page) leaves the edits
  behind, as any web form does.
- A small dialog holds no entry. Back navigates, and the dialog closes with
  the page it was over (`rac/dialog.tsx`).
- The unsaved-changes guard (`lib/use-unsaved-changes-guard.ts`) asks before
  a reload, a tab close or a link inside the app. It never asks on Back.
- Only the router pushes or walks history. `no-overlays.test.ts` fails on
  code that does it by hand.

### 2.3 Leaving a page

**The bar's back control and the browser's Back never disagree.** (Owner's
decision, 21 November 2026.)

The page asks the history where the reader came from. No link marks anything.
One hook owns this, `useLeave()` in `lib/leave.ts`, and it is the only
`navigate(-1)` in a page.

| The reader | Came from a page of this app | Arrived directly (shared link, bookmark, the installed app's first screen) |
|---|---|---|
| Presses the bar's back | A real Back | To the page above, by a replace |
| Presses Cancel on a form | A real Back | To the page above, by a replace |
| Saves, and the page closes itself | A real Back | To the page above, by a replace |

On a direct arrival a real Back would leave the site, so the control goes up
instead. The replace keeps the page they left out of the history.

- **The control is named for where it goes**: "Back to Comp analysis" for the
  page behind, or "Back to <the page above>" on a direct arrival. The name is
  kept for the history entry, so it is the same after a reload.
- **A delete replaces.** After a task or a competition is deleted, the app
  goes to the page above by a replace. The page the reader was on no longer
  exists.
- **A create goes to the thing it made**, by a replace, so Back from there
  does not return to an empty form.
- **The last step of a page with steps goes to the list, by a replace.** "Copy
  pilots from another competition" has a choice and then a review, at one
  path. A Back from the review goes to the choice, so finishing the review
  cannot be a Back.
- **Every page that is not top-level has a back control.** The installed app
  has no browser Back, so the bar's is the only one.
- **In the markup the back control is a link to the page above**, so it works
  without JavaScript.

Until #901 the opener had to mark the history entry it pushed. About sixteen
links did and the rest did not. From Comp analysis into a task's analysis, the
bar went up to the task page and the browser went back to Comp analysis.

### 2.4 The URL holds the view

**What a reader chose to look at is in the URL.** A search, a sort order, a
chosen class and an open tab are query parameters. Back then returns a list
exactly as it was left, and a shared link shows the same view.

- The pilots list keeps `?q=` and `?sort=`.
- A view control writes the URL with a replace, so changing a filter five
  times does not put five entries in the history.
- A public URL is `${slug}-${id}`. Build every link with the path helpers in
  `lib/slug.ts`, so that a hidden competition's share key stays in the link.
- A page corrects its own address to the canonical slug when its data loads
  (`lib/use-canonical-path.ts`), by a replace.

### 2.5 Reload, a shared link and drafts

**A reload shows the same page.** So does a link sent to another person who
may open that page.

Work that is not saved yet, and that another page, a reload or Back must find
again, is a **draft** (`lib/draft-store.ts`). A draft lives in this tab's
session storage. It is keyed by what it edits, owned by the signed-in user,
versioned, and always allowed to come back empty. [drafts.md](drafts.md) has
the design.

- A draft edited over several pages (a route, a waypoint file) is one stored
  draft that every page reads and writes. Both editors are built on
  `useDraftEditor()` (`lib/draft-editor.ts`).
- Save is on the draft's list page and is live only while the draft differs
  from what is stored. "Discard changes" is in ⋯ and is shown only while
  there are changes.

### 2.6 Links are links

**Anything that opens a page is an `<a href>`.** A reader can open it in a new
tab, copy it and follow it without JavaScript.

- A closed menu puts no link in the markup. The bar therefore renders its
  trail and every ⋯ row that opens a page as real links in two visually hidden
  navs ([3.7](#37-landmarks-headings-and-titles)). The server-rendered pages
  and a crawler depend on them.
- The public competition pages are server-rendered and read without
  JavaScript. The content pages carry every word and image in the prerendered
  HTML.
- A list row that opens a page is a link across its whole width
  ([5.7](#57-lists)).

### 2.7 Scroll and focus follow the navigation

The browser restores scroll on Back and moves focus on a document load. A
single-page app must give both back.

- **Scroll**: Back returns a page to where it was left
  (`lib/scroll-restoration.ts`).
- **Focus**: arriving on a page focuses its `<h1>`, unless the page focused
  something itself. Back returns focus to the control the reader left from
  (`lib/route-focus.ts`, in the Shell). A dialog does this for its trigger. A
  page does not do it by itself.

### 2.8 The keyboard and the screen's edges

**Nothing is fixed to an edge of the screen.** A fixed bar must be moved
around the on-screen keyboard by hand. On an iPhone the pilots page's bottom
bar once stopped halfway up the screen while doing that.

- The page bar is `sticky` at the top of the page's flow, never `fixed`. A
  bar at the top is never under the keyboard.
- When the keyboard opens, an iPhone pans the screen, and that took the
  sticky bar off the top with Save in it. The bar follows the pan with one
  transform (`useKeepOnScreen` in `rac/page-bar.tsx`). That is the only place
  the app positions anything from script. Do not add a second.
- **Nothing sticks to the bottom.** The route editor, the waypoints page and
  the altitude review each had a bottom bar until #863.
- The app runs edge to edge (`viewport-fit=cover`). A surface that touches an
  edge keeps its content clear of the notch and the home indicator with the
  `pt-safe`, `pb-safe` and `px-gutter-safe` utilities in
  `react/globals.css`.
- Pinch-zoom is never disabled ([3.3](#33-text-and-zoom)).

### 2.9 The pointer

- **Nothing needs a hover.** A phone has none. No instruction says "hover"
  ([3.13](#313-charts-maps-and-the-3d-scene)).
- **A coarse pointer and a fine pointer get different sizes**, through
  `(pointer: coarse)`, never through the screen's width
  ([3.9](#39-targets)).
- **A drag is never the only way to do a thing.** HTML drag never fires on touch
  without a long press. Reordering a route is a mode with Move up and Move
  down on each row (`comp/TurnpointList.tsx`).

### 2.10 A page the reader may not use

**An organiser's page sends anyone else on** to the public page it belongs to,
signed in or not, with a line that says why. Signed out, the line also offers
sign-in. It is never a page that only says the reader cannot be there
(`components/OrganisersOnly.tsx`, owner's decision 3 November 2026).

A dead link under `/comp` offers the pages that carry its words now. That rule
is in `CLAUDE.md` ("A dead link is a searchable one"), with the lookup
endpoint it depends on.

---

## 3. Accessibility: WCAG 2.2 AA and the WAI-ARIA Authoring Practices

This part was `docs/accessibility-standard.md` (adopted 8 July 2026). It is
specific to this codebase on purpose: "follow WCAG" is not something a person
can act on, so the rules name the components and tokens we ship.

### 3.1 Conformance target

- **Baseline: WCAG 2.2 Level AA** for every page. Every A or AA success
  criterion applies unless this part exempts it.
- **AAA where it is cheap**: single criteria such as 2.4.9 (link purpose) and
  1.4.6 (enhanced contrast on primary text). We do not target full AAA.
- **No regressions**: a change may not remove an accessible affordance that
  exists today (a keyboard path, a label, a landmark) without a documented
  replacement.
- A criterion you cannot meet is a finding to raise in the pull request. It
  is not a default to accept.
- `lang="en"` is set on `src/app.html` and `static/src/layouts/Base.astro`.
  Keep it on any new HTML entry point, and mark inline text in another
  language with `lang`.

### 3.2 Colour and contrast

WCAG 1.4.1, 1.4.3, 1.4.11.

- **Text contrast is 4.5:1 or more** (3:1 for text of 24px or more, or
  18.66px bold), in **both** the light and the dark theme. The colour tokens
  are in `web/frontend/src/react/globals.css` and the content pages reuse
  them. When you add or change a pairing, check the ratio in `:root` and in
  `.dark`.
- **The accent is two colours: a fill and a text colour.** `--primary` is the
  fill and `--primary-foreground` is its label. `--link` is the accent as
  text: a link, a chip's label, a tick. Do not use the fill as text. A blue
  light enough to fill a button is too light to read on a light surface, and
  on dark it is the other way round. When the accent was one colour (until
  November 2026), every primary button's label was at 4.02:1 in light and
  3.65:1 in dark. `src/react/accent-text.test.ts` holds the ratios for both
  themes and fails on `text-primary`.
- **Red is two colours too.** `--destructive` is the fill and the mark: an
  invalid field's border and ring, the wash behind a destructive button.
  `--danger` is red as text: a field's error, an alert, the label of a
  destructive button. A mark needs 3:1 and the fill has it. A letter needs
  4.5:1 and the fill does not. The same test fails on `text-destructive` and
  on a wash stronger than the ones it has measured.
- **Amber and green are pairs as well.** `--warning` and `--success` are the
  fills. `--caution` and `--positive` are the text. Until November 2026 the
  app wrote Tailwind's palette into its classes and nothing measured it:
  `text-amber-500` was 2.13:1 on a card and was every warning.
- **A colour that carries text is a token in `globals.css`.** Do not write a
  Tailwind palette colour (`text-amber-500`, `bg-green-500/20`) in the app,
  the analysis page or the content pages. Do not use a chart tone as text
  (`text-chart-2`): a chart's line is a mark and its label is text. The test
  fails on both. The 3D replay has its own theme and is outside this rule.
- **Text dimmed by opacity is a new colour, so measure it.** A token that
  holds 4.5:1 at full strength can lose it at `/60`. Use
  `text-muted-foreground` for quieter text. The test measures every
  `text-<token>/NN` on every surface in both themes. Text that marks
  something inactive (a day outside the month in a calendar) is exempt, as
  WCAG 1.4.3 allows, and the test lists each case with its reason.
- **A wash under coloured text must not change with what is behind it.** The
  analysis page's rank bubbles were a translucent wash on an item that turns
  grey when hovered and blue when selected, so a rank fell to 2.13:1 on a
  selected item. A bubble is now its fill mixed with the card
  (`color-mix(in srgb, var(--success) 20%, var(--card))`).
- **Non-text contrast is 3:1 or more** for boundaries and states that carry
  meaning: input borders, the focus ring (`--ring`), checkbox and radio
  marks, and chart and track lines and legends.
- **Never carry meaning in colour alone.** A task status, a pilot status, a
  field's state and a score change also have a shape, an icon, a label or a
  pattern. Red and green for gain and loss need a `+` or `−` sign or an arrow
  too.
- Respect the reader's theme. Do not hard-code a colour that breaks in dark
  mode, the replay's inline theme included.

### 3.3 Text and zoom

WCAG 1.4.4, 1.4.10, 1.4.12.

- A layout must survive **200% zoom** and a **320px-wide viewport** with no
  loss of content or function and **no sideways scrolling of the page**. Wide
  content scrolls inside its own container.
- Use relative units (`rem`, `em`, `%`, `ch`) for text and spacing that
  should scale. Never disable pinch-zoom (no `maximum-scale` or
  `user-scalable=no` in a viewport meta).
- The comp page's print sections stay legible on paper, because briefings
  depend on them. `#tasks` and `#activity` (`CompDetail.tsx`) each start a
  fresh page with `break-before-page`. `#admins` deliberately does not.
- **Scores are not a print target.** The paper copy of a competition's scores
  is the results record ([results-record.md](results-record.md)). That rule
  is in `CLAUDE.md`.

### 3.4 Images, icons and media

WCAG 1.1.1, 1.2.x.

- Every `<img>` has an `alt`. A decorative image has `alt=""` or is a CSS
  background. The hills background is decorative.
- An icon-only control has an accessible name, from `aria-label` or visually
  hidden text.
- A QR code is never the only path. The URL it encodes is also on the page as
  a link.
- Third-party video (YouTube) is the provider's. Media we host needs captions
  (1.2.2).

### 3.5 Keyboard

WCAG 2.1.1, 2.1.2.

- **Everything works from the keyboard.** Every control is reachable and
  operable with Tab, Shift-Tab, Enter, Space and the arrow keys. Nothing
  traps focus except a modal, which traps on purpose and releases on close.
  `rac/dialog.tsx` and `rac/confirm.tsx` do this. Use them.
- Escape, the ✕ or the dialog's own buttons close a dialog. Back navigates
  ([2.2](#22-back-is-the-browsers)).
- **No click-only handlers.** Do not attach behaviour to a `div` or `span`.
  Use `<button>`, `<a>` or the kit component. A custom widget needs a `role`,
  a `tabindex` and key handlers that match its APG pattern.
- On the map and the replay, pan, zoom, layer toggles and playback have
  keyboard equivalents. A control that only drags fails this.

### 3.6 Focus

WCAG 2.4.3, 2.4.7, 2.4.11, 2.4.13.

- **Every focusable element shows a focus ring.** The kit's buttons and
  fields have one (`data-focus-visible:ring-3 data-focus-visible:ring-ring/50`
  on `rac/button.tsx`, `data-focused:ring-3` on `rac/field.tsx`). Do not
  strip it. A custom focusable element gets an equally visible ring in
  `--ring`.
- A destructive button's ring is red: a border of `--destructive` at full
  strength with a 50% halo. Do not make a focus border translucent.
  `accent-text.test.ts` fails on it.
- Never set `outline: none` without a replacement.
- **Focus is not hidden under the bar.** The page bar is 60px and the
  safe-area inset, or about 120px where a search field or tabs stick with it.
  Rows under the bar carry a `scroll-mt-*` at least that tall
  (`comp/PilotList.tsx`). A refused Save moves focus to the field, and the
  field must come to rest below the bar (`e2e/page-bar.spec.ts`). Toasts must
  not cover the focused element.
- **Focus order follows reading order.** When a dialog opens, focus moves
  into it. When it closes, focus returns to its trigger. When a page opens,
  focus goes to its `<h1>` ([2.7](#27-scroll-and-focus-follow-the-navigation)).

### 3.7 Landmarks, headings and titles

WCAG 1.3.1, 2.4.1, 2.4.2, 3.2.3.

- **Skip link**: every page with the bar has "Skip to main content" as its
  first focusable element. It is in `Shell.tsx` for the app and `Base.astro`
  for the content pages. Each is hidden until focused and points at
  `#main-content`, which has `tabindex="-1"`. Keep the two the same, and give
  any new page shell the link.
- **Landmarks**: one `<main>` and one `<footer>` on a page. In the app the
  bar is a `<header>` inside `<main>`, because it holds the `<h1>` that takes
  focus on arrival.
- **One `<h1>` on a page, and it is the bar's title.** Headings are in order
  and none is skipped. A `SectionHeader` title is a real `<h2>`.
- **The trail** uses one label for one destination everywhere. The trail a
  reader sees is the tree in the title's menu. The bar also renders a
  visually hidden `<nav aria-label="Breadcrumb">` with an ordered list, in the
  APG breadcrumb pattern: links to the pages above, then the current page as
  plain text with `aria-current="page"`. Assistive technology, crawlers and
  the `BreadcrumbList` structured data use it. Its links are out of the Tab
  order, because a hidden link must not take focus where nobody can see it.
  The title's menu is the keyboard's way to them.
- **Every action that opens a page is a link in the markup**, in a visually
  hidden `<nav aria-label="Page actions">`.
- **Each route sets a unique, descriptive `<title>`.**
- The analysis page and the 3D replay have the same bar in plain markup: a
  visually hidden `<h1>` and breadcrumb nav, and the bar's menus as native
  `<details>`.
- The active tab carries `aria-current="page"` as well as its underline.

### 3.8 Motion

WCAG 2.2.2, 2.3.1, 2.3.3.

- **Honour `prefers-reduced-motion`.** A blanket rule in `react/globals.css`
  brings animation, transition and smooth scrolling to near zero. The content
  pages and the analysis page inherit it. `replay.css` has its own copy.
- The blanket rule is a floor. A component whose meaning **is** its motion
  needs a designed reduced state. The indeterminate progress bar becomes a
  static striped fill, because a solid full bar would read as "done".
- Motion driven by JavaScript is not covered by the media query and must
  check it itself. The replay's camera does, through `easeMs()` in
  `replay/terrain-backend.ts`.
- Nothing flashes more than three times a second.
- Anything that updates by itself (a toast, the activity feed) can be
  dismissed and does not take focus.

### 3.9 Targets

WCAG 2.5.8, and the HIG's 44 points.

- **A pointer target is 24×24 CSS px or more**, or has 24px of spacing. The
  kit's smallest buttons are 28px. Nothing goes below that.
- **Every control in the page bar and every row of its menus is 44px, at
  every pointer.** The footer's links are 44px rows.
- **On a coarse pointer the floor is 44px** for the kit's own controls:
  buttons, fields, the select and its options, menu rows, tabs and the date
  field. 24px is WCAG's line, not a thumb's. There are two ways to reach 44:
  - Where the control can grow, grow it with a `pointer-coarse:` size
    utility. A real 44px box cannot overlap anything.
  - Where growing would move what sits beside it (a small button in a dense
    row, a search field's clear button, the `Explain` ⓘ in a heading), use
    the `touch-target` utility in `react/globals.css`. It is a transparent
    pseudo-element that only widens where a finger may land.
  - Both apply only on `(pointer: coarse)`. A mouse is precise at 24px, and
    an invisible 44px box on a desktop would take clicks from its
    neighbours.
- **A tap target is the whole area that does nothing beside it.** The
  waypoints list's locate pin was a 28px icon with 300px of inert row beside
  it. It is now the row's whole left strip, 48×44px. Read-only, where no
  page opens, the whole row flies the map. The pin stays because it names the
  action for a reader who cannot see the map move.
- **Measure a target in the e2e, not by its classes.** tailwind-merge does
  not resolve `size-*` against `h-*` and `w-*`, so a class check can pass
  over a 28px box.
- A chart's dots and lines are not sized as targets. The chart answers the
  pointer and chooses the nearest mark
  ([3.13](#313-charts-maps-and-the-3d-scene)).

### 3.10 Forms and inputs

WCAG 1.3.5, 3.3.1, 3.3.2, 3.3.3, 4.1.2.

- **Every input has a label tied to it in code.** Use the kit's fields
  (`rac/field.tsx`). Placeholder text is not a label.
- A required field, a format and a limit are stated in text, not by colour or
  an asterisk alone.
- **An error names its field in text and says how to fix it.** It is wired
  with `aria-invalid` and `aria-describedby`. Render it as `FieldError`
  inside the field and the kit does both. What happens when a save is refused
  is in [5.6](#56-forms).
- Use `autocomplete` tokens on identity and sign-in fields.
- The Submit-track form's "Submitting for" row stays a real, labelled
  control.

### 3.11 Predictable and clear

WCAG 2.4.4, 2.4.9, 3.2.1, 3.2.2.

- **Nothing changes context on focus or on simple input.** A select does not
  navigate when its value changes without an explicit action. Focusing a
  field does not open a dialog.
- **A link or a button says where it goes or what it does**, out of context.
  No "click here" and no "read more". "Download .xctsk" and "Edit route" are
  the model.
- Do not put an interactive role on the wrong element (no `role="button"` on
  a link that navigates).

### 3.12 Name, role, value and status

WCAG 4.1.2, 4.1.3.

- **Prefer the kit.** Its components carry the correct roles, states and
  keyboard behaviour. Add what is missing to `rac/`. A hand-written widget
  exposes the same name, role, value and states (`aria-expanded`,
  `aria-pressed`, `aria-selected`, `aria-current`).
- **A status message is announced without moving focus**: a toast, a save's
  result, a notice that scores are being recomputed. Use a live region
  (`aria-live="polite"`, or `role="alert"` for an error).
- The analysis page and the replay have no kit. Their controls (`.btn*`,
  `.input`, `.alert*`, `.tabs` in `analysis.css`) set their ARIA attributes
  explicitly.

### 3.13 Charts, maps and the 3D scene

The kit does not reach these, so they have rules of their own.

- **An interactive graphic has a text alternative** (WCAG 1.1.1). The task
  map, the charts and the 3D scene give their essential information in an
  accessible form beside them: the score explainer's numbers, the turnpoint
  list, a table. This is the same thing as the project rule that decisions
  must be explainable.
- **A chart is a `role="img"` whose accessible name states its reading in a
  sentence, with the exact values in a table beside it.** The `aria-label`
  is prose, not a title: "Top-down lift rose. Exact numbers per band are in
  the table below." The table is the exact reading, not a fallback. Both are
  always rendered.
- **The axis furniture is `aria-hidden`** (`charts/AxisTitle.tsx`): titles,
  the unit stamp and the in-plot title. A screen reader already has the
  sentence. The furniture is still required. A caption is read once and an
  axis is consulted continuously, and a screenshot separates the two.
  `AxisTitle.tsx` and `charts/scale.ts` are shared by every chart family.
- **A chart's labels are painted at 11px or more at every width.** An inline
  SVG scales its type with its width: `text-[10px]` in a 560-unit drawing is
  painted at 5.7px on a phone. 11 is also the HIG's minimum text size. There
  are three ways to hold a size:
  - `charts/use-chart-box.ts`: the viewBox is as wide as the chart is drawn,
    so one unit is one pixel and labels are 13px. Use this for a new chart.
  - `charts/use-chart-label-size.ts`: a fixed viewBox, with the type grown
    until it is painted at the size wanted.
  - A static SVG on a content page cannot measure itself. Draw it on a narrow
    viewBox with 13-unit labels and cap the figure's width
    (`web/scripts/generate-data-cleaning-charts.ts`).
  - Measure labels as **painted**, in the e2e
    (`e2e/analysis-charts.spec.ts`, `e2e/task-weather-charts.spec.ts`,
    `e2e/data-cleaning-charts.spec.ts`).
  - A label with no room is moved, cut short with an ellipsis or left out. It
    is never made smaller and never runs off the chart.
- **A mark that a chart can name is chosen by pointing near it, and no
  instruction says "hover".** The chart finds the nearest dot or line
  (`charts/use-nearest-pointer.ts`):
  - A tap chooses the nearest mark, however far away. A finger dragged across
    the chart does the same. Vertical scrolling stays with the page.
  - A mouse hovers or clicks within 32px of a mark.
  - Choosing moves focus to the mark, so a tap and an arrow key end in the
    same state.
  - The chosen mark is named in the line **above** the plot
    (`charts/ChartReadout.tsx`), because a hand covers what is below a
    finger.
- Chart and track colours meet 3:1 and can be told apart without colour (line
  style, direct labels, markers). The horserace is the worked example.
- Map interactions follow
  [mapbox-interactions-spec.md](mapbox-interactions-spec.md). A keyboard
  affordance added for accessibility becomes part of that specification.
- What a particular chart may claim (the report card's emphasis charts, a
  curve that is the formula and not a fit) is in `CLAUDE.md`, under "The
  report card".

---

## 4. The Apple Human Interface Guidelines

For anything Parts 2, 3 and 5 do not decide, do what the HIG says for iOS.
Read the page itself. Do not answer from memory, because Apple revises it.
The pages below were read on 21 November 2026.

### 4.1 What we take as written

| HIG page | What it gives us here |
|---|---|
| [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) | 44×44 pt as the size of a control; spacing between controls counts as much as size; 4.5:1 text contrast; more than colour alone; reduced motion |
| [Typography](https://developer.apple.com/design/human-interface-guidelines/typography) | 11 pt as the smallest text anywhere, charts included |
| [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons) | One prominent button for the most likely action; a press state; never the prominent style on a destructive action |
| [Alerts](https://developer.apple.com/design/human-interface-guidelines/alerts) and [Action sheets](https://developer.apple.com/design/human-interface-guidelines/action-sheets) | Confirm only what is uncommon and cannot be undone; a title that says what will happen; button titles that are verbs, never "Yes" and "No"; "Cancel" is always called Cancel; the button a reader most likely wants is last; a destructive choice is drawn as one |
| [Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars) | Leading edge, centre and trailing edge always mean the same thing; a concise title; the standard back symbol with no "Back" text beside it; one primary action, on the trailing side |
| [Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets) | Cancel on the leading edge and the commit on the trailing edge. We apply this to a form's page, since we have no sheets |
| [Lists and tables](https://developer.apple.com/design/human-interface-guidelines/lists-and-tables) | Short text in rows; a row opens a detail view; reordering is a mode the reader enters |
| [Entering data](https://developer.apple.com/design/human-interface-guidelines/entering-data) | Offer choices before text entry; prefill what we know; the commit is available only when the required data is there |
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
| System gestures (swipe back from the edge, pull to refresh) | The browser's own. We add no gesture |
| VoiceOver from the system's controls | The kit, built to the APG ([3.12](#312-name-role-value-and-status)) |

---

## 5. Where we diverge, and what is ours

Each section says what the HIG does, what we do and why. Part 6 says who owns
it.

### 5.1 Mobile first, and one layout at every width

**HIG**: an iPad or Mac version of an app may use a different layout
(sidebars, multicolumn tables).

**Here**: a phone is the shape a surface is designed **for**, not a width it
must survive. Where a phone and a desktop conflict, the phone wins. There is
one layout, at every width. (Owner's decision, 19 September 2026.)

Why: a competition is run from a hill, and nobody carries a laptop up it. Two
layouts are two code paths, and a reviewer at a desk then sees something the
author never tested on a phone.

- The worked example is `/comp/:id/waypoints`. It was a 145-row, eight-column
  grid. It scrolled sideways inside a page that scrolled down, and its frozen
  Code column hid the column beside it. It is now a list whose rows each open
  a page (`comp/WaypointList.tsx`), at every width. The grid is gone, not
  hidden behind a breakpoint.
- **An organiser's view and a visitor's view are the same component.** The
  read-only waypoints view was a six-column table after the editor had become
  a list, so the old shape survived for the pilot on the hill. `WaypointList`
  with no `onOpen` is the read-only mode. When a surface has two views,
  fixing one is half the job.
- **One way to do a thing.** A second way is a thing to keep working, to
  explain and to test. The waypoints page lost a "Fill altitudes from map"
  button that `Check altitudes` does better, a "Show on the map" button that
  the row's pin already was, and a status line that judged a set nobody had
  asked about.

### 5.2 Pages, not sheets

**HIG**: a sheet for a scoped task; a full-screen modal for a complex one.

**Here**: a page with a URL ([2.1](#21-a-screen-is-a-page)). We have no
sheets and no full-screen modals. A small dialog is the only modal.

### 5.3 One bar, no tab bar

**HIG**: a tab bar at the bottom for an app's top-level sections, and a
toolbar for the current view.

**Here**: every page has one bar at the top, `PageBar` in
`src/react/rac/page-bar.tsx`, and nothing at the bottom
([2.8](#28-the-keyboard-and-the-screens-edges)). The principle is the
owner's: **the page is for information, and every action goes in the bar.**
People learn to look in one place for what they can do. (Owner's decision,
15 November 2026, #863.)

The bar has three slots. They always mean the same thing.

| Slot | Holds |
|---|---|
| **Left: the way out** | Back ([2.3](#23-leaving-a-page)). Cancel on a form. The main menu on a top-level page |
| **Centre: where you are** | The page's title, which is its `<h1>`, over a menu drawn as one tree: up to the pages above, across or down to the pages beside or under this one, and out to the other top-level places |
| **Right: what you can do** | A form's commit button. Or ⋯ for the page's actions, with + and a status beside it |

- **The top-level places** (Competitions, My Flights, Submit track, Settings)
  are in the main menu and in every title menu. That is what a tab bar would
  hold.
- **The title is one line.** It may be cut short. The menu prints every level
  in full.
- **A page whose name is a sentence is an action.** The sentence is the ⋯ row
  that opens it. The page has a short `title` and the sentence as its
  `fullTitle`.
- **The trail is where a page belongs, not where the reader came from.** It
  is built by the helpers in `src/react/lib/crumbs.ts`, never inline. Where a
  page has two plausible parents, the URL and the trail pick the same one. A
  task's analysis belongs to the task. The comp analysis is a sibling link on
  it, not its parent.
- **A second layer may stick with the bar** (`below`): a search field, tabs
  or a class picker. Nothing else sticks. A class picker filters the whole
  page, so it stays there and not inside one section. On the analysis pages
  it is a segmented control for up to five classes.
- **A mode changes the bar.** In Reorder the title names the mode and the
  right slot holds Done.
- **The content pages have the same bar** in plain markup
  (`static/src/components/SiteHeader.astro`). So do the 3D replay and the
  analysis page, as pills over the scene or the map. Sign in, Onboarding and
  the OAuth consent page stand outside the Shell and have no bar.
- On the analysis page the bar's title and the ⋯ rows that open it name what
  the page shows: "Climbs and glides" for one pilot's track and "All tracks"
  for a task's field. "Analysis" stays the task's and the comp's word. The
  button beside ⋯ ("Lists" or "Scores") opens its side panel, and on a wide
  screen the bar ends at the open panel's edge. The replay's ⋯ opens its
  control drawer.

### 5.4 Actions go in ⋯

**HIG**: "Try to include all actions in the toolbar if possible, and only add
this [More] menu if you really need it."

**Here**: a page's actions go in ⋯, so that there is one place to look for
what a page can do ([5.3](#53-one-bar-no-tab-bar)).

- Rows are grouped by rules. Rare rows go behind one row.
- "Submit your track" is the first row of ⋯ on the competition and task
  pages.
- Pass the bar only the actions this reader may use.
- **An action stays on the page only when its place says something**: "Add
  turnpoint" under the list, and the one destructive action at the foot of a
  form.
- **A page whose content is its actions keeps them on the page.** One pilot
  on one task, for the organiser (`pages/TaskPilotPage.tsx`), is only its
  actions: the status, Upload track, Add manual flight, Restore track and the
  way to the score card. They are rows on the page (`rac/nav-list.tsx`), each
  with a line that says what it is for, and the bar has no ⋯. (Owner's
  decision, 20 November 2026.)
- `SectionHeader` is a section's `<h2>` row. An action sits right-aligned on
  it only where it belongs to that section and its place says something.
- Every Submit-track entry point links to the one form on `/submit`, with
  `submitTrackPath()`. It never opens in a dialog
  ([track-submission.md](track-submission.md)).

### 5.5 Every ⋯ row has an icon

**HIG**: "Use menu item icons sparingly and with purpose", and within a group
give every item an icon or none.

**Here**: every ⋯ row carries a line icon from Lucide, and one icon means one
thing everywhere. The bar chart, for example, always means analysis.

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

- A destructive row's icon is red with its label.
- A list of formats behind one row (the waypoint files) keeps empty slots,
  not one icon repeated.
- In a menu where any row has an icon, the rest keep an empty slot so the
  labels line up.

### 5.6 Forms

**HIG**: Cancel and Done on a sheet; an alert for a problem.

**Here**: a form is a page. Its commit button is in the bar's right slot and
Cancel is on the left. A failed save is never a toast and never an alert.

**The commit button**

- It is in the bar whatever the form does. Cancel asks before it throws a
  change away. A top-level form (Submit track) keeps the main menu on the
  left.
- **It is live only when there is something to commit**: a change, on a form
  that edits; the required fields, on a form that makes something new.
- The one destructive action for the thing being edited is at the foot of
  the form.
- Where the commit produces a result (Submit track, Test IGC, a new API key),
  the result appears on the page.
- On a page with no bar (Onboarding, the OAuth consent page) and in a
  dialog's footer, the primary button is last.

**Button wording**

| Word | Means |
|---|---|
| **Save** | Writes to the server. No other word does |
| **Create** | Makes something new: a competition, a task, a key |
| **Add** | Makes a new member of a list |
| **Done** | Only closes, or finishes one part of a draft that its page will save later. It is always live. In the bar it is drawn as Save is |

There is no Done where Back does the same thing.

**When a save does not work** (`rac/form.tsx` owns all of this)

- An error about a field goes **under that field**, which is focused and
  scrolled into view.
- An error about no field goes in the form's one banner, the first thing
  under the bar, focused and scrolled into view the same way.
- One submit at a time. A dropped connection keeps what was typed.
- The server's half is `{ error, field }` on every refusal. `validated()`
  does it for schema failures, and a route that knows which input it refuses
  says so.
- A one-control action that is not a form (a row's status menu, Upload track)
  follows the same rules through `useAction` and `ActionErrorBanner`: its
  refusal sits beside the control, focused. An action inside a form that is
  not its submit is `useFormAction`.

Why: every form did this by hand until November 2026, two ways, and both lost
the reader. On an iPhone the pilot sheet's Done spun and stopped, with the
reason at the top of a body scrolled past it.

**Choosing one of several**

- A value in a form the reader will Save is a **list in flow**
  (`rac/choice-list.tsx`, `rac/switch.tsx`). Nothing opens over what they
  were reading, the keyboard covers nothing, and the whole 44px row is the
  target.
- A control that chooses what to **look at** stays a popover select. A filter
  drawn as a card of rows pushes the thing it filters off the screen.

### 5.7 Lists

**HIG**: lists, multicolumn tables, swipe actions and an edit mode.

**Here**: a list of rows that each open a page. No swipe actions, and no
editable grid.

- **A row's body is a kit component**, `RowContent` in `rac/grid-list.tsx`.
  Three lists had each written their own, and they disagreed about the
  gutter, the title's weight and the chevron.
- **A row that opens a page is a target across its whole width**, with a
  chevron. A row that opens nothing has no chevron.
- **There is no editable grid.** An editable collection is a list of rows
  that each open a page of their own: the pilots page, the waypoints page and
  the organiser's list of a task's pilots. Work shaped like a spreadsheet
  goes to a real spreadsheet through CSV export and import, so that round
  trip must lose nothing (the export's `glidecomp_id` column). Do not bring a
  grid back for the desktop alone. That is two editors. The last grid went on
  1 November 2026: the pilots roster, fourteen columns in a dialog, of which
  a phone showed about one and a half.
- **A list of readings is a card for each row** (`rac/reading-list.tsx`,
  owner's decision 19 November 2026). Where every row has a name, a figure
  and a mark on an axis the list shares (`rac/meter.tsx`), each row is its
  own card with a gap before the next, and its name is bold. Rows divided by
  a hairline left a reader who was scrolling unsure which name a track
  belonged to. The heading and the axis sit above the cards, so the section
  is a plain `<section>`. One mark a row, and counts as words: a second bar
  under the first reads as the same unit. Where a row has more to say than
  fits, it opens a page. The worked examples are the Winning strategies
  ranking, the comp analysis ranking, the "Who flew like me?" results and the
  census of thermals.
- **A row of one line keeps a hairline** in its section's card, where the eye
  has nothing to lose. A family on Metric details is one behaviour at a time
  for every pilot (`analysis/PerPilotMetricList.tsx`), with a picker for the
  behaviour and an order control where a table's sortable headings were.
- **A table of more than three columns is a list of records**
  (`analysis/ReportTableView.tsx`): a box a row, its first cell as its name
  and the rest as label and value. Three columns or fewer stay a table.
- The comparison table on `/scoring/gap` stays a table. That page is a
  document, not an interface. (Owner's decision, 20 November 2026.)

### 5.8 Waiting

**HIG**: show that content is loading.

**Here**: the same, with one component for each kind of wait
(`rac/progress.tsx`).

| The wait | Use |
|---|---|
| A section of a page is fetching | `<Loading>`: a `role="status"` live region with a sentence |
| An action is in flight | `<Button isPending pendingLabel="Saving">`. Never `isDisabled` with a changed label: that drops focus in the middle of the action |
| A known background job is running | `<ProgressBar isIndeterminate>` |

### 5.9 Units

**HIG**: nothing specific.

**Here**: three rules, because a pilot reads altitudes in feet or metres and
a task is written in metres. Code comments call the first one the altitude
rule.

- **An altitude a reader types is in the reader's own unit, and the label
  says which** (#662). Every altitude the app prints honours the unit
  preference, so an input labelled "(m)" made the two disagree in front of
  the reader. Altitude inputs go through `AltitudeField` in
  `src/react/comp/fields.tsx`. Metres remain what is stored, exported and
  scored.
- **A cylinder radius is always metric**, read and typed. The FAI states it
  in metres, and so do the `.xctsk`, the briefing and the editor's `400m` and
  `5k` chips. Print one with `formatCylinderRadius()`.
- **The waypoints editor is metric throughout**, because it is the waypoint
  file edited in place. Its fields say "Altitude (m)" and "Radius (m)". A
  read-only waypoint row on the same page honours the preference.

What an altitude of zero means, and the one action that checks altitudes, are
in [waypoint-altitudes.md](waypoint-altitudes.md).

---

## 6. Who owns each pattern

A pattern is safe when one place in the code owns it or a test holds it. Where
the last column says "none", the pattern depends on each page remembering it.
Close those first.

| Pattern | Owner | Test |
|---|---|---|
| A screen is a page ([2.1](#21-a-screen-is-a-page)) | The router | `src/react/no-overlays.test.ts` |
| Back is never caught ([2.2](#22-back-is-the-browsers)) | `rac/dialog.tsx`, `lib/use-unsaved-changes-guard.ts` | `no-overlays.test.ts`, `use-unsaved-changes-guard.test.ts`, `e2e/comp-settings-pages.spec.ts` |
| The bar's back is the browser's Back ([2.3](#23-leaving-a-page)) | `useLeave()` and `useBackLabel()` in `lib/leave.ts` | `lib/leave.test.ts`, `e2e/comp-analysis.spec.ts`, `e2e/page-bar.spec.ts` |
| A save leaves by Back ([2.3](#23-leaving-a-page)) | `useLeave()`, called by each page | `e2e/comp-creation.spec.ts`, `e2e/task-settings-pages.spec.ts`. No test finds a page that forgets |
| A delete and a create replace ([2.3](#23-leaving-a-page)) | Each page | `e2e/task-new-page.spec.ts` for create. None for delete |
| The view is in the URL ([2.4](#24-the-url-holds-the-view)) | Each page | `e2e/comp-detail.spec.ts` for the scores views. None in general |
| Drafts ([2.5](#25-reload-a-shared-link-and-drafts)) | `lib/draft-store.ts`, `lib/draft-editor.ts` | `lib/draft-store.test.ts`, `e2e/comp-waypoints.spec.ts` |
| Links in the markup ([2.6](#26-links-are-links)) | `rac/page-bar.tsx` | `e2e/page-bar.spec.ts`, `bun run test:e2e:ssr` |
| Scroll on Back ([2.7](#27-scroll-and-focus-follow-the-navigation)) | `lib/scroll-restoration.ts` | `lib/scroll-restoration.test.ts`, `e2e/task-thermal-map.spec.ts` |
| Focus on arrival ([2.7](#27-scroll-and-focus-follow-the-navigation)) | `lib/route-focus.ts` | None |
| Nothing fixed to an edge ([2.8](#28-the-keyboard-and-the-screens-edges)) | `rac/page-bar.tsx` | `e2e/page-bar.spec.ts` |
| Colour as text ([3.2](#32-colour-and-contrast)) | The tokens in `react/globals.css` | `src/react/accent-text.test.ts` |
| No sideways scroll ([3.3](#33-text-and-zoom)) | Each page | The `mobile` Playwright project, for the pages in `e2e/fixtures/mobile.ts` |
| 44px in the bar ([3.9](#39-targets)) | `rac/page-bar.tsx` | `e2e/page-bar.spec.ts`, `e2e/replay-bar.spec.ts`, `e2e/analysis-bar.spec.ts` |
| 44px in the kit on a coarse pointer ([3.9](#39-targets)) | The kit components | Partly: the specs that measure a target. No test finds a new control that is too small |
| Chart labels at 11px ([3.13](#313-charts-maps-and-the-3d-scene)) | `charts/use-chart-box.ts`, `charts/use-chart-label-size.ts` | `e2e/analysis-charts.spec.ts`, `e2e/task-weather-charts.spec.ts`, `e2e/data-cleaning-charts.spec.ts` |
| A mark is chosen by pointing near it ([3.13](#313-charts-maps-and-the-3d-scene)) | `charts/use-nearest-pointer.ts` | `e2e/analysis-charts.spec.ts` |
| One bar, three slots ([5.3](#53-one-bar-no-tab-bar)) | `rac/page-bar.tsx`, `SiteHeader.astro` | `e2e/page-bar.spec.ts` |
| The trail ([5.3](#53-one-bar-no-tab-bar)) | `lib/crumbs.ts` | None for a trail built inline |
| Actions in ⋯ ([5.4](#54-actions-go-in-)) | `rac/page-bar.tsx` | None. A button on a page is found only in review |
| One icon, one meaning ([5.5](#55-every--row-has-an-icon)) | The table in 5.5 | None |
| The commit button and its words ([5.6](#56-forms)) | `components/SettingsForm.tsx` | `e2e/comp-settings-pages.spec.ts` for "live only when changed". None for the words |
| A refused save ([5.6](#56-forms)) | `rac/form.tsx` | `rac/form.test.ts`, `e2e/forms.spec.ts` |
| One kit ([3.12](#312-name-role-value-and-status)) | `src/react/rac/` | `src/react/one-kit.test.ts` |
| A row's body ([5.7](#57-lists)) | `RowContent` in `rac/grid-list.tsx` | None |
| No editable grid ([5.7](#57-lists)) | No component exists to build one, and no grid library is installed | None |
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
- [ ] Bar: the page's actions are in ⋯ with an icon from the table; the commit button is in the right slot and says Save, Create, Add or Done
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

1. **On a phone, or the `mobile` Playwright project.** Walk the change at
   phone width with a coarse pointer. `bunx playwright test --project=mobile`
   runs the specs listed in `e2e/fixtures/mobile.ts`. It proves those journeys
   still work on a phone. It does not check this guide.
2. **Back and reload.** Open the page from inside the app and press the
   browser's Back, then the bar's back. They go to the same place. Reload on
   the page. Open its URL in a new tab.
3. **Keyboard only.** Tab through the whole flow. Can you reach and operate
   everything? Is focus always visible?
4. **Zoom.** Browser zoom to 200%, then narrow to 320px. Nothing is clipped
   and the page does not scroll sideways.
5. **Screen reader.** VoiceOver (macOS, ⌘F5) or NVDA (Windows). Walk the
   landmarks and headings. Confirm names and roles, and that status changes
   are announced.
6. **Contrast.** The browser's contrast checker, on new token pairings, in
   both themes.
7. **axe or Lighthouse, by hand, in the browser**, on the changed pages.
   There is no automated accessibility check in this repository yet
   ([9](#9-known-gaps)). A clean axe run is necessary and not sufficient.

---

## 9. Known gaps

Places where the code does not meet this guide today. New work must not add
to the list.

1. **Keyboard parity and text alternatives on the map and the replay**
   ([3.5](#35-keyboard), [3.13](#313-charts-maps-and-the-3d-scene)). Both
   bind global key handlers, but nobody has confirmed that every pan, zoom,
   layer and playback control has a keyboard equivalent, or that the scene's
   essential content is available as text.
2. **Live regions are partial** ([3.12](#312-name-role-value-and-status)).
   The Submit-track form's status line is a proper live region, but the
   sentence that names the pilot found in the IGC file appears silently.
   Confirm that `sonner` announces its toasts.
3. **No automated accessibility check runs.** `axe-core` is in neither
   `package.json`, and `e2e/` has no accessibility spec. Closing this means
   `@axe-core/playwright` and a spec that sweeps one route for each surface.
4. **Patterns with no owner and no test.** Part 6 marks them "none": the
   words on a commit button, one icon for one meaning, actions in ⋯, a trail
   built inline, a row's body, focus on arrival, a grid library coming back,
   and where a delete goes. Each needs one owner in code or a test.
