# Task Management & Matching Feature Specification

> **Status:** Pending - Waiting on authentication implementation

## Overview

Build a task management system that allows users to onboard competition tasks with metadata, then match those tasks to loaded tracks.

## Problem Statement

When loading a track (IGC file), we need to find matching task files (.xctask). Challenges include:
1. Multiple competitions run concurrently (floater vs open class)
2. Task files from xcontest don't contain date information
3. The declared task in an IGC file may not exactly match any task file
4. Floater and open class tasks have identical turnpoints but different radii

## Current State

- **Frontend only** - No backend workers or D1 database yet (workers/ directory is empty)
- **Command menu exists** - Uses native `<dialog>` with Basecoat styling
- **No authentication** - Needs to be implemented first
- **Task files** - Currently loaded from static `/data/tasks/` or fetched from xcontest.org

## Prerequisites

- [ ] Implement secure authentication on Cloudflare (separate spec needed)
- [ ] Set up D1 database
- [ ] Create API Worker infrastructure

---

## Scope

### Phase 1: Backend Foundation
1. Create D1 database schema for tasks
2. Create API Worker with CRUD endpoints
3. Integrate with authentication system

### Phase 2: Task Creation UI
1. Add "Create Task" command menu action
2. Build task creation dialog with form fields
3. Integrate with API to persist tasks

### Phase 3: Task Matching
1. Load tasks from D1 when loading a track
2. Match by date, start location, and turnpoint sequence
3. Present selection UI for multiple matches

---

## Phase 1: Backend Foundation

### D1 Database Schema

```sql
-- Tasks table with user-entered metadata
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_name TEXT NOT NULL,
  task_name TEXT NOT NULL,
  task_date TEXT NOT NULL,           -- ISO date: "2026-01-05"
  xcontest_code TEXT NOT NULL,       -- e.g., "zenu", "face"
  task_data TEXT NOT NULL,           -- Full XCTask JSON
  created_by TEXT,                   -- User identifier (from auth system)
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(xcontest_code)              -- Prevent duplicate task codes
);

-- Index for date-based queries
CREATE INDEX idx_tasks_date ON tasks(task_date);
```

### API Worker Endpoints

**File: `/workers/api/src/index.ts`**

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/tasks` | No | List all tasks (with optional date filter) |
| GET | `/api/tasks/:id` | No | Get single task with full data |
| POST | `/api/tasks` | Yes | Create new task |
| DELETE | `/api/tasks/:id` | Yes | Delete task (admin only) |

**Request/Response Examples:**

```typescript
// POST /api/tasks
// Request:
{
  "competition_name": "Corryong Cup 2026",
  "task_name": "Day 1 - Open Class",
  "task_date": "2026-01-05",
  "xcontest_code": "zenu"
}

// Response:
{
  "id": 1,
  "competition_name": "Corryong Cup 2026",
  "task_name": "Day 1 - Open Class",
  "task_date": "2026-01-05",
  "xcontest_code": "zenu",
  "task_data": { /* full XCTask JSON fetched from xcontest */ },
  "created_at": "2026-01-05T10:30:00Z"
}
```

---

## Phase 2: Task Creation UI

### Command Menu Addition

**File: `/pages/src/analysis.html`**

Add menu item in the command menu:
```html
<div role="menuitem" id="menu-create-task" data-keywords="create add new task competition">
  <svg><!-- Plus icon --></svg>
  <span>Create Task</span>
