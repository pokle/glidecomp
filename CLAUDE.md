# CLAUDE.md

## Project Overview

GlideComp is a web application for analyzing hanggliding/paragliding competition
track logs (IGC files). It provides task analysis, scoring explanations, glide
and thermal analysis.

**Production:** https://glidecomp.com

## Architecture

Cloudflare monorepo on the Workers Paid plan ($5/mo — includes paid-plan
features like Email Sending; still cost-conscious, avoid services beyond that).

- **`web/engine`** — pure TypeScript analysis library: IGC/XCTask parsing, event
  detection, GAP scoring, cross-pilot task analysis (`src/analysis/`),
  track quality (`src/track-quality.ts`), task weather (`src/weather/`). No DOM
  dependencies; all track analysis runs client-side in the browser.
- **`web/frontend`** — Vite app on Cloudflare Pages. Three kinds of page:
  - The **SPA** (`src/react/`, served from `src/app.html`) — competitions,
    comp/task detail, scores, dashboard, profile, settings, onboarding. Built
    with the react-aria-components kit in `src/react/rac/` and Tailwind (tokens
    in `src/react/globals.css`). Most SPA routes reach `/app.html` via
    `public/_redirects`.
  - The **content pages** (`/`, `/about`, `/legal`, `/scoring`, `/scoring/gap`,
    `/scoring/open-distance`, `/scoring/data-cleaning`, `/scoring/track-validity`,
    and the `404`) — prerendered static HTML from a small Astro app in
    `web/frontend/static/`, reusing the SPA's `globals.css` tokens/fonts. KaTeX
    on the GAP page is prerendered at build via `katex.renderToString`.
  - The **eight public comp pages**, which are **server-rendered** — see
    [docs/ssr.md](docs/ssr.md) and the SSR-safety rule below.

  The analysis page and 3D replay are separate vanilla-TS Vite entries.
  `bun run build` runs the Vite app build → the SSR bundle (`build:ssr` →
  `dist-ssr/`) → the Astro build, merging all into `dist/`. `bun run dev` runs
  Vite + `astro dev` together and proxies the static routes (and Astro's
  `/_static` dev namespace) so everything is seamless on `:3000`.
- **`web/workers/*`** — auth-api, competition-api, airscore-api, backed by D1 +
  R2. Reached via Pages Functions proxies in `functions/api/`. In local dev they
  all run in ONE `wrangler dev` session behind the `dev-router` Worker on port
  **8790** — see [docs/local-dev.md](docs/local-dev.md).

## Build & Development

Build commands are in `package.json`; the key ones are `bun run dev`,
`bun run test`, `bun run typecheck:all`, `bun run test:all`. These install
dependencies for you — the `dev`/`preview`/`test`/`typecheck:all` entry points
all run `bun install` first, and `.claude/hooks/session-start.sh` does it once
per Claude Code session (the web containers clone fresh, so `node_modules/` is
always absent).

**If you invoke a tool directly — `bun test ./web/engine`, `bunx playwright`,
`tsc` — you skip those guards.** On a fresh tree the unresolved imports surface
as ordinary *test failures*, not as a missing install, so run `bun install`
first or go through `bun run`. `bunx playwright test` skips a second guard:
`test:e2e` and `test:e2e:ssr` also fetch the Chromium build the pinned
Playwright wants, which no environment is guaranteed to pre-bake — see
[docs/local-dev.md](docs/local-dev.md).

For dev servers, the e2e suite and its failure modes, the isolated container
preview, and the dev tunnel: **[docs/local-dev.md](docs/local-dev.md)**. Read its
"Before you trust an e2e failure" section before debugging one.

**A new e2e spec must be added to a CI shard.** CI runs the e2e suite as
explicit per-shard file lists in `e2e/fixtures/shards.ts`, so a spec in no list
would never run in CI. `e2e/fixtures/shards.test.ts` fails the `test` job when
that happens. When you add `e2e/*.spec.ts`, put it in the shard that matches its
subject, beside related specs, in the same commit. A spec that should also run
on the phone pass goes in `MOBILE_SPEC_FILES` too (`e2e/fixtures/mobile.ts`).

**Working in a git worktree? Give the e2e its own ports.** `reuseExistingServer`
is on outside CI, so `bun run test:e2e` in one worktree silently REUSES another
worktree's dev server on :3000 and asserts every expectation against the wrong
code — green, and meaningless. Nothing warns you.

```bash
DEV_FRONTEND_PORT=3100 DEV_API_PORT=8890 DEV_API_ORIGIN=http://localhost:8890 \
  DEV_INSPECTOR_PORT=9330 bun run test:e2e
```

