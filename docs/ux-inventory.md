# GlideComp UX Inventory — Analysis Tool & My Flights

Inventory of the UX elements, jobs to be done, commands, buttons and flows of
the two **personal** surfaces: the vanilla analysis tool at `/analysis.html`
and the My Flights dashboard at `/u/:username`. Map-internal interactions are
excluded — those live in
[mapbox-interactions-spec.md](mapbox-interactions-spec.md).

**This is not a map of the competition SPA.** Competitions, comp and task
detail, scores, the report card, field analysis, track submission and the
organiser/admin pages are deliberately out of scope here. For those, read
[2026-07-08-information-architecture-v2.md](2026-07-08-information-architecture-v2.md),
which is the current information architecture.

## Pages & Navigation

| Page | Path | Purpose |
|------|------|---------|
| Home | `/` | Static (Astro) marketing home page |
| Onboarding | `/onboarding` | First-login account setup — full name, username, optional CIVL/SAFA IDs |
| My Flights | `/u/:username` | Personal file library — competition flights, personal tracks/tasks, storage |
| Analysis | `/analysis.html` | The analysis tool — map + right sidebar panel |
| About | `/about` | Static (Astro) page — about the author + library credits |

`/u/me` redirects to the signed-in user's own `/u/:username`. Every `/u/*` URL
is rewritten to the SPA shell by `public/_redirects`; `/analysis.html` is a
separate Vite entry, so links to it are plain anchors, never client-side routes.

## Jobs To Be Done

### 1. Load Flight Data

- **Drag & drop** IGC/XCTSK files onto the map or onto My Flights
- **File picker** via command menu → "Load track (IGC) / task (XCTSK) file" —
  one item that accepts both kinds
- **Load XContest task** by code (e.g. `buje`)
- **Load AirScore task** by pasting a tracklog URL
- **Try sample flights** (2 built-in demos)
- **Try a sample competition** — Corryong Cup 2026 Task 1, task + every track
- **Load from storage** — recent tracks/tasks in the command menu (up to 10 each)
- **URL parameters** — `?task=CODE`, `?storedTrack=ID`, `?compId=…&taskId=…`, etc.
- **My Flights rows** — the track/task name, or its "View" button

### 2. Analyse Flight Events

- **Events tab** — chronological list of all detected events (takeoff, thermals, glides, landing, etc.)
- **Glides tab** — filtered glide segments with distance, altitude lost, L/D ratio
- **Climbs tab** — thermal segments with duration, altitude gain, avg climb rate
- **Sinks tab** — poor glides (L/D > 5) sorted by altitude lost
- **Altitude sparkline** — area chart with time axis, clickable to jump to nearest event
- **Click any event row** → pan map to location, highlight segment, show vertical marker on sparkline

### 3. Define/Edit Tasks

- **Task tab** — inline turnpoint editor
- **Turnpoint rows** — each has: drag handle, type dropdown (Takeoff/SSS/TP/ESS/Goal), name, lat/lon, radius, altitude, delete button
- **Add waypoint** — "Search database", "Paste coordinates", or "Click on map"
- **Drag to reorder** turnpoints
- **Auto-calculated leg distances** between turnpoints
- **Clear all** button (with inline confirmation)
- **Download task (.xctsk)** from the command menu — the item stays hidden
  until a task is loaded

### 4. View Scoring

- **Score tab** — turnpoint sequence results
- Shows: start crossing, each TP reached (with checkmarks), ESS/Goal status, total task distance, points, L/D
- **Competition Score tab** — in multi-track mode only, the field's scores for
  the loaded task (GAP or open distance)

### 5. Configure Display

Via command menu (`Cmd/Ctrl+K`) — six items, five of which carry an `(on)`/`(off)` status:

- **Toggle 3D Track**
- **Toggle Task** (turnpoint cylinders and route)
- **Toggle Track**
- **Show/Hide track metrics** (speed overlay)
- **Annotate Map** (drawing mode)
- **Text Shadow Tuner** (a debug tool, no on/off state)

