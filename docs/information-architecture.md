# Information Architecture Plan

Date: 2026-04-05

## Current Problems

1. **Dashboard identity crisis** — The logged-in dashboard (`/u/{username}/`) tries to be both a personal flight log *and* a competition entry point. The "Competitions" button in the header and the sample competition link at the bottom compete for attention and serve different purposes.

2. **Analysis page overload** — The analysis page carries 8 sidebar tabs (Task, Score, Events, Glides, Climbs, Sinks, Comp Score, GAP Config) mixing personal flight analysis with competition scoring. This was fine for a single-purpose tool but doesn't scale as competitions become a first-class feature.

3. **No clear mental model** — Users can't answer "where am I?" or "how do I get to X?" easily. The navigation changes contextually (Dashboard shows "Competitions" + "Analysis"; Competitions shows "Dashboard") without a persistent structure.

4. **Competition flow is disconnected** — A scorer creating a competition must bounce between `/comp`, `/comp/{id}/task/{id}`, and potentially `/analysis.html` for map-based task visualization. There's no coherent flow.

5. **Sample competition is buried** — Placed at the bottom of the dashboard, it reads as an afterthought rather than a discovery mechanism.

---

## Proposed Information Architecture

### Design Principles

- **Two top-level spaces**: Personal flying vs. Competitions. Users always know which space they're in.
- **Progressive disclosure**: Show the simple view first, let users drill into detail.
- **Role-aware, not role-gated**: The same pages serve pilots and admins — admins just see additional controls.
- **Analysis is a tool, not a destination**: The map/analysis view is invoked *from* a context (a personal flight, a competition task), not navigated to independently.

### Site Map

```
/                               Landing page (public, marketing)
│
├── /fly                        Personal flying hub (auth required)
│   ├── Tracks list             Upload & manage IGC files
│   ├── Tasks list              Upload & manage XCTSK files
│   └── /fly/analysis?...       Flight analysis (map + sidebar)
│                               Opened from a track/task click
│
├── /comp                       Competitions hub (public browsable, auth to participate)
│   ├── Competition list        Browse & create competitions
│   ├── /comp/{id}              Competition detail
│   │   ├── Overview tab        Tasks list, pilots, standings summary
│   │   ├── Scores tab          Full competition standings (public)
│   │   └── Settings tab        Admin-only: GAP params, admins, close date
│   │
│   └── /comp/{id}/task/{id}    Task detail
│       ├── Overview section    Task definition, track list, upload
│       ├── Scores section      Task scores (public, computed on-demand)
│       └── Task editor         Admin-only: define/edit waypoints
│
├── /profile                    Pilot profile (auth required)
│                               Name, CIVL ID, sporting body IDs, phone, glider
│
├── /scores?comp={id}           Public scores deep-link (no auth)
│
├── /about                      About page (public)
├── /legal                      Legal page (public)
└── /scoring                    GAP scoring docs (public)
```

### Key Changes from Current

| Current | Proposed | Rationale |
|---------|----------|-----------|
| `/u/{username}/` (dashboard) | `/fly` | Simpler URL. Username in URL adds no value for a personal page. |
| "Competitions" button in dashboard header | Top-level nav item always visible | Competitions deserve equal billing, not a button buried in one page's header. |
| `/analysis.html` as standalone page | `/fly/analysis?...` | Analysis is always opened *in context* of a specific flight or task. Not a page you navigate to cold. |
| 8 analysis tabs (flat) | Contextual tab sets (see below) | Personal flight analysis doesn't need Comp Score or GAP Config. Competition view doesn't need personal Glides/Climbs/Sinks detail. |
| Sample competition at dashboard bottom | Featured on `/comp` list + onboarding | Discovery belongs where users browse competitions. |

---

## Navigation Pattern

### Global Navigation Bar (persistent, all pages)

```
┌─────────────────────────────────────────────────────────┐
│  [Logo] GlideComp        My Flights    Competitions    [User Menu ▾] │
└─────────────────────────────────────────────────────────┘
```

- **Logo**: Always links to `/` (landing) or `/fly` (if logged in).
- **My Flights**: Links to `/fly`. Active state when on `/fly/*`.
- **Competitions**: Links to `/comp`. Active state when on `/comp/*`.
- **User Menu** (dropdown): Profile, Sign Out. Collapsed to avatar on mobile.
- **Unauthenticated**: Show "Sign In" instead of User Menu. Both nav items still visible (competitions are publicly browsable).

This replaces the current pattern of context-dependent header buttons. Users always know where they can go.

### Mobile Navigation

On small screens, collapse to a hamburger or bottom tab bar:

```
┌──────────────────────────────┐
│  [✈ Flights]  [🏆 Comps]  [👤 Me] │
└──────────────────────────────┘
```

Three bottom tabs. Simple, thumb-friendly.

---

## Page-by-Page Detail

### `/fly` — My Flights

The personal flying hub. Replaces the current dashboard.

**Layout:**
- Page title: "My Flights"
- Two-tab content area: **Tracks** | **Tasks** (same as current)
- Each tab has: upload zone + file list
- Clicking a track → opens `/fly/analysis?track={id}`
- Clicking a task → opens `/fly/analysis?task={id}`

**What's removed:**
- "Competitions" button (now in global nav)
- "Analysis" button (analysis is opened contextually from a track/task click)
- Sample competition link (moved to `/comp`)

**What's added:**
- Nothing. This page gets *simpler*.

### `/fly/analysis` — Flight Analysis

The map-based analysis tool, opened in context.

