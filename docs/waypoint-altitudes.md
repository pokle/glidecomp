# Waypoint altitudes

What a waypoint's altitude means, what unit each file format states it in, and
how the waypoints editor finds a wrong one.

## Zero is not missing

A waypoint altitude has exactly two states: **known** (any number, including 0)
and **absent** (the file said nothing). `WaypointFileRecord.altitude` is
therefore optional, and 0 never stands in for "unknown" anywhere — not in the
parsers, not in the grid, not in the route editor.

The two used to be collapsed into `0`, and every symptom traced back to that:

- A waypoint genuinely at sea level could not be left alone. The fill-blanks
  action of the day kept offering to fill it, and filling it wrote 0 again, so
  the button never went quiet. (That button is gone now — see "Check
  altitudes" below — but the ambiguity it tripped over was the real fault.)
- A file with no elevation column and a file full of beaches were
  indistinguishable after parsing.
- The waypoints grid and the route editor's turnpoint sheet disagreed about
  what a `0` in the same column meant — one treated it as a value, the other
  as a blank.

So:

- **Parsers** leave `altitude` undefined when the field is absent, blank,
  unparseable, or the format's own "unknown" sentinel. They return `0` only
  when the file really says zero.
- **Exporters** use each format's way of saying nothing where one exists —
  OziExplorer's `-777`, an empty `elev` column in SeeYou `.cup` and in our CSV,
  an omitted `<ele>` in GPX. The formats whose elevation is *positional* (FS
  `$FormatGEO` and `$FormatUTM`, where the long name follows the number, and
  KML, where it is the third value of a coordinate triple) have no way to
  express it, so they write `0`; the same is true of the packed `z` string in
  an XCTrack waypoint QR.
- **The editor** shows an empty altitude field for absent and `0` for zero, and
  says so: "Leave it empty if the altitude is unknown. Zero means sea level."
  A list row prints "no altitude" rather than a `0` it does not have.
- **A zero that is wrong** — a `0` sitting under a 1500 m launch — is a *wrong
  altitude*, not a missing one. Nothing silently overwrites it; "Check
  altitudes" reports it as a 1500 m disagreement.

## Units, per format

Every `WaypointFileRecord.altitude` is metres. Most formats state metres too,
but not all:

| Format | Elevation field | Unit |
|---|---|---|
| OziExplorer `.wpt` | field 14 (0-indexed) | **feet**, `-777` = unknown |
| CompeGPS / Garmin PCX5 `.wpt` | first number after the coordinates | metres |
| SeeYou `.cup` | `elev` column | metres, or feet with an explicit `ft` suffix |
| FS `$FormatGEO` / `$FormatUTM` | the column before the long name | metres |
| GPX | `<ele>` | metres |
| KML | third value of `<coordinates>` | metres |
| CSV (ours) | `altitude` / `elev` | metres |

OziExplorer being the odd one out cost us a real bug: field 14 was read as
metres, which inflated every imported altitude by 3.28. The bundled HG Worlds
2026 set is the proof, because the organiser published the same points in four
formats — `web/samples/reference/hg-worlds-2026/waypoints/`:

| Waypoint | FS `$FormatGEO` | CompeGPS | OziExplorer | 
|---|---|---|---|
| `A01` BORDANO LANDING | 225 | 225.000000 | 738 (= 224.9 m) |
| `A06` ENEMONZO LANDING | 373 | — | 1224 (= 373.1 m) |
| `A11` SAURIS LANDING | 1392 | 1392.000000 | 4567 (= 1392.0 m) |

`LIENZ LANDING` reads 2234 in the OziExplorer file, which is 681 m — and Lienz
sits at about 673 m. The cross-format agreement test in
`web/engine/tests/waypoint-files.test.ts` is what now holds this down: the same
point must decode to the same altitude whichever file the organiser uploads,
exactly as it already had to decode to the same coordinates.

The two bundled sample comps (Corryong, Unungra) are the CompeGPS/PCX5 dialect
and state metres, so no seeded comp's altitudes changed.

## Finding a wrong altitude: "Check altitudes"

`/comp/:id/waypoints` has **one** altitude action: `Check altitudes`. It reads
the terrain under every waypoint and opens a review — it changes nothing on its
own, and it reports nothing until it is pressed.

There used to be two. "Fill altitudes from map" answered *blanks* without
asking, and a status line beside it said whether any blanks were left. Both are
gone: the check does the fill's job better, because it shows what it would
write before writing it, and the status line was a verdict on a question nobody
had put yet — standing clutter on the page. One way to do a thing.

The review is **two pages** (`pages/CompAltitudeReviewPage.tsx`, content in
`comp/AltitudeReview.tsx`): the list of what the check found at
`/comp/:id/waypoints/altitudes`, and one waypoint of it at `/altitudes/:n`. It
began as three extra columns in the Tabulator grid the page used to be, which
is the right shape on a desktop and a poor one on a phone — see the editor
section below for what that cost. It was then a full-screen sheet until #811,
when the overlays rule in CLAUDE.md made each of its two views a page.

### What the review shows

**A list view**, narrowed to the rows with something to decide. Each row states
both altitudes, labelled, and their difference:

```
Point_Addis_Hill
file 6660 m  →  map 80 m      +6580 m
Not your file: an old terrain-read fault
                              [ Use 80 m ]
```

Both numbers on the row is the whole point. The grid version put the file's
altitude in a column the reader had to scroll away from to see the map's, so a
disagreement was reported with one of its two halves off screen.

A trailing button takes the map's value without leaving the list; tapping the
row body opens **that waypoint's page** — the two altitudes side by side, a
sentence saying which of them to doubt, the accept, and both the altitude and
the coordinates editable in place.

Inside a waypoint, **Back, Done and "All N" all return to the review's LIST**.
Done used to close the whole review from there, which dropped the reader out to
the waypoints page half way down a list of twelve: "done with this waypoint" is
not "done with the check". Only the list's own Done leaves the review, and going
back IS "leave it as it is", so no third button says so. The browser's Back
walks the same way, one page per press: the waypoint, the review, the
waypoints. Back from the review leaves it open, for Forward to find; Done
closes it, and its readings go with it.

There is deliberately **no map on a waypoint's page**: editing the coordinates
as text is what a pasted correction needs anyway.

While that page is open it shows the reading the waypoint had when it opened,
however the coordinates change. A reading belongs to where the waypoint WAS
(`readingFor()` in `comp/waypoints-draft.ts` drops it once the coordinates
differ from the ones it was read at), and applied per keystroke that took the
comparison away mid-paste: "From the map" fell to "—" and the accept button
unmounted on the first character typed. Back on the list, the moved waypoint
reads "no map reading".

Accepting is an ordinary unsaved edit to the waypoints draft, so Save on the
waypoints page stays the commit, and "Discard changes" beside it the undo.

A difference of exactly zero prints **nothing**. The absence of a finding is not
a finding, and "0 m" beside a row the reader has just fixed is noise where the
interesting thing is that there is nothing left to say.

The thresholds and the arithmetic live in
`web/frontend/src/react/comp/altitude-check.ts`, away from the grid:

- **Under 50 m is not a finding.** The DEM is a ~10 m grid
  (`web/frontend/src/analysis/elevation.ts`) and published files are routinely
  rounded to 10 m — the Corryong set encodes the altitude in the code itself
  (`4C-080` is 800 m). Listing every row that differs would list every row, so
  agreeing rows are *counted in the banner and left out of the list*: the
  difference between "12 to look at" and "145 differ".
- **Past 300 m, doubt the coordinates first.** 300 m of terrain error inside
  one DEM pixel needs a cliff; 300 m between two valleys needs only a typo.
  Those rows are marked with a visible `!` and the banner says so.
- **A whole file can be wrong the same way.** `detectAltitudePattern()` looks
  for a constant *ratio* (a set of feet read as metres) or a constant *offset*
  (a datum or pressure reference) across the set, and offers the one bulk fix
  before the reader starts working down the list. Near-sea-level rows are
  excluded from that test, where a ratio of two altitudes means nothing.

### The list holds still — membership AND order

The rows the check picked out are a snapshot taken when the check runs, and so
is **the order they are in**. Both halves matter, and the second was learned the
hard way: with only the membership frozen, accepting a row sent it to the bottom
of the list the instant its disagreement became zero, because the sort is by the
size of the disagreement. Every row stayed on screen and the one under the
reader's thumb still moved. An e2e assertion caught it.

So a row never moves while a reader works down the list. Its Δ goes to 0 where
it sits, and the counts in the header do the counting.

The snapshot lives in the waypoints draft (`AltitudeReviewSnapshot`,
`comp/waypoints-draft.ts`), not in the review page's memory, because the review
is two pages: going into one waypoint and back, or reloading, must find the
same list in the same order. `waypoint-altitude-review.spec.ts` reloads it to
make sure.

### The editor: a list of pages, over one draft

`comp/WaypointList.tsx` is a row per waypoint — code, name, coordinates,
altitude and radius, on two lines, with a chevron saying there is more behind it
and a pin that flies the page's map. Tapping the row opens that waypoint's page,
`/comp/:id/waypoints/:n` (`pages/CompWaypointPage.tsx`): every field of that one
waypoint, the radius chips, and Remove. Add waypoint (`/waypoints/new`) and the
map at full size (`/waypoints/map`) are pages too. They were sheets and a dialog
over the list until #811; the overlays rule in CLAUDE.md says why they are
pages now.

What all of them edit is the waypoint FILE, saved as a set — so the file is a
**draft** in this tab's storage (`comp/waypoints-draft.ts`,
`comp/use-waypoints-editor.ts`, [drafts.md](drafts.md)). Each page reads it when
it mounts and writes every change straight back, so a waypoint's page edits
live: Done and Back both keep the edit, and so does a reload. Nothing is saved
until Save on the list, and "Discard changes" beside it throws the draft away.
A waypoint is addressed by the draft's own row id rather than its code, because
the code is one of the fields its page edits and a waypoint added a minute ago
exists only in the draft; with no draft the rows are numbered 1..N in file
order, the same numbers on every page.

