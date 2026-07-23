# Competition setup guide — progress bar for not-yet-set-up comps

*2026-07-12. Status: Accepted.*

## 1. Problem

Setting up a new competition is a multi-step job spread across several
surfaces: the create dialog on `/comp`, the Settings dialog, the separate
Waypoints page, the pilots grid, and the New Task dialog. Nothing tells an
organizer what order to do things in or what's left. After creating a comp
they land on `/comp/:id` — a page designed for a *populated* comp — and see
a header, a row of section links, and a stack of empty sections.

The section-links row (`Tasks · Scores · Pilots · Waypoints · Activity ·
Admins`, `CompDetail.tsx:216–226`) makes this worse for a fresh comp: five
of the six links scroll to sections with nothing in them. The links are
wayfinding for a populated page; on an empty page they navigate you to
emptiness.

The canonical setup order (matching how the pieces depend on each other —
waypoints feed the route editor, pilots feed track submission):

1. **Create the competition** — the "Start a new competition" button on `/comp`
2. **Review Settings** — timezone, close date, scoring format, GAP params
3. **Add Waypoints** — upload/paste on `/comp/:id/waypoints`
4. **Add Pilots** — the Edit-pilots grid in the `#pilots` section
5. **Create the first task** — New Task dialog, then set its route

## 2. Design

### 2.1 The setup guide

A **setup guide card** rendered at the top of `/comp/:id` (inside
`CompDetailView`, between the section-nav row and `ClassWarnings`), visible
only when **both** hold:

- the viewer is a comp admin (`isAdmin`, already computed at
  `CompDetail.tsx:173–175`), and
- at least one step is incomplete.

It shows the five steps as an ordered checklist with a thin progress bar
("2 of 5 steps") using the existing `ui/progress.tsx`. Completed steps get
a check mark; the **first incomplete step is the highlighted "next" step**
with its action inline. Every step row is also a link/button to the place
where you do it, so the guide doubles as navigation while it's visible.

```
┌─────────────────────────────────────────────────────────────┐
│ Set up your competition                        2 of 5 steps │
│ ▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░                                │
│ ✓ Create the competition                                    │
│ ✓ Review settings                                           │
│ ● Add waypoints            → opens /comp/:id/waypoints      │
│ ○ Add pilots               → opens the Edit-pilots grid     │
│ ○ Create the first task    → opens the New Task dialog      │
│                                              [Hide guide]   │
└─────────────────────────────────────────────────────────────┘
```

The guide is **condition-based, not stored**: when the last step completes
it disappears on the next data refresh, with no persisted "done" bit to
migrate or get stale. A "Hide guide" link (for organizers who deliberately
skip a step, e.g. a comp run without shared waypoints) sets a
per-comp `localStorage` key — client-only state for a client-only
component, no API surface. Non-admins never see the guide. 

Important: Some of the steps can be performed out of order - e.g. you can
add pilots before waypoints or reviewing the settings.

### 2.2 Step completion signals

| # | Step | Complete when | Data source |
|---|------|---------------|-------------|
| 1 | Create the competition | always (the page exists) | — |
| 2 | Review settings | comp settings saved at least once | **new** `settings_reviewed` flag (§3.2) |
| 3 | Add waypoints | comp has ≥ 1 waypoint | **new** `waypoint_count` on `GET /api/comp/:id` (§3.1) |
| 4 | Add pilots | `pilot_count > 0` | already in the comp payload |
| 5 | Create the first task | a task exists **and** has a route (`tasks.some(t => t.has_xctsk)`) | already in the comp payload |

Notes on the judgement calls:

- **Step 1 is shown pre-checked** rather than omitted. It costs one row,
  makes the list read as the complete recipe (useful when someone else
  created the comp), and the immediate "1 of 5 done" is honest momentum.
- **Step 5 requires a route, not just a task row.** Creating the task shell
  takes seconds; a task without a route can't be flown or scored
  (`has_xctsk` is already surfaced per task, and the tasks list already
  warns "No route"). While a task exists without a route, the step stays
  active but its label and action adapt: "Set the route for Task 1" →
  `/comp/:id/task/:tid#edit-route` (an existing deep-link that opens the
  route editor).
