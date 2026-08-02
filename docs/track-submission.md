# Track submission

How an IGC file gets into a competition, and the trade-off the quick path makes.

## The problem

A pilot who has just landed wants to do one thing. Before this, that was the
hardest path on the site: find the competition, drill to the right task, sign
in, upload. The homepage offered "Start a competition" and "Browse
competitions" and nothing about submitting; the task page's fallback for a
signed-out visitor was a button reading "Sign in to submit your track".

## The flow

**`/submit`** (`src/react/pages/SubmitTrack.tsx`) is a real page, linked from
the homepage hero and from the nav on every page. It asks three things:

1. **Which task** — from `GET /api/comp/open-now`, with the most likely one
   already chosen.
2. **Who the track is for** — an identifier the organiser already registered.
3. **The IGC file.**

`?comp=` and `?task=` prefill the first step, so the URL is worth putting on a
poster or behind a QR code at launch.

### One flow, two presentations

The logic lives in `src/react/comp/SubmitTrackForm.tsx` and its DOM-free half
in `submit-track.ts`. Two things render it:

- `pages/SubmitTrack.tsx` — as page content.
- `comp/SubmitTrackDialog.tsx` — a `Modal` wrapper, for the comp and task
  pages, where comp and task are already known and those steps collapse to a
  line with a **Change** button.

A step never simply disappears when it is prefilled. Filing a track against
yesterday's task without ever being shown which task it was is the commonest
way this kind of flow fails.

The only behavioural difference between the two is what happens on success: the
dialog closes itself after a clean upload (and never when there are
track-quality findings — it would take the warning away before it was read),
and the page has nothing to close.

### The third entry point, and the size rule

`comp/TaskStandings.tsx` — the admin manage grid — deliberately does **not**
open the form. The pilot is already known from the row, so a dialog that asked
which pilot would be worse than the `FileTrigger` it has. What it must share is
the *rules*, and it did not: it carried an invented `file.size > 5 MB` check on
the uncompressed file.

The server enforces two caps
(`web/workers/competition-api/src/igc-validation.ts`), and the second is the one
that bites:

| Cap | Value | What breaches it |
|---|---|---|
| Compressed body | 1 MiB | essentially nothing — IGC gzips about 8:1 |
| Decompressed text | 2 MiB | an ordinary all-day flight logged at 1 Hz |

So a check on the compressed size alone looks right, passes every file anyone
tries, and still hands the pilot a bare 400 for the case that actually happens.
Both call sites go through `tooLargeReason(rawBytes, compressedBytes)` in
`submit-track.ts`, which names the limit and says what to do about it.

The grid shares one more thing: `describeUploadOutcome()`. A wrong-day or
wrong-place track is **stored and then withheld from scoring**, so announcing
"Track uploaded" over the top of that says the opposite of what happened — and
on this screen the pilot whose track it is never sees the message, so the
organiser is the only person who could act on it.

### Picking the task

A `RadioGroup`, not a row of buttons and not a `Select`. It is one choice out
of a small set that must stay **visible**: seeing the date beside each task is
how a pilot avoids filing today's flight against yesterday's task, and a
control that collapses to the chosen value takes away the thing worth reading.
Radio semantics also carry arrow-key navigation and "3 of 7" for free.

Each task names its pilot class **only when its own title doesn't**
(`unnamedClasses()`): "Task 1 (Open)" repeats nothing, but a task called
"Boosfy" gives the pilot no way to see which field they are filing into. The
radio's `aria-label` composes the same words with separators, because the
visible parts are laid out with a flex gap and would otherwise be read as
"Boosfysport2026-08-02".

**Choosing does not close the list.** The picker collapses to a line with a
**Change** button in exactly one case: the caller already named the task, which
is the dialog on a comp or task page where the flow is a two-field form and a
list of one is noise. It never collapses because the pilot picked something.
Selecting a task is not finishing with it — confirming the choice against the
dates either side is the entire reason the dates are printed, and a control
that answers once and shuts turns a glance into two taps. The chosen comp also
survives the search box and the three-comp cap: a checked radio that isn't
rendered is a selection the pilot can't see, check or undo.

**Most recent task first**, ordered by the endpoint (`open-comps.ts`), ties
broken by name so two classes on one day stay stable. A pilot submits after
landing, so the task they mean is at the recent end; on day six of a comp,
oldest-first makes them read past five days they have already filed. The
suggested task is derived from the dates and never from the array's ends — it
used to read `tasks[tasks.length - 1]`, which silently meant "oldest" the
moment the wire order flipped.

If the list ever outgrows a screen, `ListBox` with a section per competition is
the next step up; `ComboBox` only once searching beats scanning.

### Which endpoint

Decided in one place, by whether there is a session:

| Caller | Route |
|---|---|
| Signed in, for themselves | `POST /api/comp/:comp_id/task/:task_id/igc` |
| Signed in, on behalf | `POST …/igc/:comp_pilot_id` |
| Not signed in | `POST …/igc/open-submit` |

