# Track submission

How an IGC file gets into a competition, and the trade-off the quick path makes.

## The problem

A pilot who has just landed wants to do one thing. Before this, that was the
hardest path on the site: find the competition, drill to the right task, sign
in, upload. The homepage offered "Start a competition" and "Browse
competitions" and nothing about submitting; the task page's fallback for a
signed-out visitor was a button reading "Sign in to submit your track".

## The flow

**`/submit`** (`src/react/pages/SubmitTrack.tsx`) is a real page, reached from a
**Submit track** tab in the nav on every page — the SPA header
(`components/Shell.tsx`) and the prerendered static one (`SiteHeader.astro`)
both carry it. The homepage hero deliberately does **not**:
its job is to explain what GlideComp is to somebody who has never seen it, and a
third competing action there was buying reach with clarity. The hero says the
words instead, under the two buttons — *"Free · Submit a track and read the
scores without an account"*. It asks three things:

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
- `comp/SubmitTrackDialog.tsx` — a `Modal` wrapper, for the **task page**
  (`pages/TaskDetail.tsx` and, inside it, `comp/TaskResults.tsx`), where comp
  and task are already known and those steps collapse to a line with a
  **Change** button.

The comp page is the third way in, and it opens neither: `pages/CompDetail.tsx`
links to `/submit?comp=<id>`. From a comp page the task is still an open
question, and the page is where that question gets asked — a dialog opening onto
a task picker would only be the page in a smaller box. Both the comp and the
task button are mount-gated, because both pages are server-rendered, and neither
is gated on a session.

A step never simply disappears when it is prefilled. Filing a track against
yesterday's task without ever being shown which task it was is the commonest
way this kind of flow fails.

The only behavioural difference between the two is what happens on success: the
dialog closes itself after a clean upload (and never when there are
track-quality findings — it would take the warning away before it was read),
and the page has nothing to close.

### The admin grid, and the size rule

`comp/TaskScores.tsx` — the admin manage grid — deliberately does **not**
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
is the dialog on a task page where the flow is a two-field form and a list of
one is noise. It never collapses because the pilot picked something.
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

### What the browser remembers

A successful **anonymous** submission writes one entry to `localStorage` under
`glidecomp:last-submit` (`readLastSubmission` / `writeLastSubmission` in
`submit-track.ts`): the comp id, the task id, and the identifier the submitter
named the pilot with — its kind and its value, trimmed. Day two of a six-day
comp then costs no typing. The identifier prefills, and `pickDefaultTask` puts
that comp's current task ahead of everything except an explicit `?comp=` /
`?task=`. A signed-in submission writes nothing, and the entry is read back only
while there is no session and nobody has touched the identity fields.

Say what that is, because the value can be an **email address** and `/submit` is
a public page a pilot may well open on a borrowed phone at launch or on a shared
laptop in the HQ tent. It is one entry, in that browser's own storage, holding
two ids and one identifier — no name, no file, no session. It has **no expiry
and nothing clears it**: there is no TTL, no sign-out hook and no "forget me"
control in the flow, so it lives until the browser's site data for GlideComp is
cleared. Anything malformed reads back as nothing, and a storage that refuses
the write (private browsing, a full quota) is ignored rather than failing the
upload.

It is a convenience and never a credential. The worker re-checks the identifier
against the roster on every submission, so a leftover entry lets nobody submit
anything they could not have typed — but it does leave an email address legible
to the next person who opens the page on that device.

### Which endpoint

Decided in one place, by whether there is a session:

| Caller | Route |
|---|---|
| Signed in, for themselves | `POST /api/comp/:comp_id/task/:task_id/igc` |
| Signed in, on behalf | `POST …/igc/:comp_pilot_id` |
| Not signed in | `POST …/igc/open-submit` |

The first two are unchanged, so open registration and the existing on-behalf
rights keep working exactly as they did.

