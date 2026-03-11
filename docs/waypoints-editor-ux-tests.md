# Waypoints Editor — UX Test Plan

Manual and automated test flows for the task editor feature (PR #91).

## Prerequisites

- Dev server running (`bun run dev`)
- Open `http://localhost:3000/analysis.html`
- Panel visible (click "Toggle panel" button if hidden)
- Task tab selected

---

## 1. Empty State

**Steps:**
1. Open analysis page with no task loaded

**Expected:**
- Task tab shows "Add waypoints to build a task" placeholder
- Large "Add waypoint" button with + icon centered
- Toolbar shows +, map pin, and trash buttons
- Stats footer absent or shows 0

---

## 2. Add Waypoint via Database Search

**Steps:**
1. Click the "+" (Add waypoint) button in toolbar
2. Select "Search database" from popover
3. Type a waypoint name (e.g., "launch") in search field
4. Click a result from the dropdown

**Expected:**
- Search input appears with "Search waypoints..." placeholder
- Type-ahead filters results as you type
- Clicking a result adds a waypoint card to the list
- Card shows name, type badge ("Turnpoint"), radius, altitude
- Map updates with new cylinder marker
- Stats footer updates (e.g., "1 turnpoint · 0.00 km")

---

## 3. Add Multiple Waypoints — Distance Calculation

**Steps:**
1. Add a second waypoint via search (e.g., "north corry")
2. Observe distance calculation

**Expected:**
- Second card shows leg distance and cumulative distance
- First card shows "—" for leg, "Start" for cumulative
- Stats footer shows total (e.g., "2 turnpoints · 1.19 km")
- Header distance updates to match
- Map shows both cylinders and a connecting leg line

---

## 4. Expand/Collapse Waypoint Card

**Steps:**
1. Click on a waypoint card body (not the delete button)
2. Click on a different card

**Expected:**
- Clicked card expands to show editable fields: Name, Type, Radius, Altitude, Coordinates
- Only one card expanded at a time
- Previously expanded card collapses when another is clicked
- Map pans to the expanded turnpoint

---

## 5. Change Turnpoint Type

**Steps:**
1. Expand a waypoint card
2. Change type dropdown to "Start (SSS)"
3. Change another waypoint to "Goal"

**Expected:**
- Badge updates immediately (e.g., "Turnpoint" → "Start (SSS)")
- Map popup label updates to match new type
- Setting SSS creates `task.sss` config (race type, exit direction)
- Setting Goal creates `task.goal` config (cylinder type)
- All 5 types available: Takeoff, Start (SSS), Turnpoint, ESS, Goal

---

## 6. Edit Waypoint Name

**Steps:**
1. Expand a waypoint card
2. Change the Name text input
3. Click outside (blur) or press Enter

**Expected:**
- Card header updates to new name
- Map popup updates to new name

---

## 7. Edit Radius

**Steps:**
1. Expand a waypoint card
2. Change radius value (e.g., 400 → 2000)
3. Blur the field

**Expected:**
- Collapsed card shows updated radius (e.g., "2.00 km")
- Map cylinder resizes
- Distances recalculate (optimized distances depend on radius)

---

## 8. Edit Altitude

**Steps:**
1. Expand a waypoint card
2. Change altitude value
3. Blur the field

**Expected:**
- Collapsed card shows updated altitude

---

## 9. Paste Coordinates

**Steps:**
1. Click "+" → "Paste coordinates"
2. Type `-36.200, 147.950` in the input
3. Press Enter

**Expected:**
- Input appears with placeholder "-36.185, 147.891"
- Helper text: "Enter lat, lon (e.g. from Google Maps)"
- New waypoint "WP {n}" created with type "Turnpoint", radius 400m
- Card auto-expands for editing
- Map updates with new cylinder at coordinates
- Coordinates shown read-only in expanded card: "-36.20000, 147.95000"

---

## 10. Map Click Mode

**Steps:**
1. Click the map pin toggle button in toolbar (or "+" → "Click on map")
2. Click on the map

**Expected:**
- Map pin button gets active/highlighted state
- Map cursor changes to crosshair
- Clicking map creates a new waypoint at click coordinates
- Map click mode auto-exits after adding
- New card auto-expands

---

## 11. Delete Individual Waypoint

**Steps:**
1. Have 2+ waypoints
2. Click the "×" delete button on a card

**Expected:**
- Waypoint removed from list
- Map cylinder removed
- Remaining cards renumber (1, 2, 3...)
- Distances recalculate
- Stats footer updates

---

## 12. Clear All Waypoints

**Steps:**
1. Have 1+ waypoints
2. Click trash icon in toolbar

**Expected:**
- Button morphs to "Clear? Yes No" inline confirmation
- Clicking "Yes" removes all waypoints, shows empty state
- Clicking "No" or waiting 3 seconds reverts to trash icon
- Map clears all cylinders and leg lines

---

## 13. Drag-and-Drop Reorder

**Steps:**
1. Have 3+ waypoints
2. Click and hold the 6-dot drag handle on a card
3. Drag up or down past another card
4. Release

**Expected:**
- 8px movement threshold before drag starts
- Dragged card gets lifted appearance (opacity, shadow)
- Colored insertion line shows drop position
- On drop, cards reorder
- Numbering updates (1, 2, 3...)
- Distances recalculate
- Map leg lines update

---

## 14. Load xctsk File

**Steps:**
1. Drop a `.xctsk` file onto the page (e.g., buje.xctsk)

**Expected:**
- Turnpoints appear in editor with correct types from file
- SSS turnpoints show "Start (SSS)" badge
- ESS turnpoints show "ESS" badge
- Intermediate turnpoints show "Turnpoint" badge
- Distances calculated and displayed
- Map shows all cylinders and leg lines

---

## 15. Load IGC File with Declared Task

**Steps:**
1. Drop an IGC file that contains a declared task

**Expected:**
- Task turnpoints appear with types inferred from IGC structure
- First point → "TAKEOFF" type
- Intermediate points → "TURNPOINT" type
- Last point → "GOAL" type
- Distances calculated

---

## 16. Score Tab Compatibility

**Steps:**
1. Load an IGC file with a task
2. Switch to Score tab
3. Switch back to Task tab

**Expected:**
- Score tab renders correctly with new type system
- Task tab preserves editor state
- No console errors

---

## 17. Radius Display Formatting

**Steps:**
1. Add waypoints with various radii

**Expected:**
- Radius < 1000m: shown in km with 2 decimals (e.g., "0.40 km")
- Radius >= 1000m: shown in km with 2 decimals (e.g., "5.00 km")

---

## 18. Search Close Behavior

**Steps:**
1. Open search via "+" → "Search database"
2. Press Escape or click the close button

**Expected:**
- Search input and results dismiss
- Returns to normal waypoint list view

---

## Playwright Automation Notes

- The sidebar can overlap with the map. Use `dispatchEvent(new MouseEvent('click', { bubbles: true }))` or the "Toggle panel" button to interact with sidebar elements when Playwright can't click them directly.
- For "Clear all" confirmation, use `document.querySelector('.te-clear-btn').click()` then after 50-100ms `document.querySelector('.te-confirm-yes').click()` — the 3s auto-revert timeout makes Playwright snapshot-based clicks unreliable.
- Tab switching: use `evaluate` to dispatch click events on tab elements if direct clicks are intercepted by the map overlay.
- File loading: use `fetch()` + `DataTransfer` + `DragEvent('drop')` dispatched on `document.querySelector('main')`.