Also set `BETTER_AUTH_URL` in `web/workers/auth-api/.dev.vars` to the same
frontend port, or every signed-in test fails with `INVALID_ORIGIN` (the file is
gitignored; put it back afterwards). `test:e2e:ssr` serves on :3100 by default
(`SSR_PORT` overrides) and honours `DEV_API_PORT` too. To check a port is
yours, hit a route only your branch has — a 404 means you are about to test
somebody else's tree. Full details, including why the inspector port needs its
own knob, are in
[docs/local-dev.md](docs/local-dev.md#two-worktrees-at-once-the-green-but-meaningless-run).

**Backlog:** open and planned work is tracked in
[GitHub issues](https://github.com/pokle/glidecomp/issues) — **not** in a
checked-in TODO file (`docs/TODO.md` was deleted as stale; don't recreate it).
`docs/` holds specs, plans, and reference. Treat the dated ones (`docs/2026-*.md`)
as point-in-time snapshots rather than current status.

**Python runs with uv.** The stack is TypeScript/bun, but where a Python
script earns its keep (e.g. the S7F PDF extraction pipeline in
`docs/reference/fai-s7f-xc-scoring-2024/`), it declares its dependencies
inline in a PEP 723 `# /// script` block and is invoked with
`uv run <script.py>` — never `pip install` into the environment, and no
`requirements.txt`.

**Branch previews:** every branch gets a Cloudflare Pages branch-alias URL.
**When you open or push to a PR, always include it in the PR body and show it in
the chat** — and get it from `bun run preview-url`, **never by deriving it in
your head** (the slug truncates mid-token; see
[docs/local-dev.md](docs/local-dev.md)).

## Rules

These are the standing imperatives. Each links to the reference that explains it.

### Writing

- **Australian English spelling in all prose.** `-ise`/`-isation` (organise,
  optimised, analyse, recognise), `-our` (colour, behaviour, favour), `-re`
  (metre, centre), `-ogue` (catalogue), `defence`, `licence` (noun) /
  `license` (verb), `travelled`, `modelling`. This covers everything a person
  reads: UI copy, error and toast messages, page content, `docs/`, code
  comments, commit messages and PR bodies.
  - **This deliberately overrides ASD-STE100 Rule 1.14**, which mandates
    American spelling. The rest of the standard's writing rules still apply to
    documentation — see the `simple-english` skill — but spelling is ours.
  - **Never respell code.** Identifiers, CSS/Tailwind classes (`items-center`),
    DOM and CSS properties (`behavior`, `color`), JSON/DB field names, API
    routes, npm packages, and third-party names (Mapbox, AirScore, `optimizer`)
    keep their original spelling. A rename there is a code change, not a
    spelling fix, and mostly breaks things. When a UI label is generated from
    such a name, respell the label, not the name.
  - Quoted external text — FAI/CIVL spec wording, error strings from other
    tools — is reproduced verbatim, whatever it spells.
- **Propose UI wording before you change it.** Asked to reword something a
  user reads — a label, a button, a dialog's explanation, a status message —
  write the proposed text out and get it confirmed FIRST, then edit. Wording
  is the owner's call and it is cheap to settle in a message and expensive to
  settle in a diff: a paragraph rewritten in the code drags its tests, its
  e2e assertions and its screenshots with it.
  - Show the whole affected block, not the changed clause, and include the
    neighbouring copy the change has to sit beside — a rewrite that reads well
    alone can repeat or contradict the line above it.
  - **Trivial fixes are exempt**: typos, grammar, punctuation, and the
    Australian English spellings above. Just make those.

### Correctness and transparency

- **Decisions MUST be explainable.** Return explanations for scoring decisions
  and support unit testing. The explainers live in
  `web/engine/src/score-explanation*.ts` and surface on the **report card**
  (`/comp/:id/task/:id/pilot/:id`, `src/react/pages/PilotScoreDetail.tsx`). See
  the report-card rules below.
- **A pilot's registration is never guessed.** If a competition holds any
  UNCLAIMED `comp_pilot` row, a signed-in upload asks which one the pilot is
  (`ensureCompPilot` in `routes/igc.ts` → `409 identity_ambiguous`; the form
  settles it beforehand via `POST /api/comp/:comp_id/registration/resolve`).
  Guessing used to mean a silent SECOND roster row whenever the organiser
  mistyped an email — the pilot registered twice, one entry empty, and the
  pilot count feeding launch validity (S7F §9.1) counting a phantom.
  - **Names may propose, never dispose.** `nameAffinity()` orders the picker so
    the pilot's own entry is first. Nothing branches on it, and the decision to
    ask involves no names at all. `pilot-linker.ts` and `pilot-resolver.ts`
    still refuse to auto-link on a name, and must keep refusing.
  - **Every submission emails the registered pilot** (`track-notice-email.ts`),
    and the submit form promises that upfront. A route that skipped it would
    make the copy a lie. See [docs/track-submission.md](docs/track-submission.md).
- **Every mutation that could affect a competition's scores MUST be
  audit-logged.** Use `audit()` in `web/workers/competition-api/src/audit.ts`
  from every mutating route handler (comp / task / pilot / track / penalty /
  xctsk / settings). The description must be a specific human-readable sentence —
  include the subject name and, where available, old and new values via
  `describeChange()`. The audit log is publicly visible for non-test comps and is
  the competition's transparency record. Adding the audit call is part of "done".
- **Every mutation that changes a scoring input MUST also mark the materialized
  scores stale.** Scores are stale-first rows in D1 (`task_scores`,
  [docs/score-caching-stale-first-plan.md](docs/score-caching-stale-first-plan.md));
  reads never compute, so a mutation that skips the bump serves silently stale
  scores forever. Call `bumpAndRevalidateScores()` from
  `web/workers/competition-api/src/score-store.ts` right AFTER the mutation's DB
  write (never before), beside `audit()`, under the same "part of done" rule.
  - Scoring inputs are: tracks/uploads, penalties, task xctsk/date/classes, comp
    `category`/`scoring_format`/`gap_params`, pilot name/class, and pilot status
    (absent/DNF/landed feed launch validity, S7F §9.1). Roster metadata like team
    names is read live and needs no bump.
  - **One bump covers every derived table.** `bumpScoreInputs()` batches an upsert
    for `task_scores` *and* `task_analysis`, so call sites stay unaware of
    the second table — anything new that derives from scoring inputs belongs in
    that same batch rather than in 28 new call sites.
  - Two standing exceptions, both because they are **not** derived from
    competition data: `task_weather` ([docs/weather.md](docs/weather.md)) and
    `pilot_ranking` ([docs/civl-rankings.md](docs/civl-rankings.md)). Neither
    takes an `audit()` call either.
    - The roster's own copy of a world ranking (`comp_pilot.wprs_points` and
      its source columns, migrations 0029/0030) is the other way round: it IS
      competition data an organiser entered, so it is audited — but it feeds
      launch order, never a task score, so it takes no bump.
- **A failure to ask is not an answer** (issue #481). Identity and page data are
  each fetched once per page load, and every downstream decision keys off the
  result — so a *transient* failure must never be recorded as a *fact*. A dropped
  request or 5xx is not "signed out" and not "not found": those are terminal
  states nothing re-fetches, so a blip lasting milliseconds becomes a wrong page
  that stays wrong until reload. Retry, then decide.
  - The four places this lives: `getCurrentUser()` (`src/auth/client.ts`),
    `fetchWithRetry()` (`src/react/comp/types.ts`) — which every comp/task page
    load goes through, so use it rather than a bare `$get` — `resolveUser()`
    (`web/workers/competition-api/src/middleware/auth.ts`), and
    `src/react/lib/retry.ts` for the SSR/loader path, where a heavily-loaded D1
    can also produce a false 404.
  - **A 4xx is a real answer** and must NOT be retried (`/api/auth/me` answers
    429 for a rate-limited API key).
  - Coverage: `e2e/transient-api-failure.spec.ts`.
- **The search index maintains itself — do NOT add a call site for it.**
  `GET /api/comp/search` answers over an FTS5 index of competitions, tasks
  (including their routes' turnpoints) and pilots
  ([docs/2026-08-01-site-search.md](docs/2026-08-01-site-search.md)). Unlike
  `audit()` and `bumpAndRevalidateScores()`, which every handler must remember
  to call, the documents derive from columns the database watches itself:
  triggers in migration 0026 queue the changed keys and
  `web/workers/competition-api/src/search-index.ts` drains that queue from one
  middleware, the search endpoint, a cron and an admin button. A new mutating
  route needs nothing.
  - What DOES need a change: adding a column to a document (extend the trigger's
    `UPDATE OF` list, and bump `SEARCH_DOC_REV` so the nightly sweep reindexes
    what is behind), and anything that could name a competition it was not given
    the id of — visibility is `visibleCompsFilter()` in `src/comp-visibility.ts`,
    and a search must never be how someone discovers a hidden `test` comp.
  - A competition's waypoint set is deliberately not indexed: the task's frozen
    `xctsk` is what it flew.
- **A dead link is a searchable one.** Public URLs are `${slug}-${id}` segments
  (`lib/slug.ts`): the id is the identity, but the slug is a readable copy of the
  name and survives whatever happened to the id. A 404 under `/comp` does not
  merely apologise — `src/react/components/NotFound.tsx` reads the words out of
  the dead path, asks `GET /api/comp/lookup` which comps/tasks/pilots carry those
  words *now*, and offers the deepest URL that resolves, plus a search box.
  - It is rendered by the router's catch-all AND from each public comp page's own
    not-found branch, because those pages match a real route and never reach the
    catch-all — the id parses, it just doesn't resolve, which is exactly the
    repairable case.
  - **The lookup endpoint knows nothing about URLs** — no slugifying, no path
    building. Those live in `lib/slug.ts` on the client, so the two cannot drift;
    the worker route (`routes/lookup.ts`, mounted ahead of `compRoutes` so the
    static segment beats `/api/comp/:comp_id`) is a name search over three tables
    returning ids and names. Public and unauthenticated, so every dimension of its
    work is capped (term length, token count, comps drilled into, rows per kind),
    and `test` comps stay invisible to anyone who can't already see them.
  - Coverage: `e2e/not-found-suggestions.spec.ts`.

### The report card

- **(a) Every section that states a rule must name its inputs and print the
  substituted arithmetic.** The day-quality section asserted bare percentages for
  a year, which is the one figure a reader cannot check
  ([docs/2026-07-28-report-card-improvements.md](docs/2026-07-28-report-card-improvements.md)).
  Numbers come from `ClassScore.validity_inputs` — and because the stale-first
  store keeps serving pre-change bodies, every consumer must degrade to the bare
  value rather than fail when a field is absent.
- **(b) Never re-derive GAP parameters from the comp record on a page that
  explains a scored task.** The scorer merges the TASK's `gap_params` (migration
  0021 — imported AirScore comps publish a different formula, and a different
  nominal distance, per task) over the comp's, and resolves "auto" nominal
  distance against the route. Read the published `ClassScore.gap_params`;
  `resolveCompGapParams(comp…)` is a fallback for old cached payloads only.
- **(c) The report card's charts are EMPHASIS charts, not field charts** — one
  accent dot for this pilot, muted ink for everyone else. Do not reuse the
  task-analysis `RankScatter`, which paints every dot alike and would bury the
  reader in the crowd they came to locate themselves in. The curve is sampled
  from the scorer's own functions (`score-explanation-charts.ts`), so it is the
  formula and never a fit — the task-analysis captions say "a trend fitted
  through the dots"; these must not. A pilot is plotted only when the curve
  provably explains their published points; anyone carrying a reduction it
  doesn't model (§12.1, §12.3.5) is counted out, and if that's the viewing pilot
  the chart is suppressed. Shared chart geometry lives in
  `src/react/charts/scale.ts`.
- **(d) A repaired track shows its repairs.** The "Track data cleaning" section
  draws the same three lines as `/scoring/data-cleaning` (raw GPS, raw barometer,
  the cleaned line the analysis used) via `charts/TrackCleaningChart.tsx`, off the
  tracklog the page already downloads for the map. That makes it deliberately
  **client-only**: server-side there are no fixes, the SSR'd prose and list are
  unchanged, and the exact numbers live in the list either way — which also
  doubles as the chart's controls. A channel the file doesn't carry is named in
  the legend, never drawn as a flat line at 0, and the y domain always covers the
  RAW excursion: how far off the fix was is the whole finding, so it must never be
  clipped off-frame.
- Sections carry a `docHref` into `/scoring/gap`, so a reader who doesn't know
  GAP always has a way out of the page.

### Frontend

- **Mobile first, and that is a change of stance (2026-09-19).** A competition
  is run from a hill, and nobody wants to carry a laptop up it: less and less
  of this app's work happens on a laptop, so a phone is the shape a surface is
  designed FOR, not a width it has to survive. Where the two conflict, the
  phone wins.
  - The worked example is `/comp/:id/waypoints`. It was a 145-row,
    eight-column Tabulator grid, which is the better tool on a desktop and
    unusable on a phone: it scrolled sideways inside a page that scrolled down,
    under a map pane that stuck, and its frozen Code column hid whichever
    column sat beside it — which is how a reader came to see a waypoint's map
    altitude without its file altitude. It is now a LIST whose rows open
    full-screen sheets (`comp/WaypointList.tsx`, `comp/WaypointSheet.tsx`), at
    every width. The grid is gone, not hidden behind a breakpoint: two editors
    meant two code paths and a reviewer on a desktop seeing something the
    author never tested on a phone.
  - **And the read-only view is the same list.** It was a six-column RAC
    `Table` in an `overflow-x-auto` scroll region, so the shape the editor had
    just stopped using survived for the anonymous PILOT — the one actually
    standing on the hill — while the organiser more likely to be at a desk got
    the list. `WaypointList` with no `onOpen` IS the read-only mode: no
    chevron, because nothing opens. When a surface has an admin view and a
    visitor view, fixing one is half the job.
  - **A tap target is the whole area doing nothing beside it.** The waypoints
    list's locate pin was a 28x28 px icon with 300 px of inert row next to
    it. It is now the row's entire left-hand strip (48x44 px, flush to the
    card's edge), and read-only — where no sheet opens — the WHOLE ROW flies
    the map. The pin stays there because it is what NAMES the action for a
    reader who cannot see the map move; one action with a big target is not
    two ways to do a thing. Measure a target in the e2e rather than asserting
    about classes: tailwind-merge does NOT resolve `size-*` against
    `h-*`/`w-*`, so a `size="icon-sm"` added later leaves two competing rules
    and a 28 px box with every class-level check still green.
  - **One way to do a thing.** The same pass deleted a "Fill altitudes from
    map" button that duplicated what `Check altitudes` does better, a
    "Show on the map" button in the waypoint sheet that duplicated the list
    row's pin, and a status line that pre-judged a set nobody had asked about.
    A second way to do something is a thing to keep working, explain and test.
  - **A sheet is dismissable with Back.** A sheet lives in React state, not in
    the URL, so the history stack cannot see it and Back would skip past it to
    the previous page — from a waypoint's details, one press left the whole
    editor and its unsaved work. `lib/use-back-dismiss.ts` gives every
    `FullScreenSheet` a history entry while it is open and pops it again on the
    way out; nested sheets stack, so Back walks out one layer at a time. Read
    its note before touching it: a popstate reaches every listener, popping our
    own entry looks like a user Back to the layer underneath, and StrictMode
    runs the effect twice — all three broke it, and all three were caught by
    the e2e rather than by review.
- **One component kit — react-aria-components, in `src/react/rac/`.** Every page,
  dialog and piece of shared chrome uses it. Read
  [docs/2026-07-18-rac-adoption-guide.md](docs/2026-07-18-rac-adoption-guide.md)
  before touching kit code — it carries the conventions and twenty-eight hard-won
  gotchas. The shadcn/Base UI kit is **gone** (migration finished 2026-07-27,
  [#483](https://github.com/pokle/glidecomp/issues/483)); `src/react/one-kit.test.ts`
  fails the build if it comes back, and there is no `components.json`, so
  `bunx shadcn add` is not the way to get a missing component — add it to `rac/`
  instead (a static styled element is fine: see `rac/badge.tsx`, `rac/alert.tsx`).
  - Thin wrappers over non-RAC third-party widgets live in `src/react/vendor/` —
    today the `input-otp` sign-in field and the `sonner` toaster.
  - **A sheet's chrome and a list row's body are kit components, not things
    each surface writes out.** `rac/full-screen-sheet.tsx` carries
    `SheetHeader` / `SheetBody` / `SheetFooter`, and `rac/grid-list.tsx`
    carries `RowContent`. Four sheets and three lists had each grown their
    own, in vocabularies that disagreed about the gutter, the title's weight,
    the readable-width cap and the chevron — none of it decided, all of it
    copied. Two consequences worth knowing before adding padding of your own:
    a `FullScreenSheet` already spends the safe-area inset on its `p-safe`, so
    `px-gutter-safe` INSIDE one counts the notch twice; and `variant="rows"`
    already makes a row `flex items-center gap-3`, so restating that says
    nothing.
  - **Tabulator is for a grid that is genuinely spreadsheet-shaped** — many
    rows, many columns, edited cell by cell on a wide screen, like the pilots
    grid. Lazy-load it, RAC chrome around it, shared theme in
    `comp/tabulator-grid.css`; and still don't rebuild spreadsheet editing in
    RAC. It is no longer the default answer for "an editable collection": that
    it was is how the waypoints page ended up with a grid nobody could use from
    a hill (see the mobile-first rule above). A list of rows that open sheets
    is usually the better shape, and `rac/grid-list.tsx` is what it is built
    from.
  - The analysis page is vanilla TS and shares tokens via `src/analysis.css`,
    which defines its small set of vanilla component classes (`.btn*`, `.input`,
    `.alert*`, `.tabs`, `.command`) — extend those there rather than adding a UI
    library. The 3D
    replay styles itself (`replay.css` + inline theme).
- **Use Tailwind utilities** — avoid custom CSS where Tailwind has an equivalent.
- **UI conventions** (see the design-language section of
  [docs/2026-07-08-information-architecture-v2.md](docs/2026-07-08-information-architecture-v2.md)):
  section-scoped manage actions sit right-aligned on the section header row via
  `SectionHeader`; breadcrumbs are one component app-wide — the RAC kit's
  `Breadcrumbs`, ARIA-native (parent links + the current page as a final
  `aria-current="page"` crumb), with the ancestor array built by the helpers in
  `src/react/lib/crumbs.ts` rather than inline (the parent crumb is where a page
  *belongs* in the IA, not where the user came from); every Submit-track entry
  point goes through the one `SubmitTrackForm`
  ([docs/track-submission.md](docs/track-submission.md)) — as the `/submit`
  page, or wrapped in `SubmitTrackDialog` where comp and task are already known;
  **anything waiting on an API response says
  so** via `src/react/rac/progress.tsx` — `<Loading>` for a fetching section (a
  `role="status"` live region), `<Button isPending pendingLabel="Saving">` for an
  action in flight (never `isDisabled={saving}` + a label swap — that drops focus
  mid-action), `<ProgressBar isIndeterminate>` for a known background job.
- **An altitude a reader TYPES is in the reader's own unit, and the label says
  which** (issue #662). Every place the app prints an altitude honours the unit
  preference, so an input hard-labelled "(m)" made the two disagree in front of
  the reader — what they typed reappeared multiplied in the list beside it.
  Altitude inputs go through `AltitudeField` in `src/react/comp/fields.tsx`,
  which converts at the field's edge (`toAltitudeInput` / `fromAltitudeInput` in
  `lib/units.ts`); metres remain what is stored, exported and scored.
  - Cylinder **radii** go the other way and are **always metric**, read and
    typed: the FAI states a cylinder radius in metres, so does the `.xctsk`,
    the briefing and the editor's `400m` / `5k` chips — it is the task's own
    number, not a length to convert for the reader. Print one with
    `formatCylinderRadius()`, which takes no preferences at all;
    `formatRadius(m, { prefs })` is only for a radius that IS a measured length
    (the track HUD's 1000 m averaging window).
  - The waypoints editor on `/comp/:id/waypoints` stays metric throughout — it
    is the waypoint FILE edited in place. Its fields say "Altitude (m)" /
    "Radius (m)" rather than leave anyone guessing, and the altitude review
    prints both altitudes with the unit on each. A READ-ONLY waypoint row on
    the same page is the other way round: nobody is editing the file there, it
    is simply an altitude printed to a reader, so it honours the preference.
- **A zero altitude is never "missing", in any UI**
  ([docs/waypoint-altitudes.md](docs/waypoint-altitudes.md)). An altitude is
  either KNOWN — any number, 0 included — or ABSENT, which is why
  `WaypointFileRecord.altitude` is optional: a waypoint on a beach is at 0 m
  and a file with no elevation column knows nothing. Collapsing the two meant
  a sea-level waypoint could never be left alone: the fill-blanks action of the
  day kept offering to fill it, and filling it wrote 0 again. Parsers leave an
  absent one undefined, exporters use their format's own way of saying nothing
  (OziExplorer's `-777`, a blank `elev`, an omitted `<ele>`), an empty field is
  the only "missing" signal, and a 0 that is WRONG is a wrong altitude for
  `Check altitudes` to report — never something to overwrite unasked.
  - **Only OziExplorer's `.wpt` states elevation in FEET** (field 14, `-777` =
    unknown); every other format we read says metres. Reading it as metres
    inflated every imported altitude by 3.28 — the bundled HG Worlds set
    publishes the same points in four formats and proves it. The cross-format
    altitude agreement test in `web/engine/tests/waypoint-files.test.ts` is
    what keeps a new format honest.
  - **`Check altitudes` is the ONLY altitude action on the waypoints page**,
    and it reports nothing until it is pressed. A "Fill altitudes from map"
    that answered blanks without asking, and a status line that pre-judged the
    set, were both deleted: the check does the fill's job better because it
    shows what it would write before writing it. (The route editor keeps a
    fill for its turnpoint blanks, where there is no list to review.) It
    changes nothing on its own and reviews in a SHEET
    (`comp/AltitudeReviewSheet.tsx`) whose every row states BOTH altitudes —
    the grid columns it replaced put the file's altitude behind the frozen Code
    column, so a disagreement was reported with half of itself off screen.
    Under 50 m is not a finding (a ~10 m DEM grid against a file rounded to
    10 m), past 300 m a wrong COORDINATE is the likelier fault, and a
    whole-file ratio or offset is one bulk fix rather than 187 decisions. The
    review's list is a snapshot in BOTH membership and order: sorting by the
    size of the disagreement live sends each row to the bottom the moment it is
    accepted. A difference of exactly zero prints nothing — the absence of a
    finding is not a finding — and inside a waypoint both Back and Done return
    to the LIST, never out of the review.
  - **The waypoints page is a list of sheets, at every width** — see the
    mobile-first rule above for what it replaced. `comp-waypoints.spec.ts` runs
    in both Playwright projects, and asserts that the page never scrolls
    sideways.
  - **Never read a Terrain-RGB pixel through a canvas.** The tiles are RGBA and
    Mapbox marks no-data — the sea past a coastline included — with partial
    alpha; a canvas stores premultiplied bytes, so the 24-bit elevation those
    three bytes carry does not survive the round trip, and the red byte is
    6553.6 m a step. A coastal waypoint read 13273 m that way.
    `analysis/elevation.ts` inflates and unfilters the PNG itself (exact by
    construction, and unit-testable), rejects anything outside -500..9000 m,
    and takes the 3x3 median of the plausible pixels. Any test fixture standing
    in for a terrain tile must be RGBA, or it cannot catch this.
- **Content pages: the rule is SEO, not a JS ban.** Every word and image a
  visitor or crawler needs must be in the prerendered HTML, and the page must stay
  useful with JS off. Interaction that genuinely helps someone understand
  GlideComp is worth adding on top — the homepage already carries hand-written
  vanilla enhancement (reveal-on-scroll, the FAQ accordion, and the chart tabs in
  "For pilots", a plain ARIA tablist over a native scroll-snap track with all six
  panels in the prerendered DOM). Write such things in vanilla JS/CSS against the
  existing tokens rather than pulling the RAC kit (or any framework) into these
  pages.
- **The analysis page opens for ONE anonymous URL shape, and no other**
  (issue #666). The public report card links a single pilot's track into
  `/analysis` as `?compId=…&taskId=…&pilotId=…`, and that deep link reads only
  published competition data the report card had already fetched anonymously
  to draw its own map — so it loads with no session. `isPublicCompLink()` in
  `src/analysis/public-deep-link.ts` is the entire gate, and it is a whitelist
  of that one shape rather than a blocklist, so a param it has never heard of
  cannot quietly widen it. Everything else still redirects to `/u/me/`: the
  bare page, the personal library (`storedTrack`, `storedTask`, `u`), the
  bundled samples (`track`, `task`, `sampleComp`) and the share target.
  - The relaxation is **client-side only**. No worker route moved from
    `requireAuth` to `optionalAuth` and no endpoint was added; a patch here
    that touches `web/workers/` has gone too far. The account library stays
    gated by `storage.isAvailable()` on the client and `requireAuth` on the
    server, which is the boundary that actually holds.
  - A hidden `test` comp stays hidden: all four routes the deep link uses 404
    for a non-admin, and the viewer must say not-found while naming nothing —
    the breadcrumbs are built only once the task really resolved.
  - Anything that would RELOAD into a URL the gate refuses (the sample
    loaders) is marked `data-requires-account` in the markup and hidden for an
    anonymous reader, rather than left to bounce them out of the page.
  - Coverage: the "signed out" block in `e2e/report-card.spec.ts`.
- **SSR-safety.** When you touch anything the eight server-rendered comp pages
  import ([docs/ssr.md](docs/ssr.md)):
  - No `window`/`document`/`localStorage` at **module scope** — it runs in
    workerd; guard with `typeof window`.
  - Render dates/times **deterministically** (fixed locale, injected "today"/zone
    — never the runtime's) or hydration mismatches appear.
  - Keep the `entry-server`/`entry-client` React trees identical (e.g. the toaster
    lives in its own root).
  - Heavy browser-only libs (mapbox/three/tabulator) stay behind `lazy()` so they
    stay out of the SSR entry bundle.
  - New server-side data means extending the route's loader in
    `src/react/loaders.ts` and seeding via `initial-data`.
  - Dev serves the SPA shell with no SSR, so verifying is part of "done":
    `bun run test:e2e:ssr`, or `curl` the built output under `wrangler pages dev`.
- **Accessibility**: all UI work is measured against
  [docs/accessibility-standard.md](docs/accessibility-standard.md) (WCAG 2.2 AA
  across the SPA, static pages, analysis map and 3D replay). Use its per-PR
  checklist; meeting the standard is part of "done".

### Engine

- **A scoring change writes a note; it never bumps a number**
  ([docs/scoring-version.md](docs/scoring-version.md)). The engine generation
  every scoring cache is keyed by is **derived** — a content hash over the
  import closure of `SCORING_ROOTS`, generated into
  `src/scoring-fingerprint.generated.ts` (gitignored) by
  `bun run engine:fingerprint`, which `postinstall`, `deps`, `dev`, `build` and
  every `deploy:*` already call. There is no `SCORING_ENGINE_VERSION` to bump
  and no fingerprint to paste; both were deleted because two parallel engine
  branches conflicted over them, and a hash over the merged tree matches
  neither parent, so the conflict had no correct side to keep.
  - What a behaviour change DOES owe is a note in
    `web/engine/scoring-changes/` — one file per change, `NNN-slug.md`, so two
    branches can never collide. Say whether points move, and if they do, by how
    much and for whom (measure over the 25-comp archive where you can); if
    nothing observable changes, say that, because the generation still rolls
    and every competition still recomputes. CI enforces it
    (`web/scripts/check-scoring-change-note.ts`, a merge-base diff — deliberately
    no baseline in the tree).
  - The directory is **published**, linked from `/scoring` and `/scoring/gap`:
    a pilot whose points moved without their organiser touching anything is
    entitled to read why.
  - Code that must never drag the report card or a file format into the closure
    stays outside it on purpose — see `format-distance.ts`, `waypoint-files.ts`.
    New code that CAN affect a score but no root imports goes in `SCORING_ROOTS`
    (that is why `track-quality.ts` and `manual-flight.ts` are there).
- **`parseIGC` fixes are non-decreasing in time — rely on it, don't re-derive
  it.** Every time-window loop (altitude cleaning, track quality, event
  detection, any dt-based rate) may assume it, and only the parser can
  establish it: a B record carries HHMMSS and no date. Duplicate seconds are
  KEPT (legitimate above 1 Hz); strictly backwards fixes are DROPPED — never
  clamped or coalesced, which would invent a timestamp the logger never wrote —
  and counted in `IGCFile.timeOrder`. One midnight crossing per file is the
  cap, and only a VALIDATED time field may advance the day offset. See
  `scoring-changes/050-monotonic-fix-timestamps.md`.
- **Never implement inline geo math** (distance, bearing, etc.) — always use
  `web/engine/src/geo.ts`, which provides WGS84 ellipsoid formulas
  (`ellipsoidDistance` — the Vincenty inverse that S7F 2026 §7.1.5 requires,
  with Andoyer-Lambert only as its non-convergence fallback — and Vincenty
  direct for destination) and Turf.js for bearing/bbox.
- **Single source of truth for map visuals/interactions**:
  [docs/mapbox-interactions-spec.md](docs/mapbox-interactions-spec.md) — the map
  provider must match this spec.
- **Track quality** ([docs/track-quality.md](docs/track-quality.md)): two HARD
  checks withhold a track from scoring and task analysis; three SOFT checks only
  annotate. A withheld pilot is **never** deleted from the scores — they are
  seated last at 0 with reasons. Every verdict is organiser-overridable (FAI S7A
  §4.4.6). Re-tune thresholds only via `audit-track-quality.ts` over both the
  bundled comps and the archive.
- **Comp analysis and task analysis are two different things, and are named
  apart.** Both are built from the same 25 behavioural metrics (climbing,
  gliding, decision-making, gaggle, race craft, day profile) ranked by Spearman
  ρ against GAP rank, in `web/engine/src/analysis/`. Both are public and SSR'd.
  They are not interchangeable, and neither is called "field analysis" any more
  — that one name covered both and told a reader nothing about which they had
  open. Where the distinction genuinely does not matter, say "analysis".
  - **TASK analysis** is ONE task's field read against itself:
    `/comp/:id/task/:id/analysis` (+ `/<section>`), `pages/TaskAnalysis.tsx`.
    It hangs off the TASK — in the URL, in the breadcrumbs, and in the IA — and
    it is the only one of the two that is STORED (`task_analysis`).
  - **COMP analysis** is the same separation question asked across every task of
    a competition: `/comp/:id/analysis`, `pages/CompAnalysis.tsx`. It hangs off
    the COMP, and is a pure aggregation over the stored task analyses —
    `aggregateComp()`, materializing nothing.
  - Shared UI is `src/react/analysis/`; the CLI prints a task analysis with
    `bun run score-task -- --analysis` (and every task of a comp with
    `--comp <slug>`).
    See [docs/2026-07-18-field-analysis-plan.md](docs/2026-07-18-field-analysis-plan.md).
  - The task analysis is a child of the TASK, in the URL and in the
    breadcrumbs alike — that is where a reader comes from. The comp analysis
    collects the task analyses and is a sibling link on each one, not their
    parent. `/comp/:id/analysis/task/:id`, where it lived from July to August
    2026, 301s in the SSR Function (it was public and indexable, so a shell
    would not do) and redirects again in the SPA for in-app navigation.
  - The task analysis is a **contents list of boxes**, one per section, and
    each section is its own page
    (`/analysis/strategies|weather|thermals|metrics|style|method`, listed in
    `src/react/analysis/sections.ts` — the SSR route pattern is built from
    that list; the pilot-similarity sheet gets a box too but predates them and
    keeps its own route). A box carries its name and one line of this-task fact,
    never an explanation: it is there to be chosen between, and what needs
    explaining is on the other side of it. One report behind all of them:
    `use-task-report.ts` fetches it and `TaskAnalysisFrame` wears the trail, the
    class select and the freshness poll, so no page can disagree with another
    about which class it is showing. **Presentation order is fixed** — the
    behaviours that separated the field first, then the day, then the per-pilot
    tables — because which metrics have explanatory power *is* the finding.
  - Printing a whole task analysis in one go is **not** a goal (dropped
    2026-08-29): each page prints as itself. Per-component print mirrors (the
    heatmap's caption) stay; the page-level ones went with the one-page report.
  - Some metrics emit charting series (`ReportSeries`, a discriminated union)
    alongside their tables. The day family's series are composed by
    `charts/day-profile/DayProfilePanel.tsx` onto ONE shared comp-zone time axis
    rather than per-metric; tables stay the accessible exact reading, and a new
    series kind must be **ignored, not crash**, in older UIs.
  - Storage is stale-first (`task_analysis`, migration 0019) with two
    departures from scores: revalidation is **lazy** (triggered by a read — it's
    expensive and few people read it) and the cold path **never computes
    synchronously** (returns `pending`, schedules, UI polls).
  - Visibility is `canViewAnalysis()` in `routes/analysis.ts` — one rule for
    both — mirroring the score route: anyone may read a normal comp's analysis;
    a hidden `test` comp 404s for non-admins.
- **Weather** ([docs/weather.md](docs/weather.md)) — provider-neutral interface
  over outside meteorological sources, so a call site names no provider. A
  prediction can never be read as a record; every chart prints its source, and
  weather notes are the organizer's account beside the model's.

## Where things live

| Topic | Doc |
|---|---|
| Local dev, e2e, container preview, tunnel | [docs/local-dev.md](docs/local-dev.md) |
| SSR'd public comp pages + `scores.csv` | [docs/ssr.md](docs/ssr.md) |
| Track submission (incl. anonymous) | [docs/track-submission.md](docs/track-submission.md) |
| Bundled comps, seeding, synthetic fixtures | [docs/sample-data.md](docs/sample-data.md) |
| Task weather + weather notes | [docs/weather.md](docs/weather.md) |
| Site search (comps/tasks/routes/pilots) | [docs/2026-08-01-site-search.md](docs/2026-08-01-site-search.md) |
| Waypoint altitudes (units, zero, the check) | [docs/waypoint-altitudes.md](docs/waypoint-altitudes.md) |
| Track data quality | [docs/track-quality.md](docs/track-quality.md) |
| Thermal shapes (reconstruction + surfaces) | [docs/thermal-shapes.md](docs/thermal-shapes.md) |
| CIVL world rankings | [docs/civl-rankings.md](docs/civl-rankings.md) |
| RAC component kit conventions | [docs/2026-07-18-rac-adoption-guide.md](docs/2026-07-18-rac-adoption-guide.md) |
| Accessibility standard | [docs/accessibility-standard.md](docs/accessibility-standard.md) |
| Map interaction spec | [docs/mapbox-interactions-spec.md](docs/mapbox-interactions-spec.md) |
| Score caching (stale-first) | [docs/score-caching-stale-first-plan.md](docs/score-caching-stale-first-plan.md) |
| Engine generation + scoring changelog | [docs/scoring-version.md](docs/scoring-version.md) |
| Comp & task analysis internals | [docs/2026-07-18-field-analysis-plan.md](docs/2026-07-18-field-analysis-plan.md) |
| Information architecture + design language | [docs/2026-07-08-information-architecture-v2.md](docs/2026-07-08-information-architecture-v2.md) |
| 3D replay | [docs/3d-flight-replay-notes.md](docs/3d-flight-replay-notes.md) |
| Database | [docs/database.md](docs/database.md) |