**Entry points:**
- Click a track from `/fly` → `?track={id}`
- Click a task from `/fly` → `?task={id}`
- Drag-and-drop a file onto the page (still supported for power users)
- Command menu (Cmd+K) for advanced file operations

**Sidebar tabs (personal flight context):**

| Tab | Purpose |
|-----|---------|
| Task | Task definition display |
| Score | Turnpoint sequence scoring |
| Events | Flight event timeline |
| Glides | Glide segment analysis |
| Climbs | Thermal/climb analysis |
| Sinks | Descent analysis |

**Removed from this context:**
- "Comp Score" tab → lives on the competition task page
- "GAP Config" tab → lives in competition settings

This keeps the analysis page focused on *flight analysis*, which is its core strength.

### `/comp` — Competitions

**Layout:**
- Page title: "Competitions"
- "New Competition" button (auth required)
- **Featured section**: Sample competition card (Corryong Cup) prominently displayed for new users / empty states
- **My Competitions**: Comps where user is admin (auth required section)
- **Recent Competitions**: Public, non-test comps from the last 24 months

### `/comp/{id}` — Competition Detail

**Tab navigation within the page:**

```
┌─────────────────────────────────────┐
│  ← Competitions    Corryong Cup 2026│
│                                     │
│  [Overview]  [Scores]  [Settings⚙]  │
│─────────────────────────────────────│
│  ...tab content...                  │
└─────────────────────────────────────┘
```

**Overview tab:**
- Task list (clickable → `/comp/{id}/task/{tid}`)
- Pilot count + class breakdown
- Class coverage warnings (prominently displayed)
- "New Task" button (admin only)

**Scores tab:**
- Overall competition standings
- Filter by class / team
- Per-task score summaries
- Public (no auth required via `/scores?comp={id}` deep link)

**Settings tab (admin only):**
- Competition name, category, close date
- GAP parameters
- Admin management (add/remove by email)
- Pilot class definitions
- Delete competition (danger zone)

### `/comp/{id}/task/{id}` — Task Detail

**Sections (single scrollable page, not tabs):**

1. **Header**: Task name, date, pilot class badges, status badge (task defined / not defined)
2. **Task Definition** (admin: editable task editor; others: read-only waypoint list + download XCTSK)
3. **Tracks**: Upload area + track list with pilot names, status, download links
4. **Scores**: Ranked pilot list with point breakdowns, penalties. Computed on-demand.

**"View on Map" action**: A button that opens the analysis view with all tracks loaded. This is how the map integrates with competitions — as an optional deep-dive, not the primary interface.

### `/profile` — Pilot Profile

Simple form page:
- Display name
- CIVL ID
- Sporting body IDs
- Phone
- Default glider
- Account actions (sign out, delete account — moved from dashboard footer)

---

## Analysis Page: Context-Aware Tabs

The analysis sidebar adapts based on how it was opened:

| Context | Tabs Shown |
|---------|-----------|
| Personal track from `/fly` | Task, Score, Events, Glides, Climbs, Sinks |
| Personal task from `/fly` | Task (editable) |
| Competition task ("View on Map") | Task, Score, Events, Comp Score |
| Drag-and-drop (no context) | All tabs (legacy power-user mode) |

This reduces cognitive load — users only see tabs relevant to their current task.

---

## URL Summary

| URL | Page | Auth |
|-----|------|------|
| `/` | Landing / marketing | Public |
| `/fly` | Personal flights hub | Required |
| `/fly/analysis?...` | Flight analysis (map) | Required |
| `/comp` | Competitions list | Public (create requires auth) |
| `/comp/{id}` | Competition detail | Public (non-test) |
| `/comp/{id}/task/{id}` | Task detail | Public (non-test) |
| `/scores?comp={id}` | Public scores deep-link | Public |
| `/profile` | Pilot profile | Required |
| `/about` | About | Public |
| `/legal` | Legal | Public |
| `/scoring` | GAP docs | Public |

---

## Migration Path

This IA can be implemented incrementally:

1. **Add global nav bar** to all authenticated pages (My Flights, Competitions, User Menu). This alone fixes the biggest confusion.
2. **Rename dashboard route** from `/u/{username}/` to `/fly`. Keep old URL as redirect.
3. **Remove competition-related UI from dashboard** (sample comp link, competitions button). Dashboard becomes purely about personal flights.
4. **Add tabs to competition detail** (Overview, Scores, Settings) instead of the current single-page layout.
5. **Move "Comp Score" and "GAP Config"** out of the analysis sidebar into the competition pages.
6. **Add "View on Map" button** to task detail page as the bridge to analysis.
7. **Add `/profile` page** for pilot profile management.

Steps 1-3 can ship together as one release. Steps 4-7 can follow as competition features mature.

---

## Open Questions

1. **Should `/fly/analysis` be a separate page or a modal/overlay from `/fly`?** A separate page gives more screen real estate for the map. A modal keeps context. Recommend: separate page (current behavior works well).

2. **Should competition scores be a standalone page (`/scores`) or just a tab on the comp detail?** Recommend both — the tab for logged-in users navigating the comp, and `/scores?comp={id}` as a shareable public link that renders the same content.

3. **Should the command menu (Cmd+K) be available globally or only on the analysis page?** It could be useful globally for quick navigation, but its current commands are analysis-specific. Recommend: keep it analysis-only for now, consider global command palette later.

4. **Do we need a `/comp/{id}/task/{id}/analysis` route or is query-param-based `/fly/analysis?compTask={id}` sufficient?** Query params are simpler and avoid duplicating the analysis page. Recommend query params.
