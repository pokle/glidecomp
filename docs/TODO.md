# High Level TODOs

## Features for pilots

- [ ] Analyse a tracklog against a task
  - Visualise task on the map
  - [x] Calculate task score (CIVL GAP scoring engine — `web/engine/src/gap-scoring.ts`, CLI via `bun run score-task`)
  - [ ] Explain the scores on the map
- [ ] Submit tracklogs
  - IGC files via drag-and-drop (implemented)
  - (Future) email with IGC file attachment, and text containing pilot's thoughts
- [ ] View all previously submitted tracklogs

## Features for scorers

- [ ] Bulk upload of tracklogs
- [ ] Manage pilot accounts
- [ ] Manage competition
  - Manage scoring rules
- [ ] Manage tasks
- [ ] Manage maps
- [ ] Manage turnpoints

## Features for admins

- [ ] Manage scorer accounts

# Analysis page TODOs

- [ ] BUG: The `web/frontend/public/data/tracks/2025-01-05-Tushar-Corryong.igc` IGC file has segments that aren't a glide or a thermal or sink. They're basically unclickable. These sections are near the end. I think there was so much lifty air that I was climbing on glide. Also there are sections that are identified as a thermal but are actually a climbing glide (flying straight).
- [ ] Improve usability of the glide segment visualisation (Increase font size. 1km Chevrons.)
- [ ] **Browser Storage Management** (see `browser-storage-spec.md` in this directory):
  - [ ] Clear individual items from storage (delete a stored task or track)
  - [ ] Clear all storage (reset to empty state)
  - [ ] Download stored files back to user's computer (export IGC files)
- [x] Allow users to click on the track to show details on the events panel.
  - Open the Event panel if closed
  - If the point lies within a segment, select the segment (glide, thermal, or sink)
  - Otherwise select the closest event on the event panel.
  - Accomodations:
    - [x] If possible, on hover, change the cursor to indicate that it's clickable.
    - [ ] DEFER: If possible, on hover over a segment, highlight the segment by increasing its width.
- [x] Implement 'Highest climbs' tab - show all climbs/thermals sorted by greatest altitude gain first
- [x] Implement 'Deepest sinks' tab - show all descents sorted by greatest altitude drop first
- [ ] DEFER: Add box plots to the 'Longest glides' view showing vertically stacked box plots per detail (use uPlot for plotting, and simple-statistics for the descriptive statistics)
- [x] Review code and ensure that we're using appropriate libraries for statistics and geo calculations.
- [x] Make units selectable (see `configurable-units-spec.md` in this directory)
- [x] Add altitude chart — implemented as an interactive altitude sparkline (see `sparkline-spec.md` in this directory)
- [x] Associate tasks with tracks. When we load a track, we should use the IGC file's declared task information if available. 
- [x] If the IGC file doesn't contain task information, we should try to associate the track with any known tasks in the region on the date.
- [x] USABILITY: The altitude colours should be on by default.

# AirScore TODOs

These aren't items for taskscore, but ideas for feature requests in AirScore.

- [ ] Dockerise AirScore so that I can run it locally and test it easily.
- [ ] AirScore should load XContest tasks while creating tasks
- [ ] Downloading IGC files from AirScore should include the task they were scored against.

# code-improver suggestions 8-Feb-2026

Critical (1)

  - Missing transaction error handling in storage.ts — Some IndexedDB operations only handle request-level errors, not transaction-level
  errors, which can lead to unhandled promise rejections.

  Important (7)

  1. Monolithic init() function in main.ts — Over 1000 lines handling too many responsibilities. Should be broken into focused functions
  (theme, file handling, feature toggles, etc.).
  2. Error handling loses context — Generic error messages without structured logging make production debugging harder.
  3. Performance: multiple passes over fixes array in event-detector.ts — Thermal detection, altitude extremes, and vario extremes each
  iterate the full array separately. Could be combined for large flights (10k+ fixes).
  4. ~~Thermal exit detection off-by-one in event-detector.ts~~ — Analyzed and confirmed correct. `thermalEnd = i - exitThreshold` is the
  last index where the window average was above threshold. See `events/thermal-detection-spec.md` for full analysis.
  5. Promise anti-pattern in storage.ts — Manual Promise wrapping around IndexedDB could be simplified with a helper or the idb library.
  6. Missing integer overflow/negative validation in the AirScore worker — comPk/tasPk aren't checked for negative values or safe integer
  bounds.
  7. Potential cache poisoning in the AirScore worker — Upstream data structure isn't deeply validated before caching.

  Suggestions (3)

  - Inconsistent optional chaining after null checks are already done
  - Magic numbers (e.g., 768 for mobile breakpoint) without named constants
  - Hardcoded localhost:8787 — could use import.meta.env.DEV instead of hostname check

  Top 3 recommendations by impact:

  1. Break up the init() function in main.ts for maintainability
  2. Fix IndexedDB transaction error handling to prevent silent failures
  3. Add structured error logging for easier production debugging