Why a whole-file draft and not a save per waypoint, as the pilot page does:
the server holds the set as one document (`PUT /api/comp/:id/waypoints`, one
audit entry per save), and the editor's biggest changes are set-wide — upload a
file, convert from feet, take the map's altitude for all of them. A save per
waypoint would be a read-modify-write of the whole set on every tap.

There is no "show on the map" button on a waypoint's page: the row it opened
from has a pin that does exactly that, and one waypoint does not need two ways
to be looked at.

It was a Tabulator grid until 2026-09-19, and Tabulator was the app's standard
for an editable table. What settled it is that GlideComp is used from a hill
with a phone — see the mobile-first rule in CLAUDE.md. The grid scrolled
sideways inside a page that scrolled down, under a map pane that stuck, with its
frozen Code column hiding whichever column sat beside it. The grid is **gone**,
not hidden behind a breakpoint: two editors would mean two code paths and a
reviewer on a desktop seeing something the author never tested on a phone.

An anonymous visitor gets the same list, and that took a second pass. The
read-only view was a six-column RAC `Table` in its own `overflow-x-auto` scroll
region — so the sideways-scrolling shape the editor had just stopped using
survived for the PILOT, who is the one standing on the hill, while the organiser
more likely to be at a desk got the list. `WaypointList` with no `onOpen` is the
read-only mode: no chevron, because nothing opens. It cost the table's sortable
columns, which can come back as a sort control over the list; the filter box
above it did not move.

