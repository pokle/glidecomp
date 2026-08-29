# Information Architecture v2 — collapse the hierarchy around the comp page

Date: 2026-07-08
Status: implemented (see the 2026-07-23 update below and the resolutions in
§9). Supersedes the navigation parts of
[information-architecture.md](./information-architecture.md) (2026-04-05);
builds on [issue #277](https://github.com/pokle/glidecomp/issues/277) and the
review comments there, and aligns with
[2026-07-06-ssr-public-pages-plan.md](./2026-07-06-ssr-public-pages-plan.md).

> **Update (2026-07-23, comp/task page UX rework):** the hub thesis below was
> revised — the comp page stays the hub, but the heavyweight surfaces moved off
> it. Where this doc and the shipped app now differ, the app is right:
>
> - **Scores are no longer inline.** `/comp/:id/scores` is the canonical,
>   SSR'd scores page (per-class tabs, Top 3, Teams, Scores by task —
>   `?task=<id>` deep-links a task's results). The comp page keeps a compact
>   top-3-per-class Scores summary linking there. `/scores?comp_id=X` now
>   redirects to `/comp/X/scores`, not `/comp/X#scores`.
> - **Pilots moved to an admin-only page**, `/comp/:id/pilots` (noindex shell;
>   `#edit-pilots` opens the editor). The public roster section is gone —
>   visitors see every pilot in the scores. This is the one deliberate
>   exception to §7's "stays public" principle: the roster was a management
>   surface duplicating the score tables.
> - **The today's-task hero merged into the task list**: one list, newest date
>   first, the hero date rendered as the featured card in place; Share/QR/
>   downloads folded into a single Share menu; per-row Submit track / 3D
>   replay removed (they live on the task page). Finished comps lead with the
>   scores summary before the task list.
>   **Superseded (2026-07-30, [#514](https://github.com/pokle/glidecomp/issues/514),
>   "Every task alike: the comp hub groups them by day and class, no hero"):**
>   the featured card is gone too. There is no hero and no privileged task —
>   `pages/CompDetail.tsx` renders one list, grouped by date (newest day first,
>   each day a `Disclosure` open by default) and then by pilot class within the
>   day, in the order the organisers declared the classes. A task flown by
>   several classes gets a row under each. Rows carry only the link, the setup
>   badges and the route glyph; every action lives on the task page.
> - **The task page split public results from management**: a public top-3
>   podium + link to the scores page; the old scores grid is the admin-only
>   "Manage pilots & tracks" section.
> - Activity is a 3-entry digest ("Show all activity" expands); Admins is an
>   "Organized by …" footnote (the `#admins` anchor survives). The section nav
>   is sticky, and it has since grown past the four entries §9's question 3
>   asked about. What `<nav aria-label="Sections">` in `pages/CompDetail.tsx`
>   carries today: **Tasks (n)** · **Scores** · **Waypoints (n)** ·
>   **Pilots (n)** (admins only — the roster moved to its own admin page) ·
>   **Field analysis** (only when `scoring_format !== "open_distance"`, because
>   an open-distance comp has no legs to measure) · **Activity**. Only Tasks
>   and Activity are in-page anchors; the rest are links to sibling pages.
>   SSR covers **eight** public pages — the authoritative list is
>   the `ROUTES` table in `functions/comp/[[path]].ts`: `/comp`,
>   `/comp/:id`, `/comp/:id/scores`, `/comp/:id/waypoints`,
>   `/comp/:id/task/:id`, `/comp/:id/task/:id/pilot/:id`, and the two
>   field-analysis reports `/comp/:id/analysis` and
>   `/comp/:id/analysis/task/:id` (both went public and SSR'd later; a cold
>   report server-renders its pending notice under `noindex` and the client
>   polls). The admin-only `/comp/:id/pilots` roster and the superseded
>   `/comp/:id/task/:id/analysis` redirect get a noindex SPA shell instead.

**Scope guard: this is a navigation/IA change only.** No permission changes,
no new backend capabilities (one small exception, §8). Everything public today
stays public; everything admin-gated stays admin-gated. Pages are role-aware,
not role-gated: the same URL serves everyone, admins just see extra controls.

## 1. Jobs to be done

The IA is judged by how fast these get done, starting from a Google result or
a bookmarked comp URL:

| # | Job | Who |
|---|-----|-----|
| J1 | Find today's task, understand it, load it into a flight instrument | Pilot |
| J2 | Submit a track after the flight | Pilot |
| J3 | See scores, understand them, dispute with the comp admin | Pilot |
| J4 | Set up a competition quickly; add tasks day by day | Admin |
| J5 | Help pilots submit their tracks | Admin |
| J6 | View scores/scores and announce them at the daily briefing | Admin |
| J7 | Make quick task changes as conditions dictate | Admin |
| J8 | Crawl up-to-date comp info and scores; pilots/friends can Google the comp | Search engines |

## 2. The core idea: the comp page is the hub

Today the comp's information is spread over four levels
(`/comp` → `/comp/:id` → `/comp/:id/task/:tid` → `/scores?comp_id=` →
explainer), and the thing a pilot needs *right now* — today's task — is one
undifferentiated row in a list, two levels down.

The collapse: **one URL per competition that a pilot bookmarks on day 1 and
never leaves.** Every pilot job is served on `/comp/:id` directly or is one
click from it. Drill-down pages remain only where a job genuinely needs a
whole page: the task workroom and the score explainer.

```
Level 0   /                     Home (static): what GlideComp is, sign in,
│                               prominent "Browse competitions"
Level 1   Global tabs:  Competitions (/comp)   My Flights (/u/:username)
│                       Submit track (/submit)                        [user menu]
│                       (the third tab arrived with #535 — see §3)
│
Level 2   /comp/:id             THE COMP HUB — everything about one comp:
│                               today's task, task list, scores, pilots,
│                               activity, admins
│
Level 3   /comp/:id/task/:tid                    Task workroom (route, tracks,
│                                                pilot status, task scores)
│         /comp/:id/task/:tid/pilot/:pid         Score explainer (unchanged)
│
Tools     /analysis.html        Full-screen map analysis  (opened FROM a flight/task)
          /replay               Full-screen 3D replay     (opened FROM a task)
```

Maximum depth anywhere: 3. No page exists whose only purpose is navigation
(the old "dashboard" dissolves into the global tabs).

### Job → path, after the change

| Job | Path | Clicks from the comp URL |
|-----|------|--------------------------|
| J1 today's task | `/comp/:id` → **Today's task** hero → turnpoints + Download .xctsk | 0–1 |
| J2 submit track | *(2026-08-02, #535)* **Submit track** in the nav, on any page → `/submit`; or `/comp/:id` → **Submit track** → `/submit?comp=` with the comp prefilled; or the task page's dialog | 0 — the tab is on every page |
| J3 scores + dispute | `/comp/:id` → Scores section inline → click a score → explainer; "contact the admins" links to the Admins section | 0–1 |
| J4 comp setup | `/comp` → **Start a new competition** → hub → **New task** (defaults to today) | 2 per day |
| J5 on-behalf upload | *(2026-08-02)* the task page's **Submit track** → `SubmitTrackDialog` → "Submitting for" picker; the hero it used to run through is gone | 1 |
| J6 briefing | `/comp/:id#scores` — per-class tabs, deep-linkable for a projector | 0 |
| J7 quick task change | `/comp/:id` → hero **Edit route** (admin) → route editor | 1 |
| J8 crawlers | `/`, `/comp`, `/comp/:id`, explainer all SSR (per the SSR plan) | — |

## 3. Global chrome

**Header (tabs), on every SPA page and every static page:**

```
[GlideComp]  Competitions  My Flights  Submit track    [Sign in | ☰ user menu]
```

- **Competitions** first (it's the shared, public space; login lands here).
  **My Flights** second. Active tab underlined, as today.
- **Update (2026-08-02, #535):** a third tab, **Submit track** (`/submit`),
  sits after My Flights in both headers — `react/components/Shell.tsx` and the
  static `SiteHeader.astro`, which must stay in sync. It is the one thing a
  pilot who has just landed came here to do, so it is reachable from every
  page; the homepage hero deliberately did **not** take a third button.
- Right-aligned **user menu** (avatar): Settings, Sign out. Signed out: a
  **Sign in** button in the same slot. This satisfies "Settings right-justified"
  and rescues Sign out from the footer where it hides today
  (`Shell.tsx:98-112`).
- The static Astro pages (`/`, `/about`, `/legal`, `/scoring*`) get the same
  header (static markup, no client JS needed beyond the sign-in button they
  already have).

**Footer, unified across SPA and static pages** (today they differ):
About · Scoring · Privacy & Terms · GitHub · YouTube · build sha.

**Exempt from tabs/footer** (full-screen tools + focused flows):
- `/analysis.html` and `/replay` — instead each carries a **top-center
  breadcrumb bar** (`GlideComp › comp › task` when task-scoped, bare
  `GlideComp` otherwise). Real links, so a shared link opened in a fresh
  tab — where the browser back button is useless — still leads into the
  app; centered because both tools keep their controls in the corners.
- `/onboarding` — stays chrome-free as today.

## 4. Page-by-page

### `/` — Home (static, prerendered — already better than SSR)

1. What GlideComp is (one paragraph + screenshot, as today).
2. **Browse competitions** — prominent, above the fold (today `/comp` is
   reachable only via a footer link).
3. Sign in with Google → lands on `/comp` (first-timers detour via
   `/onboarding` as today).

### `/comp` — Competitions (SSR)

- No page H1 (redundant with the tab), no subtitle.
- Each comp is one tappable row → `/comp/:id`:
  **name** · `HG · GAP · Open, Floater` · task date range
  (`12–18 Jan 2026`; falls back to creation date when no tasks yet) ·
  `Test` badge (admins only see test comps, as today).
  Needs `GET /api/comp` to add min/max task dates — presentational only.
- **Start a new competition** (signed-in; signed-out sees it as a sign-in
  prompt). Existing create dialog unchanged (J4).

### `/comp/:id` — the comp hub (SSR)

Section order tracks the daily rhythm of a comp — task first while it runs,
scores forever after:

1. **Header**: comp name; summary line `HG · GAP · Open, Floater ·
   12–18 Jan 2026` (task date range, not creation date). Admin: ⚙ Settings
   (existing dialog, unchanged). Admin: existing class/SSS/ESS warnings.
2. **Today's task hero** (the J1/J2/J7 accelerator). Picks the task dated
   today in the comp timezone; else the next upcoming ("Next task — Sat");
   else the most recent ("Latest task"). Shows name, date, classes, route
   summary (distance, turnpoint count), and the action row:
   **Task details** (→ workroom, also the default tap) ·
   **Download .xctsk** (see §8) · **Submit track** (signed-in, comp open;
   admins get the existing on-behalf picker) · **3D replay**.
   Omitted entirely when the comp has no tasks.
   *(2026-08-02: the hero itself is gone — see the update at the top — and
   #535 dropped the session gate. Submitting is open to anyone the comp's
   roster knows, so the surviving buttons on the comp and task pages are
   gated on `mounted && !isClosed` and nothing else.)*
3. **All tasks**: compact date-grouped list (existing rows: status badges,
   3D replay, Submit track). Default tap → task workroom. Admin: **New task**
   button, date pre-filled with today (J4's "day by day").
4. **Scores** (inline — the `/scores` page content moves here, J3/J6):
   tabs = one per class (scores) · Top 3 per task & class · Teams (when
   teams exist) · **Scores by task** (the per-task tables, one task at a
   time via a task picker — all-tasks-at-once is too heavy to SSR for a
   10-task comp). Keeps the ScoreFreshness re-score banner and CSV export.
   Every score links to the explainer. Deep-linkable anchors
   (`#scores`, per-class tab in the URL) so an admin can project it at
   briefing (J6).
   Below the tables, one line for J3's dispute path: *"Questions about a
   score? Ask the comp admins"* → anchors to §7.
5. **Pilots** roster (public today, stays public). Admin: **Edit** (existing
   grid dialog).
6. **Activity** (public audit log — stays public; it is the transparency
   record).
7. **Admins** (public, as today).

Signed-out users see all of the above minus the signed-in affordances; the
Submit track slot renders as "Sign in to submit your track". No "log in to
see more" blurb — there is nothing hidden to tease.

> **Update (2026-08-02, #535):** that last sentence is no longer true, and the
> button it describes was deleted. Anonymous submission shipped, so the session
> gate came off the Submit track slot entirely: a signed-out visitor now gets
> the same **Submit track** button a signed-in one does (`mounted && !isClosed`
> in `pages/CompDetail.tsx` and `comp/TaskResults.tsx`), and the identity step
> asks for an identifier the organiser already registered instead of a sign-in.
> See [track-submission.md](./track-submission.md).

### `/comp/:id/task/:tid` — task workroom

Everything about one task, role-aware (mostly a reorder of today's page):

1. Header: task name, date, classes, status badges. Admin: ⚙ task settings
   (existing dialog).
2. **Route**: turnpoints table (public, as today) + start-gate summary +
   **Download .xctsk** (§8) + **View on map** (→ analysis). Admin:
   **Edit route** (existing editor — J7).
3. **Tracks**: submit + list (existing role rules: signed-in self-upload
   while open; on-behalf for admins/open-upload; penalties + delete admin-only).
4. **Pilot status** roll call (when configured).
5. **Scores for this task** (existing ScoresSection) → explainer links.

### `/comp/:id/task/:tid/pilot/:pid` — score explainer

Unchanged. Becomes SSR per the SSR plan (it is the SEO centerpiece and the
J3 "understand my score" surface).

### `/scores`

Retired as a destination: `/scores?comp_id=X` → 301 `/comp/X#scores`. One
canonical scores surface (and one canonical URL for crawlers).

### `/u/:username` — My Flights

Per #277, unchanged in spirit:
- Flight list first; no H1/subtitle. Tracks and Tasks tabs both stay (two
  file types exist today).
- Card default tap = open in analysis; explicit **View** · **Download** ·
  **Remove** (Remove gains a confirm dialog — today it deletes instantly).
- Whole page is a drop target (already true); **Add .igc track log** button
  at the end of the list with "or drag and drop .igc files onto this page".
- **Storage** section last, with the existing privacy "Heads up" note; a
  near-quota warning still surfaces at the top when ≥80% so uploads don't
  fail surprisingly.

### `/settings`, `/onboarding`, `/admin/users`, `/admin/cache`

Unchanged. Settings is reached from the user menu; the superadmin links
stay inside Settings. Admin pages keep the global tabs (they're inside the
Shell today).

### `/about`, `/legal`, `/scoring`, `/scoring/gap`, `/scoring/open-distance`

Content unchanged; they gain the global header tabs and the unified footer.

*(Two scoring guides have been added since: `/scoring/data-cleaning` and
`/scoring/track-validity` — same Astro app, `static/src/pages/scoring/`, same
chrome.)*

### 404

Link list updated to: Competitions, My Flights, How scoring works, Home.
*(Later replaced by the link-repair + search 404: `components/NotFound.tsx`
reads the words out of the dead path, asks `GET /api/comp/lookup` which comps,
tasks and pilots carry them now, and offers "Did you mean…" plus a search
field. The standing link list went with it — the header nav and the footer
already carry those on every page, this one included.)*

## 5. What this changes, page by page (all navigation/presentation)

| Surface | Change |
|---|---|
| Shell | Tab order Competitions→My Flights; user menu right (Settings, Sign out); Sign out leaves the footer |
| Static pages | Gain header tabs; footers unified |
| Home | Adds prominent Browse competitions link |
| `/comp` | Drops H1/subtitle; rows gain format/classes + task date range; button renamed "Start a new competition" |
| `/comp/:id` | Adds Today's-task hero; scores move inline; section order fixed; dispute-path line |
| Task page | Reordered (route → tracks → status → scores); gains Download .xctsk |
| `/scores` | 301 → `/comp/:id#scores` |
| My Flights | #277 changes (list first, confirm on remove, add-button + hint, storage last) |
| Analysis, replay | Gain a top-center breadcrumb bar (GlideComp › comp › task) |

Explicitly **not** changing: any permission or API behaviour, the comp/task
settings dialogs, route editor, penalties, pilot editor, pilot status rules,
test-comp visibility, audit-log visibility, admin-list visibility, the
explainer page, onboarding, admin pages.

## 6. SSR alignment (J8)

Identical to the SSR plan's four routes: `/`(already static), `/comp`,
`/comp/:id`, explainer — plus the task workroom's public half if cheap.
(Shipped wider than this: eight `/comp` routes are server-rendered today —
see the 2026-07-23 update at the top for the list.) This
IA makes the plan's Phase-2 "scores move onto the comp page" flow change
official. Sitemap/robots/meta per the plan's Phase 0. Test comps keep
404-ing anonymously (SSR loaders forward cookies, per the plan).

## 7. Design principles carried forward

- **Hub-and-spoke, not tree**: one hub per comp; spokes only where a job
  needs a whole page.
- **Role-aware, not role-gated** (from IA v1): same URL for everyone; role
  only adds controls.
- **Public by default**: scores, tasks, pilots, activity, admins stay
  public — that's both the transparency principle and the SEO strategy.
- **Analysis is a tool, not a destination** (from IA v1): reached from a
  flight card or a task, never from the tabs.

## 8. The one genuine gap: pilots can't download the task file

J1 says pilots load the task into their instruments, but `.xctsk` export
today lives only inside the admin-only route editor
(`RouteEditorDialog.tsx` "Export .xctsk"). The task's xctsk JSON is already
public via `GET /api/comp/:id/task/:tid`, so a public **Download .xctsk**
button (hero + task workroom) exposes no new data — but it is the one new
affordance in this proposal, called out so it's a deliberate decision.

Optional follow-on (same data, briefing-friendly): a QR code next to the
download that encodes the task URL, so pilots at briefing scan instead of
typing. Cheap, offline-generatable, purely presentational.

## 9. Open questions

1. Hero fallback when a comp has multiple classes flying *different* tasks
   on the same day (Corryong scores as open + floater): show two hero cards,
   or one hero per class tab? Suggest: one hero listing both tasks for today.
   *(Resolved in implementation: one hero listing every task on that date.)*
2. Should "Scores by task" default to today's/latest task (matching the
   hero) rather than task 1? Suggest: yes. *(Resolved: defaults to the hero
   task.)*
3. Does the comp hub need in-page section anchors in the header (Tasks ·
   Scores · Pilots · Activity) once everything is inline? Suggest: yes on
   mobile, where the page gets long. *(Resolved: anchor bar on all sizes.)*
4. `/scores` 301 vs keeping it as an SPA power view — this doc says retire;
   confirm nothing links to it externally that needs preserving beyond the
   redirect. *(Implemented as a client redirect to `/comp/:id#scores`.)*

## 10. Design language settled during the polish round (implemented)

Conventions that emerged while implementing this IA, now encoded as
components so future work stays consistent:

- **Section actions sit right-aligned on the section header row** —
  `SectionHeader` (`src/react/components/SectionHeader.tsx`): title owns the
  left edge (scan column), the section's manage action sits top right.
  Applied to comp/task Settings, Tasks → New Task, Turnpoints → Edit route,
  Pilots → Edit, Tracks → Submit track, and My Flights' add-file buttons
  (which ride the tab-switcher row, as that page has no section headers).
  Inline CTA clusters (the hero's action row) are content, not section
  management — they stay left-aligned.
- **Breadcrumbs** — same label for the same destination everywhere
  ("Competitions"). The pilot score page carries the full
  `Competitions › comp › task` trail; the full-screen tools carry the
  top-center bar described in §3. One component app-wide (see the RAC
  adoption guide, gotcha #11): **ARIA-native** —
  `src/react/rac/breadcrumbs.tsx`, ancestor links followed by the current
  page as a final `aria-current="page"` crumb, per the WAI-ARIA breadcrumb
  pattern. The H1 below still names the page; the crumb duplicates it
  deliberately, as the "you are here" anchor. Ancestors come from
  `src/react/lib/crumbs.ts` — never hand-rolled — so the same destination
  always gets the same label and the same fallback while data loads. A
  parents-only variant (`components/Breadcrumbs.tsx`, GOV.UK "up links"
  style, current page omitted) coexisted through the RAC migration; it was
  removed once every page converted, because two conventions made trail
  depth inconsistent between sibling pages.
- **The trail is the information architecture, not the history** — and where
  a page has two plausible parents, the URL and the trail must pick the same
  one. The per-task field analysis was briefly the counter-example: it lived
  at `/comp/:compId/analysis/task/:taskId` as a chapter of the comp's field
  analysis, while everyone in fact arrived from the task page, and a trail
  that swapped the task out for a report they had never opened read as a jump
  into another branch of the site. Both now parent on the task
  (`/comp/:compId/task/:taskId/analysis`), and the whole-comp report — the
  other genuine parent — is an explicit sibling link on the destination
  ("Comp field analysis") rather than a second bent breadcrumb.
- **One Submit track *form* everywhere** — superseded wording, 2026-08-02
  (#535). It used to be one dialog (`comp/SubmitTrackDialog.tsx`) behind every
  Submit track button. It is now one form, `comp/SubmitTrackForm.tsx`, with two
  presentations: as the whole of the public `/submit` page, or wrapped in
  `SubmitTrackDialog` on the task page, where comp and task are already known
  and those steps collapse to a line with a **Change** button. The comp page
  links to `/submit?comp=` rather than opening either — from there the task is
  still an open question, and the page is where it gets asked. The rest holds,
  with one amendment: the "Submitting for" row is shown to **signed-in**
  submitters (locked to "Myself (name)" for plain pilots, registered-pilot
  dropdown for admins/open-upload comps) — a signed-out one names a registered
  identifier instead — and choosing an IGC surfaces the pilot name from the
  file header as a visible line, `Pilot named in the file: …`, rather than
  auto-selecting from it. Full account: [track-submission.md](./track-submission.md).
- **Print**: every major comp-page section (`#tasks #scores #pilots
  #activity #admins`) starts a fresh page (`break-before-page`) so a printed
  comp page works as briefing handouts.
- **Chrome details**: SPA and static headers share a 60px min-height (no
  jump crossing between them); the static footer clears the viewport-fixed
  hills background; `#edit-route` on a task page URL opens the route editor
  and clears the hash on close (`pages/TaskDetail.tsx`). The mechanism
  outlived its first caller: the hero's "Edit route" is gone with the hero,
  and the deep link is now issued by the admin setup checklist,
  `comp/CompSetupProgress.tsx` — which uses the same pattern for the roster
  (`/comp/:id/pilots#edit-pilots`). *(2026-08-19, #637: the route editor is a
  routed page, so `#edit-route` is now a REDIRECT to it rather than a flag
  that opens a dialog — which also makes the hash leave the address bar on
  arrival, instead of being cleared on close.)*

## 11. Admin editors are routed pages (2026-08-19, #636/#637/#638)

Every admin editor of a thing that already exists has a URL. What used to be a
centred modal over the page it edited is now a page in the hierarchy:

| Editor | URL |
|---|---|
| Competition settings | `/comp/:c/settings[/:group]` |
| Task settings | `/comp/:c/task/:t/settings` |
| Task route | `/comp/:c/task/:t/route` |
| Weather notes | `/comp/:c/task/:t/weather` |
| Manual flight | `/comp/:c/task/:t/pilot/:p/manual-flight` |

The reason is the same one throughout this document, applied to a viewport it
had not been: the app is used on phones on the hill, and a form taller than the
viewport inside a centred modal is the desktop-most thing an app can do. Real
routes also hand back the browser's back button, a shareable URL, and scroll
position, none of which a modal has.

Two exceptions, and both are about what the surface IS rather than how tall it
is:

- **Create flows stay dialogs** (New Task, Start a new competition). There is
  no entity yet, so there is nothing for a URL to name — a `/new` route would
  be a page identified by the absence of its subject.
- **Short single-purpose forms over an editor stay dialogs** (the turnpoint
  editor and the add-waypoint form, over the route page). They are not the
  tall-scrolling-form shape this removes, and the waypoint form is shared with
  the competition waypoints page, so routing it would fork it.

The competition's settings are an INDEX of grouped sub-pages because there are
21 controls; the task's are one flat form because there are five. The shape
follows the content, not the precedent — an index of two rows is a tap that
buys nothing.

**The task's three editors are siblings, and the settings page does not list
them.** Each is reached from the part of the task page it edits — the Route
section's button, the Weather section's button, the header's Settings — which
is what §10's first rule already says about section-scoped manage actions.
Listing route and weather on the settings page as well (which the first cut of
this did) duplicates those entry points and, worse, frames content as
configuration: the notes are prose the organiser publishes and the route is
the task itself, neither of which is a setting. It also put nav rows below the
Save button, where they read as leftovers.

Controls follow the same split. A value in a form the admin will Save is a list
in flow (`rac/choice-list.tsx`); a control that chooses what to LOOK at stays a
popover Select, because a filter rendered as a card of rows pushes the thing
being filtered off the screen. The RAC adoption guide's Conventions section
carries the rule.
