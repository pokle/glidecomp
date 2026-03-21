# TaskScore UX Inventory

Complete inventory of all UX elements, jobs to be done, commands, buttons, and flows — excluding map-internal interactions.

## Pages & Navigation

| Page | Path | Purpose |
|------|------|---------|
| Home | `/` | Welcome/landing with links to Sign In, GitHub, YouTube, About |
| Login | `/login` | Google OAuth sign-in |
| Onboarding | `/onboarding` | Username setup (3-20 chars, alphanumeric + hyphens) |
| Dashboard | `/dashboard` | File management — two tabs: Tracks & Tasks |
| Analysis | `/analysis` | Main app — map + right sidebar panel |
| About | `/about` | Library credits |

## Jobs To Be Done

### 1. Load Flight Data

- **Drag & drop** IGC/XCTSK files onto map or dashboard
- **File picker** via command menu → "Load IGC" / "Load XCTSK"
- **Import XContest task** by code (e.g. `buje`)
- **Import AirScore task** by pasting a tracklog URL
- **Try sample flights** (2 built-in demos)
- **Load from storage** — recent tracks/tasks in command menu (top 10 each)
- **URL parameters** — `?task=CODE`, `?storedTrack=ID`, etc.
- **Dashboard cards** — click a stored track/task card

### 2. Analyze Flight Events

- **Events tab** — chronological list of all detected events (takeoff, thermals, glides, landing, etc.)
- **Glides tab** — filtered glide segments with distance, altitude lost, L/D ratio
- **Climbs tab** — thermal segments with duration, altitude gain, avg climb rate
- **Sinks tab** — poor glides (L/D > 5) sorted by altitude lost
- **Altitude sparkline** — area chart with time axis, clickable to jump to nearest event
- **Click any event row** → pan map to location, highlight segment, show vertical marker on sparkline

### 3. Define/Edit Tasks

- **Task tab** — inline turnpoint editor
- **Turnpoint rows** — each has: drag handle, type dropdown (Takeoff/SSS/TP/ESS/Goal), name, lat/lon, radius, altitude, delete button
- **Add waypoint** — manual coords, waypoint database search, or click-on-map mode
- **Drag to reorder** turnpoints
- **Auto-calculated leg distances** between turnpoints
- **Clear all** button

### 4. View Scoring

- **Score tab** — turnpoint sequence results
- Shows: start crossing, each TP reached (with checkmarks), ESS/Goal status, total task distance, points, L/D

### 5. Configure Display

Via command menu (`Cmd/Ctrl+K`):

- **3D Track** toggle
- **Task visibility** toggle
- **Track visibility** toggle
- **Track metrics overlay** (speed)
- **Annotate map** (drawing mode)
- **Text Shadow Tuner**
- **Map provider** switch (Mapbox/Leaflet/Three.js globe)

### 6. Configure Settings

Settings dialog (`Cmd/Ctrl+,`) with collapsible sections:

- **Units** — Speed (km/h, mph, knots), Altitude (m, ft), Distance (km, mi, nm), Climb Rate (m/s, ft/min, knots) + reset
- **Thermal Detection** — min climb rate, min duration, min gap + reset
- **Glide Detection** — max glide ratio for sink, min duration, min gap indices + reset
- **Vario Extremes** — min significant climb/sink, window size, landing descent threshold + reset
- **Takeoff/Landing** — min ground speed, min altitude gain, min climb rate, time window + reset

### 7. Annotate/Draw on Map

- `D` to enter annotation mode
- `E` for eraser
- `V`/`Esc` to exit
- `Cmd+Z` / `Cmd+Shift+Z` for undo/redo
- `Cmd+Shift+Delete` to clear all

### 8. Manage Stored Files (Dashboard)

- **Tracks tab** / **Tasks tab** — card list with name, meta info, relative time
- **Upload zone** — drop or click to browse
- **Delete** individual tracks/tasks (X button on card)
- **Delete account** dialog (destructive)

### 9. Auth Flow

- Sign in via Google OAuth
- Set username on first visit
- Sign out from dashboard header

## Commands & Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl+K` | Open command menu (searchable) |
| `Cmd/Ctrl+,` | Open settings |
| `D` | Toggle annotation mode |
| `E` | Eraser (in annotation mode) |
| `V` / `Esc` | Exit annotation / close dialog |
| `Cmd/Ctrl+Z` | Undo annotation |
| `Cmd/Ctrl+Shift+Z` / `Cmd/Ctrl+Y` | Redo annotation |
| `Cmd/Ctrl+Shift+Delete` | Clear all annotations |
| `Escape` | Close any dialog |
| `Enter` | Submit active dialog |

