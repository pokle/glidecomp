# Windy.com Plugin Investigation for TaskScore

## Summary

Building a Windy plugin for TaskScore is **feasible and a good fit architecturally**. The `@taskscore/engine` package is already framework-agnostic and fully separable from the UI. Windy plugins use Leaflet (via "Leaflet GL" — a cut-down MapLibre 5 with Leaflet 2 API), so TaskScore's existing Leaflet provider code can inform the map rendering. The main concerns are mobile support limitations and the recent turbulence around Windy's plugin maintenance commitment.

---

## Q1: Can a Windy Plugin Load IGC Files and Tasks?

**Yes.** There are no technical barriers.

### IGC File Loading

A Windy plugin is essentially a small web app (Svelte component + HTML/CSS/JS) running inside windy.com. You have full access to standard browser APIs, which means:

- **`<input type="file">`** — standard file picker, works in all browsers
- **`FileReader` API** — read the selected file as text
- **Drag-and-drop** — via standard HTML5 drag/drop events

TaskScore's `@taskscore/engine` package includes a pure-TypeScript IGC parser (`igc-parser.ts`) with zero framework dependencies. It takes a string and returns a structured `IGCFile` object with fixes, header info, events, and task declarations. This can be bundled directly into the plugin.

```typescript
// This would work inside a Windy plugin as-is:
import { parseIGC } from '@taskscore/engine';

function handleFile(text: string) {
  const igc = parseIGC(text);
  // igc.fixes[] — lat, lon, altitude, time
  // igc.header — pilot, glider, date
  // igc.task — declared task from IGC
}
```

### Task Loading

Tasks can come from multiple sources:

1. **IGC-declared tasks** — parsed automatically from the IGC file header
2. **XContest task codes** — fetched via HTTP (see Q3 below)
3. **AirScore competition tasks** — fetched via the TaskScore API
4. **Direct input** — user pastes a task definition or URL

The `xctsk-parser.ts` module handles the XCTask format (turnpoints, SSS, ESS, goal config). Tasks are pure data — no UI dependency.

### How It Would Work

1. User opens the TaskScore plugin on windy.com
2. Plugin presents a file picker (or drag/drop zone) for IGC files
3. IGC is parsed client-side using `@taskscore/engine`
4. Flight track is rendered on Windy's Leaflet map as a polyline
5. Task turnpoints rendered as circle overlays
6. Analysis sidebar shows thermals, glides, sinks, event timeline

---

## Q2: Can It Call Your API?

**Yes, with a caveat about CORS.**

Windy plugins run in the browser context of windy.com. Standard `fetch()` / `XMLHttpRequest` calls work, subject to normal browser CORS rules. Your AirScore API worker already sets `Access-Control-Allow-Origin: *`, so cross-origin requests from windy.com will work.

### Available API Endpoints

| Endpoint | Purpose | CORS |
|---|---|---|
| `GET /api/airscore/task?comPk=X&tasPk=Y` | Load competition task + pilot results | ✅ `*` |
| `GET /api/airscore/track?trackId=X` | Download IGC file by track ID | ✅ `*` |

### Loading AirScore Tasks

The AirScore task endpoint returns full task definitions including turnpoints, SSS/ESS configuration, and pilot results with track IDs. From within the plugin you could:

1. Fetch a competition task via the AirScore API
2. Fetch other pilots' IGC tracks from the same task
3. Parse and render them alongside the user's flight

### Example

```typescript
// Fetch an AirScore task from within the Windy plugin
const resp = await fetch(
  'https://taskscore.shonky.info/api/airscore/task?comPk=123&tasPk=456'
);
const { task, pilots } = await resp.json();

// task is an XCTask object — render turnpoints on Windy map
// pilots[] includes trackId for each pilot — can fetch their IGCs
```

---

## Q3: Does It Work on Mobile and Web?

**Web: Yes. Mobile: Partially.**

### Web (Desktop Browsers)

Plugins work fully on desktop browsers. When installed, they appear in the Windy plugin gallery at `windy.com/plugins` and get their own URL route (e.g., `windy.com/plugin/taskscore`).