There is no map-provider control: Leaflet was removed (#358) and Mapbox is the
only provider.

### 6. Configure Settings

Settings dialog (`Cmd/Ctrl+,`, or command menu → "Settings...") with six
collapsible sections, each with its own "Reset to defaults":

- **Units** — Speed (km/h, mph, knots), Altitude (m, ft), Distance (km, mi, nmi), Climb Rate (m/s, ft/min, knots)
- **Thermal Detection** — min climb rate, min duration, min gap
- **Glide Detection** — max glide ratio for sink, min duration, min gap indices
- **Vario Extremes** — min significant climb/sink, window size, landing descent threshold
- **Takeoff / Landing** — min ground speed, min altitude gain, min climb rate, takeoff/landing time windows, landing speed factor
- **Circle Detection** — max bearing rate, max wind speed, min ground speed variation, lookback window, cruise-to-climb and climb-to-cruise delays, min turn rate, min fixes per circle

GAP scoring parameters are a separate **Competition Settings** dialog (command
menu → "Competition Settings..."). While a competition task is loaded, that
dialog edits a session-only what-if layer that is never persisted or synced, so
a comp link always opens on the competition's own configuration.

### 7. Annotate/Draw on Map

- `D` to enter annotation mode
- `E` for eraser
- `V`/`Esc` to exit
- `Cmd+Z` / `Cmd+Shift+Z` for undo/redo
- `Cmd+Shift+Delete` to clear all

### 8. Manage Stored Files (My Flights)

Three blocks, top to bottom:

- **Competition flights** — read-only; managed by the competition, so no remove
  button. Hidden entirely until the pilot has one.
- **Personal flights** — **Tracks tab** / **Tasks tab** with counts, an "Add
  .igc track log" / "Add .xctsk task" button on the tab row, and drag-and-drop
  anywhere on the page. Each row offers View · Download · Remove; Remove asks
  for confirmation in a dialog first.
- **Storage** — a meter of quota used, plus a warning banner at the top of the
  page once usage passes 80%.

Deleting the whole account is not here — it is the danger zone on `/settings`.

### 9. Auth Flow

- Sign in at `/signin` — email code (OTP), or "Continue with Google"
- Complete onboarding on first visit: full name (required, focused first when
  the account has no name), username (prefilled with the derived handle, and
  the only field that can be rejected as taken), optional CIVL ID and SAFA ID
- Sign out from the account menu in the shared header
- Delete the account from `/settings`

## Commands & Keyboard Shortcuts

Analysis tool only.

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl+K` | Open command menu (searchable) |
| `Cmd/Ctrl+,` | Open the settings dialog directly |
| `D` | Toggle annotation mode |
| `E` | Eraser (in annotation mode) |
| `V` / `Esc` | Exit annotation / close dialog |
| `Cmd/Ctrl+Z` | Undo annotation |
| `Cmd/Ctrl+Shift+Z` / `Cmd/Ctrl+Y` | Redo annotation |
| `Cmd/Ctrl+Shift+Delete` | Clear all annotations |
| `Escape` | Close any dialog |
| `Enter` | Submit active dialog |

Single-key shortcuts do not fire while typing in an input.

## Command Menu Sections

1. **Email Feedback** — an ungrouped item ahead of everything else
2. **File** — Load track (IGC) / task (XCTSK) file; Load XContest task; Load
   AirScore task; Download task (.xctsk) (hidden until a task is loaded);
   Unload all (task & track)
3. **Display Options** — the six items above
4. **Settings** — Competition Settings...; Settings...
5. **Sample Flights** — 2 built-in demos
6. **Sample Competitions** — Corryong Cup 2026 Task 1 (33 pilots)
7. **Stored Tasks** — up to 10 recent (dynamic; the group is hidden when empty)
8. **Stored Tracks** — up to 10 recent (dynamic; the group is hidden when empty)

## UI Components & Controls

### Analysis Page Layout

- **Breadcrumb bar** (`#breadcrumbs`) — a centred pill at the top of the map
  with a "GlideComp" link, so a shared or direct link always has a way back
  into the app; `main.ts` appends "› comp › task" links when a competition task
  is loaded
- **Sidebar resize handle** (`#sidebar-resize-handle`) — a full-height strip on
  the right edge, always visible, titled "Drag to resize, click to cycle
  widths". Clicking cycles half → third → collapsed; the width is remembered.
- **Right sidebar** — slide-in panel with close button, backdrop on mobile
- **Two tab rows**, one visible at a time:
  - `#tab-row-single` — Task, Score, Events, Glides, Climbs, Sinks
  - `#tab-row-multi` — Competition Score, Task — shown in multi-track mode
  - `gap-config` survives in the tab type only for the saved-tab check; the GAP
    parameters are a dialog now, not a tab
- **Event count bar** — "N events" below the tabs
- **Flight info banner** — pilot, glider, date, duration, max alt, task distance
- **Status alerts** — overlay centred below the breadcrumb bar (info/success/warning/error)
- **Drop zone overlay** — appears on file drag-over
- **Map control buttons** — "Menu ⌘K" top-left (opens the command menu) and
  "Analysis" top-right (shows/hides the sidebar). A first-visit tooltip, "View
  flight analysis here", points at the panel toggle once and then never again.

### Analysis Panel Detail

#### Flight Info Banner (Top of sidebar)

- Displays: Pilot, Glider, Date, Duration, Max Alt, Task Distance
- Default text: "Load an IGC file to see flight info"
- Close button to hide the panel

#### Altitude Sparkline (Below tabs, 88px height)

- Shows only on the track tabs (Events/Glides/Climbs/Sinks), not Task/Score/Competition Score
- Background altitude area chart with gradient fill
- Y-axis: Altitude labels with tick marks (computed nice values)
- X-axis: Time labels with tick marks (5/10/15/20/30/60 minute intervals)
- Vertical marker line on event selection (orange glow)
- Clickable: select nearest event matching current tab filter

#### Event List Rows

Each event row shows:
- Icon (event type specific)
- Event type label (Takeoff, Landing, Thermal Entry, etc.)
- Time (HH:MM:SS)
- Data relevant to type (altitude, climb rate, speed, etc.)
- Colour-coded by event type
- Clickable: pan map to event, mark selection

Raw crossings (turnpoint entry/exit, start, goal, circle complete) are hidden —
the scored "reaching" events supersede them.

#### Glide Rows

- Glide icon, start/end times
- Distance, altitude lost, L/D ratio
- Clickable for map highlight

#### Climb Rows

- Thermal icon, entry/exit times
- Duration, altitude gain, average climb rate
- Clickable for map highlight

#### Sink Rows

- Poor glide icon, start/end times
- Distance, altitude lost, L/D ratio (> 5)

#### Task Editor

- Editable turnpoint list with:
  - Drag handle (6-dot grip icon) for reordering
  - Type dropdown (Takeoff, SSS, Turnpoint, ESS, Goal)
  - Waypoint name (text input)
  - Latitude/Longitude inputs (or map-click mode)
  - Radius (metres)
  - Altitude (optional)
  - Delete button (trash icon)
- Add waypoint button (+) with three methods: Search database, Paste
  coordinates, Click on map
- Clear all button
- Auto-calculated leg distances between turnpoints

### My Flights Page

- **Header** — the shared app chrome (`react/components/Shell.tsx`), not a
  page-specific header: a skip link, the GlideComp wordmark (a full navigation
  to the static home page), then Competitions, My Flights and Submit track,
  with a right-aligned account menu (initials avatar → Settings, Sign out).
  Site super admins also get the floating "Preview as" pill. The footer carries
  the build SHA, About, Scoring, Privacy & Terms, GitHub and YouTube.
- **Competition flights** — a tree grouped by competition (all groups start
  expanded), each flight row linking to the comp, the task and, once scored,
  the pilot's report card
- **Tab system** — Tracks / Tasks with counts, and the add-files button
  right-aligned on the tab row
- **Track rows** — name (links to `/analysis.html?storedTrack=…`), glider ·
  filename, relative time, then View · Download · Remove
- **Task rows** — name (links to `/analysis.html?storedTask=…`), turnpoint
  count · task code, relative time, then View · Download · Remove
- **Storage section** — a meter with "X of 200 MB" (plus track/task counts when
  those near their own limits), and the sharing note: uploaded files are
  visible to anyone with the link
- **Full-page drop overlay** on drag-over

### Dialogs/Modals

| Dialog | Trigger | Contents |
|--------|---------|----------|
| Command Menu | `Cmd/Ctrl+K` or the map's Menu button | Searchable combobox with all commands |
| Settings | `Cmd/Ctrl+,` or command menu | Units + detection thresholds (6 sections) |
| Competition Settings | Command menu → Competition Settings | GAP scoring parameters for the loaded task |
| Load XContest task | Command menu → Load XContest task | Task code input field |
| Load AirScore task | Command menu → Load AirScore task | URL paste field with format example |
| Remove track / task | My Flights → Remove | Warning text, cancel, destructive confirm |
| Storage quota exceeded | An upload that exceeds quota | Alert with the limit that was hit |
| Delete Account | `/settings` → Danger zone | Warning text, cancel, destructive confirm |

## Mobile Behaviour

- Sidebar hidden by default, slides in with backdrop overlay
- Tap backdrop to close
- Selecting an event closes the sidebar so the map is visible
- The app header wraps and scrolls with the page instead of pinning (vertical
  space is too precious on phones)
- Touch-compatible drag-and-drop reordering
- Map control labels collapse to icons; the panel toggle stays top-right
- Installable as a PWA, and registered as a Web Share Target for IGC/XCTSK files

## State & Persistence

### localStorage

- `glidecomp:preferences` — one JSON blob (`analysis/config.ts`): `units`,
  `thresholds`, `theme`, `mapLocation` (centre, zoom, pitch, bearing),
  `mapStyle`, `gapParameters`, `nominalDistancePct`. There is no map-provider
  field, and no feature flags.
- `glidecomp-sidebar-width` — last sidebar width in pixels
- `glidecomp-seen-analysis-hint` — set once the first-visit tooltip is dismissed
- `glidecomp-active-tab` — the analysis panel's selected tab

**Preferences cloud-sync when signed in** (`auth/preferences-sync.ts`):
localStorage stays the synchronous read cache, the account is the source of
truth across devices. Pushes are debounced 2s, conflicts are last-write-wins,
and startup reconciles cloud over local. `mapLocation` is deliberately
device-local and never uploaded.

### Stored tracks & tasks

Server-side, not in the browser: tracks in R2 and tasks in D1, via
`/api/user/*` for your own files and `/api/u/:username/*` for public-by-link
reads (`analysis/storage.ts`). The legacy IndexedDB stores are dropped after
the one-time migration. Signed out, storage is a no-op surface — the analysis
page still loads files into memory, it just cannot keep them.

### URL Parameters

Read by `analysis/main.ts` on `/analysis.html`:

| Parameter | Purpose |
|-----------|---------|
| `task=CODE` | Load a task by code — a bundled `/data/tasks` file first, then XContest |
| `track=FILE` | Load a track from `/data/tracks` |
| `storedTask=ID` | Load one of your stored tasks |
| `storedTrack=ID` | Load one of your stored tracks |
| `u=USERNAME` | Public-by-link namespace — re-reads `task`/`track` as that user's public ids |
| `sampleComp=ID` | Load a bundled sample competition (task + every track); exclusive |
| `compId=X&taskId=Y` | Load a competition task and all its uploaded tracks from the competition API |
| `pilotId=Z` | With the pair above, pre-focus that pilot's track |
| `shared=1` | Files arrived via the PWA Web Share Target; cleaned from the URL after loading |
| `3d=0` | Disable 3D mode |
| `task-visible=0` | Hide task overlay |
| `track-visible=0` | Hide track overlay |
| `speed=1` | Show metrics overlay |

`trackid`, `comPk` and `tasPk` are **not** parameters of `/analysis.html` — they
are read out of the AirScore tracklog URL a user pastes into the "Load AirScore
task" dialog (`parseAirScoreUrl()`), e.g.
`https://xc.highcloud.net/tracklog_map.html?trackid=43826&comPk=466&tasPk=2030`.

With no task or track parameter and nothing loaded, the page opens the command
menu to guide the user.

## External Integrations

| Service | Purpose |
|---------|---------|
| Google OAuth + email OTP | Authentication |
| XContest API | Fetch tasks by code |
| AirScore/Highcloud API | Fetch tasks & tracks by URL |
| Mapbox | The map, terrain and 3D track |

The task editor's waypoint search is not an external service: it reads a
bundled CSV (`/data/waypoints/corryong-cup-waypoints.csv`) loaded at startup.
