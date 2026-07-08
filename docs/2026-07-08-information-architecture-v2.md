# Information Architecture v2 — collapse the hierarchy around the comp page

Date: 2026-07-08
Status: proposed. Supersedes the navigation parts of
[information-architecture.md](./information-architecture.md) (2026-04-05);
builds on [issue #277](https://github.com/pokle/glidecomp/issues/277) and the
review comments there, and aligns with
[2026-07-06-ssr-public-pages-plan.md](./2026-07-06-ssr-public-pages-plan.md).

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
| J6 | View scores/standings and announce them at the daily briefing | Admin |
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
Level 1   Global tabs:  Competitions (/comp)   My Flights (/u/:username)   [user menu]
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
| J2 submit track | `/comp/:id` → hero **Submit track** | 1 |
| J3 scores + dispute | `/comp/:id` → Scores section inline → click a score → explainer; "contact the admins" links to the Admins section | 0–1 |
| J4 comp setup | `/comp` → **Start a new competition** → hub → **New task** (defaults to today) | 2 per day |
| J5 on-behalf upload | hero **Submit track** → "on behalf of" picker (existing dialog) | 1 |
| J6 briefing | `/comp/:id#scores` — per-class tabs, deep-linkable for a projector | 0 |
| J7 quick task change | `/comp/:id` → hero **Edit route** (admin) → route editor | 1 |
| J8 crawlers | `/`, `/comp`, `/comp/:id`, explainer all SSR (per the SSR plan) | — |

## 3. Global chrome

**Header (tabs), on every SPA page and every static page:**

```
[GlideComp]   Competitions   My Flights                    [Sign in | ☰ user menu]
```

- **Competitions** first (it's the shared, public space; login lands here).
  **My Flights** second. Active tab underlined, as today.
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
- `/analysis.html` and `/replay` — instead each gains a small persistent
  **"← GlideComp"** link (today they have *no* way back at all).
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
3. **All tasks**: compact date-grouped list (existing rows: status badges,
   3D replay, Submit track). Default tap → task workroom. Admin: **New task**
   button, date pre-filled with today (J4's "day by day").
4. **Scores** (inline — the `/scores` page content moves here, J3/J6):
   tabs = one per class (standings) · Top 3 per task & class · Teams (when
   teams exist) · **Results by task** (the per-task tables, one task at a
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

### 404

Link list updated to: Competitions, My Flights, How scoring works, Home.

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
| Analysis, replay | Gain "← GlideComp" back link |

Explicitly **not** changing: any permission or API behaviour, the comp/task
settings dialogs, route editor, penalties, pilot editor, pilot status rules,
test-comp visibility, audit-log visibility, admin-list visibility, the
explainer page, onboarding, admin pages.

## 6. SSR alignment (J8)

Identical to the SSR plan's four routes: `/`(already static), `/comp`,
`/comp/:id`, explainer — plus the task workroom's public half if cheap. This
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
2. Should "Results by task" default to today's/latest task (matching the
   hero) rather than task 1? Suggest: yes.
3. Does the comp hub need in-page section anchors in the header (Tasks ·
   Scores · Pilots · Activity) once everything is inline? Suggest: yes on
   mobile, where the page gets long.
4. `/scores` 301 vs keeping it as an SPA power view — this doc says retire;
   confirm nothing links to it externally that needs preserving beyond the
   redirect.
