# CIVL world rankings import

How GlideComp gets the FAI/CIVL world pilot rankings, and what it does with them.

**Scope: acquisition and storage, plus one reader — the pilot roster.** The
`pilot_ranking` table is still standalone (no foreign keys, nothing joins it),
but an organiser can now copy a ranking onto each of their pilots from the
roster editor. See [The roster's copy](#the-rosters-copy) below.

Launch order itself (task 1 in reverse world-ranking order, subsequent tasks in
reverse of the previous task's scores) is still a separate, later piece of work;
see `docs/competition-spec.md` Iteration 10 and the prior implementation in
[pokle/taskmaster](https://github.com/pokle/taskmaster). This gives that work,
and the organiser doing it by hand today, the numbers to run on.

**This is not competition data**, so — like `task_weather` — the import takes
neither an `audit()` call nor a `bumpScoreInputs()` bump. A world ranking cannot
change a task score. It is the standing exception, alongside weather, to the two
"part of done" rules in CLAUDE.md.

| | |
|---|---|
| Source | https://civlcomps.org/rankings — 10 lists, one per discipline |
| Cadence | CIVL publishes monthly, dated the 1st, on no fixed day |
| Importer | `web/scripts/fetch-civl-rankings.ts` (`bun run civl-rankings`) |
| Schedule | `.github/workflows/civl-rankings.yml`, daily at 04:00 UTC |
| Table | `pilot_ranking`, migration `web/db/migrations/0025_pilot_ranking.sql` |
| Retention | Latest snapshot per list; a new month replaces the previous one |
| Inspect | `/civl-rankings.csv` (whole table), `?slug=<list>` for one list |

## The download protocol

The "Excel download" button on a list's pilots page is an async export job,
which is why watching it in devtools shows two requests to the same URL. The
importer reproduces the whole flow.

**1. `GET /ranking/<slug>/pilots`** — one page load that yields four things:

| What | Where |
|---|---|
| Session cookies | `Set-Cookie: PHPSESSID`, `_csrf` |
| CSRF token | `<meta name="csrf-token" content="…">` |
| Current period id | `<input id="search-ranking_id" value="1914">` |
| **Every published period** | an inline `const data = [{"id":1914,"name":"Jul","fullname":"Jul 2026","date":"2026-07-01","year":2026}, …]` |

That last array is the freshness signal — 233 entries for PG XC, going back to
March 2007. Its newest element is the newest published month.

**2. `POST /ranking/export-new?rankingId=<id>&type=export_pilots_ranking&format=xlsx&async=1`**

Body is the site's own search form, unfiltered:

```
search[nation_id]=&profile_id=&ranking_id=<id>&search[continent_id]=&search[continent_id]=0&search[scoringCategory]=&search[scoringCategory]=0
```

The CSRF token goes in the **`X-CSRF-Token` header** — it is *not* in the form
body, despite the `_csrf` cookie. Response: `{"status":"new","hash":"JuY8HYVp","url":false}`.

**3. `GET …&hash=<hash>`** every 5 s (the interval the site's own JS uses) until
`{"status":"completed","url":"https://civlcomps.org/ranking/download-file?hash=…"}`.
Other statuses are `processing`, `failed`, `cancelled`.

**4. `GET /ranking/download-file?hash=…`** — the `.xlsx`. Needs the session
cookie; no CSRF.

Two things worth knowing before changing any of this:

- **`format=csv` is ignored.** The job accepts the parameter and returns
  `Content-Type: …spreadsheetml.sheet` regardless. There is no CSV escape
  hatch, which is why `web/scripts/lib/xlsx-reader.ts` exists.
- **Period ids are per list per month.** Jul 2026 is `1914` for HG Class 1,
  `1913` for PG XC, `1919` for HG Class 1 Sport. They must be read off each
  list's page, never derived or shared between lists.

## Workbook shape

One sheet, LibreOffice-written, all strings inline (no `sharedStrings.xml`), no
formulas. Two tables stacked:

```
row 1    ranking_date |  | name       |  | region |  | selection |  | created
row 2    Jul 1, 2026  |  | HG Class 1 |  | World  |  | Overall   |  | Jul 1, 2026 03:05
rows 3-4 (blank)
row 5    Rank | CIVL ID | Name | Gender | Nation | Points | r1 p1 e1 … r4 p4 e4
row 6+   1 | 25161 | Marco Laurenzi | M | Italy | 339.3 | …
row N-1  count
row N    747
```

`web/scripts/lib/civl-ranking-sheet.ts` reads both header rows **by name** (the
metadata block interleaves blank columns) and finds the pilot table by looking
for the row starting `Rank` rather than hardcoding row 5. The trailing `count`
footer is the exporter's own row total and is **asserted**, so a truncated
download fails loudly instead of importing a partial ranking.

Ranks tie heavily — 344 of the 747 rows in the Jul 2026 HG Class 1 list share a
rank with someone, and the tail is a long run of rank 695 at 0.1 points. That is
why `points` is stored: rank alone cannot order the list.

Two real exports are committed under `web/samples/civl-rankings/` and are what
`civl-ranking-sheet.test.ts` and `xlsx-reader.test.ts` run against. They are the
only guard against civlcomps.org silently changing the workbook's shape.

## Polling without hammering

The workflow runs daily because the publication day moves. The cost of a quiet
day is kept at zero by deciding in three widening steps
(`web/scripts/lib/ranking-schedule.ts`, unit-tested):

1. **One D1 read** gives the stored `ranking_date` per list. A list already
   holding a date on or after the 1st of the current month is skipped with **no
   HTTP request at all**. This is the steady state — roughly 30 days a month,
   and the whole run finishes in about two seconds.
2. Otherwise **one page load** (step 1 of the protocol above). If the newest
   published period isn't newer than what's stored, stop; look again tomorrow.
3. Only then run the **export**, which is what actually costs them work.

Step 2 asks "is there anything newer?", never "is this month's list out yet?".
CIVL publishing late, or skipping a month entirely, both fall out correctly;
the "must equal the current month" phrasing gets the skipped month wrong and
polls forever.

Between outbound requests the importer sleeps `REQUEST_DELAY_MS` (default
3500 ms, the same knob `download-airscore-comp.ts` uses), and lists are
processed strictly sequentially. A publication-day run takes a while — PG XC
alone is about five minutes end to end, mostly their export job.

One list failing does not stop the others; the run still exits non-zero, and the
next day retries only what is missing.

## Writing to D1

Retention is latest-only, so each import both inserts and deletes — **in that
order**:

```sql
INSERT OR REPLACE INTO pilot_ranking (…) VALUES (…),(…),… ;  -- chunked
DELETE FROM pilot_ranking WHERE ranking_slug = ? AND ranking_date <> ?;
```

The chunks go through separate `wrangler d1 execute` invocations, so
delete-then-insert would leave a list **empty** if the run died in between.
Insert-first means the table transiently holds two months and always holds a
complete set. `INSERT OR REPLACE` (against the unique index on
`ranking_slug, ranking_date, civl_id`) is what makes `--force` idempotent.

Rows are batched 200 per statement, 10 statements per temp SQL file, and values
are inlined via the shared `q()` escaper rather than parameterised — the same
approach `seed-sample-comp.ts` uses. Both scripts now share one wrangler runner
and one retry policy in `web/scripts/lib/wrangler-d1.ts`.

### Credentials

The workflow needs only the two repository secrets that already exist:
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. `deploy.yml` already runs
`wrangler d1 migrations apply taskscore-auth --remote` with them against this
same database, which is what establishes the token carries account-level **D1
Edit**; `d1 execute --remote` needs nothing more. No worker-with-a-shared-secret
is required.

The workflow does **not** apply migrations — `deploy.yml` owns that on master,
so `0025` must have landed there before the first scheduled run can write.

## Inspecting the result

`/civl-rankings.csv` dumps the whole table (add `?slug=hang-gliding-class-1-xc`
for one list). It is a verification hatch, not a product surface: linked from
nowhere, `X-Robots-Tag: noindex`, and public because every row is a verbatim
copy of a list anyone can download from civlcomps.org. Rows are fetched in pages
and streamed, and the response carries a deliberately short (60 s) edge cache —
long enough to absorb a burst, short enough that "did the import land?" is
answered by the current table.

Served by `functions/civl-rankings.csv.ts` → `routes/civl-rankings.ts` over the
service binding. Under `bun run dev` the Pages Function doesn't run, so
`vite.config.ts` rewrites the same URL to `/api/civl-rankings.csv` on the
dev-router; the one public URL works in both.

## The roster's copy

A competition wants the rankings **as they stood when the roster was built** —
a launch order that reshuffles itself when CIVL publishes next month is not a
launch order. So nothing reads `pilot_ranking` at page-render time. The number
is COPIED onto `comp_pilot` once, by an organiser pressing a button, and stays
put:

| Column | |
|---|---|
| `civl_ranking` | the rank. Existed unused since migration 0001; real since 0029 |
| `civl_ranking_slug` | which list it came from, NULL when set by hand |
| `civl_ranking_date` | that list's snapshot month, NULL when set by hand |

Both source columns being NULL is what the roster renders as "set by
organiser" — an override (a pilot the list has missed, or has wrong) must not
be indistinguishable from an import.

**Filling the roster in** happens two ways in the pilots editor
(`/comp/:id/pilots` → Edit, `src/react/comp/PilotsSection.tsx` +
`civl-rankings.ts`), and both apply the same rules.

**"Fill from CIVL…"**, in the editor's footer with the other grid-wide
actions. It opens a dialog of its own (`CivlFillDialog`) saying how many of
these pilots the rankings can place, and the button that places them. It was
a bar under the grid, and on a phone it cost about a fifth of the editor's
height permanently, for a step most rosters take once. It closes on the way
out so the outcome lands under the grid, beside the rows it changed.

The fill does two passes, in this order and for this reason:

1. **Ids** — into an EMPTY id cell whose name exactly one ranked pilot
   answers to. This is the one place a name decides anything.
2. **Ranks** — into an EMPTY ranking cell, matched on **CIVL ID only**. A rank
   against the wrong human silently sets the wrong launch order, and a shared
   name is not evidence of a shared identity (the same rule
   `pilot-resolver.ts` and `pilot-linker.ts` refuse to link accounts on).

The lookup is re-run **between** the passes: rows that just gained an id are
matched by it on the second, which is what makes their ranks fillable at all.
This was two buttons, and the ordering was the organiser's to know — pressing
them the other way round simply did less.

**Neither pass overwrites.** The dialog promises "Add CIVL IDs and rankings
when missing", and a number already in the grid is somebody's answer — typed
for a pilot the list has wrong or has missed, or filled from a list chosen
earlier. The cost is the refresh path: when CIVL publishes a new month,
filling again adds nothing to a roster that is already ranked, and **clearing
a ranking is how an organiser asks for the newer one**. The outcome line says
so, because "0 rankings filled in" otherwise reads as a failure — a matched
row that was left alone is counted separately (`already_set`) from one the
list has never heard of.

**A name typeahead**, on the name column. Typing two or more characters offers
ranked pilots — each once, from their best-scoring list — labelled with nation
and world rank because that is what tells two pilots of one name apart. Picking one
takes CIVL's spelling of the name and brings the id and the rank with it — the
same match the button makes, made one row at a time and before the ambiguity
exists. The column stays **freetext**: most rosters have pilots who have never
been ranked, and a name cell that refused to hold them would be worse than one
with no suggestions. It reads `GET /api/comp/:comp_id/pilot/civl-search`
(admin only), and an id already in the row is never overwritten.

Every ambiguity is refused rather than resolved: two DIFFERENT ranked humans
sharing a name, two roster rows claiming one ranked pilot, or a ranked pilot
whose id another row already holds. One pilot appearing in several lists is
not an ambiguity — see below. Names match on case and whitespace only — accents
are **not** folded, because SQLite's `NOCASE` is ASCII-only and the fold would
claim matches the query could never fetch. Rules and reasoning:
`web/workers/competition-api/src/civl-ranking-match.ts`.

The button reads `POST /api/comp/:comp_id/pilot/civl-rankings` (admin only),
which answers about the rows in the **grid** — the organiser is mid-edit when
they press it — and returns every list we hold, including ones that place
nobody, so a wrong-discipline pick shows as "0 of 24" instead of vanishing.
Nothing is written until Save.

The typeahead's route defaults to the discipline's **main** XC list when the
caller names none (`preferredListSlug`). Taking the first slug of the right
discipline alphabetically does not work: that is
`hang-gliding-class-1-sport-xc`, so an HG comp would quietly search a list
almost none of its field is in.

Writes go through the ordinary roster save, so they are `audit()`ed like any
other roster change. They take **no** `bumpAndRevalidateScores()` call: a world
ranking is not a scoring input and cannot change a task score.

### One number per pilot: WPRS points choose the list

CIVL publishes ten lists and **no overall ranking** — every row of every list
is `region=World, selection=Overall`, where "Overall" is CIVL's own selection
filter rather than an aggregate. A pilot in more than one list therefore has no
single published number, and the roster needs one.

The rule: take the list where the pilot scores the most **WPRS points** (the
World Pilot Ranking Scheme score CIVL computes from their results, and sorts
each list by), and copy their **rank in that list** onto the roster, recording
the list in `civl_ranking_slug`. Two pilots on one roster are routinely ranked
from two different lists. Equal points go to the lower rank; an exact tie falls
to the slug so a re-run answers the same. `bestPerPilot()` in
`civl-ranking-match.ts` does the collapsing, and doing it BEFORE the matching
is also what stops one pilot in four lists reading as four rivals for a name.

**Points and not the lowest rank**, because a rank is only a position within
one pool and the pools differ enormously — HG Class 2 holds six pilots, PG XC
holds 6,875 — so the smaller the list, the flatter the rank it hands out. In
the August 2026 snapshot:

| | |
|---|---|
| ranked pilots in more than one list | 4,140 of 10,019 (41%), up to 4 lists |
| median spread between a pilot's ranks | 1,835 places |
| pilots whose best rank and best points are in different lists | 3,457 |

Luke Nicol is **#1 in PG XC Sport and #106 in PG XC on identical points**,
because Sport is a subset of the same field; picking the lowest number would
call him first in the world. Points are the same quantity in every list, so
"which list has this pilot achieved most in" is a question they can answer and
ranks cannot.

What the roster holds is still a **rank**, because that is what a launch order
is set from — but it is now their rank in their strongest discipline rather
than in their smallest.

### Rankings on a development database

`bun run fresh-dev` wipes D1, and the import runs against **production** on a
GitHub Actions cron — so a fresh local database has no rankings at all and the
roster editor correctly offers nothing to fill from. `bun run
seed-civl-rankings` (which `fresh-dev` now calls) fixes that with two things:

1. **A real snapshot** —
   `web/samples/civl-rankings/civl-rankings-2026-08.csv`, all ten lists as
   published for August 2026, taken verbatim from production's own
   `/civl-rankings.csv` dump. Rows keep their `civl_ranking_id` and
   `fetched_at`, so a locally-filled roster carries exactly the provenance
   production would have given it. 37 of the seeded Corryong Cup's 64 pilots
   are genuinely in HG Class 1, which is what makes the local roster a real
   test of the feature rather than a mock of it.
2. **A synthetic list** of invented pilots (`sample-world-ranking` — never one
   of the ten, and named "Sample World Ranking" wherever it appears) that
   `e2e/civl-rankings.spec.ts` matches against. The e2e cannot key on the real
   data: it is a point-in-time copy whose ranks move every month.

It deliberately does NOT invent rankings for the real pilots on the sample
comps. A fabricated number against a real name, displayed with a list and a
month beside it, is indistinguishable from a published one.

Refresh the snapshot by downloading `/civl-rankings.csv` from production over
the top of it — same format, no code change — or run `bun run civl-rankings`
for a live import. **When you refresh it, re-check `LIST_LABELS` in
`src/react/comp/civl-rankings.ts` against the file's `ranking_name` column**:
the roster labels a stored rank from that map while the picker shows the
snapshot's own name, and the two must agree (CIVL calls
`paragliding-accuracy` "PGA", not "PG Accuracy").

## Adding a list

`LISTS` in `web/scripts/fetch-civl-rankings.ts` — one line per slug, taken from
the `/ranking/<slug>/pilots` links on https://civlcomps.org/rankings. The slug,
not the sheet's `name`, is the row's identity in D1: two lists can share a
region and selection, and the display name is CIVL's to change.

## Running it by hand

```bash
bun run db:migrate                                  # local, first time only
bun run civl-rankings                               # all lists → local dev D1
bun run civl-rankings hang-gliding-class-1-xc       # one list
bun run civl-rankings -- --dry-run                  # fetch + parse, write nothing
bun run civl-rankings -- --force                    # re-import a stored month
bun run civl-rankings -- --remote                   # production D1
REQUEST_DELAY_MS=6000 bun run civl-rankings         # be gentler still
```

Note the `--` before flags when going through `bun run`.
