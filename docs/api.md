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
> This document covers only the most useful endpoints, not every endpoint. If
> something here disagrees with reality, the running app is the source of truth.

## Authentication

Most **read** endpoints for public competitions need no authentication at all.
**Writes** (uploading tracks, editing competitions) and a few personal read
endpoints require an API key.

Create a key under **Settings → API keys**. Keys look like `glc_XXXXXXXX…` and
are shown **once** at creation time — copy it immediately. Pass it in the
`x-api-key` header on every request:

```bash
curl -H "x-api-key: glc_XXXXXXXX..." https://glidecomp.com/api/comp
```

Verify a key works by calling the identity endpoint — it returns your user, or
`{"user":null}` if the key is missing or invalid:

```bash
curl -H "x-api-key: glc_XXXXXXXX..." https://glidecomp.com/api/auth/me
```

A key inherits the permissions of the account that created it. If your account
administers a competition, its key can perform admin actions on that comp.

### Object IDs

`comp_id`, `task_id`, and `comp_pilot_id` in URLs are short opaque strings (e.g.
`Ux7Kp2`), **not** raw numbers. Always take them from a list/detail response and
pass them back verbatim. An unrecognisable ID returns `400 {"error":"Invalid comp_id"}`.

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

## Read endpoints

All examples below work anonymously for public (non-test) competitions.

### List competitions

```bash
curl https://glidecomp.com/api/comp
```

Returns public competitions from the last 24 months, newest first. If you send a
key, competitions you administer are merged in with `"is_admin": true`.

```json
{
  "comps": [
    {
      "comp_id": "Ux7Kp2",
      "name": "Corryong Cup 2026",
      "category": "paragliding",
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
curl https://glidecomp.com/api/comp/Ux7Kp2
```

Returns the competition plus its list of tasks (`tasks[]`, each with `task_id`,
`name`, `task_date`, `has_xctsk`, …), pilot count, and admin list.

### Get a task

```bash
curl https://glidecomp.com/api/comp/Ux7Kp2/task/9fBqLm
```

Returns task metadata and `xctsk` — the full XCTrack task definition (turnpoints,
start, goal), or `null` if none is set yet.

### Competition standings

Aggregate results across all tasks, grouped by pilot class:

```bash
curl https://glidecomp.com/api/comp/Ux7Kp2/scores
```

### Task scores

Scored results for a single task:

```bash
curl https://glidecomp.com/api/comp/Ux7Kp2/task/9fBqLm/score
```

Both score endpoints return `computed_at` and a `stale` flag, and carry an
`ETag`. Use it to poll cheaply while a re-score is in flight:

```bash
curl -H 'If-None-Match: "abc123"' \
  https://glidecomp.com/api/comp/Ux7Kp2/task/9fBqLm/score
# -> 304 Not Modified while unchanged; 200 with the new body once it updates
```

A task with no task definition yet returns `422`.

### List tracks on a task

```bash
curl https://glidecomp.com/api/comp/Ux7Kp2/task/9fBqLm/igc
```

Returns one entry per submitted track (`comp_pilot_id`, `pilot_name`,
`pilot_class`, `uploaded_at`, `file_size`, any penalty, …).

### Registered pilots

```bash
curl https://glidecomp.com/api/comp/Ux7Kp2/pilot
```

Returns pilots registered in the comp. Personal contact fields (email, phone)
are redacted unless your key belongs to an admin of that competition.

## Writing: submitting a track

Uploading a track requires a key. The request body is a **gzip-compressed IGC
file** sent as raw bytes (max ~5 MB uncompressed). Uploads are rejected after a
competition's close date.

Upload **your own** track for a task:

```bash
gzip -c flight.igc | \
  curl -X POST \
    -H "x-api-key: glc_XXXXXXXX..." \
    --data-binary @- \
    https://glidecomp.com/api/comp/Ux7Kp2/task/9fBqLm/igc
```

On success you get `201 Created` (or `200` if it replaced an existing track for
you) with the stored track's details. Submitting a track auto-registers you as a
pilot in that competition.

To upload **on behalf of a specific pilot**, append their `comp_pilot_id`:

```bash
gzip -c flight.igc | \
  curl -X POST \
    -H "x-api-key: glc_XXXXXXXX..." \
    --data-binary @- \
    https://glidecomp.com/api/comp/Ux7Kp2/task/9fBqLm/igc/PILOT_ID
```

This is allowed only if your key belongs to a comp admin, or to a registered
pilot when the comp has open track upload enabled — otherwise `403`.

You can download any track back out (raw IGC) from a public comp:

```bash
curl -OJ https://glidecomp.com/api/comp/Ux7Kp2/task/9fBqLm/igc/PILOT_ID/download
```

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

```json
{ "error": "Not authenticated" }
```
