# Browser Storage Specification

## Overview

This specification defines a browser-based storage layer for persisting XContest tasks and IGC tracks locally. The storage layer provides a "filesystem-like" experience using web browser storage APIs, allowing users to build a personal library of tasks and flights without requiring server-side accounts.

## Goals

1. **Persist XContest tasks** - When a user imports a task by code, store it for future access
2. **Persist IGC tracks** - When a user opens/drops an IGC file, store it for future access
3. **Command menu integration** - Show stored items in dedicated groups ("Stored Tasks", "Stored Tracks")
4. **Transparent loading** - Selecting a stored item should behave identically to loading fresh from source

## Out of Scope (Future Work)

- Clearing individual items from storage
- Clearing all storage (delete all stored tasks and tracks from browser)
- Downloading stored files back to user's computer
- Syncing between devices
- Storage quota management UI

## Storage Technology

### Comparison

| Technology | Max Size | Structure | Async | Browser Support |
|------------|----------|-----------|-------|-----------------|
| localStorage | ~5MB | Key-Value | No | Universal |
| IndexedDB | 50MB-unlimited | Object Store | Yes | Universal |
| OPFS | 50MB-unlimited | File System | Yes | Modern only |

### Decision: IndexedDB

**Rationale:**
- IGC files range from 50KB-500KB each; localStorage's 5MB limit would only hold ~10-50 flights
- IndexedDB supports structured queries (e.g., list all tracks, find by name)
- IndexedDB has universal browser support (unlike OPFS)
- Async API prevents UI blocking when loading large track libraries
- Follows pattern of modern web apps (Google Docs offline, etc.)

## Data Model

### Stored Task

```typescript
interface StoredTask {
  /** Unique identifier (XContest code) */
  id: string;

  /** Display name for command menu */
  name: string;

  /** The parsed XCTask object */
  task: XCTask;

  /** Original JSON source (for debugging/export) */
  rawJson: string;

  /** When the task was stored */
  storedAt: number; // Unix timestamp

  /** When the task was last accessed */
  lastAccessedAt: number;
}
```

### Stored Track

```typescript
interface StoredTrack {
  /** Unique identifier (SHA-256 hash of file content) */
  id: string;

  /** Display name for command menu (pilot name, date, or filename) */
  name: string;

  /** Original filename */
  filename: string;

  /** Raw IGC file content (for re-parsing) */
  content: string;

  /** Brief summary for search keywords */
  summary: {
    pilot?: string;
    glider?: string;
    date?: string;
    location?: string; // Could be derived from takeoff coordinates
  };

  /** When the track was stored */
  storedAt: number;

  /** When the track was last accessed */
  lastAccessedAt: number;
}
```

### Why Store Raw Content?

For tracks, we store the raw IGC content rather than parsed `IGCFile` objects because:
1. **Parser updates** - Re-parsing ensures tracks benefit from parser improvements
2. **Smaller storage** - Raw text often compresses better than parsed objects with redundant fields
3. **Consistency** - Loading from storage behaves identically to loading a fresh file

For tasks, we store both `rawJson` and parsed `task` because:
1. **Offline availability** - No need to re-fetch from XContest
2. **Fast loading** - Skip network request entirely
3. **Raw for debugging** - Original response preserved if needed

## IndexedDB Schema

### Database: `taskscore`

### Object Stores

```
taskscore (database)
├── tasks (object store)
│   ├── keyPath: "id"
│   └── indexes:
│       ├── by-name (name field, non-unique)
│       └── by-stored (storedAt field)
└── tracks (object store)
    ├── keyPath: "id"
    └── indexes:
        ├── by-name (name field, non-unique)
        ├── by-stored (storedAt field)
        └── by-filename (filename field, non-unique)
```

## Storage Service API

### Location: `pages/src/analysis/storage.ts`

```typescript
/**
 * Browser storage service for tasks and tracks.
 * Backed by IndexedDB for capacity and performance.
 */
class StorageService {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;

  /**
   * Initialize the database connection.
   * Called automatically on first operation.
   */
  async init(): Promise<void>;

  // === Tasks ===

  /**
   * Store a task (upsert - updates if exists).
   * @param code XContest task code (used as ID)
   * @param task Parsed XCTask object
   * @param rawJson Original JSON response
   */
  async storeTask(code: string, task: XCTask, rawJson: string): Promise<void>;

  /**
   * Get a stored task by code.
   * @returns StoredTask or null if not found
   */
  async getTask(code: string): Promise<StoredTask | null>;

  /**
   * List all stored tasks, ordered by most recently accessed.
   */
  async listTasks(): Promise<StoredTask[]>;

  /**
   * Update last accessed timestamp for a task.
   */
  async touchTask(code: string): Promise<void>;

  // === Tracks ===

  /**
   * Store a track (upsert by content hash).
   * @param filename Original filename
   * @param content Raw IGC file content
   * @param igcFile Parsed IGCFile (for extracting metadata)
   */
  async storeTrack(filename: string, content: string, igcFile: IGCFile): Promise<string>; // Returns ID

  /**
   * Get a stored track by ID.
   */
  async getTrack(id: string): Promise<StoredTrack | null>;

  /**
   * List all stored tracks, ordered by most recently accessed.
   */
  async listTracks(): Promise<StoredTrack[]>;

  /**
   * Update last accessed timestamp for a track.
   */
  async touchTrack(id: string): Promise<void>;

  // === Utilities ===

  /**
   * Get storage statistics.
   */
  async getStats(): Promise<{ taskCount: number; trackCount: number }>;
}

export const storage = new StorageService();
```