</div>
```

### Task Creation Dialog

```html
<dialog id="create-task-dialog" class="command-dialog" onclick="if (event.target === this) this.close()">
  <div class="p-6 bg-background rounded-lg shadow-lg max-w-md w-full">
    <h2 class="text-lg font-semibold mb-4">Create Task</h2>

    <form id="create-task-form" class="space-y-4">
      <div>
        <label class="block text-sm font-medium mb-1" for="competition-name">Competition Name</label>
        <input type="text" id="competition-name" class="input w-full"
               placeholder="e.g., Corryong Cup 2026" required>
      </div>

      <div>
        <label class="block text-sm font-medium mb-1" for="task-name">Task Name</label>
        <input type="text" id="task-name" class="input w-full"
               placeholder="e.g., Day 1 - Open Class" required>
      </div>

      <div>
        <label class="block text-sm font-medium mb-1" for="task-date">Task Date</label>
        <input type="date" id="task-date" class="input w-full" required>
      </div>

      <div>
        <label class="block text-sm font-medium mb-1" for="xcontest-code">XContest Task Code</label>
        <input type="text" id="xcontest-code" class="input w-full"
               placeholder="e.g., zenu, face" required>
      </div>

      <div class="flex justify-end gap-2 pt-4">
        <button type="button" class="btn btn-secondary" onclick="this.closest('dialog').close()">
          Cancel
        </button>
        <button type="submit" class="btn btn-primary">
          Create Task
        </button>
      </div>
    </form>

    <div id="create-task-status" class="mt-4 hidden"></div>
  </div>
</dialog>
```

### Form Handler

**File: `/pages/src/analysis/main.ts`**

```typescript
const createTaskDialog = document.getElementById('create-task-dialog') as HTMLDialogElement;
const createTaskForm = document.getElementById('create-task-form') as HTMLFormElement;
const createTaskStatus = document.getElementById('create-task-status') as HTMLDivElement;

// Open dialog from command menu
document.getElementById('menu-create-task')?.addEventListener('click', () => {
  commandDialog?.close();
  createTaskDialog?.showModal();
});

// Handle form submission
createTaskForm?.addEventListener('submit', async (e) => {
  e.preventDefault();

  const formData = {
    competition_name: (document.getElementById('competition-name') as HTMLInputElement).value,
    task_name: (document.getElementById('task-name') as HTMLInputElement).value,
    task_date: (document.getElementById('task-date') as HTMLInputElement).value,
    xcontest_code: (document.getElementById('xcontest-code') as HTMLInputElement).value,
  };

  try {
    createTaskStatus.className = 'mt-4 alert';
    createTaskStatus.textContent = 'Creating task...';

    const response = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formData),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to create task');
    }

    const task = await response.json();
    createTaskStatus.className = 'mt-4 alert alert-success';
    createTaskStatus.textContent = `Task created: ${task.task_name}`;

    // Reset form and close after delay
    createTaskForm.reset();
    setTimeout(() => createTaskDialog?.close(), 1500);

  } catch (error) {
    createTaskStatus.className = 'mt-4 alert alert-destructive';
    createTaskStatus.textContent = error instanceof Error ? error.message : 'Failed to create task';
  }
});
```

---

## Phase 3: Task Matching

### Matching Algorithm

**File: `/pages/src/analysis/task-matcher.ts`**

```typescript
import { haversineDistance } from './geo';
import type { IGCFile, IGCTask } from './igc-parser';
import type { XCTask } from './xctsk-parser';

export interface StoredTask {
  id: number;
  competition_name: string;
  task_name: string;
  task_date: string;
  xcontest_code: string;
  task_data: XCTask;
}

export interface TaskMatch {
  task: StoredTask;
  confidence: 'exact' | 'partial' | 'date-only';
  matchedTurnpoints: number;
  totalTurnpoints: number;
}

export async function findMatchingTasks(igcFile: IGCFile): Promise<TaskMatch[]> {
  // 1. Get flight date from IGC header
  const flightDate = igcFile.header.flightDate?.toISOString().split('T')[0];

  // 2. Fetch tasks from API (optionally filtered by date)
  const url = flightDate ? `/api/tasks?date=${flightDate}` : '/api/tasks';
  const response = await fetch(url);
  const tasks: StoredTask[] = await response.json();

  if (!igcFile.task) {
    // No declared task - return all tasks for the date
    return tasks.map(t => ({
      task: t,
      confidence: 'date-only',
      matchedTurnpoints: 0,
      totalTurnpoints: 0,
    }));
  }

  // 3. Score each task by turnpoint match
  return tasks
    .map(t => scoreTaskMatch(t, igcFile.task!))
    .filter(m => m.matchedTurnpoints > 0)
    .sort((a, b) => b.matchedTurnpoints - a.matchedTurnpoints);
}