**The locate pin is the row's whole left-hand strip**, and read-only the whole
ROW flies the map. The pin began as a 28x28 px icon with 300 px of inert row
beside it, which is a poor thing to ask a thumb to find on a hill. In the editor
the row opens the waypoint's page, so the pin is a separate action and keeps
its own target — 48x44 px, flush to the card's edge, and RAC does not fire a
row's action when a focusable child of it is pressed. Read-only there is no
page behind a row, so the row does the pin's job too; the pin stays because it is what names
the action ("Show BEACH on the map") for a reader who cannot see the map move.
The e2e measures the rendered box, because tailwind-merge does not resolve
`size-*` against `h-*`/`w-*` and a `size` prop added later would leave the
target at 28 px with every class-level assertion still passing.

The one thing the two modes do not share is the altitude's unit. The editor is
the waypoint FILE edited in place, so it is metric throughout and its rows and
fields say so. A read-only row is an altitude PRINTED to a reader, so it honours
the unit preference like every other altitude in the app (issue #662).

### Back is the browser's

The editor's screens were sheets, React state over the list, because the list
held the unsaved work and a sibling route would have unmounted it. That left
them invisible to the history stack, and `lib/use-back-dismiss.ts` gave each one
a history entry so Back could close it — machinery that broke three ways
(StrictMode, a popstate reaching every listener, our own pop looking like the
reader's), and whose e2e tests were the flaky ones in CI.

With the work in a stored draft, the screens are pages and none of that is
needed: Back walks out of a waypoint, the review or the map one page per press
because they ARE pages. Opened from the list, each page's Done is a real Back,
so the list returns at the scroll it was left at (`lib/scroll-restoration.ts`);
opened from a bookmark or a reload, Done replaces the page with the list.

Leaving the editor asks only when it should. Going between its own pages is
not leaving (`isWithin` on `use-unsaved-changes-guard`); a link OUT of the
editor with unsaved edits asks "Discard changes?", and discarding forgets the
draft. Back out of the editor does not ask: it means "not now", and the draft is
there when the reader comes back.

Number fields commit on blur rather than per keystroke, which is RAC's
behaviour; tapping Done blurs first, and `comp-waypoints.spec.ts` asserts that
path specifically (type an altitude, tap Done, expect the value on the row)
because losing it would be silent.

### The saved order is the file's order

Worth recording because it used to be a live hazard: Tabulator's `getData()`
returned rows in *display* order, so a header sort rewrote the stored waypoint
set in that order the next time any cell was edited. With the grid gone, the
draft's `rows` are the only copy and they keep the file's order by
construction — there is nothing left to mirror back.

### What it does not reach

A task **copies** a waypoint's values when it is built
(`draftFromRecord` in `web/frontend/src/react/comp/turnpoint-draft.ts`), and a
scored task is frozen against its own `xctsk`. So correcting the competition's
waypoint database does **not** change any task already built — the review says
so in as many words. This matters for one scored quantity: the goal waypoint's
altitude feeds the §13.4.6 stopped-task altitude bonus
(`resolveGoalAltitude` in `web/engine/src/gap-stopped.ts`). A task built with a
wrong goal altitude has to be corrected in the route editor, which keeps its
own "Fill altitudes from map" for blanks.

## Reading the terrain: why there is a PNG decoder

`web/frontend/src/analysis/elevation.ts` fetches Mapbox Terrain-RGB tiles at a
fixed z13 and **decodes the PNG itself** — inflate plus unfilter, no canvas.
That is not fastidiousness; a canvas gives the wrong answer here.

A Terrain-RGB pixel is a 24-bit *number* spread over three bytes
(`height = -10000 + (R*65536 + G*256 + B) * 0.1`), and the tiles are **RGBA**:
Mapbox marks no-data, including the sea beyond a coastline, with partial alpha.
A canvas stores premultiplied 8-bit RGBA, so drawing such a pixel and reading
it back does not round-trip — the payload is multiplied by alpha going in and
divided by it coming out, and only the nearest byte survives.
`premultiplyAlpha: 'none'` does not help, because the loss is in the canvas,
not in the decoder.

The red byte carries **6553.6 m per step**, so one step of that error is
kilometres. Measured, for a real 166 m coastal hill:

| alpha | read back off a canvas |
|---|---|
| 255 | 166 m |
| 200 | 192 m |
| 128 | 6720 m |
| 100 | -6413 m |
| 0 | -10000 m |

This is how `Big_Hill`, a Great Ocean Road waypoint a few metres from the
water, was read as **13273 m** and offered for writing into the waypoint file.

### Cleaning up what the bug already saved

The fault was in a *read*, but its results were **written**: "Fill altitudes
from map" and any accepted map altitude saved those numbers into waypoint
files, and fixing the decoder does not retract them. On the Great Ocean Road
comp, `Point_Addis_Hill` still held 6660 m over terrain that now reads 80 m —
and 80 m read through the old canvas path at partial alpha comes out at
6659.2 m, which is where the stored value came from.

Such an altitude is recognisable rather than merely wrong, so the review says
which of the two numbers is at fault instead of leaving the organiser to guess.
`looksLikeCorruptedTerrainRead()` in `altitude-check.ts` asks whether the
disagreement is a whole number of red-byte steps (6553.6 m) to within 60 m —
the residual being only the difference between the single pixel the old code
read and the 3x3 median read now. Nothing a person types is out by 6554 m to
within 60 m, and a file in feet is out by a *factor*, not a step, so the two
patterns do not collide. Where it fires, the banner says the number is not
theirs and that taking the map's altitude corrects it, and the row's Δ tooltip
stops blaming the coordinates.

Two further guards, because a wrong elevation must never be presentable as a
right one:

- **A plausibility range** (`isPlausibleElevation`): -500 m to 9000 m, which
  covers the Dead Sea shore and Everest. Anything outside is not an elevation,
  so the point reads as "could not be read from the map" rather than as a
  number. It is a backstop, not the fix — 6720 m is also an ordinary Himalayan
  summit, so no range check could have rejected that one.
- **A 3x3 median** (`sampleElevation`), counting only plausible pixels. One bad
  pixel then cannot become the answer, and a waypoint on a cliff edge — where a
  ~10 m grid is least stable, and where coastal waypoints all sit — is read from
  its own ground rather than from whichever side of the escarpment the nearest
  pixel landed on. The neighbourhood is clamped to the tile rather than fetching
  a second one for two more samples.

Because there is no canvas in the path any more, it is also unit-testable: the
tests decode the four real Mapbox tiles the e2e suite records and check their
elevation ranges against an independent (plain `node:zlib`) decode of the same
files.

The e2e fixture `flatTerrainRgbPng` writes **RGBA**, with a settable alpha, for
the same reason. It used to write colour type 2 with no alpha at all, which is
precisely why the suite stayed green while the real site read 13273 m; the
waypoints spec now drives the review through a partially transparent tile.

## Coverage

- `web/engine/tests/waypoint-files.test.ts` — the OziExplorer feet conversion,
  `-777`, the cross-format altitude agreement, and "a missing elevation reads
  as undefined, never 0" per format.
- `web/engine/tests/waypoint-export.test.ts` — feet on the way out, and an
  unknown altitude round-tripping as unknown rather than as sea level.
- `web/frontend/src/react/comp/altitude-check.test.ts` — the verdicts,
  thresholds, sort order and both patterns.
- `web/frontend/src/analysis/elevation.test.ts` — the PNG decode (including a
  partially transparent pixel at every alpha, the case a canvas destroys), the
  plausibility range and its limit, the 3x3 median against a corrupt pixel and
  a cliff edge, and the four real recorded Mapbox tiles.
- `web/frontend/src/react/comp/waypoints-draft.test.ts` — the draft: row ids
  that keep meaning one waypoint, a stored draft against a saved set that
  moved, the review's snapshot holding still, and a reading dropped once its
  waypoint moves.
- `e2e/comp-waypoints.spec.ts` — the list and the editor's pages (one
  waypoint, Add waypoint, the map), the draft across pages and reloads, and
  leaving. `e2e/waypoint-altitude-review.spec.ts` — the review's two pages,
  over a flat synthetic DEM (`stubTerrainElevations` in
  `e2e/fixtures/mapbox.ts`) so the disagreements are arithmetic the test chose,
  and at alpha 128 so the coastal no-data case is exercised end to end. Both
  run in **both** Playwright projects (they are in `MOBILE_SPEC_FILES`), assert
  that the pages never scroll sideways, and cover Back from each page.