Which of them a given person can actually reach, and what each competition
setting does to that, is the matrix in
[What is possible, and when](#what-is-possible-and-when).

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

One rough edge remains, and it is now narrower than it was: **a roster added by
name only cannot use the ANONYMOUS flow at all**, because the identifier is the
only key there and name matching is deliberately refused.

A signed-in pilot on such a roster is fine — the registration picker below
shows them the whole list and lets them say which entry is theirs, which is
precisely a name match performed by the one party entitled to make it. The
anonymous route cannot offer the same thing, because "pick any name off the
public roster" is not a claim, it is a menu.

## What is possible, and when

Every rule below is explained on its own further down. This is the one place
they are shown together, because the question that actually comes up is never
"what does `open_igc_upload` do" — it is "can this person, in this state, do
this thing".

The signed-in state does not merely change permissions: it picks a **different
endpoint**, which is why the columns behave so differently.

| | **Not signed in** | **Signed in — pilot** | **Signed in — comp admin** |
|---|---|---|---|
| **My own track — I am already on the roster** (account linked) | ✅ if I can name an identifier the organiser recorded. Needs `open_igc_upload` | ✅ straight through | ✅ straight through |
| **My own track — registered, but nothing matches me** (mistyped email, no CIVL on my profile) | ✅ if I type the identifier they *did* record | ⚠️ **asked which registration I am**; picking it claims and links it | ⚠️ the same — admin does **not** bypass this |
| **My own track — genuinely not on the roster** | ❌ `no_pilot_match`, and it names the organiser to email | ✅ self-registers **if `open_registration`**, else ❌ `registration_closed`. If the roster holds unclaimed rows I must decline them explicitly first | as pilot |
| **Another pilot's track** | ⚠️ possible — name their identifier. The deliberate trade-off (see below), contained by the audit log and the email | ✅ only if `open_igc_upload` **and** I am myself on that roster | ✅ always |
| **Replace a track already on file** | ✅ same rules as above; the pilot is emailed | ✅ | ✅ |
| **Task closed for submissions** | ❌ hard stop | ❌ | ✅ bypasses |
| **Competition past its close date** | ❌ | ❌ | ❌ — nobody bypasses |
| **A hidden `test` competition** | ❌ 404, as if it did not exist | ❌ the same 404 | ✅ — the flag hides a rehearsal, it does not stop the organiser rehearsing |

### The settings that move those cells

| Setting | Default | What it actually gates |
|---|---|---|
| `comp.open_igc_upload` (0005) | **on** | (a) anonymous submission at all; (b) a non-admin uploading for *another* pilot. **Not** your own signed-in upload |
| `comp.open_registration` (0027) | **on** | Whether a signed-in pilot who is on nobody's roster may add themselves by uploading |
| `comp.close_date` | none | Closes the whole competition, for everyone including admins |
| `task.submissions_closed` (0028) | **off** | Closes one task. Admins bypass it on both signed-in routes; a hard stop anonymously |
| `comp.test` (hidden comp) | **off** | Hides the competition from everyone but its admins. Every submission route — including `registration/resolve` — answers a non-admin with its own not-found body, never a 403 |

### Four things that surprise people

**Turning off `open_igc_upload` does not stop pilots submitting.** It stops
*anonymous* submission and *acting for others*. A signed-in pilot can still file
their own track — the self route never reads that column. If the intent is "no
submissions", that is `close_date` or `submissions_closed`.

**Being a comp admin does not bypass the identity question.** Admin gets you
past a closed task, not past "which registration are you?". An organiser who is
not on their own roster meets the picker like anybody else. The two are
deliberately separate: one is about *when* a track may arrive, the other about
*whose* it is.

**A hidden `test` competition takes tracks from its admins and nobody else.**
Every route reads `comp.test` now — anonymous, self, on-behalf, manual flight,
the `registration/resolve` pre-flight, and the pilot-status writes beside them
— through one `hiddenFromCaller()` (`comp-visibility.ts`, next to the search
filter that answers the same question for a query rather than an id). Every one
of them answers a non-admin exactly as a missing competition does, in its own
not-found wording.
A 403 would still concede that the competition exists, which is the one thing
the flag is there to withhold. Admins are the exception the flag is for: an
organiser rehearsing an unpublished comp has to be able to submit to it, or the
rehearsal proves nothing. Until 2026-08-06 the three signed-in routes read
`close_date` but not `test`, so any account that knew the ids could read a
hidden roster and write a track into it (SEC-37/38).

**`MAX_PILOTS_PER_TASK` is 250** and caps every route. The anonymous one can
never push it, because it does not create roster rows.

## Which registration is this?

A signed-in pilot uploads. Whose track is it?

Until migration 0028's sibling change, `ensureCompPilot` answered by trying
three things and then **guessing**: a row already linked to the account, else an
exact id/email match via `linkExistingRegistrations`, else INSERT a new roster
row. That last step was the bug. An organiser who registered a pilot with a
mistyped email — and a pilot whose own profile carries no national ids — got a
silent duplicate: the organiser's entry sitting empty, a self-made one carrying
the track, and nobody told. The pilot count feeds launch validity (S7F §9.1),
so the phantom is a scoring input too.

### The rule

**If the competition has ANY unclaimed registration, the server asks.** It does
not guess, and it does not create a second entry. `ensureCompPilot` returns
`ambiguous`, the upload answers `409 identity_ambiguous` with the candidates,
and the pilot picks — including an explicit "None of these — register me as a
new pilot".

An empty roster still self-registers silently, exactly as before. That is the
legitimate open-registration path and nothing about it changed.

### Names may propose, never dispose

This is the one place the codebase compares names, and the distinction has to
survive future editing:

- **The decision to ask involves no names at all.** It is "is there an
  unclaimed row", nothing more. A name threshold would mean a pilot the
  organiser wrote down as "Mick" never sees "Michael" — the original bug, back
  again and harder to spot.
- **`nameAffinity` only ORDERS the list** the pilot chooses from, so their own
  entry is first rather than forty rows down. Nothing branches on it.

`pilot-linker.ts` and `pilot-resolver.ts` still refuse to auto-link on a name,
and must keep refusing. A name may propose; only a person disposes.

### Asking before it matters

The refusal is the safety net, not the flow. `POST
/api/comp/:comp_id/registration/resolve` (`routes/registration.ts`) answers the
same question as soon as the form knows the competition — while the pilot is
still choosing a file — so the 409 is only ever reached by a stale bundle or a
scripted client. It is **strictly read-only**: it never claims, links or
inserts, so an abandoned or replayed resolve leaves nothing behind. POST rather
than GET because the optional identifier can be an email address.

It answers `linked` / `choose` / `new`, and `choose` carries candidates ordered
by `nameAffinity` with masked addresses — often how somebody recognises which
of two entries is their own old email.

### The answer travels in one header

`x-comp-pilot: <comp_pilot sqid>` or `x-comp-pilot: new-pilot`. The hyphen is
load-bearing: the sqid alphabet is a–z only, so a hyphenated sentinel can never
collide with a real id — the same trick as the `open-submit` and `open-now`
route segments. In the CORS `allowHeaders` list, without which every browser
preflight fails and only in a real browser.

Deliberately **not** the on-behalf route (`.../igc/:comp_pilot_id`), which
looks like it would do: its authorisation excludes a pilot who is not yet on
the roster, its audit line says "on behalf", and — decisively — it never sets
`comp_pilot.pilot_id`, so the row would stay unclaimed and the next upload
would duplicate anyway.

Claiming is the ONE strict thing in an otherwise permissive design: the row
must be genuinely unclaimed, and a pilot already registered here cannot move.
A wrong track is recoverable (the superseded file is retained, restore exists);
a wrong claim is a persistent identity link that redirects every future upload.

## Telling the pilot

`track-notice-email.ts`. **Every submission emails the registered pilot** —
self, on behalf, anonymous, first upload or replacement. The submit form says
so upfront, before a file is chosen, so the promise is made rather than
discovered.

It is unconditional on purpose: the notice is only worth anything if its
ABSENCE is meaningful. One exception, and it is not a hedge — when the address
is provably the submitter's own account, there is nobody to tell.

Where it goes matters, and the two cases differ:

| Event | Address | Why |
|---|---|---|
| Ordinary upload to a claimed row | the **account** | the registered address may be the very typo that started this, and writing to it tells a stranger that Jane flew task 3 |
| A **claim** | the **registered** address, only | the claim just set `pilot_id` to the CLAIMER, so preferring the account would mail the person who did it. A notice sent to its own subject is not a notice |

When there is no address, the upload still stands — refusing it would punish
exactly the pilots whose organiser did the least data entry — and the audit log
says so, because it is then the only record.

## Closing a task for submissions

`task.submissions_closed` (migration 0028). The competition already had
`close_date`, which closes everything; this closes one task, which is what an
organiser actually wants at the end of a day while tomorrow is still flying.

Enforced in **four** places, all before the body is read: the self upload, the
on-behalf upload, the anonymous submit, and the **manual flight** — a manual
flight is evidence for the task in exactly the way a tracklog is, and leaving
it open would make "closed" false.

Deliberately **not** enforced on pilot-status (marking the day's DNFs is what
an organiser does *after* closing) or on either restore route (reactivating
evidence the task already holds is a correction, not a submission). Both carry
a comment saying so, because the next author will otherwise add them.

**Comp admins bypass it** on the three routes with an admin concept; the
anonymous route is a hard stop. The flag tells pilots to stop sending files —
it must not lock the scorekeeper out of the recovered SD card, or it stops
being used. Their upload is audit-logged like any other.

**No score bump**: whether further evidence *may* arrive changes no score that
exists. It IS audit-logged — that is what makes a later organiser upload
legible rather than mysterious. `GET /api/comp/open-now` excludes closed tasks
entirely, so the picker never steers a pilot into a 403.

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
- **every submission emails the pilot** (`track-notice-email.ts`) — that notice
  is the detection channel, which is why it goes out on every submission and
  not only suspicious ones (see "Telling the pilot" below);
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

| Key | Budget | Charged | Why |
|---|---|---|---|
| `anon-igc:cp:<comp_pilot_id>` | 6 / 24 h | on a stored track | Enough to fix a genuinely wrong upload several times; not enough to sit there overwriting somebody else's. |
| `anon-igc:comp:<comp_id>` | 300 / 24 h | on a stored track | Above anything a real comp does, below a flood. |
| `anon-igc:futile:<ip>` | 40 / 24 h | on every request that stores nothing | Bounds wasted work, and is what keeps the endpoint from answering "is this address registered?" as fast as anyone can ask. National IDs are already public; email addresses are not. |

**What is charged, and when, is the security property** (SEC-39). The first two
are *damage* budgets: they are keyed on the thing being protected, so they are
charged at the far end, once a track is actually in R2. The third is an *effort*
budget: it is keyed on the caller, so it is charged for work that produced
nothing.

Getting that backwards is what SEC-39 was. Everything an attacker needs to name
a competition or a registration is public by design — the comp id is in the
comp's own URL, and `GET /api/comp/:comp_id/pilot` publishes every pilot's
national IDs — so charging on arrival let anyone spend a competition's or a
pilot's whole day without ever uploading a file. Six a day made the pilot case
sharp: six empty POSTs naming a real CIVL id took that pilot's landing day.

Order of work is still a cost decision, and `peekBudget` is what keeps it one:
the damage budgets are **peeked** early — a read, where this used to do a write
— so something already at its cap is turned away before the body is read, while
the counter itself stays unmovable by anyone who is not really uploading. The
peek admits a small race (concurrent requests can all pass it), which is bounded
by concurrency and harmless against 6 and 300 a day.

A 429 never charges the effort budget: a caller already being turned away by one
budget should not also spend another, or a pilot who hits their own six-a-day
would burn allowance shared with everyone else at the comp.

The effort budget is the only per-IP budget here, and it is safe to be one
*because* it is charged on failure. A submission that lands costs nothing, so a
hillside of pilots behind one connection or a CGNAT address can all submit; only
somebody generating failures pays. A budget on every submission instead would
429 real pilots on exactly the day this route exists for.

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
| `registration_closed` | 403 | Only the organiser — they add the pilot to the roster |
| `comp_closed` | 400 | Nothing; it says so |
| `comp_not_found` / `task_not_found` | 404 | Re-picking the task |
| `invalid_file` | 400 | Another file |
| `task_pilot_limit` | 400 | The organiser |
| `rate_limited` | 429 | Waiting (`Retry-After`, exposed via CORS) |
| `submissions_closed` | 403 | Re-picking the task — yesterday's is probably still open — or asking the organiser |
| `identity_ambiguous` | 409 | Saying which registration is theirs |
| `claim_rejected` | 409 | Picking another, or the organiser |

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

## Getting a file to test with (IGC Forge)

Testing any of this needs tracklogs, and the only other ways to get one are to
go flying or to reuse a bundled sample. A sample is worse than it looks: it was
flown somewhere else on some other day, so track quality withholds it — the
upload exercises the FAILURE path while appearing to test the happy one.

So `web/engine/src/forge-igc.ts` synthesises a flight that actually flies a
given route, on the task's day, at plausible speeds — launch, climb-out, glide
and thermal leg by leg, into each cylinder, then a descent and a stint on the
ground so the landing is detectable at all.

Two front ends, one engine, so they cannot drift into making different files:

- **`bun run forge-igc`** — the CLI. Lists what is open (`--open`), writes a
  file (`--out`), or submits one straight to the anonymous route
  (`--submit --ident`).
- **Create a test IGC**, a dialog on the task page (`comp/ForgeIgcDialog.tsx`).
  Opens with that task's own route, date and competition zone; downloads the file.
  It never uploads — submitting it through the real flow is the thing being
  tested.

Both **verify before offering**: every forged file goes through `parseIGC` and
`assessTrackQuality`, the same code the worker runs, and the verdict is shown.
That is the whole point — a clean result means the file will be accepted AND
scored, not that it looks about right. A "clean" forge that fails a hard check
is reported as a bug in the forge, because the file is then useless for what it
was asked for.

**Landing out.** The slider (`--land-out <km>` on the CLI) picks how far round
the course the pilot got, from nothing to the whole task. It is measured along
the **optimised task line** — the same geometry the scorer measures — so the
number chosen is the distance the pilot should be credited with, not merely one
they travelled. That is what makes a land-out a usable fixture: you can say in
advance what it ought to score. The flight follows that line rather than
waypoint centres for the same reason.

At zero they launch, fail to connect and land back on the hill; at the far
right they make goal.

**Open distance.** An open-distance task has one TAKEOFF turnpoint, no goal and
therefore no optimised line to measure anything along — asking the optimiser for
one returns a single point of zero length, which is what used to leave the
slider running 0→0 and reading NaN, with nothing forgeable behind it. So those
tasks get a course of their own, invented in `openDistanceCourse`: off in a
**random** bearing from the take-off cylinder, wandering the way a pilot hunting
thermals does, landing exactly as far beyond the cylinder edge as was asked.
That distance is the same one `openDistanceForFlight` credits — the furthest
fix's distance from the centre, minus the radius — so the slider still names
what the pilot should score. The range is `forgeRange()`: up to 250 km, 80 km by
default. Each intermediate point of the wander is kept provably nearer the
centre than the landing, because on this format a mid-flight detour that
strayed further out would quietly BECOME the score. At zero the pilot never
leaves the cylinder: scored nothing, and flagged `never-left-takeoff` (SOFT) for
it rather than withheld.

`--sabotage day` / `place` (the dropdown in the dialog) deliberately breaks one
check. Those files are still VALID — they upload fine and are then withheld
from scoring, which is the state nobody can otherwise reach on demand.

**Who can see the dialog:** any admin of the competition — `useAdminView()`,
the same check every other manage action on the task page uses, so the button
also vanishes while a super admin previews as a pilot
(`TaskDetail.tsx`). Widened from the original super-admin-only gate once the
dialog stopped being a script and became a task-page button: the people who
need a file to test submission and scoring with are the ones running the
competition. This widens who SEES the button and nothing more — the dialog
never reaches the server, it only makes a file and offers it as a download.
The button only appears when the task has a route, because there is nothing to
fly without one. The component is `lazy()`-loaded so its code stays out of
everyone else's bundle.

## Where things are

| Thing | File |
|---|---|
| The flow | `src/react/comp/SubmitTrackForm.tsx` |
| Its DOM-free logic + tests | `src/react/comp/submit-track.ts` |
| Dialog wrapper | `src/react/comp/SubmitTrackDialog.tsx` |
| Admin per-row upload | `src/react/comp/TaskScores.tsx` |
| The page | `src/react/pages/SubmitTrack.tsx` |
| Anonymous route | `web/workers/competition-api/src/routes/igc-anon.ts` |
| Shared upload half | `web/workers/competition-api/src/track-upload.ts` |
| Roster matcher | `web/workers/competition-api/src/pilot-linker.ts` |
| Budgets | `web/workers/competition-api/src/rate-limit.ts` |
| Submission notice email | `web/workers/competition-api/src/track-notice-email.ts` |
| Registration resolve | `web/workers/competition-api/src/routes/registration.ts` |
| Closed-task gate | `web/workers/competition-api/src/submission-gate.ts` |
| Hidden-comp gate | `web/workers/competition-api/src/comp-visibility.ts` (`hiddenFromCaller`) |
| Open competitions | `web/workers/competition-api/src/routes/open-comps.ts` |
| Flight summary | `web/engine/src/flight-summary.ts` |
| Forging a test tracklog | `web/engine/src/forge-igc.ts` |
| IGC Forge dialog | `src/react/comp/ForgeIgcDialog.tsx` |
| IGC Forge CLI | `web/scripts/forge-igc.ts` |
| Coverage | `test/igc-anon.test.ts`, `test/igc-routes.test.ts`, `test/registration-resolve.test.ts`, `test/open-comps.test.ts`, `e2e/track-submission.spec.ts` |