- **Step 2 uses a stored flag, not a heuristic.** Guessing "reviewed" from
  non-default timezone/close-date/GAP params is brittle — the defaults are
  often exactly what the organizer wants, and Save-with-defaults is a valid
  review. The flag flips on the first successful `PATCH /api/comp/:id`
  (the Settings dialog's save), which also nudges organizers to confirm
  defaults with an explicit Save.

### 2.3 Step actions

The guide renders inside `CompDetailView`, so most actions are direct:

- *Review settings* → `setSettingsOpen(true)` (the state that already backs
  the Settings button).
- *Create the first task* → `setCreateOpen(true)` (backs the New Task
  button) — or the `#edit-route` link once a task exists (above).
- *Add waypoints* → router `Link` to `/comp/:id/waypoints` (separate page).
- *Add pilots* → `PilotsSection` owns its `editOpen` state internally
  (`PilotsSection.tsx:62`), so reuse the established hash pattern
  (`#edit-route` on the task page): navigate to `#edit-pilots`, and
  `PilotsSection` opens its dialog when it sees that hash, clearing it on
  close. This also gives admins a shareable deep-link to the pilots editor.
  *(Update 2026-07-23: the roster moved to the admin-only `/comp/:id/pilots`
  page, so this step now links to `/comp/:id/pilots#edit-pilots` — same hash
  pattern, different page. The section nav also changed: it's sticky, Scores
  points at `/comp/:id/scores`, Pilots is an admin-only link to the new page,
  and Admins is a footnote rather than a nav entry.)*

### 2.4 Should the section links merge into the progress bar?

**Recommendation: no literal merge — keep the nav row, and make the two
elements point at the same targets so they feel like one system.**

Reasons:

- **The nav is SSR'd chrome; the guide is post-auth chrome.** The section
  nav is part of the server-rendered markup every visitor sees at first
  paint. Admin status resolves only after `/api/auth/me` returns
  post-hydration (same as the Settings button pop-in). Replacing the nav
  with the guide would mean the nav *appears then vanishes* for admins on
  every visit — a layout jump the current pop-in pattern deliberately
  avoids (adding content below the header is much less jarring than
  removing content). It would also make the four SSR'd pages render
  differently per role, against the "role-aware, not role-gated" IA
  principle.
- **Different jobs.** The nav is permanent wayfinding for every visitor;
  the guide is a transient to-do list for one role. Merging couples a
  visitor-facing element to admin-only state.
- The overlap concern is real but small: while the guide is visible, its
  step rows land in the same places as four of the six nav links. That
  redundancy lasts only until setup completes, and the guide sits directly
  under the nav so the duplication reads as emphasis, not confusion.

What *does* improve the nav for everyone — first visit and every visit
after — is making it state-aware (§2.5).

### 2.5 First-time and subsequent experience beyond the guide

The guide fixes the admin's first-run experience. Two smaller changes fix
"the links are useless for an empty comp" for **all** viewers and improve
the populated-comp experience too:

1. **Counts on the nav links.** `Tasks (3) · Scores · Pilots (24) ·
   Waypoints (67) · Activity · Admins (2)`. Tasks/pilots/admins counts are
   already in the SSR-seeded comp payload; waypoints uses the new
   `waypoint_count`. A zero-count link is honest signage ("Tasks (0)" tells
   you not to bother scrolling), and on a populated comp the counts are
   at-a-glance facts. Scores and Activity stay uncounted (no cheap or
   meaningful number).
2. **Role-aware empty states in each section.** Today the sections render
   terse text ("No tasks yet"). Upgrade each to a proper empty state:
   - *visitor*: an explanatory sentence — "The organizers haven't published
     any tasks yet." (Pilots, Scores similar.)
   - *admin*: the same sentence plus the section's CTA — the empty Tasks
     section shows a "New Task" button in the body, not just in the
     `SectionHeader` corner.

   This means even after the guide is hidden or setup completes partially,
   every navigation target explains itself.

Sequencing: the guide is the headline; counts and empty states are
follow-on polish (phases in §5) and each stands alone if descoped.

## 3. API changes (competition-api)

Both changes extend `GET /api/comp/:comp_id` (`routes/comp.ts:313–437`),
which both the SSR loader (`loadCompDetail`, `loaders.ts:86`) and the SPA
consume — so the guide computes entirely from the one already-fetched comp
payload, no extra client round-trips.

### 3.1 `waypoint_count`

Waypoints live in D1 (`comp_waypoints.waypoints`, a JSON array — migration
`0015_comp_waypoints.sql`). Add to the comp-detail handler:

```sql
SELECT json_array_length(waypoints) AS n FROM comp_waypoints WHERE comp_id = ?
```

(absent row → 0), returned as `waypoint_count: number` beside
`pilot_count`. One cheap indexed lookup; also powers the nav count.

### 3.2 `settings_reviewed`

Migration `0016_comp_settings_reviewed.sql`:

```sql
-- Setup-guide signal (comp setup progress): has an admin saved the comp's
-- settings at least once? Flipped by the first successful PATCH
-- /api/comp/:id; purely presentational, never read by scoring.
ALTER TABLE comp ADD COLUMN settings_reviewed INTEGER NOT NULL DEFAULT 0;
UPDATE comp SET settings_reviewed = 1;  -- grandfather existing comps
```

The backfill marks every existing comp reviewed: for pre-existing comps we
can't know, and nagging established organizers about a step they've
effectively done is worse than missing the nag on a genuinely fresh comp
(any comp created after this ships starts at 0).

`PATCH /api/comp/:comp_id` sets `settings_reviewed = 1` alongside its other
writes. Per the coding rules: the PATCH handler already calls `audit()` and
`bumpAndRevalidateScores()` for the fields that need them; the flag itself
is not a scoring input and not independently user-visible, so it rides the
existing mutation with **no new audit entry and no score bump**. The two
new read-side fields likewise need neither.

`CompDetailData` (`comp/types.ts:27–53`) gains `waypoint_count: number` and
`settings_reviewed: boolean`. (While there, consider also declaring the
`is_admin` the API already returns but the type omits — not needed for this
feature, the client's `admins`-array check stays.)

## 4. Frontend structure & SSR safety

- New `src/react/comp/CompSetupProgress.tsx`: pure presentational component
  taking `{ comp, onOpenSettings, onCreateTask, compId }`. Step derivation
  is a **pure exported function** `deriveSetupSteps(comp): Step[]` so it
  unit-tests without rendering.
- Built from existing pieces: `Card`, `Progress`/`ProgressTrack`/
  `ProgressIndicator`, lucide icons (`Check`, `Circle`), Tailwind. No new
  UI primitives; there is no stepper component in `ui/` and this doesn't
  need one.
- **Rendered only when `isAdmin`** — on SSR and first client paint
  `isAdmin` is `false` (auth resolves post-mount), so server and hydration
  markup agree (`null`), and the guide pops in after auth exactly like the
  existing Settings / New Task buttons. No `window`/`localStorage` at
  module scope; the "Hide guide" read happens in an effect/lazy initializer
  guarded by `typeof window` (the component never renders server-side
  anyway, but the file is imported by an SSR'd page, so the rule applies).
- All step signals come from the seeded comp payload (§3), so there is no
  per-step client fetch and no loading flicker inside the guide.
- Refresh: `CompDetail` already refetches the comp after mutations
  (task create, settings save); returning from the Waypoints page or the
  pilots dialog closing likewise lands on fresh data — steps tick over
  without extra wiring.

## 5. Implementation phases

Each phase ships independently.

1. **API + guide** — migration 0016, `waypoint_count` +
   `settings_reviewed` on comp detail, PATCH flag write,
   `CompSetupProgress` + `deriveSetupSteps`, `#edit-pilots` hash in
   `PilotsSection`, wire into `CompDetailView`.
2. **Nav counts** — counts on Tasks / Pilots / Waypoints / Admins links.
3. **Role-aware empty states** — Tasks, Scores, Pilots sections.

## 6. Accessibility (per docs/accessibility-standard.md)

- The guide is a `<section aria-labelledby>` containing an `<ol>`; each
  completed step carries a visually-hidden "Completed:" prefix (the check
  mark alone is not conveyed to screen readers).
- The progress bar uses `ui/progress.tsx` (base-ui `Progress` with proper
  `progressbar` semantics + `ProgressLabel`/`ProgressValue`), as on the
  Dashboard quota bar.
- Step actions are real `<button>`/`<Link>` elements; the whole row may be
  a click target but the accessible name lives on the control.
- Completion-state color pairs with the icon shape (check vs circle), never
  color alone; verify tokens meet contrast in both themes.
- "Hide guide" is keyboard reachable; hiding moves focus sensibly (to the
  section nav).

## 7. Testing

- **Unit (frontend):** `deriveSetupSteps` — fresh comp (1/5), each signal
  flipping independently, task-without-route keeps step 5 active with the
  "set the route" variant, all-complete → guide hidden.
- **Worker tests:** comp detail returns `waypoint_count` (0 with no row,
  n with data) and `settings_reviewed`; PATCH flips the flag.
- **E2E:** create a comp → guide shows with step 1 checked; save settings →
  step 2 ticks; add pilots via grid → step 4 ticks; create task + set route
  → guide disappears. Guide never renders signed-out or as non-admin.
- **SSR:** `bun run test:e2e:ssr` unchanged — anonymous `/comp/:id` markup
  must not contain the guide; hydration stays clean.

## 8. Non-goals

- No setup wizard/modal flow — the guide points at existing surfaces, it
  doesn't duplicate them.
- No changes to the four SSR'd pages' public markup beyond the (uncounted →
  counted) nav labels in phase 2.
- No per-step "skip" state — "Hide guide" hides the whole card; per-step
  skips add persistence complexity for little gain.
- Waypoints/pilots/task *quality* checks (e.g. "task missing SSS") stay
  where they are (`ClassWarnings`, task-list pills) — the guide tracks
  existence, not validity.

## 9. Questions and answers

1. Should the guide also appear on the `/comp/:id/waypoints` page (a
   slimmer variant), so an organizer mid-flow keeps their bearings?
   - No.
2. Is "waypoints" genuinely required for every comp format?
   - Yes. Even the Open Distance format requires a single waypoint for the launch.
3. Counts on nav links change the SSR'd public markup.
   - Confirm no SEO snapshot/test depends on the exact link text.