The first two are unchanged, so open registration and the existing on-behalf
rights keep working exactly as they did.

### Open registration

`comp.open_registration` (migration 0027). **On by default**, which is exactly
how every competition behaved before it existed: the signed-in route calls
`ensureCompPilot`, which creates a `comp_pilot` row when the caller has none, so
anyone signed in joins a competition the first time they submit.

Until 0027 that was unconditional — no column, no setting, nothing in the
settings dialog — so an organiser reading their own settings could not discover
it. It matters more with a public `/submit` front door, so it is now a switch
they can see. Off, the upload answers `403 registration_closed` naming the
organisers; pilots the organiser already registered are unaffected, because they
are on the roster and nothing needs creating.

Two things that are deliberately NOT this setting:

- `open_igc_upload` (migration 0005) governs acting for **other** pilots. Both
  sit adjacent in the settings dialog, worded to contrast: "register themselves"
  against "for each other".
- The **anonymous** route never creates anything whatever `open_registration`
  says — the identifier must already match the roster.

**Where it is visible.** The pilots list carries an "Open registration" /
"Registration closed" badge and one sentence, because the roster is the list
that grows and so the place the consequence is legible. Turning it on or off is
audit-logged, and so is a pilot joining ("Registered pilot … on first upload") —
that last one used to be silent, leaving the transparency record showing a track
for a pilot it never saw register, while the pilot count feeds launch validity
(S7F §9.1).

One rough edge remains: **a roster added by name only cannot use the anonymous
flow at all**, because the identifier is the only key and name matching is
deliberately refused.

## Anonymous submission

`web/workers/competition-api/src/routes/igc-anon.ts`.

No session. The submitter names a pilot with an identifier — a CIVL ID, an
email address, one of the six other national bodies — and it is matched against
that competition's roster by `findCompPilotsByIdentifier` in `pilot-linker.ts`.

The identifier travels in **headers** (`x-pilot-ident-kind`, `x-pilot-ident`,
percent-encoded), not the query string: the value can be an email address, and
query strings land in access logs, `Referer` and browser history. The body
stays raw gzip, so all three upload routes share one validator. Both headers
are in the CORS `allowHeaders` list — without that, every browser preflight
fails, and only in a real browser.

### The trade-off, stated plainly

**The identifier is a name, not a secret.** `GET /api/comp/:comp_id/pilot` is
public and returns every pilot's national IDs; CIVL ids are on the FAI ranking
site besides. Anyone who can read the roster can submit as anyone on it.

That is a deliberate choice for low-stakes competitions, and the same posture
`email-submission-spec.md` argues for: flag, don't reject. What contains it:

- the organiser controls it per competition via `open_igc_upload` — the same
  switch that already lets registered pilots upload for each other. **Note it
  defaults to 1** (migration 0005), so it is opt-*out*, not opt-in;
- the identifier must **already** be on the roster. This route never creates a
  `pilot` or a `comp_pilot`, so it cannot grow a competition — and therefore
  cannot push `MAX_PILOTS_PER_TASK` either;
- **never a name match.** `pilot-linker.ts` and `pilot-resolver.ts` both refuse
  to auto-link on a name because two people share one. An anonymous caller has
  strictly less standing than either, and names are on the public roster, so a
  name match would mean typing nothing you cannot already see;
- every submission is in the public audit log, named as anonymous;
- a **replacement emails the pilot** (`track-replaced-email.ts`) — that notice
  is the detection channel, which is why it goes out on every replacement and
  not only suspicious ones;
- the superseded track is retained; `POST …/igc/:comp_pilot_id/restore` already
  exists for admins;
- track quality still withholds a wrong-day or wrong-place file from scoring;
- budgets (below) bound how much of any of this is possible.

Residual risk this does **not** cover: somebody who uploads a plausible but
worse track from the same day and place. That is inherent to the decision, and
is mitigated by the notice and the audit trail rather than prevented.

### Budgets

`src/rate-limit.ts`, one atomic upsert against the `rateLimit` table migration
0017 already ships. The unit worth protecting is *a pilot's track*, not a
request.

| Key | Budget | Why |
|---|---|---|
| `anon-igc:cp:<comp_pilot_id>` | 6 / 24 h | Enough to fix a genuinely wrong upload several times; not enough to sit there overwriting somebody else's. |
| `anon-igc:comp:<comp_id>` | 300 / 24 h | Above anything a real comp does, below a flood. |
| `anon-igc:miss:<ip>` | 20 / 24 h | Charged **only** on `no_pilot_match`, so the endpoint cannot become a fast way to test whether an address is registered. National IDs are already public; email addresses are not. |

