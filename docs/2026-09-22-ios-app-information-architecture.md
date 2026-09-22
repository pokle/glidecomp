# Information architecture for a native iOS / iPadOS GlideComp app

Date: 2026-09-22
Status: draft for discussion. No code committed to it.

Builds on the partial IA sketched in conversation (comps view → comp view,
hierarchical disclosure in the style of the iOS Settings app) and completes it.
Where it differs from the web app it says so and why. The web decisions it is
measured against are
[2026-07-08-information-architecture-v2.md](./2026-07-08-information-architecture-v2.md)
and the rules in `CLAUDE.md`.

---

## 1. What this IA is for

GlideComp has accumulated surfaces faster than it has accumulated places to put
them. On the web a competition today is a hub page plus five sibling pages plus
a sticky section bar, a task is a page with six sections and three admin editors
hanging off it, and the same job — submit a track — has three entry points. Each
addition was locally right. The sum is a reader hunting.

**The job of this IA is retrieval, not coverage.** Every question below is one
somebody actually asks while standing on a hill or sitting in a briefing, and
the IA is judged by how many taps and how much reading it takes to answer it:

| # | The question | Who asks it | Answer lives |
|---|---|---|---|
| Q1 | What is today's task and what is the route? | Pilot | Comp → Task |
| Q2 | How do I get this task into my instrument? | Pilot | Task → Route → Send to device |
| Q3 | I've landed — how do I hand in my track? | Pilot | Submit, from anywhere |
| Q4 | Did my track arrive? | Pilot | Task → Your track |
| Q5 | What did I score, and why that and not more? | Pilot | Scores → Report card |
| Q6 | Where am I overall? | Pilot | Comp → Scores |
| Q7 | Who hasn't handed in a track yet? | Organiser | Task → Pilots & tracks |
| Q8 | Set tomorrow's task before briefing. | Organiser | Comp → Add task |
| Q9 | Who changed that score, and when? | Anyone | Comp → Activity |
| Q10 | Which pilots are even in this comp? | Organiser | Comp → Pilots |

Three tests apply to every screen in this document:

- **One way to do a thing.** If an action appears twice, one of them is deleted.
  (`CLAUDE.md`, the waypoints rework.)
- **One question per screen.** A screen that answers two questions is two
  screens; hierarchical disclosure is how they get separated.
- **A phone is the shape, not a constraint.** No screen here is a desktop
  layout that survived. Where iPad has more room it gets a split view over the
  *same* hierarchy, never a second one.

---

## 2. Structure: a tab bar over four stacks

The sketch starts at the comps list and pushes down from there. That is right
for competition data and wrong for everything a pilot owns — their own flights,
their account, their unit preferences — which would otherwise only be reachable
by first entering a competition they may not be in.

```
┌─────────────────────────────────────────────────────────────┐
│  UINavigationController per tab; each is a disclosure stack  │
├─────────────┬─────────────┬─────────────┬───────────────────┤
│   Comps     │   Submit    │  My flights │        Me         │
│  (default)  │  (action)   │             │                   │
└─────────────┴─────────────┴─────────────┴───────────────────┘
```

- **Comps** — the stack the sketch describes. Launch tab, and where a cold
  start lands.