function scoreTaskMatch(stored: StoredTask, igcTask: IGCTask): TaskMatch {
  const task = stored.task_data;
  let matched = 0;

  // Compare start location
  const taskSSS = task.turnpoints.find(tp => tp.type === 'SSS');
  if (taskSSS && igcTask.start) {
    const dist = haversineDistance(
      taskSSS.waypoint.lat, taskSSS.waypoint.lon,
      igcTask.start.latitude, igcTask.start.longitude
    );
    if (dist < 500) matched++;
  }

  // Compare intermediate turnpoints
  const taskTPs = task.turnpoints.filter(tp => !tp.type);
  for (const igcTP of igcTask.turnpoints) {
    for (const taskTP of taskTPs) {
      const dist = haversineDistance(
        taskTP.waypoint.lat, taskTP.waypoint.lon,
        igcTP.latitude, igcTP.longitude
      );
      if (dist < 500) {
        matched++;
        break;
      }
    }
  }

  // Compare finish location
  const taskESS = task.turnpoints.find(tp => tp.type === 'ESS');
  if (taskESS && igcTask.finish) {
    const dist = haversineDistance(
      taskESS.waypoint.lat, taskESS.waypoint.lon,
      igcTask.finish.latitude, igcTask.finish.longitude
    );
    if (dist < 500) matched++;
  }

  const total = 2 + igcTask.turnpoints.length; // start + finish + turnpoints

  return {
    task: stored,
    confidence: matched === total ? 'exact' : matched > 0 ? 'partial' : 'date-only',
    matchedTurnpoints: matched,
    totalTurnpoints: total,
  };
}
```

### Task Selection UI

When multiple tasks match, show a selection dialog:

```html
<dialog id="select-task-dialog" class="command-dialog">
  <div class="p-6 bg-background rounded-lg shadow-lg max-w-lg w-full">
    <h2 class="text-lg font-semibold mb-4">Select Task</h2>
    <p class="text-muted-foreground mb-4">Multiple tasks match this flight. Please select one:</p>

    <div id="task-options" class="space-y-2 max-h-64 overflow-y-auto">
      <!-- Dynamically populated with task cards showing:
           - Competition name + task name
           - Turnpoint sequence (e.g., "ELLIOT → TOWONG → ELLITP → KHANCO")
           - Match confidence indicator
           - Cylinder radii summary (helps distinguish floater vs open)
      -->
    </div>
  </div>
</dialog>
```

---

## Files to Create/Modify

### New Files
| File | Purpose |
|------|---------|
| `/workers/api/src/index.ts` | API Worker with task endpoints |
| `/workers/api/wrangler.toml` | Worker configuration |
| `/schema.sql` | D1 database schema |
| `/pages/src/analysis/task-matcher.ts` | Task matching logic |

### Modified Files
| File | Changes |
|------|---------|
| `/pages/src/analysis.html` | Add "Create Task" menu item, dialogs |
| `/pages/src/analysis/main.ts` | Add dialog handlers, task matching flow |
| `/wrangler.toml` | Add D1 binding configuration |

---

## Verification Steps

1. **Database setup**: Run `wrangler d1 execute taskscore --file=schema.sql`
2. **Worker deployment**: Run `wrangler deploy` in workers/api
3. **Create task**: Use command menu → Create Task → fill form
4. **Verify storage**: Check D1 database has the task
5. **Load track**: Load an IGC file and verify matching tasks appear
6. **Run tests**: `bun run test`

---

## Future Enhancements

- **Manual waypoint selection** - Allow creating tasks by selecting waypoints from a waypoints file instead of xcontest code
- **Task editing** - Allow modifying task metadata after creation
- **Offline support** - Cache tasks in localStorage for offline use
- **Migrate static tasks** - Option to import existing `/data/tasks/*.xctask` files into D1