The plugin config lets you choose UI layout:
- **`desktopUI: "rhpane"`** — right-hand panel (like Windy's built-in panels), scrollable, up to 400px wide
- **`desktopUI: "embedded"`** — smaller overlay that stays open alongside other UI

### Mobile Browsers

Plugins work in **mobile browsers** (Chrome, Safari, Firefox) when accessing `windy.com/plugins` directly. The plugin config offers:
- **`mobileUI: "fullscreen"`** — takes over the full screen
- **`mobileUI: "small"`** — minimal bottom strip

**However**, there are significant caveats:
- Phone browser layouts are simplified and may not show plugin options easily
- Not all plugins render correctly on small screens — you'd need to design for mobile explicitly
- Windy recommends bookmarking `windy.com/plugins` on the home screen for quick access

### Native Windy App

**Plugins do NOT work in the native Windy mobile app.** Windy has stated: "At this moment, there is no plan to implement external plugins to our mobile version" — citing privacy/security concerns about running third-party code.

The only workaround: if a user installs a plugin via desktop and loads it from URL while logged in, it _may_ be accessible in the mobile app, but this is not officially supported or reliable.

---

## Q4: Windy Plugin Architecture — Technical Details

### Tech Stack

| Component | Technology |
|---|---|
| Framework | **Svelte** (optional — vanilla JS works too) |
| Language | **TypeScript** (optional) |
| Map library | **"Leaflet GL"** — cut-down MapLibre 5 with Leaflet 2 API |
| Build tool | Windy's own toolchain (npm-based) |
| Dev server | `localhost:9999` serving `plugin.js` |

### Plugin Lifecycle

```
onMount()     — called once when plugin loads (set up listeners here)
onopen(params) — called each time plugin opens (may be called multiple times)
onDestroy()   — called once when plugin unloads (clean up here)
```

### Map Access

Leaflet's `L` object is globally available — no import needed. You can:
- Add polylines, markers, polygons, circles
- Listen to map events (click, zoom, pan)
- Use Windy's weather interpolator at any coordinates
- Access Windy's store for current weather layer/overlay settings

### Available Windy API Modules

```typescript
import { map } from '@windy/map';           // Map manipulation
import { store } from '@windy/store';         // App state
import { broadcast } from '@windy/broadcast'; // Event messaging
import { singleclick } from '@windy/singleclick'; // Click events
import { getLatLonInterpolator } from '@windy/interpolator'; // Weather data at point
import { metrics } from '@windy/Metric';      // Unit conversion
```

### Plugin Config Example

```typescript
export default {
  name: 'windy-plugin-taskscore',
  version: '1.0.0',
  title: 'TaskScore Flight Analysis',
  icon: '🪂',
  description: 'Analyze hanggliding/paragliding competition flights with thermal, glide, and sink analysis',
  author: 'TaskScore',
  desktopUI: 'rhpane',
  mobileUI: 'fullscreen',
  desktopWidth: 420,
  routerPath: '/taskscore/:taskId?',
  listenToSingleclick: true,
  addToContextmenu: true,
};
```

### Distribution

Plugins are published to the **Windy Plugins Gallery** at `windy.com/plugins`. They can also be:
- **Private** — hidden from the gallery (good for testing or institutional use)
- **Internal** — no menu link, only accessible programmatically

### Getting Started

```bash
git clone https://github.com/windycom/windy-plugin-template.git
cd windy-plugin-template
npm install
npm start
# Dev server at https://localhost:9999/plugin.js
# Open windy.com → plugin loads from localhost in dev mode
```

---

## Q5: What's the Maintenance/Stability Situation?

### The 2024 Scare

In early 2024, Windy announced they could no longer maintain the external plugin API due to a planned migration to ES Modules that would break the plugin system. This caused significant community backlash, particularly from the balloon piloting community who depend on trajectory plugins for flight safety.

### Current Status (2025-2026)

Windy reversed course after community pressure. They committed to:
1. Keeping the plugin system alive
2. Integrating popular plugin functionality (like trajectories) as core Windy features
3. Releasing updated plugin documentation at `docs.windy-plugins.com`

The plugin system appears **actively maintained** as of late 2025 / early 2026, with updated documentation, TypeScript types, and a modern template repo. However, the episode highlights a risk: Windy is a proprietary platform and could change their plugin story again.

---

## Architecture Fit: TaskScore Engine → Windy Plugin

### What Maps Cleanly

| TaskScore Component | Windy Plugin Equivalent |
|---|---|
| `@taskscore/engine` (IGC parser, event detector, thermal/glide/sink analysis) | Bundle directly into plugin — zero changes needed |
| Leaflet map provider (`leaflet-provider.ts`) | Reference implementation for Windy's Leaflet GL map |
| Flight track polylines | `L.polyline()` on Windy's map |
| Turnpoint cylinders | `L.circle()` or `L.polygon()` on Windy's map |
| Event markers | `L.marker()` with custom icons |
| AirScore API client | `fetch()` to `taskscore.shonky.info` — CORS already open |
| Analysis panel UI | Svelte component in rhpane (right-hand panel) |

### What Needs Adaptation

| Current TaskScore | Windy Plugin Adaptation |
|---|---|
| MapBox GL JS (primary provider) | Use Windy's Leaflet GL instead — no MapBox in plugin context |
| 3D terrain/Threebox | Not available in Windy — 2D only (Windy has its own terrain shading) |
| IndexedDB storage | Use localStorage or plugin-scoped storage (simpler, smaller scale) |
| Basecoat UI components | Replace with Windy's CSS styleguide + custom Svelte components |
| Command palette | Simplify to plugin panel controls |

### What You Gain From Windy

- **Animated weather overlay** — wind, clouds, rain, thermals layer on the same map as the flight track
- **Weather data at any point** — `getLatLonInterpolator()` returns forecast data at coordinates along the flight
- **Time scrubbing** — Windy's timeline lets you see weather conditions at the time of flight
- **Global audience** — Windy has millions of users; the plugin gallery provides discovery
- **Wind data correlation** — overlay actual/forecast wind with the pilot's glide segments

---

## Proposed Plugin Structure

```
windy-plugin-taskscore/
├── src/
│   ├── plugin.svelte           # Main entry — panel UI + map integration
│   ├── pluginConfig.ts         # Windy plugin metadata
│   ├── components/
│   │   ├── FileLoader.svelte   # IGC file picker + drag-drop
│   │   ├── TaskLoader.svelte   # Load task by XContest code or AirScore ID
│   │   ├── EventList.svelte    # Flight events timeline
│   │   ├── GlideList.svelte    # Glide segments with L/D, speed
│   │   ├── ClimbList.svelte    # Thermal climbs with climb rate
│   │   ├── SinkList.svelte     # Sink segments
│   │   └── TrackHUD.svelte     # Point-click info overlay
│   ├── map/
│   │   ├── track-renderer.ts   # Render flight track on Leaflet map
│   │   ├── task-renderer.ts    # Render turnpoints/cylinders
│   │   └── event-markers.ts    # Render event markers
│   └── lib/
│       └── engine/             # @taskscore/engine bundled or npm-linked
├── package.json
└── tsconfig.json
```

---

## Risks and Considerations

| Risk | Severity | Mitigation |
|---|---|---|
| Windy deprecates plugin API again | Medium | Keep engine portable; could pivot to standalone Windy Leaflet API embed |
| No native mobile app support | Medium | Mobile browser works; design UI to be responsive |
| Bundle size (Turf.js + engine) | Low | Tree-shake; Turf modules are individually importable |
| Windy Leaflet GL quirks vs standard Leaflet | Low | Test early; TaskScore already has a Leaflet provider as reference |
| CORS or CSP issues on windy.com | Low | AirScore API already allows `*`; test with dev plugin |

---

## Recommendation

**Start with a minimal proof-of-concept:**

1. Clone the Windy plugin template
2. Bundle `@taskscore/engine` into it
3. Add a file picker that loads an IGC file
4. Parse it and render the track as a Leaflet polyline on Windy's map
5. Show basic event list in the right-hand panel
6. Test on desktop and mobile browser

This would validate the integration surface (Leaflet compatibility, bundle size, CORS, panel UI) before investing in the full analysis experience. The engine code requires zero changes — it's the map rendering and UI that need to be rebuilt in Windy's Svelte + Leaflet context.

---

## References

- [Windy Plugins Guide](https://docs.windy-plugins.com/getting-started/)
- [Plugin Examples Tutorial](https://docs.windy-plugins.com/getting-started/examples.html)
- [Plugin Config Reference](https://docs.windy-plugins.com/api/interfaces/ExternalPluginConfig.html)
- [Windy Plugin Template (GitHub)](https://github.com/windycom/windy-plugin-template)
- [Windy Map Forecast API (GitHub)](https://github.com/windycom/API)
- [Community: Plugins on Mobile](https://community.windy.com/topic/32507/how-to-run-windy-plugin-on-mobile-device)
- [Community: Plugin Maintenance Status](https://community.windy.com/topic/30927/we-are-sorry-but-windy-plugins-are-no-longer-mainatainable)
- [Windy Plugins Gallery](https://community.windy.com/category/21/windy-plugins)
