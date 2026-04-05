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
/                                   Landing page (public, marketing)
│
├── /u/{username}/                  Personal flying hub (auth required)
│   ├── Tracks list                 Upload & manage IGC files
│   ├── Tasks list                  Upload & manage XCTSK files
│   └── /u/{username}/analysis?...  Flight analysis (map + sidebar)
│                                   Opened from a track/task click
│
├── /comp                           Competitions hub (public browsable, auth to participate)
│   ├── Competition list            Browse & create competitions
│   ├── /comp/{id}                  Competition detail
│   │   ├── Overview tab            Tasks list, pilots, standings summary
│   │   ├── Scores tab              Full competition standings (public)
│   │   └── Settings tab            Admin-only: GAP params, admins, close date
│   │
│   └── /comp/{id}/task/{id}        Task detail
│       ├── Overview section        Task definition, track list, upload
│       ├── Scores section          Task scores (public, computed on-demand)
│       └── Task editor             Admin-only: define/edit waypoints
│
├── /u/{username}/profile           Pilot profile (auth required)
│                                   Name, CIVL ID, sporting body IDs, phone, glider
│
├── /scores?comp={id}               Public scores deep-link (no auth)
│
├── /about                          About page (public)
├── /legal                          Legal page (public)
└── /scoring                        GAP scoring docs (public)
```

The username-scoped URLs (`/u/{username}/`) serve multiple purposes:
- **Shareability**: `/u/pokle/` is a clean, meaningful link to share
- **Wayfinding**: the URL itself tells the user where they are in the IA
- **Global uniqueness**: every user has their own namespace
- `/u/me/` continues to redirect to `/u/{username}/` for convenience

### Key Changes from Current

| Current | Proposed | Rationale |
|---------|----------|-----------|
| `/u/{username}/` (dashboard with mixed concerns) | `/u/{username}/` (personal flights only) | Same URL, but strip out competition entry points. Dashboard becomes purely about personal flights. |
| "Competitions" button in dashboard header | Top-level nav item always visible | Competitions deserve equal billing, not a button buried in one page's header. |
| `/analysis.html` as standalone page | `/u/{username}/analysis?...` | Analysis is opened *in context* of a specific flight or task, scoped to the user's namespace. |
| 8 analysis tabs (flat) | Contextual tab sets (see below) | Personal flight analysis doesn't need Comp Score or GAP Config. Competition view doesn't need personal Glides/Climbs/Sinks detail. |
| Sample competition at dashboard bottom | Featured on `/comp` list + onboarding | Discovery belongs where users browse competitions. |
| `/profile` (new) | `/u/{username}/profile` | Pilot profile lives under the user's namespace where it logically belongs. |

---

## Navigation Pattern

### Global Navigation Bar (persistent, all pages)

```
┌─────────────────────────────────────────────────────────┐
│  [Logo] GlideComp        My Flights    Competitions    [User Menu ▾] │
└─────────────────────────────────────────────────────────┘
```

- **Logo**: Always links to `/` (landing) or `/u/{username}/` (if logged in).
- **My Flights**: Links to `/u/{username}/`. Active state when on `/fly/*`.
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

### `/u/{username}/` — My Flights

The personal flying hub. Same URL as today, but with a clearer, narrower purpose.

**Layout:**
- Page title: "My Flights"
- Two-tab content area: **Tracks** | **Tasks** (same as current)
- Each tab has: upload zone + file list
- Clicking a track → opens `/u/{username}/analysis?track={id}`
- Clicking a task → opens `/u/{username}/analysis?task={id}`

**What's removed:**
- "Competitions" button (now in global nav)
- "Analysis" button (analysis is opened contextually from a track/task click)
- Sample competition link (moved to `/comp`)

**What's added:**
- Nothing. This page gets *simpler*.

### `/u/{username}/analysis` — Flight Analysis

The map-based analysis tool, opened in context under the user's namespace.

**Entry points:**
- Click a track from `/u/{username}/` → `?track={id}`
- Click a task from `/u/{username}/` → `?task={id}`
- Drag-and-drop a file onto the page (still supported for power users)
- Command menu (Cmd+K) for advanced file operations

**Shareable URL state:** The analysis URL encodes the full view state so any link is a permalink to an exact view of a flight. Parameters are synced bidirectionally — URL updates as the user navigates, and loading a URL restores the exact view.

| Parameter | Example | Purpose |
|-----------|---------|---------|
| `track` | `abc123` | Stored track ID to load |
| `task` | `def456` | Stored task ID to load |
| `compTask` | `ghi789` | Competition task ID to load |
| `lat` | `-37.812` | Camera latitude |
| `lng` | `144.963` | Camera longitude |
| `zoom` | `14` | Map zoom level |
| `pitch` | `60` | Camera tilt in degrees (0 = top-down, 60 = 3D perspective) |
| `bearing` | `220` | Camera compass bearing in degrees |
| `3d` | `1` | Enable 3D terrain mode |
| `tab` | `glides` | Active sidebar tab |
| `event` | `12` | Highlighted event index (scrolls sidebar + highlights on map) |
| `t` | `10:32:15` | Playback time / cursor position along the track |

Example shareable URL:
```
/u/pokle/analysis?track=abc123&lat=-37.812&lng=144.963&zoom=14&pitch=60&bearing=220&3d=1
```

A recipient clicking this link sees the exact same flight, from the exact same vantage point, looking in the exact same direction. The URL *is* the state.

**Implementation approach:**
- Use `URLSearchParams` to read/write state, debounced on map move/zoom/rotate events
- `replaceState` (not `pushState`) for camera movements to avoid polluting browser history
- `pushState` for discrete navigation actions (switching tracks, tabs, selecting events)
- A "Copy Link" button in the UI copies the current URL with all view state included

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

### `/u/{username}/profile` — Pilot Profile

Scoped under the user's namespace for consistency.

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
| Personal track from `/u/{username}/` | Task, Score, Events, Glides, Climbs, Sinks |
| Personal task from `/u/{username}/` | Task (editable) |
| Competition task ("View on Map") | Task, Score, Events, Comp Score |
| Drag-and-drop (no context) | All tabs (legacy power-user mode) |

This reduces cognitive load — users only see tabs relevant to their current task.

---

## URL Summary

| URL | Page | Auth |
|-----|------|------|
| `/` | Landing / marketing | Public |
| `/u/{username}/` | Personal flights hub | Required |
| `/u/{username}/analysis?...` | Flight analysis (map) | Required |
| `/u/{username}/profile` | Pilot profile | Required |
| `/u/me/` | Redirect to `/u/{username}/` | Required |
| `/comp` | Competitions list | Public (create requires auth) |
| `/comp/{id}` | Competition detail | Public (non-test) |
| `/comp/{id}/task/{id}` | Task detail | Public (non-test) |
| `/scores?comp={id}` | Public scores deep-link | Public |
| `/about` | About | Public |
| `/legal` | Legal | Public |
| `/scoring` | GAP docs | Public |

---

## Migration Path

This IA can be implemented incrementally:

1. **Add global nav bar** to all authenticated pages (My Flights, Competitions, User Menu). This alone fixes the biggest confusion.
2. **Remove competition-related UI from dashboard** (sample comp link, competitions button). Dashboard becomes purely about personal flights.
3. **Add tabs to competition detail** (Overview, Scores, Settings) instead of the current single-page layout.
4. **Move "Comp Score" and "GAP Config"** out of the analysis sidebar into the competition pages.
5. **Add "View on Map" button** to task detail page as the bridge to analysis.
6. **Route analysis under `/u/{username}/analysis`** instead of standalone `/analysis.html`.
7. **Add `/u/{username}/profile` page** for pilot profile management.

Steps 1-3 can ship together as one release. Steps 4-7 can follow as competition features mature.

---

## Open Questions

1. **Should `/u/{username}/analysis` be a separate page or a modal/overlay from `/u/{username}/`?** A separate page gives more screen real estate for the map. A modal keeps context. Recommend: separate page (current behavior works well).

2. **Should competition scores be a standalone page (`/scores`) or just a tab on the comp detail?** Recommend both — the tab for logged-in users navigating the comp, and `/scores?comp={id}` as a shareable public link that renders the same content.

3. **Should the command menu (Cmd+K) be available globally or only on the analysis page?** It could be useful globally for quick navigation, but its current commands are analysis-specific. Recommend: keep it analysis-only for now, consider global command palette later.

4. **Do we need a `/comp/{id}/task/{id}/analysis` route or is query-param-based `/u/{username}/analysis?compTask={id}` sufficient?** Query params are simpler and avoid duplicating the analysis page. Recommend query params.