## Command Menu Sections

1. **Feedback** — Email feedback
2. **File** — Load IGC, Load XCTSK, Import XContest, Import AirScore, Unload all
3. **Display Options** — 6 toggles (3D, task, track, metrics, annotate, shadow tuner) + map provider
4. **Settings** — Open settings dialog
5. **Sample Flights** — 2 built-in demos
6. **Stored Tasks** — up to 10 recent (dynamic)
7. **Stored Tracks** — up to 10 recent (dynamic)

## UI Components & Controls

### Analysis Page Layout

- **Right sidebar** — slide-in panel with close button, backdrop on mobile
- **6-tab system** — Task, Score, Events, Glides, Climbs, Sinks
- **Event count bar** — "N events" below tabs
- **Flight info banner** — pilot, glider, date, duration, max alt, task distance
- **Status alerts** — top-center overlay (info/success/warning/error), auto-close on success
- **Drop zone overlay** — appears on file drag-over
- **Panel toggle button** — top-right, shows/hides sidebar

### Analysis Panel Detail

#### Flight Info Banner (Top of sidebar)

- Displays: Pilot, Glider, Date, Duration, Max Alt, Task Distance
- Default text: "Load an IGC file to see flight info"
- Close button (X icon) to hide panel

#### Altitude Sparkline (Below tabs, 88px height)

- Shows only on track tabs (Events/Glides/Climbs/Sinks), not Task/Score
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
- Color-coded by event type
- Clickable: pan map to event, mark selection

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
  - Radius (meters)
  - Altitude (optional)
  - Delete button (trash icon)
- Add waypoint button (+) with options: manual coords, waypoint database search, click on map
- Clear all button
- Auto-calculated leg distances between turnpoints

### Dashboard Page

- **Header** — logo, user name, "Open Analysis" button, "Sign out" button
- **Tab system** — Tracks / Tasks with count badges
- **Upload zone** — drop files or click to browse (per tab)
- **Track cards** — name, glider + filename, relative time, delete button, link to analysis
- **Task cards** — name, turnpoint count + task code, relative time, delete button, link to analysis
- **Full-page drop overlay** on drag-over
- **Staggered card-enter animation** on load

### Dialogs/Modals

| Dialog | Trigger | Contents |
|--------|---------|----------|
| Command Menu | `Cmd/Ctrl+K` or menu button | Searchable combobox with all commands |
| Settings | `Cmd/Ctrl+,` or command menu | Units + threshold configuration (5 sections) |
| Import XContest Task | Command menu → Import XContest | Task code input field |
| Import AirScore Task | Command menu → Import AirScore | URL paste field with format example |
| Delete Account | Dashboard | Warning text, cancel, destructive confirm |

## Mobile Behavior

- Sidebar hidden by default, slides in with backdrop overlay
- Tap backdrop to close
- Smaller header, stacked buttons
- Touch-compatible drag-and-drop reordering
- Panel toggle button visible top-right

## State & Persistence

### localStorage

- Unit preferences (speed, altitude, distance, climb rate)
- Detection thresholds (thermal, glide, vario, takeoff/landing)
- Map location (center, zoom, pitch, bearing)
- Map style and provider
- Active tab selection
- Feature flags

### IndexedDB

- Stored track records (IGC files with metadata)
- Stored task records (XCTSK files with metadata)

### URL Parameters

| Parameter | Purpose |
|-----------|---------|
| `task=CODE` | Load XContest task by code |
| `track=FILE` | Load track file |
| `storedTask=ID` | Load stored task from IndexedDB |
| `storedTrack=ID` | Load stored track from IndexedDB |
| `m=l\|m` | Map provider (leaflet/mapbox) |
| `3d=0` | Disable 3D mode |
| `task-visible=0` | Hide task overlay |
| `track-visible=0` | Hide track overlay |
| `speed=1` | Show metrics overlay |

## External Integrations

| Service | Purpose |
|---------|---------|
| Google OAuth | Authentication |
| XContest API | Fetch tasks by code |
| AirScore/Highcloud API | Fetch tasks & tracks by URL |
| XContest Waypoint Database | Waypoint search for task editor |
