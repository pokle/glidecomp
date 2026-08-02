# CIVL world rankings import

How GlideComp gets the FAI/CIVL world pilot rankings, and what it does with them.

**Scope today: acquisition and storage only.** The `pilot_ranking` table is
standalone — nothing joins it to `pilot` or `comp_pilot`, and no page reads it.
Launch order (task 1 in reverse world-ranking order, subsequent tasks in reverse
of the previous task's scores) is a separate, later piece of work; see
`docs/competition-spec.md` Iteration 10 and the prior implementation in
[pokle/taskmaster](https://github.com/pokle/taskmaster).

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
