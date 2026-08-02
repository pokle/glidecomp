# Site search — competitions, tasks, routes and pilots

*Written 1 August 2026, with the implementation it describes.*

The competitions page used to filter the list it had already loaded: comp names
only, client-side, with a comment admitting that server-side search was "a later
problem (~1,000+ comps)". This is that problem, plus the one nothing could
answer at any layer: **find the tasks that fly through these turnpoints.**

The query that drove the design is `elliot KANGCK` — two turnpoint codes, no
competition, no task, no pilot. The answer is the tasks that fly through both,
under the competitions they belong to.

## What it searches, and what it answers with

Three kinds of thing, returned as the hierarchy they live in:

```
competition
└── task            (matched by name, date, or the turnpoints on its route)
    └── pilot       (matched by roster name, account name, team or CIVL id)
```

**Only what matched is listed. A level nobody asked about collapses to a count
and a link.** A turnpoint query returns the tasks and says "47 pilots"; a
pilot's name returns them under each task they flew. This is the rule that keeps
the response bounded without an arbitrary truncation, and it is why searching a
competition's name does *not* unpack its entire roster.

A matched pilot with no flight yet has no per-task page to link to, so they
appear under the competition, pointing at the roster.

**Competitions are ordered by name-match, then recency — not by score.** A
competition that matched on its own name comes first (a competition matches only
when *every* word of the query is in its own name or metadata, the strongest
signal here), then the most recent. bm25 decides which tasks and pilots come
back and how they read inside a competition, but not the order of the
competitions themselves. Both halves of that rule were forced by the archive —
see "At archive scale" below.

## Infrastructure

Nothing new on Cloudflare. The request path is the one that already existed:

```
browser  →  Pages Function  functions/api/comp/[[path]].ts   (already matches /api/comp/*)
         →  service binding COMPETITION_API
         →  competition-api Worker   (Smart Placement — already runs next to D1)
         →  D1 "taskscore-auth"      — search_doc + search_fts (FTS5)
```

| Piece | What | Cost |
|---|---|---|
| `web/db/migrations/0026_search_index.sql` | `search_doc`, `search_fts` (FTS5), `search_dirty`, triggers | included |
| `src/routes/search.ts` | `GET /api/comp/search` | included |
| `[triggers] crons` on competition-api | hourly drain, nightly sweep | free |

