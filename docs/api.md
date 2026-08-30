# GlideComp API

GlideComp exposes an HTTP API over `https://glidecomp.com`. You can create an
API key on your [Settings page](https://glidecomp.com/settings) and use it to
read competition data and submit tracks programmatically.

> ## ⚠️ These APIs primarily drive the GlideComp UI
>
> **This API exists to power the GlideComp web app, not as a stable public
> contract.** Endpoints, request shapes, and response fields **may change at any
> time, without notice or versioning,** whenever GlideComp changes. There is no
> deprecation policy. Do not build anything you can't afford to fix when it
> breaks — pin your integrations to nothing and expect to update them.
>
> This document lists **every** endpoint — `web/scripts/api-doc-coverage.test.ts`
> fails the build if a route exists that is not named here, or if a row here
> names a route that no longer exists. The endpoints with a worked `curl`
> example are additionally *executed* against a live stack by
> `e2e/api-doc.spec.ts`. Completeness and the examples are therefore both
> checked; the prose around them is not, so if something here disagrees with
> reality, the running app is the source of truth.
>
> Endpoints marked **admin** need a key belonging to an administrator of that
> competition. Endpoints marked **internal** are not reachable from the internet
> at all.

## Authentication

Most **read** endpoints for public competitions need no authentication at all.
**Writes** (uploading tracks, editing competitions) and a few personal read
endpoints require an API key.

Create a key under **Settings → API keys**. Keys look like `glc_XXXXXXXX…` and
are shown **once** at creation time — copy it immediately. Pass it in the
`x-api-key` header on every request:

```bash
curl -H "x-api-key: $API_KEY" https://glidecomp.com/api/comp
```

Verify a key works by calling the identity endpoint — it returns your user, or
`{"user":null}` if the key is missing or invalid:

```bash
curl -H "x-api-key: $API_KEY" https://glidecomp.com/api/auth/me
```

A key inherits the permissions of the account that created it. If your account
administers a competition, its key can perform admin actions on that comp.

### Object IDs

`comp_id`, `task_id`, and `comp_pilot_id` in URLs are short opaque strings of
lowercase letters (e.g. `abcde`), **not** raw numbers. Take them from a
list/detail response and pass them back verbatim. An unrecognisable ID returns
`400 {"error":"Invalid comp_id"}`.

### Running the examples

Every example below is a real command. Set these four shell variables once and
you can paste any of them straight into a terminal or a script:

```bash
export API_KEY=glc_XXXXXXXX...          # Settings -> API keys
export COMP_ID=abcde                    # from: GET /api/comp
export TASK_ID=fghij                    # from: GET /api/comp/$COMP_ID
export PILOT_ID=klmno                   # from: GET /api/comp/$COMP_ID/task/$TASK_ID/igc
```

A URL containing a variable is double-quoted so the shell expands it — keep the
quotes if you copy the line. Reference tables use the route's own parameter
names instead (`/api/comp/:comp_id`), because those name the *route*, where a
variable names *your* value.

## Rate limiting

API keys are rate limited to **60 requests per 60 seconds, per key**. This is
sized for interactive UI traffic and light scripting, not bulk crawling.

When you exceed the limit you get:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 30
```

Honour the `Retry-After` header (seconds) and back off — do not blind-retry.
For batch work, add a small delay between calls (roughly 1 request/second keeps
you comfortably under the limit) and cache responses where you can. Score
endpoints return an `ETag`; send it back as `If-None-Match` to get a cheap
`304 Not Modified` instead of re-fetching an unchanged body (see below).

## Competitions and tasks

| Method | Path | |
|---|---|---|
| `GET` | `/api/comp` | Public comps from the last 24 months, newest first |
| `POST` | `/api/comp` | Create a competition; you become its administrator |
| `GET` | `/api/comp/:comp_id` | One comp, with its tasks, pilot count and admins |
| `PATCH` | `/api/comp/:comp_id` | Edit name, category, dates, scoring format, GAP params — **admin** |
| `DELETE` | `/api/comp/:comp_id` | Delete the comp and everything under it — **admin** |
| `POST` | `/api/comp/:comp_id/task` | Add a task — **admin** |
| `GET` | `/api/comp/:comp_id/task/:task_id` | Task metadata and its `xctsk` definition |
| `PATCH` | `/api/comp/:comp_id/task/:task_id` | Edit the task's date, classes or route — **admin** |
| `DELETE` | `/api/comp/:comp_id/task/:task_id` | Delete the task — **admin** |
| `GET` | `/api/comp/:comp_id/audit` | The comp's transparency log: every change, who made it, when |

Every mutation above is audit-logged and, where it can move a score, marks the
affected scores stale — see [the audit rules](../CLAUDE.md).

All examples below work anonymously for public (non-test) competitions.

### List competitions

```bash
curl https://glidecomp.com/api/comp
```

Returns public competitions from the last 24 months, newest first. If you send a
key, competitions you administer are merged in with `"is_admin": true`.
`category` is `"hg"` (hang gliding) or `"pg"` (paragliding).

```json
{
  "comps": [
    {
      "comp_id": "compa",
      "name": "Corryong Cup 2026",
      "category": "pg",
      "scoring_format": "gap",
      "first_task_date": "2026-01-04",
      "last_task_date": "2026-01-10",
      "pilot_classes": ["open", "floater"],
      "..." : "..."
    }
  ]
}
```

### Get one competition

```bash
curl "https://glidecomp.com/api/comp/$COMP_ID"
```

Returns the competition plus its list of tasks (`tasks[]`, each with `task_id`,
`name`, `task_date`, `has_xctsk`, …), pilot count, and admin list.

### Get a task

```bash
curl "https://glidecomp.com/api/comp/$COMP_ID/task/$TASK_ID"
```

Returns task metadata and `xctsk` — the full XCTrack task definition (turnpoints,
start, goal), or `null` if none is set yet.

## Scores and analysis

| Method | Path | |
|---|---|---|
| `GET` | `/api/comp/:comp_id/scores` | Aggregate results across every task, by pilot class |
| `GET` | `/api/comp/:comp_id/task/:task_id/score` | One task's scored results |
| `GET` | `/api/comp/:comp_id/task/:task_id/pilot/:comp_pilot_id/analysis` | One pilot's **report card**: every scoring decision, explained |
| `POST` | `/api/comp/:comp_id/rescore` | Force a full recompute — **admin**, and expensive |
| `GET` | `/api/comp/:comp_id/analysis` | **Comp analysis** — behaviours across every task |
| `GET` | `/api/comp/:comp_id/task/:task_id/analysis` | **Task analysis** — behaviours within one task's field |
| `POST` | `/api/comp/:comp_id/task/:task_id/analysis/refresh` | Recompute one task analysis — **admin** |
| `GET` | `/api/comp/:comp_id/task/:task_id/3dvis` | Packed 3D track data for the replay viewer |
| `GET` | `/api/comp/sample-3dvis` | The bundled sample pack, for trying the replay without a comp |

Scores are **stale-first**: a read never computes, it serves the last result
with a `stale` flag and schedules a recompute. Poll with the `ETag` rather than
blocking. You never need `/rescore` for an ordinary edit — every mutation marks
what it affects stale by itself.

Both analyses were served under `/field-analysis` until the two were named
apart. The old paths still answer, with a `308` to the new one — the method,
body and query string all survive the hop, so an integrator on the old URL
needs no change beyond following redirects (every HTTP client does by default).

| Method | Path | |
|---|---|---|
| `ALL` | `/api/comp/:comp_id/field-analysis` | Superseded — `308` to `/api/comp/:comp_id/analysis` |
| `ALL` | `/api/comp/:comp_id/task/:task_id/field-analysis` | Superseded — `308` to `…/task/:task_id/analysis` |
| `ALL` | `/api/comp/:comp_id/task/:task_id/field-analysis/refresh` | Superseded — `308` to `…/analysis/refresh` |

### Competition scores

Aggregate results across all tasks, grouped by pilot class:

```bash
curl "https://glidecomp.com/api/comp/$COMP_ID/scores"
```

This can take several seconds to compute if it isn't cached.

### Task scores

Scored results for a single task:

```bash
curl "https://glidecomp.com/api/comp/$COMP_ID/task/$TASK_ID/score"
```

Both score endpoints return their per-class results as **`class_scores`**, an
array of `{ pilot_class, pilots }`. The shape is the same on both, so one
reader handles either.

> **Changed 2026-08.** This array used to be called `standings` on the
> competition endpoint and `classes` on the task endpoint — the same data under
> two names. Both are now `class_scores`, and the old names are gone. (The
> competition response also has a `tasks[].classes`, which is unrelated: it is
> the list of class *names* a task was scored for.)

Both score endpoints return `computed_at` and a `stale` flag, and carry an
`ETag`. Use it to poll cheaply while a re-score is in flight:

```bash
curl -H 'If-None-Match: "abc123"' \
  "https://glidecomp.com/api/comp/$COMP_ID/task/$TASK_ID/score"
# -> 304 Not Modified while unchanged; 200 with the new body once it updates
```

A task with no task definition yet returns `422`.

### Task analysis

```bash
curl "https://glidecomp.com/api/comp/$COMP_ID/task/$TASK_ID/analysis"
```

Per-pilot behavioural metrics across one task's whole field (climbing, gliding,
decision-making, gaggle, race craft, day profile), ranked by their Spearman
correlation against GAP rank. Expensive to compute, so a cold report returns
`pending` and is scheduled — poll until it lands.

### Comp analysis

```bash
curl "https://glidecomp.com/api/comp/$COMP_ID/analysis"
```

The same metrics aggregated across every task of the competition, which is what
tells a metric that holds across days from one that just suited one day's
weather. A pure aggregation over the stored task analyses: tasks with no report
yet are scheduled and reported as `pending` rather than computed inline.

## Tracks, flights and pilot status

| Method | Path | |
|---|---|---|
| `GET` | `/api/comp/:comp_id/task/:task_id/igc` | Every track submitted for the task |
| `POST` | `/api/comp/:comp_id/task/:task_id/igc` | Upload **your own** track (gzipped IGC) |
| `POST` | `/api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id` | Upload on behalf of a pilot — **admin**, or open upload |
| `GET` | `/api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id/download` | Download the stored track as raw IGC |
| `PATCH` | `/api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id` | Set a penalty or its reason — **admin** |
| `PATCH` | `/api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id/quality-override` | Overrule a track-quality verdict (FAI S7A §4.4.6) — **admin** |
| `DELETE` | `/api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id` | Withdraw the track — **admin** |
| `POST` | `/api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id/restore` | Restore a withdrawn track — **admin** |
| `POST` | `/api/comp/:comp_id/task/:task_id/igc/open-submit` | Anonymous submission, when the organiser has opened it |
| `GET` | `/api/comp/:comp_id/task/:task_id/manual-flight` | Manual (track-less) flight reports for the task |
| `GET` | `/api/comp/:comp_id/task/:task_id/manual-flight/:comp_pilot_id/history` | Every version of one pilot's report — nothing is deleted |
| `PUT` | `/api/comp/:comp_id/task/:task_id/manual-flight/:comp_pilot_id` | Record a manual flight — **admin** |
| `DELETE` | `/api/comp/:comp_id/task/:task_id/manual-flight/:comp_pilot_id` | Supersede it — **admin** |
| `POST` | `/api/comp/:comp_id/task/:task_id/manual-flight/:comp_pilot_id/restore/:manual_flight_id` | Reinstate an earlier version — **admin** |
| `GET` | `/api/comp/:comp_id/task/:task_id/pilot-status` | Who is absent, DNF or landed — these feed launch validity |
| `PUT` | `/api/comp/:comp_id/task/:task_id/pilot-status/:comp_pilot_id` | Set a pilot's status — **admin** |
| `PATCH` | `/api/comp/:comp_id/task/:task_id/pilot-status/:comp_pilot_id` | Amend it — **admin** |
| `DELETE` | `/api/comp/:comp_id/task/:task_id/pilot-status/:comp_pilot_id` | Clear it — **admin** |

### List tracks on a task

```bash
curl "https://glidecomp.com/api/comp/$COMP_ID/task/$TASK_ID/igc"
```

Returns one entry per submitted track (`comp_pilot_id`, `pilot_name`,
`pilot_class`, `uploaded_at`, `file_size`, any penalty, …).

## Pilots and registration

| Method | Path | |
|---|---|---|
| `GET` | `/api/comp/:comp_id/pilot` | The comp roster |
| `POST` | `/api/comp/:comp_id/pilot` | Register one pilot — **admin** |
| `POST` | `/api/comp/:comp_id/pilot/bulk` | Register many at once — **admin** |
| `POST` | `/api/comp/:comp_id/pilot/civl-rankings` | Attach CIVL world ranking points to the roster — **admin** |
| `PATCH` | `/api/comp/:comp_id/pilot/:comp_pilot_id` | Edit a roster entry — **admin** |
| `DELETE` | `/api/comp/:comp_id/pilot/:comp_pilot_id` | Remove a pilot — **admin** |
| `POST` | `/api/comp/:comp_id/registration/resolve` | Say which unclaimed roster entry you are, before uploading |

A pilot's registration is **never guessed**. If a comp holds unclaimed roster
entries, an upload answers `409 identity_ambiguous` and you settle it with
`/registration/resolve` rather than having a second, empty entry created for you.

### Registered pilots

```bash
curl "https://glidecomp.com/api/comp/$COMP_ID/pilot"
```

Returns pilots registered in the comp. Personal contact fields (email, phone)
are redacted unless your key belongs to an admin of that competition.

## Waypoints and weather

| Method | Path | |
|---|---|---|
| `GET` | `/api/comp/:comp_id/waypoints` | The comp's region waypoints |
| `PUT` | `/api/comp/:comp_id/waypoints` | Replace the waypoint file — **admin** |
| `GET` | `/api/comp/:comp_id/waypoints/:format` | The same set, converted |
| `GET` | `/api/comp/:comp_id/task/:task_id/waypoints/:format` | Just the waypoints one task uses |
| `GET` | `/api/comp/:comp_id/task/:task_id/weather` | Modelled weather for the route and date |
| `POST` | `/api/comp/:comp_id/task/:task_id/weather/refresh` | Re-fetch from the provider — **admin** |

Weather is a **prediction, never a record**: every answer names its provider and
says whether it is a forecast or a reanalysis.

### Task weather

```bash
curl "https://glidecomp.com/api/comp/$COMP_ID/task/$TASK_ID/weather"
```

The modelled weather for the task's route and date — winds, thermal top, and
whatever else the source carries — each answer stamped with the provider and
whether it is a record or a forecast. Answers are cached; a task nobody has
opened yet returns a `pending` marker rather than blocking on the provider, so
poll if you get one.

### Competition waypoints

```bash
curl "https://glidecomp.com/api/comp/$COMP_ID/waypoints"
```

```bash
curl "https://glidecomp.com/api/comp/$COMP_ID/waypoints/gpx"
```

The comp's region waypoints. The `:format` segment is one of `seeyou-cup`,
`gpx`, `compegps`, `ozi`, `fs-geo`, `fs-utm`, `kml`, `csv` — anything else is
`404`. Add `…/task/$TASK_ID/waypoints/:format` for just the waypoints one task
uses (that one also accepts `xctsk`).

## Discovery

| Method | Path | |
|---|---|---|
| `GET` | `/api/comp/search` | Full-text search over comps, tasks, turnpoints and pilots |
| `GET` | `/api/comp/lookup` | Name search returning ids — repairs a dead `/comp` URL |
| `GET` | `/api/comp/open-now` | Comps currently accepting track submissions |

Neither can reveal a hidden `test` comp to someone who could not already see it.

```bash
curl https://glidecomp.com/api/comp/search?q=corryong
```

```bash
curl https://glidecomp.com/api/comp/open-now
```

### Finding a comp, task or pilot by name

```bash
curl https://glidecomp.com/api/comp/lookup?comp_q=corryong
```

A capped name search over comps, tasks and pilots, returning ids and names.
It's what the "did you mean…" repair on a dead `/comp` URL runs on. Accepts
`comp_q`, `task_q` and `pilot_q`.

## Your account

| Method | Path | |
|---|---|---|
| `GET` | `/api/auth/me` | Who this key belongs to; `{"user":null}` if it is bad |
| `POST` | `/api/auth/set-name` | Change your display name |
| `POST` | `/api/auth/set-username` | Claim or change your public `/u/<username>` |
| `POST` | `/api/auth/delete-account` | Delete your account |
| `GET` | `/api/auth/preferences` | Units, timezone and display preferences |
| `PUT` | `/api/auth/preferences` | Update them |
| `ALL` | `/api/auth/*` | Everything else Better Auth serves: sessions, email OTP, API-key management |
| `GET` | `/api/comp/pilot` | Your pilot profile (CIVL id, wing, nationality) |
| `PATCH` | `/api/comp/pilot` | Update it |
| `GET` | `/api/comp/pilot/flights` | Every comp flight of yours, across competitions |

```bash
curl -H "x-api-key: $API_KEY" https://glidecomp.com/api/comp/pilot
```

## Personal track library

Your own tracks and tasks, outside any competition — what the analysis page
reads. All of it needs a key; the `/api/u/` routes are the public read side of
whatever you have chosen to share under your username.

| Method | Path | |
|---|---|---|
| `GET` | `/api/user/tracks` | List your stored tracks |
| `POST` | `/api/user/tracks` | Upload one |
| `GET` | `/api/user/tracks/:track_id` | Fetch one back |
| `DELETE` | `/api/user/tracks/:track_id` | Delete it |
| `GET` | `/api/user/tracks/:track_id/annotations` | Your drawn annotations on that track |
| `PUT` | `/api/user/tracks/:track_id/annotations/:stroke_id` | Add or replace one stroke |
| `DELETE` | `/api/user/tracks/:track_id/annotations/:stroke_id` | Delete one stroke |
| `DELETE` | `/api/user/tracks/:track_id/annotations` | Clear them all |
| `GET` | `/api/user/tasks` | List your stored tasks |
| `POST` | `/api/user/tasks` | Store one |
| `GET` | `/api/user/tasks/:task_code` | Fetch one back |
| `DELETE` | `/api/user/tasks/:task_code` | Delete it |
| `GET` | `/api/u/:username/track/:track_id` | Public: someone's shared track |
| `GET` | `/api/u/:username/track/:track_id/annotations` | Public: its annotations |
| `GET` | `/api/u/:username/task/:task_code` | Public: someone's shared task |

```bash
curl -H "x-api-key: $API_KEY" https://glidecomp.com/api/user/tracks
```

## Site endpoints

Served by Pages Functions rather than the API workers, so they sit at the site
root and not under `/api/`. They are meant to be opened in a browser or read by
a crawler, and they are a contract all the same.

| Method | Path | |
|---|---|---|
| `GET` | `/sitemap.xml` | Every public comp, its scores and its comp analysis |
| `GET` | `/civl-rankings.csv` | The CIVL monthly world ranking, as CSV |
| `GET` | `/comp/:comp_id/scores.csv` | The scores page's downloadable twin |
| `GET` | `/api/civl-rankings.csv` | The same ranking data, under `/api/` |

### CIVL world rankings

```bash
curl https://glidecomp.com/civl-rankings.csv?slug=hang-gliding-class-1-xc
```

The FAI/CIVL monthly world ranking as imported by GlideComp, as CSV: latest
month only, all ten disciplines unless you narrow it with `?slug=`. Every row is
a copy of a public CIVL list. The site-root URL is the one to open in a browser;
`/api/civl-rankings.csv` serves the same bytes for a script already pointed at
the API:

```bash
curl https://glidecomp.com/api/civl-rankings.csv?slug=hang-gliding-class-1-xc
```

`/sitemap.xml` and `/comp/:comp_id/scores.csv` have no worked example here
because Pages Functions do not run under `bun run dev`, which is the stack
`e2e/api-doc.spec.ts` executes these commands against — an example it could not
run would be an example nothing checks.

## Writing: submitting a track

Uploading a track requires a key. The request body is a **gzip-compressed IGC
file** sent as raw bytes: at most 1 MiB compressed, and at most 2 MiB once
decompressed. Uploads are rejected after a competition's close date.

Pilots can also submit without a key at all, from the website's `/submit` page —
see [track-submission.md](track-submission.md).

Upload **your own** track for a task:

```bash
gzip -c flight.igc | \
  curl -X POST \
    -H "x-api-key: $API_KEY" \
    --data-binary @- \
    "https://glidecomp.com/api/comp/$COMP_ID/task/$TASK_ID/igc"
```

On success you get `201 Created` (or `200` if it replaced an existing track for
you) with the stored track's details. Submitting a track auto-registers you as a
pilot in that competition.

To upload **on behalf of a specific pilot**, append their `comp_pilot_id`:

```bash
gzip -c flight.igc | \
  curl -X POST \
    -H "x-api-key: $API_KEY" \
    --data-binary @- \
    "https://glidecomp.com/api/comp/$COMP_ID/task/$TASK_ID/igc/$PILOT_ID"
```

This is allowed only if your key belongs to a comp admin, or to a registered
pilot when the comp has open track upload enabled — otherwise `403`.

You can download any track back out (raw IGC) from a public comp:

```bash
curl -OJ "https://glidecomp.com/api/comp/$COMP_ID/task/$TASK_ID/igc/$PILOT_ID/download"
```

## Administration, internal and development-only

Listed for completeness. None of these is part of what an API key is for: the
`/api/admin/` routes need a GlideComp **super-admin** (not a comp admin), the
`/internal/` routes are service-binding-only and are not routable from the
internet at all, and the development ones return `404` anywhere but a local dev
stack.

| Method | Path | |
|---|---|---|
| `GET` | `/api/admin/whoami` | Whether the caller is a super-admin |
| `GET` | `/api/admin/users` | The user list |
| `GET` | `/api/admin/cache/stats` | Cache occupancy |
| `DELETE` | `/api/admin/cache` | Drop cached scores and analyses |
| `POST` | `/api/admin/search/reindex` | Drain the search-index queue by hand |
| `GET` | `/internal/cache/stats` | **Internal.** Worker-to-worker cache stats |
| `POST` | `/internal/cache/clear` | **Internal.** Worker-to-worker cache clear |
| `GET` | `/api/airscore` | AirScore import worker: service description |
| `GET` | `/api/airscore/task` | Fetch a task from an AirScore instance |
| `GET` | `/api/airscore/track` | Fetch a track from an AirScore instance |
| `POST` | `/api/auth/dev-login` | **Dev only.** Sign in without OAuth |
| `GET` | `/api/auth/dev-last-otp` | **Dev only.** Read back the last email OTP |

## Errors

Errors are JSON with an `error` message and a matching HTTP status:

| Status | Meaning |
|--------|---------|
| `400`  | Bad request — e.g. an unrecognisable object ID |
| `401`  | Not authenticated — missing or invalid API key on a protected endpoint |
| `403`  | Authenticated, but not allowed to do this |
| `404`  | Not found (also returned for test comps you can't see) |
| `422`  | Understood but unprocessable — e.g. scoring a task with no definition |
| `429`  | Rate limited — see `Retry-After` |
| `503`  | We couldn't check your credentials — the request was never authorized either way, so retrying is safe |

```json
{ "error": "Not authenticated" }
```