### Content Hashing

Track IDs are computed using SHA-256 hash of the file content:

```typescript
async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
```

This ensures:
- Same file dropped twice doesn't create duplicates
- Files can be identified regardless of filename

## Command Menu Integration

### New Menu Groups

Add two new groups to the command menu after "Sample Flights":

```html
<!-- Stored Tasks (dynamically populated) -->
<hr role="separator" id="stored-tasks-separator" class="hidden">
<div role="group" aria-labelledby="stored-tasks-heading" id="stored-tasks-group" class="hidden">
    <div role="heading" id="stored-tasks-heading">Stored Tasks</div>
    <!-- Items inserted dynamically -->
</div>

<!-- Stored Tracks (dynamically populated) -->
<hr role="separator" id="stored-tracks-separator" class="hidden">
<div role="group" aria-labelledby="stored-tracks-heading" id="stored-tracks-group" class="hidden">
    <div role="heading" id="stored-tracks-heading">Stored Tracks</div>
    <!-- Items inserted dynamically -->
</div>
```

### Dynamic Menu Item Generation

```typescript
function createTaskMenuItem(task: StoredTask): HTMLElement {
  const item = document.createElement('div');
  item.setAttribute('role', 'menuitem');
  item.id = `stored-task-${task.id}`;
  item.dataset.keywords = `stored task ${task.name} ${task.id}`;
  item.innerHTML = `
    <svg><!-- globe icon --></svg>
    <span>${escapeHtml(task.name)}</span>
    <span class="text-muted-foreground text-xs">${task.id}</span>
  `;
  return item;
}

function createTrackMenuItem(track: StoredTrack): HTMLElement {
  const item = document.createElement('div');
  item.setAttribute('role', 'menuitem');
  item.id = `stored-track-${track.id.slice(0, 8)}`; // Use first 8 chars of hash
  item.dataset.keywords = `stored track ${track.name} ${track.summary.pilot || ''} ${track.summary.glider || ''} ${track.filename}`;
  item.innerHTML = `
    <svg><!-- plane icon --></svg>
    <span>${escapeHtml(track.name)}</span>
    <span class="text-muted-foreground text-xs">${track.filename}</span>
  `;
  return item;
}
```

### Menu Refresh

```typescript
/**
 * Refresh stored items in command menu.
 * Called on init and after storing new items.
 */
async function refreshStoredMenuItems(): Promise<void> {
  const tasks = await storage.listTasks();
  const tracks = await storage.listTracks();

  const tasksGroup = document.getElementById('stored-tasks-group');
  const tasksSeparator = document.getElementById('stored-tasks-separator');
  const tracksGroup = document.getElementById('stored-tracks-group');
  const tracksSeparator = document.getElementById('stored-tracks-separator');

  // Clear existing items (keep heading)
  // Repopulate with current items
  // Show/hide groups based on content
  // Limit to most recent N items (e.g., 10) to keep menu manageable
}
```

### Menu Item Limits

To keep the command menu usable:
- Show at most **10 most recently accessed** tasks
- Show at most **10 most recently accessed** tracks
- Items are sorted by `lastAccessedAt` descending

## Integration Points

### When Storing Tasks

Modify `loadTask()` in `main.ts`:

```typescript
async function loadTask(code: string): Promise<void> {
  // First, check storage
  const stored = await storage.getTask(code);
  if (stored) {
    // Use stored task
    state.task = stored.task;
    await storage.touchTask(code); // Update last accessed
  } else {
    // Fetch from XContest
    const { task, rawJson } = await fetchTaskByCodeWithRaw(code);
    state.task = task;

    // Store for future use
    await storage.storeTask(code, task, rawJson);
    await refreshStoredMenuItems();
  }

  // ... rest of task loading logic
}
```

### When Storing Tracks

Modify `loadIGCFile()` in `main.ts`:

```typescript
async function loadIGCFile(file: File): Promise<void> {
  const content = await file.text();
  const igcFile = parseIGC(content);

  // Store for future use
  await storage.storeTrack(file.name, content, igcFile);
  await refreshStoredMenuItems();

  // ... rest of track loading logic
}
```

### Loading from Storage