D1 ships the [FTS5 module](https://developers.cloudflare.com/d1/sql-api/sql-statements/),
so ranking runs inside the database we already pay for. `_routes.json` already
includes `/api/*`; there is no new Pages Function and no manifest change.

**Alternatives considered and rejected.** *Vectorize / AI Search* — semantic
retrieval plus an embedding pipeline and per-query cost, to answer a query whose
whole point is the exact token `KANGCK`; also outside the $5/mo constraint. *A
prebuilt index shipped to the browser* — cannot honour `test`-comp visibility (a
hidden competition would sit in every visitor's bundle) and grows without bound.
*A Durable Object holding an in-memory index* — a single coordination point and
cold-start rebuilds, for something D1 indexes natively. *Keeping `LIKE`* (what
`/api/comp/lookup` does) — no relevance ordering, and a full scan of three
tables per keystroke.

## The index

One denormalised document per searchable thing, and an FTS5 index over it. Four
text columns, weighted `10 : 8 : 1 : 0.5` by `bm25()`:

| Column | Holds | Why separate |
|---|---|---|
| `title` | the entity's name | what someone types when they know it |
| `route` | a task's turnpoint codes and descriptions | the discriminator: "Task 3" names a hundred tasks, "KANGCK" names a handful |
| `body` | class, team, format, dates, CIVL id | the rest |
| `owner` | the competition a task or pilot belongs to | see below |

`owner` exists to keep two questions apart. Every word of a query has to be
found in ONE document — nobody thinks of a search as scoped to a level — so
"corryong harrison" only works if the pilot's document names the competition.
But "corryong" *alone* must not then return forty pilots whose only connection
to the word is the competition they are in. So the child query is "every word
somewhere in the document, AND at least one word outside `owner`":

```
("corryong" AND "kangck"*) AND ({title route body} : ("corryong" OR "kangck"*))
```

Two things are deliberately **not** indexed:

- **`comp_waypoints`** — a competition's uploaded waypoint set. The task's own
  frozen `xctsk` is what it actually flew (migration 0015); the shared set may
  have been edited since, so it would answer with a route nobody flew.
- **`comp.test`** — visibility is joined live from `comp` at query time rather
  than copied onto the document, so hiding a competition takes effect on the
  next search rather than after a reindex.

## Freshness: triggers, not call sites

This is the one place the design departs from how `audit()` and
`bumpAndRevalidateScores()` work, and the departure is deliberate.

Those two describe things **only the handler knows**: who did what, and which
tasks a change touched. A search document derives from a handful of columns of
three tables and nothing else — a derivation the database can watch itself. So
triggers push a key onto `search_dirty`, and `src/search-index.ts` drains that
queue:

- **after every mutation**, awaited, in one middleware in `src/index.ts` — so a
  competition created by a request is findable by the request after it;
- **after every search**, on `waitUntil` — search traffic is exactly when the
  index being current matters;
- **hourly**, on a cron, for whatever a bulk import left behind;
- **nightly**, preceded by a sweep for documents that are missing or were
  written by an older builder (`search_doc.rev` vs `SEARCH_DOC_REV`), so a
  change to what a document contains heals itself instead of needing a
  migration;
- **on demand**, `POST /api/admin/search/reindex` (the "Rebuild search index"
  button on `/admin/cache`), which rebuilds everything and asks no questions.
  One request rebuilds up to 4000 documents; a caller with more to do repeats
  with **`?resume=true`**, which drains what is queued *without* queueing the
  whole database again. Without that distinction each repeat re-adds more than
  it can drain and `remaining` never reaches zero.

One middleware instead of twenty-eight call sites, and a route handler added
next year is indexed without anyone remembering to. It also means the paths that
*don't* go through a handler — `bun run seed` writes straight to D1 — are
indexed anyway.

Two details worth knowing:

- **`search_dirty.marked` is a counter, not a flag.** The drain deletes a key
  only if its count is still what it read, so a write that lands mid-rebuild
  survives the delete that ends the pass instead of being swallowed by it.
- **A fresh migration leaves the whole queue dirty and no documents.** The index
  fills over the following hour (a slice per search, then the cron). To have it
  immediately — after a deploy, or in a test — press the admin button.

## At archive scale

Measured against the whole
[glidecomp-archive](https://github.com/pokle/glidecomp-archive) back-catalogue
seeded locally — 24 competitions, 174 tasks, 1219 competition pilots, 4614
tracklogs (`GLIDECOMP_COMPS_DIR=<archive>/comps bun run seed --history`):

| | |
|---|---|
| Documents | 1417 (24 comps, 174 tasks, 1219 pilots) |
| Index on disk | 0.66 MB, of a 2.8 MB database |
| Full rebuild | one request, 164 ms |
| Query | 1–4 ms, 2.4–3 KB responses |

Three things only a database this size showed, all now fixed:

1. **The rebuild never finished.** Each call re-queued all 1417 documents and
   drained 1000, so `remaining` stalled at 417 forever. Hence `?resume=true`.
2. **`forbes` ranked the wrong competitions first.** Three Bright Opens, each
   carrying a pilot called Andrew Forbes, came above every competition actually
   named Forbes Flatlands — one of which fell off the end of the list — because
   bm25 scores a short document higher than a long one for the same word. Hence
   name-matches first.
3. **Six Corryong Cups came back 2025, 2023, 2021, 2024, 2017.** Every one of
   their tasks flies ELLIOT → KANGCK, so the scores were within a single bm25
   point of each other and the difference was purely how long each route is.
   Hence recency, not score, orders competitions.

`elliot kangck` now answers with 13 tasks across five Corryong Cups from 2017 to
2025, newest first, each with its field size — which is the question the feature
was built for and one nothing in the app could answer before.

One archive data gap, unrelated to search: `dalby-big-air-2022-open-t6` has a
task and published results but no tracklogs, and `seed` throws on it
(`No IGC files in …`), aborting the whole run rather than skipping that task.
Everything else seeds.

## Caps and abuse

Public and unauthenticated, like the lookup endpoint next door, so every
dimension is capped: term length and count (`src/search-terms.ts`, shared with
`/api/comp/lookup` so the two tokenise identically), 60 documents considered per
kind, 8 competitions, 24 matched tasks and 24 pilots in a response, 5 task rows
per competition and 3 tasks per matched pilot. That last pair matters because of
the archive: a regular on the circuit has a registration in a dozen events, and
without a per-competition bound one pilot's name filled the page. When something
is dropped the response says `truncated: true` rather than pretending it covered
everything.

Every token is quoted into the FTS5 MATCH expression, so no operator of that
query language can survive user input — `searchTokens` has already stripped the
punctuation, and the quoting is the second of two barriers.

Anonymous answers are `public, max-age=60`; a signed-in answer depends on who is
asking (a comp admin sees their own hidden competitions) and is `private,
no-store`.

## The page

`src/react/pages/Competitions.tsx` runs one box with two jobs, and the boundary
is the number of characters typed:

- **under two characters** — filter the list already on the page, instantly, with
  no network. This is also how the server renders it, so an empty query hydrates
  against identical markup;
- **from two characters** — search the whole site, replacing the flat list with
  the hierarchy.

The query mirrors into `?q=`, so a search is a link. The SSR Pages Function
serves that URL as the plain shell with `noindex`: results are fetched
client-side, there is nothing to server-render, and a search-results URL is not
a page for a crawler to keep. Because the shell carries no `__SSR_DATA__`, the
client creates a fresh root rather than hydrating — no mismatch is possible.

A dropped request is retried (`fetchWithRetry`, now abort-aware so a superseded
query stops immediately) and, if it still fails, reported as "Search is
unavailable" — never as "no matches". That distinction is issue #481's rule
applied to the search box: a failure to ask is not an answer.

## Coverage

- `web/workers/competition-api/test/search.test.ts` — the tokeniser and MATCH
  building, route extraction, the hierarchy, visibility of `test` comps,
  renames/re-routes/deletes reaching the index, the mid-rebuild write, the
  sweep, and the admin rebuild.
- `e2e/search.spec.ts` — the turnpoint query end to end, the linkable `?q=`, the
  empty result, and the failed-search message.
- `e2e/ssr.spec.ts` — `/comp?q=` is a noindex shell and `/comp` is not.

## Not done, deliberately

`/api/comp/lookup` (the 404 page's "did you mean") still runs its own `LIKE`
search. Its contract is different — per-segment terms out of a dead URL — and it
works. Re-pointing it at this index would stop the two drifting, and is the
obvious next step; it is not a prerequisite for anything here. The two already
share `src/search-terms.ts` and `src/comp-visibility.ts`.
