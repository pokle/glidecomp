# High Level TODOs

## Features for pilots

- [ ] Analyse a tracklog against a task
  - Visualise task on the map
  - Calculate task score, and explain the scores on the map
- [ ] Submit tracklogs
  - email with IGC file attachment, and text containing pilot's thoughts
  - IGC files via drag-and-drop
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

- [ ] BUG: The `pages/public/data/tracks/2025-01-05-Tushar-Corryong.igc` IGC file has segments that aren't a glide or a thermal or sink. They're basically unclickable. These sections are near the end. I think there was so much lifty air that I was climbing on glide. Also there are sections that are identified as a thermal but are actually a climbing glide (flying straight).
- [ ] Improve usability of the glide segment visualisation (Increase font size. 1km Chevrons.)
- [ ] **Browser Storage Management** (see `browser-storage-spec.md`):
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
- [x] Make units selectable (see `configurable-units-spec.md`)
- [ ] Add altitude chart. X axis: Time, Y axis: Altitude
- [x] Associate tasks with tracks. When we load a track, we should use the IGC file's declared task information if available. 
- [x] If the IGC file doesn't contain task information, we should try to associate the track with any known tasks in the region on the date.
- [x] USABILITY: The altitude colours should be on by default.

# AirScore TODOs

These aren't items for taskscore, but ideas for feature requests in AirScore.

- [ ] Dockerise AirScore so that I can run it locally and test it easily.
- [ ] AirScore should load XContest tasks while creating tasks
- [ ] Downloading IGC files from AirScore should include the task they were scored against.