- **Submit** — presents the submit sheet over whatever is on screen; it does
  not push a stack of its own. A pilot who has just landed should never have to
  navigate to hand in a file, and this is the one job with a hard deadline
  attached. (The web made the same call in #535 by giving it a nav tab.)
- **My flights** — the personal library: tracks and tasks this account holds,
  plus its competition flights. Exists today at `/u/:username`.
- **Me** — account, profile, pilot IDs, units, appearance, sign out. Signed out,
  this tab is the sign-in surface, so signing in is never a modal ambush
  mid-task.

**Depth budget: four pushes.** `Comps → Comp → Task → Pilots & tracks → Pilot`
is the deepest legitimate path. Anything deeper is a modal sheet (see §3), not
a fifth push.

**iPad**: a three-column split — sidebar (the four tabs) / list / detail. The
detail column shows the deepest selection. The map and the 3D replay are the
only full-width takeovers.

---

## 3. When a thing is a push, a sheet, or a takeover

The sketch says "slides up a sheet similar to existing dialog" for creating a
comp, which is right — but the rule needs stating once so it does not get
decided per screen:

| Shape | For | Examples |
|---|---|---|
| **Push** | Navigating *into* data that exists and stays | Comp, task, scores, a waypoint, a pilot, a settings group |
| **Sheet** | A bounded task with a completion, that you can abandon | Create comp, create task, submit a track, altitude review, filters, share |
| **Takeover** (full-screen cover) | A tool with its own controls that owns the whole device | Analysis map, 3D replay, maximised waypoint map, QR for a briefing screen |

A sheet **must** be dismissable with a swipe and with the hardware/system back
gesture, and must warn before discarding unsaved edits. The web learned this
the hard way — `lib/use-back-dismiss.ts` exists because a sheet that the
history stack cannot see loses a pilot's unsaved work on one Back press.

**Destructive and irreversible actions never live on a sheet's primary path.**
Delete comp, delete task, delete a track: bottom of the owning settings screen,
in a "Danger zone" group, red, behind a confirmation naming what goes.

---

## 4. Who sees what

Five roles. They are cumulative except the last two, which are orthogonal.

| Role | How the app knows |
|---|---|
| **Visitor** | No session |
| **Signed-in pilot** | Session, not on this comp's roster |
| **Registered pilot** | Holds a `comp_pilot` row in this comp |
| **Organiser (comp admin)** | `comp_admin` row for this comp — `is_admin` on the comp payload |
| **Site super admin** | Global; may administer any comp, and may *view as* a pilot |

### The six authorisation rules

1. **Hide, never disable.** A greyed-out row invites a tap and explains
   nothing. If a role may not do it, the row is absent. The one exception is a
   *state* rather than a permission — "This task is closed for track
   submissions" is a sentence, not a dimmed button (as on the web task page).
2. **Public stays public.** Scores, waypoints, the activity log, the report
   card and both analyses are readable by a visitor with no account. A native
   app that demands a sign-in to read a scoreboard has taken something away.
3. **A hidden comp is not found, and names nothing.** A `test` comp 404s for
   anyone who is not an admin — including in search, in link repair, and in the
   comps list. The not-found screen must not leak the name it refused.
4. **Never guess a pilot's identity.** If the roster holds unclaimed rows, the
   submit flow *asks* which one the pilot is. Names may order the picker;
   nothing branches on them. (`ensureCompPilot` → `409 identity_ambiguous`.)
5. **A transient failure is not an answer.** This is the rule a native app on a
   hill will break first. A dropped request is not "signed out" and not "not
   found": both are terminal states nothing re-fetches, so a blip in mobile
   coverage becomes a wrong screen that stays wrong. Retry, then decide, and
   show a *retry* affordance rather than an empty state. A 4xx is a real answer
   and is not retried.
6. **View-as is visible.** When a super admin is previewing as a pilot, a
   persistent bar says so and offers one tap back. Admin controls disappear
   while it is on — which is what makes the preview worth anything.

### Matrix

Legend: ● full · ◐ read only · ○ absent.

| Surface | Visitor | Signed in | Registered | Organiser |
|---|---|---|---|---|
| Comps list, search | ◐ | ◐ | ◐ | ● (sees hidden comps) |
| Create comp | ○ | ● | ● | ● |
| Comp view, comp card | ◐ | ◐ | ◐ | ● |
| Tasks list | ◐ | ◐ | ◐ | ● (+ Add task) |
| Task view, route, weather | ◐ | ◐ | ◐ | ● |
| Submit track | ● (if open registration) | ● | ● | ● (+ on behalf) |
| Your track / your score | ○ | ○ | ● | ● |
| Scores, report card | ◐ | ◐ | ◐ | ● (+ recompute) |
| Task & comp analysis | ◐ | ◐ | ◐ | ◐ |
| Waypoints | ◐ | ◐ | ◐ | ● |
| Pilots (roster) | ○ | ○ | ○ | ● |
| Activity | ◐ | ◐ | ◐ | ◐ |
| Comp settings, task settings | ○ | ○ | ○ | ● |
| Penalties, pilot status, manual flight | ○ | ○ | ○ | ● |

Two entries deserve their reasons written down:

- **Pilots is organiser-only**, although it names no secret. The roster is a
  management surface, and a visitor already sees every pilot in the scores;
  a public copy would be a second place to look that is sometimes wrong. (Web
  IA v2 made the same call and flagged it as its one deliberate exception.)
- **Activity is public** for non-test comps. It is the competition's
  transparency record — a pilot whose points moved is entitled to read who
  moved them — and every scoring mutation is required to write to it.

---

## 5. Comps view

The sketch, with the gaps filled.

**Contents** — one section list, grouped, newest activity first:

```
  [ Search comps, tasks, pilots, turnpoints… ]        ← bottom search field

  YOURS                                  (omitted when empty)
    ▸ Corryong Cup 2026        Flying today · Task 3
    ▸ Bright Open              You're 7th · finished
  FLYING NOW
    ▸ Canungra Classic         HG · GAP · Open, Floater · 12–18 Jan
  UPCOMING
  PAST
```

- **Yours** is the single biggest retrieval win available and costs nothing: a
  comp you are registered in, or administer. Without it, a pilot's own
  competition is a row in an alphabetical list of other people's.
- Row content: name · `HG`/`PG` · scoring format · classes · task date range.
  Badges: `Hidden` (organisers only), `Registered`, `Organiser`.
- **Search is comp-wide, not list-filtering.** The existing FTS index already
  covers competitions, tasks, turnpoints and pilots, so the field at the bottom
  searches all four and returns grouped results that push straight to the
  deepest thing that matched. Filtering the visible rows would be a much
  smaller promise than the index already keeps.
- **+ New comp** — a sheet (name, category, classes, scoring format, dates).
  On success, dismiss and push the new comp. Signed out, the button prompts
  sign-in rather than disappearing: it tells a would-be organiser the app does
  this.
- Pull to refresh. Offline: last-seen list, with a staleness line.

---

## 6. Comp view

The sketch's grouping is sound. Four changes.

```
  ◀ Comps                    Canungra Classic            [Share]

  ┌───────────────────────────────────────────────┐
  │ Canungra Classic                              │
  │ Hang gliding · GAP · Open, Floater            │
  │ 12–18 January 2026 · Australia/Brisbane       │
  │ Organised by Jo Smith, Alex Tan               │
  │ “Briefing 0900 at the clubhouse…”             │  ← organiser's notes
  └───────────────────────────────────────────────┘

  YOU                                   (registered pilots only)
    Registered as           Tushar Pokle · Open ›
    Your score              4th · 2,841 pts       ›
    Submit a track                                ›

  TASKS                                          + Add task (organiser)
    Wed 14 Jan
      Task 3 — 88 km ▷                            ›
    Tue 13 Jan
      Task 2 — 62 km ▷                            ›

  RESULTS
    Scores                                        ›
    Analysis                        (GAP comps only)  ›

  COMPETITION
    Waypoints                                 145 ›
    Pilots                                     72 ›   (organiser only)
    Activity                                      ›
    Settings                                      ›   (organiser only)
```

1. **"Wing" is `category`** — the stored value is hang gliding or paragliding,
   and it changes which GAP defaults apply. Label it "Class of wing" or just
   print `Hang gliding`; "Wing" reads like a glider model.
2. **A "You" group, and it does not reorder anything.** This is where Q4, Q5
   and Q6 get answered in one tap. Note the tension deliberately: the web
   removed its today's-task hero in #514 ("every task alike — no privileged
   task"). This does not resurrect it. The tasks list stays chronological and
   undifferentiated; the You group is about the *viewer*, not about which task
   matters. It is absent for anyone not on the roster.
3. **"Miscellaneous" is renamed.** A group called miscellaneous is a group
   nobody can predict the contents of, which is the opposite of retrieval.
   **Competition** holds the four rows that are about the comp rather than
   about a day of it. Settings sits last within it, as iOS does.
4. **Comp-level organiser's notes is genuinely new** and needs backend work:
   a column, a `PATCH` handler, an `audit()` call, and — because it is not a
   scoring input — explicitly **no** `bumpAndRevalidateScores()`. Do not
   confuse it with the existing per-task `weather_notes`, which is the
   organiser's account of one day's conditions and already exists. Both should
   ship; they answer different questions.

Also on this screen: the setup-progress guidance an organiser sees on a
half-configured comp (missing classes, no waypoints, task with no route) belongs
as an inline card under the comp card, organiser-only, dismissable once green.

---

## 7. Task view

The screen a pilot opens most, and today the web's busiest. Disclosure is what
rescues it: the task view states the day and then offers four doors.

```
  ◀ Canungra Classic              Task 3              [Share]

  ┌───────────────────────────────────────────────┐
  │ Task 3                                        │
  │ Wednesday 14 January 2026                     │
  │ Open, Floater · 88.4 km · Race to goal        │
  │ ⚠ Task stopped 14:35 — scored as stopped (S7F §13.4)
  └───────────────────────────────────────────────┘

  [ Submit track ]                        ← one filled button, nothing else

  ROUTE
    Turnpoints                                  7 ›
    View on map                                   ›   (takeover)
    3D replay                                     ›   (takeover; when tracks exist)
    Send to instrument / Download .xctsk          ›
    Edit route                                    ›   (organiser)

  THE DAY
    Weather                                       ›
    Organiser's notes            “Overdevelopment…” ›

  RESULTS
    Task scores                    1. J Smith 987 ›
    Task analysis                                 ›   (GAP, route set)

  YOUR TRACK                            (registered pilots only)
    Submitted                  14:52 · 62.1 km ✓  ›   → report card
  ORGANISER
    Pilots & tracks                          54/72 ›
    Task settings                                 ›
    Create test IGC                               ›
```

Notes:

- **One filled button.** Submit track is the thing to *do*; everything else is
  a place to go, and places to go are rows. The web reached the same conclusion
  and it matters more on a phone, where a wrapped row of six buttons is the
  first thing a thumb meets.
- **Route is a door, not a table.** Seven turnpoints with radii, altitudes,
  open/close times and leg bearings is a screen of its own; the row says how
  many there are. Tapping a turnpoint opens its sheet.
- **"Send to instrument"** is the native app's best single feature and deserves
  its own row rather than being a share-sheet afterthought: `.xctsk` via
  AirDrop, Files, QR on screen for a briefing, and the existing waypoint
  device-export formats.
- **Prev/next task** as a swipe gesture and as a segmented control in the nav
  bar. At a comp you read tasks in sequence.
- **Status badges are above the fold and are sentences**: route not set,
  closed for submissions, task stopped. A pilot should learn the task stopped
  before choosing a file, not after being refused.
- **Pilots & tracks** (the management grid) is a *push*, never an inline grid.
  See §11.

---

## 8. Scores — and the "Results view" naming problem

The sketch asks for both a **Scores view** and a **Results view** while also
listing Results as the *group* containing Scores. That duplication is exactly
the mess the IA is meant to remove. Resolve it as three distinct things with
three distinct names, and never use "results" as a screen name:

| Name | Scope | Route analogue |
|---|---|---|
| **Scores** | The whole competition, per class, series-scored | `/comp/:id/scores` |
| **Task scores** | One task's field | Task view → Task scores |
| **Report card** | One pilot, one task, explained | `/comp/:id/task/:id/pilot/:id` |

### Scores view (competition)

```
  ◀ Canungra Classic             Scores            [Export]

  [ Open ⌄ ]                     ← class picker, not tabs: classes can be many
  Computed 12 minutes ago · updating…      ← freshness; tap to recompute (admin)

  OVERALL        TOP 3 BY TASK        TEAMS        BY TASK
  ──────────
   1  J Smith          2,910
   2  A Tan            2,874   ›
```

- **Class first, view second.** The class is the reader's identity; the view is
  what they want to see about it. Putting both in one tab strip (as the web
  does) makes a four-class comp seven tabs.
- Row → a pilot's series breakdown (task by task, FTV discards marked) → a task
  row → the report card. That is the path Q5 takes, and it is two taps from a
  scoreboard.
- **Freshness is stated, always.** Scores are stale-first: the app must say
  when they were computed and whether a recompute is running, or a pilot will
  read a pre-penalty number as final. Recompute is an organiser action.
- Export (CSV / share sheet) is public — `scores.csv` already is.
- FTV, when in use, gets an explain row rather than a footnote.

### Report card view

The one screen the correctness rules in `CLAUDE.md` speak about directly:
every section names its inputs and prints the substituted arithmetic. That maps
onto hierarchical disclosure better than onto any web layout — the summary is
the list, and each section is a push.

```
  ◀ Scores                  Tushar Pokle · Task 3

  [ track map + scrubber ]

  4th · 841.2 points
    Flight                    62.1 km · landed 14:52 ›
    Day quality               0.83                   ›
    Distance points           312.4                  ›
    Time points               188.0                  ›
    Leading points            94.6                   ›
    Arrival points            46.2                   ›
    Penalties                 −20  Jump the gun      ›
    Total                     841.2                  ›
    How you compare                                  ›
    Track data cleaning       14 fixes repaired      ›
  ORGANISER
    Set penalty                                      ›
    Replace / delete track                           ›
    Record a manual flight                           ›
```

Each pushed section carries its formula with the numbers substituted, its
emphasis chart (this pilot accented, the field muted), and a link out to the
GAP explainer for a reader who does not know the formula. Section order is the
scorer's order and is not negotiable — it is the arithmetic.

---

## 9. Analysis views

Two things, deliberately named apart, and the native app must not merge them
just because both are "analysis":

- **Task analysis** — one task's field read against itself. Hangs off the
  **task**. A contents list of six section rows: Winning strategies, Weather,
  Thermals, Metric details, Flying style, How this was measured — plus the
  pilot-similarity tool. Each row is a push. Order is fixed: which behaviours
  separated the field *is* the finding.
- **Comp analysis** — the same question across every task. Hangs off the
  **comp**, aggregates the stored task analyses, and links to each.

Both are public, both are expensive, and both are lazily revalidated: a cold
report returns `pending`. So both screens need a **pending state that is
honest** — "Working this out, about a minute" with a progress indicator, not an
empty table — and must poll. Hidden on open-distance comps, which have no legs
to measure.

---

## 10. Waypoints view

Already reworked on the web for exactly this shape, so the native app inherits
a settled design rather than inventing one.

```
  ◀ Canungra Classic          Waypoints               [ ⋯ ]

  [ map pane — collapsible, maximisable to takeover ]
  [ Filter by code, name or coordinates… ]

    📍 │ CANUN  Canungra Launch     620 m         ›
    📍 │ BEECH  Beechmont           430 m         ›
```

- **A list, at every width** — never a spreadsheet grid. Rows open full-screen
  sheets. The grid was unusable on a phone and is gone rather than hidden
  behind a breakpoint.
- **The whole left strip flies the map**; the pin names the action. Read-only,
  the *entire row* does it, because nothing opens.
- Organiser actions in the `⋯` menu / above the list: Upload file, Add
  waypoint, **Check altitudes**. Check altitudes is the only altitude action
  and reports nothing until pressed; its findings review in a sheet where every
  row states *both* altitudes.
- Everyone gets: filter, export to device formats, QR.
- **Units**: the editor is metric throughout and labels say "(m)" — it is the
  waypoint file edited in place. A read-only altitude row honours the reader's
  unit preference. A cylinder radius is always metric, everywhere, because it
  is the task's own number.
- Never scrolls sideways.

---

## 11. Pilots view (organiser)

The roster. The web still edits it in a Tabulator grid; the native app should
not, for the same reason the waypoints grid went.

```
  ◀ Canungra Classic            Pilots                [ + ]

  Open registration · any signed-in pilot joins by submitting

  OPEN
    Tushar Pokle      tushar@…            WPRS 214.6  ›
    Jane Smith        —  unclaimed                    ›
  FLOATER
    …
```

- Grouped by class; sortable by WPRS points, because launch order is set in
  ranking order and that is the one column an organiser reads the list down.
- Row → pilot sheet: name, email, class, team, nationality, CIVL ID, WPRS
  source, comp status (present / absent / DNF), remove.
- Bulk actions behind `+` / `⋯`: Add pilot, Import CSV, Export CSV, Fill from
  CIVL, Add test pilots.
- **Unclaimed rows are marked as such** and are never auto-linked on a name.
- Registration mode is stated on the screen it affects, with a pointer to the
  setting rather than a duplicate control.
- Every edit here is audited and bumps score staleness (class and status are
  scoring inputs; a team name is not).

**Pilots & tracks** (on the task view) is a different screen with the same
shape: one row per registered pilot for *this task*, showing track state
(submitted / none / withheld by track quality / manual flight), with per-pilot
actions — upload on behalf, set status, set penalty, record a manual flight,
delete or restore a track. This is Q7, and it wants to be scannable at a glance
in low light: state as a coloured leading glyph, not a column of text.

---

## 12. Activity view

The audit log, public for non-test comps.

- Reverse chronological, grouped by day, infinite scroll.
- Filter chips: All · Tasks · Pilots · Tracks · Settings.
- Each entry: time · actor · a specific human-readable sentence, including old
  and new values. That specificity is required of every mutating handler, so
  the view can stay dumb.
- The comp view shows a three-entry digest with "Show all activity"; this is
  the screen it opens.

---

## 13. Comp settings view (organiser)

Straight iOS Settings, which the web already converged on (`NavList` / `NavRow`
with a value summary per row):

```
  ◀ Canungra Classic           Settings

    General              Canungra Classic    ›   name, timezone, dates, notes
    Access               Open registration   ›
    Pilot classes        Open, Floater       ›
    Scoring              GAP · FTV           ›
    Organisers           2                   ›

  DANGER ZONE
    Delete competition
```

- **Every row shows its current value.** An organiser should be able to audit
  the whole configuration without opening anything — that is the pattern's
  entire payoff.
- **Access** holds the three switches: Hidden, let pilots self-register by
  submitting, let registered pilots record flights and statuses for each other.
  Each switch gets a sentence of consequence under it, not a bare label.
- **Scoring** pushes again: format (GAP / open distance), series scoring
  (total / FTV, discard fraction), then GAP parameters as a further push —
  nominal distance, nominal time, nominal goal, jump-the-gun factor, distance
  origin. Deep is correct here: these are consulted once per competition and
  must not be in the way of the settings that are not.
- **Organisers** is currently an "Admin emails" text field inside Access. On
  native it should be a list you add and remove people from; a comma-separated
  email field is a desktop compromise.
- Saving anything here writes an `audit()` entry, and anything that is a
  scoring input also calls `bumpAndRevalidateScores()`. The UI consequence: a
  save may legitimately make the scores screen say "recomputing", and the app
  should not treat that as an error.

## 14. Task settings view (organiser) — missing from the sketch

Five settings, so a flat form rather than an index:

Name · Date · Pilot classes · Stop announcement time (S7F §13.4) · Open for
track submissions. Then a Danger zone with Delete task.

The route is **not** here — it is edited from the Route section of the task
view, because that is the part of the task it is about.

---

## 15. The other views the sketch is missing

| View | Why it has to exist |
|---|---|
| **Submit track** (sheet) | Q3. Three steps: which task · who the track is for · the file. Must handle the ambiguous-identity case by asking, and must promise the notification email the backend sends. |
| **Report card** | Q5, and the app's whole correctness promise. §8. |
| **Task scores** | The per-task field; distinct from comp scores. §8. |
| **Task analysis / comp analysis** | §9. |
| **Task settings** | §14. |
| **Pilots & tracks** (per task) | Q7 — the organiser's most-used screen during a comp. §11. |
| **My flights** | The personal library: tracks and tasks this account holds, plus its competition flights, plus storage used. |
| **Me / account** | Profile (name, contact, CIVL and FAI IDs), Units (altitude, distance, speed), Appearance, API keys, Sign out, Delete account. |
| **Sign in** | Email OTP and Google. Never a modal interruption — it is the Me tab, and actions that need it say so before asking. |
| **Onboarding** | First run only: what the app is, sign in, optional pilot IDs. |
| **Search results** | The bottom search field's destination, grouped by kind. |
| **Not found / link repair** | A universal link can rot. The web reads the words out of a dead path and offers what resolves now; native gets the same, or a deep link from a WhatsApp group becomes a dead end. |
| **Analysis map** / **3D replay** | Takeovers with their own controls. |

---

## 16. What a native app owes that the web cannot

These are the reasons to build it at all, and each needs a place in the IA
rather than being bolted on:

- **Offline, and honest about it.** A comp runs where there is no signal. Every
  screen in §5–§13 should render from cache with a stated age; every write
  (track upload, pilot status, penalty) queues and retries. The queue needs a
  visible home — a row in Me, or a banner — because a track that is "submitted"
  in the app but still in a queue is the worst possible lie to tell a pilot
  before scoring closes.
- **Share-sheet import.** "Open in GlideComp" from an instrument's companion
  app, Files, or an email attachment lands directly in the submit sheet with
  the file already chosen. This removes the worst step of Q3.
- **Background upload.** A 4 MB IGC over 3G from a landing paddock should
  survive the app being backgrounded.
- **Universal links.** `glidecomp.com/comp/…` opens the app at that screen, and
  falls back to the web. The slug-and-id URL shape already supports this.
- **Notifications**, opt-in per comp: your track was received and scored, task
  published, scores recomputed, a penalty applied to you. Note that every
  submission already emails the registered pilot — a push is an addition to
  that promise, never a replacement for it.
- **Handoff and state restoration** — relaunching mid-comp should return to the
  task, not the comps list.

---

## 17. Answers to "have I missed any?"

Short version:

1. **A tab bar.** A pure comps stack strands My flights, the account and
   submitting. §2.
2. **The report card.** The most-read pilot screen and the one the rules
   require. §8.
3. **"Results view" is a duplicate of the Results group.** It should be three
   named screens — Scores, Task scores, Report card. §8.
4. **Task sub-views**: route/turnpoints, weather, task scores, task analysis,
   task settings, pilots & tracks. §7, §14.
5. **Submit track** as a first-class surface. §15.
6. **Sign in, onboarding, account/units, my flights, search, not-found.** §15.
7. **Map and 3D replay** as takeovers. §3.
8. **Offline, share-sheet import, universal links, notifications.** §16.

And two renames: "Miscellaneous" → **Competition**, "Wing" → **Class of wing**
(it is hang gliding vs paragliding, not a glider model).

---

## 18. Open questions

1. **Does the "You" group on the comp view conflict with #514?** That decision
   was that no task is privileged in the task list. The You group does not
   reorder tasks, but it does put today's submission one tap away. Worth a
   ruling before it is built.
2. **Is Submit a tab or an action?** A tab that presents a sheet is a common
   pattern but not a pure one. The alternative is a persistent button on the
   comp and task views only, which costs a tap from elsewhere.
3. **Should a registered pilot see the roster?** Kept organiser-only here, for
   the reason web IA v2 gave. A comp where pilots want to see who is entered is
   a real thing, and the scores page is a poor answer before day 1.
4. **Comp-level organiser's notes**: markdown or plain text, and does it want a
   "pinned notice" variant for "briefing moved to 0930"? A notice with an
   expiry is a different feature from a description.
5. **iPad split view**: does the task view belong in the detail column with the
   comp in the list column, or does the comp own the list column and tasks push
   within the detail? The second keeps the stack intact and is probably right.
