# Waypoint altitudes

What a waypoint's altitude means, what unit each file format states it in, and
how the waypoints editor finds a wrong one.

## Zero is not missing

A waypoint altitude has exactly two states: **known** (any number, including 0)
and **absent** (the file said nothing). `WaypointFileRecord.altitude` is
therefore optional, and 0 never stands in for "unknown" anywhere — not in the
parsers, not in the grid, not in the route editor.

The two used to be collapsed into `0`, and every symptom traced back to that:

- A waypoint genuinely at sea level could not be left alone. "Fill altitudes
  from map" kept offering to fill it, and filling it wrote 0 again, so the
  button never went quiet.
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
- **The editor** shows a blank cell for absent and `0` for zero. Only a blank
  is "missing", and only blanks are touched by "Fill altitudes from map".
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

`/comp/:id/waypoints` has two altitude actions, and the difference between them
is the whole design:

- **Fill altitudes from map** answers *blanks*. There is no competing value, so
  it cannot be wrong and it applies itself in one press.
- **Check altitudes** questions the values that are already there. It therefore
  changes nothing on its own: it reads the terrain under every waypoint and
  turns the grid into a review.

The review happens **in the grid**, not in a dialog, because the grid already
has everything the decision needs: the map beside it, the locate pin, the
filter box and an editable altitude cell. A reader who finds a wrong
*coordinate* — the usual cause of a large disagreement — can fix the actual
fault in place instead of accepting a number that would hide it.

### What the review shows

Two derived columns appear beside `Alt (m)`, and an accept action:

- `Map (m)` — the ground elevation the check read.
- `Δ (m)` — the waypoint's altitude minus the map's, signed. It is **derived
  from the two cells on every redraw, never stored**, so nothing has to
  remember to recompute it when an altitude is edited or a coordinate fixed.
  Sorting is by the *size* of the disagreement, so one "biggest first" ordering
  covers a waypoint 300 m too high and one 300 m too low.
- `✓` — take the map's value for this row. It is an ordinary unsaved grid edit,
  so the page's existing Save and its discard-on-leave guard are the commit and
  the undo.

The thresholds and the arithmetic live in
`web/frontend/src/react/comp/altitude-check.ts`, away from the grid:

- **Under 50 m is not a finding.** The DEM is one pixel of a ~10 m grid
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

### Two deliberate behaviours

- **The list holds still.** The rows the check picked out are a *snapshot*
  taken when it ran. A live predicate would make each row vanish the instant
  its `✓` was pressed, which reads as having deleted it and leaves nothing to
  check the result against. The banner's counts do the counting instead.
- **The saved order is the file's order, not the grid's.** Tabulator's
  `getData()` returns rows in display order, so a header sort (or the review's
  sort by disagreement) would otherwise rewrite the stored waypoint set in that
  order the next time any cell was edited. `syncFromGrid` sorts by row id,
  which ascends in file order.

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

## Coverage

- `web/engine/tests/waypoint-files.test.ts` — the OziExplorer feet conversion,
  `-777`, the cross-format altitude agreement, and "a missing elevation reads
  as undefined, never 0" per format.
- `web/engine/tests/waypoint-export.test.ts` — feet on the way out, and an
  unknown altitude round-tripping as unknown rather than as sea level.
- `web/frontend/src/react/comp/altitude-check.test.ts` — the verdicts,
  thresholds, sort order and both patterns.
- `e2e/comp-waypoints.spec.ts` — the review in the real grid, over a flat
  synthetic DEM (`stubTerrainElevations` in `e2e/fixtures/mapbox.ts`) so the
  disagreements are arithmetic the test chose.
