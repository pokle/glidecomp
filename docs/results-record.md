# The results record (`/comp/:id/scores.pdf`)

A competition's scores as one PDF, for an organiser (or anyone) to keep. It is
the paper copy of a competition, and it replaces printing the scores page,
which is no longer a print target. Its data also comes on its own as a ZIP
(`/comp/:id/scores.zip`).

## Why it exists

GlideComp re-scores every competition whenever the scoring engine changes
([scoring-version.md](scoring-version.md)). The scores online are always the
current engine's reading of the competition. They are never a frozen copy. An
organiser who needs the scores as they stood keeps this file. That covers their
own archive, a protest, or a report to a federation.

**Nothing is stored on our side.** The file is the record. Every page says when
it was made, and the cover names the scoring engine generation and the rules
edition. An organiser can download a new record at any time, every day if they
want to. Each file has the date in its name, so a new download does not
overwrite an old one.

Printing the scores page was the old way to keep a record. It did not work
well, for two reasons:

- Each change to the site could break the printed page, and nobody checked.
- The page's tabs (one per class, Top 3, Teams, Scores by task) meant that a
  reader had to print each view separately.

A document laid out in code cannot change when the site's CSS changes.

## Who can get it

**Everyone who can see the scores page** (owner decision, 2026-10-31). The
files say nothing the page does not, and the items sit inside the page's
**Download** menu, so they add no clutter. The first version was admin-only;
that was about the menu, and the menu turned out not to need it.

- The scores page's **Download** menu offers "Results record (PDF)" and
  "Results data (ZIP)" to every reader.
- The comp page's **wrap-up card** prompts the comp's admins after the close
  date (see below). It stays admin-only: it is the scorer's to-do, not a link.

A hidden `test` comp is still a `404` for anyone who cannot see it. The data
is fetched with the visitor's own cookie, so the comp lookup decides that, as
it does on the page.

## What is in it

A4 landscape. Landscape is needed because a standings table gets one column per
task. The record contains, in this order:

1. **Cover.** What the competition is, when this file was made, when the
   scores were computed, the scoring engine generation and rules edition, the
   series method (total or FTV), a contents list with page numbers, and the
   list of attached files.
2. **Standings**, one section per class. Task columns are labelled `T1`, `T2`
   and so on, in the competition's task order, with a legend. FTV marks are
   text so that text extraction keeps them: `[812.4]` is a discarded task and
   `812.4*` is a task that counted in part. If there are more tasks than fit
   across the page, the table splits into bands.
3. **Teams**, if the competition has any.
4. **One section per task:**
   - the route: task type, gates, launch window, deadline, optimised distance,
     the task page's own route diagram (`task-diagram-pdf.ts`, drawn from the
     same `buildTaskDiagram` layout and `md` preset), a scannable QR code, and
     the turnpoint table with optimised legs
   - the QR is the same XCTrack `XCTSK:` payload as the task page's "QR code":
     the turnpoints and radii, without gates or the SSS/ESS roles (those are in
     the attached `.xctsk`). Scan it to reuse a past route. A route too long
     for one QR (`XCTSK_QR_MAX_BYTES`) gets none, as on the task page
   - the organiser's weather notes
   - for each class: the validity arithmetic with its inputs, the available
     points, the GAP parameters, the full results table, and a **Notes** list
     that names every penalty, withheld track and early start with its reason

Bookmarks follow the same sections. Pilot scores link to their report cards.
The links are clickable in a viewer and plain text on paper.

## The attachments

The printed tables are rounded for reading. Reading numbers back out of a PDF's
text is not reliable: columns interleave, rows split across pages, and long
names wrap. So the PDF also carries the exact data as **attached files**:

| File | Holds |
|---|---|
| `scores.csv` | The scores page's CSV (`src/scores-csv.ts`), unchanged |
| `task-results.csv` | Every pilot on every task with every score component, at 3 decimal places |
| `task-validity.csv` | One row per task and class: validity, its inputs, the available points, the engine generation |
| `audit-log.csv` | The public change log (up to 10,000 entries) |
| `competition.json` | Data that is not a table: competition settings, and the resolved GAP parameters, leading clock and stopped-task outcome for each task and class |
| `route-NN-<task>.xctsk` | Each task's route as an XCTrack task file |
| `README.txt` | What each file holds |