Order of work is a cost decision: the comp budget and the header parse run
before any lookup, the pilot budget after the match (an attacker cannot burn a
real pilot's allowance without an identifier that resolves), and the file is
only read once all of that has passed.

### Errors are repairable

Every failure answers `{ error, code, ...context }`. `error` is the sentence a
person reads; `code` is what the dialog branches on, via `repairStepFor()`,
to reopen the step that can fix it.

| code | Status | Repairs by |
|---|---|---|
| `bad_identifier` | 400 | Re-entering the identifier |
| `no_pilot_match` | 404 | Another identifier, or emailing the organiser |
| `ambiguous_pilot_match` | 409 | Only the organiser — a duplicated roster row |
| `anonymous_not_permitted` | 403 | Signing in |
| `comp_closed` | 400 | Nothing; it says so |
| `comp_not_found` / `task_not_found` | 404 | Re-picking the task |
| `invalid_file` | 400 | Another file |
| `task_pilot_limit` | 400 | The organiser |
| `rate_limited` | 429 | Waiting (`Retry-After`, exposed via CORS) |

Where the pilot cannot fix it, the answer names the organiser and carries their
address so the dialog can render a `mailto:` — the same thing the public comp
page already does (`CompDetail.tsx`). A hidden `test` comp answers exactly as a
missing one, so this is never how somebody discovers one exists.

**Track quality is not an error.** A wrong-day or wrong-place HARD verdict still
returns 201/200 and still stores the file; it is presented as a loud warning
with a "submit the right file" action. Do not merge the two concerns —
`igc-validation.ts` rejects, `track-quality.ts` informs.

## Feedback

### What we received

Every upload route returns `flight_summary`, built by `summariseFlight` in
`web/engine/src/flight-summary.ts`: flight date, take off, landing, airborne
time, track length, highest point, and the pilot and glider named in the file.

This exists because the scores are minutes away — a background revalidation
that depends on everyone else's tracks — and this is the only cheap moment at
which yesterday's file is still catchable. It composes `detectTakeoffLanding`
and `calculateTrackDistance`; it does **not** call `detectFlightEvents`, which
additionally runs thermal, glide and circle detection.

Every derived field is nullable. A value that could not be determined is
absent, not zero: a confident "0 km" is worse than a blank. `flightDate` is null
when the header carried no `HFDTE`, because the parser then dates the fixes
from the parse day and the times are not evidence of a date.

The routes parse the file **once** and hand the result to the quality
assessment and the summary both (`src/track-upload.ts`). They used to parse
twice.

The success panel offers **one** destination — *View provisional score card* —
plus *Submit another track*. There is deliberately no "Go to the task" beside
it: the report card answers the question the pilot actually has, and the task
page is one click on from there. Two equal-looking buttons only ask them to
choose between things they cannot tell apart.

### The provisional score card

The success panel links straight to `/comp/:id/task/:id/pilot/:id`. Scores are
stale-first — a read never computes — so straight after an upload the served
blob is the pre-upload one and does not contain this pilot.

`PilotScoreDetail.tsx` therefore distinguishes a **wait** from a **404**: when
the pilot is missing and `score.stale` is true, it throws `ScorePendingError`
and renders "your track is in, working out the scores", polling with backoff.
Telling somebody who has just submitted that their score cannot be found reads
as "your track did not go in", which is the worst answer available.

## Open competitions

`GET /api/comp/open-now` (`routes/open-comps.ts`) — public, unauthenticated,
`Cache-Control: public, max-age=60`.

Competitions that are not closed, have `open_igc_upload` on, are not `test`, and
whose task window contains today ±2 days, each with its tasks and a
`suggested_task_id` (the task dated today, else the most recent already flown —
a pilot uploads after landing, so the past beats the future).

The answer does not vary by caller, which is what makes one shared cached body
correct. It **does** vary by what day it is, so the body carries `generated_at`
and `window`, and the 60s cache must not be widened.

Mounted ahead of `compRoutes`, like `lookup` and `search`. Both new routes use a
hyphenated segment (`open-now`, `open-submit`) so they can never collide with a
sqid — the alphabet is a–z only.

## Where things are

| Thing | File |
|---|---|
| The flow | `src/react/comp/SubmitTrackForm.tsx` |
| Its DOM-free logic + tests | `src/react/comp/submit-track.ts` |
| Dialog wrapper | `src/react/comp/SubmitTrackDialog.tsx` |
| Admin per-row upload | `src/react/comp/TaskStandings.tsx` |
| The page | `src/react/pages/SubmitTrack.tsx` |
| Anonymous route | `web/workers/competition-api/src/routes/igc-anon.ts` |
| Shared upload half | `web/workers/competition-api/src/track-upload.ts` |
| Roster matcher | `web/workers/competition-api/src/pilot-linker.ts` |
| Budgets | `web/workers/competition-api/src/rate-limit.ts` |
| Replacement notice | `web/workers/competition-api/src/track-replaced-email.ts` |
| Open competitions | `web/workers/competition-api/src/routes/open-comps.ts` |
| Flight summary | `web/engine/src/flight-summary.ts` |
| Coverage | `test/igc-anon.test.ts`, `test/open-comps.test.ts`, `e2e/track-submission.spec.ts` |