```typescript
async function loadStoredTask(code: string): Promise<void> {
  const stored = await storage.getTask(code);
  if (!stored) {
    showAlert('Task not found in storage', 'error');
    return;
  }

  await storage.touchTask(code);
  state.task = stored.task;

  // ... same logic as loading fresh task
}

async function loadStoredTrack(id: string): Promise<void> {
  const stored = await storage.getTrack(id);
  if (!stored) {
    showAlert('Track not found in storage', 'error');
    return;
  }

  await storage.touchTrack(id);
  const igcFile = parseIGC(stored.content);

  // ... same logic as loading fresh IGC file
}
```

## Display Names

### Task Names

Derive from task data:
1. First turnpoint waypoint name (if meaningful)
2. Task code as fallback

```typescript
function deriveTaskName(code: string, task: XCTask): string {
  // Try to find SSS turnpoint name
  const sss = task.turnpoints.find(tp => tp.type === 'SSS');
  if (sss?.waypoint.name && sss.waypoint.name !== 'SSS') {
    return `${sss.waypoint.name} (${code})`;
  }
  return code.toUpperCase();
}
```

### Track Names

Derive from IGC metadata:
1. `${pilot} - ${date}` (if pilot exists)
2. `${filename}` (fallback)

```typescript
function deriveTrackName(filename: string, igcFile: IGCFile): string {
  const pilot = igcFile.pilot;
  const date = igcFile.date; // Already formatted as YYYY-MM-DD

  if (pilot) {
    return date ? `${pilot} - ${date}` : pilot;
  }
  return filename.replace(/\.igc$/i, '');
}
```

## Error Handling

### Storage Failures

Storage operations should be non-blocking and fail silently:

```typescript
try {
  await storage.storeTrack(file.name, content, igcFile);
} catch (error) {
  console.warn('Failed to store track:', error);
  // Continue without storing - don't block the user
}
```

### IndexedDB Unavailable

If IndexedDB is unavailable (rare, but possible in incognito modes):

```typescript
async init(): Promise<void> {
  if (!window.indexedDB) {
    console.warn('IndexedDB not available - storage disabled');
    return;
  }
  // ... normal init
}
```

All list operations return empty arrays, get operations return null, store operations are no-ops.

## File Structure

```
pages/src/analysis/
├── storage.ts          # StorageService class and exports
├── storage-menu.ts     # Command menu integration helpers
└── main.ts             # Modified to use storage
```

## Migration Path

### From No Storage

First time user:
1. IndexedDB database created on first use
2. Empty storage, no menu items
3. Items accumulate as user imports tasks/tracks

### Future Enhancements

Storage management features to implement:
1. Add `deleteTask(code)` and `deleteTrack(id)` methods for individual deletion
2. Add UI for clearing all storage (methods already exist: `clearAllTasks()`, `clearAllTracks()`, `clearAll()`)
3. Add storage quota indicator and management UI

## Testing

### Manual Testing

1. Import XContest task → verify appears in "Stored Tasks" group
2. Reload page → verify task still in "Stored Tasks"
3. Select stored task → verify loads correctly
4. Drop IGC file → verify appears in "Stored Tracks" group
5. Reload page → verify track still in "Stored Tracks"
6. Select stored track → verify loads correctly
7. Import same task/track again → verify no duplicate

### Automated Tests

```typescript
// tests/storage.test.ts
describe('StorageService', () => {
  // Use fake-indexeddb for Node.js testing

  it('stores and retrieves tasks', async () => { ... });
  it('stores and retrieves tracks', async () => { ... });
  it('deduplicates tracks by content hash', async () => { ... });
  it('updates lastAccessedAt on touch', async () => { ... });
  it('lists items in most-recently-accessed order', async () => { ... });
});
```

## Browser Compatibility

IndexedDB is supported in:
- Chrome 24+
- Firefox 16+
- Safari 10+
- Edge 12+

This covers effectively all browsers in current use.

## Security Considerations

1. **No sensitive data** - Only flight data and task definitions
2. **Same-origin policy** - IndexedDB is origin-scoped
3. **No cross-site access** - Data stays local to taskscore.shonky.info

## Implementation Status

All core features have been implemented:

### Completed
- [x] `storage.ts` with StorageService class
- [x] Store/get/list for tasks and tracks
- [x] Content hashing (SHA-256) for track deduplication
- [x] `loadTask()` checks storage first, stores fetched tasks
- [x] `loadIGCFile()` stores opened tracks
- [x] Dynamic "Stored Tasks" and "Stored Tracks" menu groups
- [x] Menu item generation with search keywords
- [x] Click handlers for loading stored items
- [x] Menu refresh on storage changes
- [x] `clearAllTasks()`, `clearAllTracks()`, `clearAll()` methods (for future UI)

### File Menu Commands

The File section of the command menu includes:
- **Load IGC file** - Opens file picker, stores track in browser storage
- **Load XContest task** - Prompts for task code, stores task in browser storage
- **Unload all (task & track)** - Clears current session (map/state), does NOT clear storage