Tabular data is CSV because every spreadsheet can open it. Everything else is
JSON, or a format the sport already reads.

**Not every viewer can reach them.** Adobe Acrobat Reader and Firefox list a
PDF's attachments; macOS Preview and Chrome do not. So the same files are
also served on their own as a ZIP, `/comp/:id/scores.zip` ("Results data
(ZIP)" in the Download menu), in one folder named like the PDF. The cover
says both of these things, because "open your viewer's attachments panel"
sent a Preview user looking for a panel that does not exist.

**There is no fixed format** (owner decision, 2026-10-31). Field names follow
the API on the day the file was made, and they can change between exports. The
README says this. A schema that we promise to keep forever is the storage cost
that the record exists to avoid.

## The wrap-up card

After the close date, the comp page shows its admins a card with the same
layout as the setup guide (`comp/CompWrapUp.tsx`). The card has two steps:
"Submissions closed" (already done) and "Download the results record". The
close date means the end of that day in the competition's time zone.

Each browser remembers the download for each competition in localStorage.
Another admin, or another device, still sees the prompt. This is intentional:
a second copy does no harm, and a record that nobody kept is the failure this
card prevents. After the download, the card stays (with the step checked) for
the rest of the visit, so the link does not disappear from under the reader's
focus. It is gone on the next visit. **Hide** dismisses the card for good.

## How it is built

```
src/results-record/serve.ts           the handler: load, build the PDF or ZIP, respond
src/results-record/build.ts           what goes on which page
src/results-record/pdf-writer.ts      pages, wrapped text, tables, links, bookmarks, QR (pdf-lib)
src/results-record/task-diagram-pdf.ts  the task page's route diagram, drawn with pdf-lib
src/results-record/attachments.ts     the CSV / JSON / .xctsk files
src/results-record/zip.ts             the same files as a ZIP (fflate)
src/react/loaders.ts               loadResultsRecord()
```

- **One handler, two callers.** In production, `functions/comp/[[path]].ts`
  calls it beside `scores.csv`. In dev, a Vite middleware (`resultsRecordDev`
  in `vite.config.ts`) loads it through `ssrLoadModule`, because the config
  bundle cannot load the engine's raw TypeScript.
- **Nothing is partial.** The loader sends every request through
  `fetchWithRetry`. If a task's scores still fail after the retries, the whole
  export fails with a `503`. It does not produce a record that silently lacks a
  day (issue #481).
- **The engine generation comes from the stored row.** The task score
  endpoint's `engine_generation` is read from the stored `task_scores` row, so
  a stale body names the engine that computed it.

### Fonts

The record embeds **Noto Sans** (OFL-1.1), cut down to Latin, Greek, Cyrillic,
Vietnamese and common symbols, at about 200 KB per weight
(`web/frontend/public/fonts/results-record/`). The Function reads the font files
through the `ASSETS` binding, so they are not part of the Function bundle. To
rebuild them, run `web/scripts/subset-results-record-fonts.py`.

- **The PDF base-14 fonts cannot print "Łukasz" or "Beneš".** A record that
  misspells a pilot's name is a wrong record.
- **A character the font cannot draw prints as `?`.** For example, CJK names
  print as `?`. The attached CSVs keep every name exactly.
- **The fonts are embedded whole, not subset by pdf-lib.** pdf-lib's fontkit
  subsetter draws the wrong glyphs for Noto Sans: the text extracts correctly
  but renders as gibberish. That is why the files are cut down ahead of time
  instead.
- **Text is encoded one glyph per code point.** It does not go through
  pdf-lib's per-string layout (`glyphTable` in `pdf-writer.ts`). Measuring with
  per-string layout cost 6.7 s of CPU for a 120-pilot, 14-task test
  competition; it now takes about 1.5 s, mostly `save()`. None of the embedded
  scripts needs shaping, and measuring and drawing now use the same numbers.
- **Ligatures are removed from the fonts.** Extracted text is the letters as
  typed.

## Known gaps

- **The PDF is not tagged** (no PDF/UA structure), because pdf-lib cannot write
  tags. A screen reader reads it as plain text. The attached CSVs are the
  accessible exact copy, in the same way the site's tables back up its charts.
- **The Top 3 view is not included.** It is a cut of the standings, which come
  first in the record.
