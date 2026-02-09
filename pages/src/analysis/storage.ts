/**
 * Browser storage service for tasks and tracks.
 * Backed by IndexedDB for capacity and performance.
 */

import type { XCTask, IGCFile } from '@taskscore/analysis';

const DB_NAME = 'taskscore';
const DB_VERSION = 1;
const TASKS_STORE = 'tasks';
const TRACKS_STORE = 'tracks';

export interface StoredTask {
  /** Unique identifier (XContest code) */
  id: string;
  /** Display name for command menu */
  name: string;
  /** The parsed XCTask object */
  task: XCTask;
  /** Original JSON source */
  rawJson: string;
  /** When the task was stored */
  storedAt: number;
  /** When the task was last accessed */
  lastAccessedAt: number;
}

export interface StoredTrack {
  /** Unique identifier (SHA-256 hash of content) */
  id: string;
  /** Display name for command menu */
  name: string;
  /** Original filename */
  filename: string;
  /** Raw IGC file content */
  content: string;
  /** Brief summary for search keywords */
  summary: {
    pilot?: string;
    glider?: string;
    date?: string;
  };
  /** When the track was stored */
  storedAt: number;
  /** When the track was last accessed */
  lastAccessedAt: number;
}

/**
 * Compute SHA-256 hash of content
 */
async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Derive a display name for a task
 */
function deriveTaskName(code: string, task: XCTask): string {
  // Try to find SSS turnpoint name
  const sss = task.turnpoints.find(tp => tp.type === 'SSS');
  if (sss?.waypoint.name && sss.waypoint.name !== 'SSS' && sss.waypoint.name.length > 2) {
    return `${sss.waypoint.name} (${code})`;
  }
  // Use first non-takeoff turnpoint
  const firstTp = task.turnpoints.find(tp => tp.type !== 'TAKEOFF');
  if (firstTp?.waypoint.name && firstTp.waypoint.name.length > 2) {
    return `${firstTp.waypoint.name} (${code})`;
  }
  return code.toUpperCase();
}

/**
 * Derive a display name for a track
 */
function deriveTrackName(filename: string, igcFile: IGCFile): string {
  const pilot = igcFile.header.pilot;
  const date = igcFile.header.date;

  if (pilot) {
    if (date) {
      const dateStr = date.toISOString().split('T')[0];
      return `${pilot} - ${dateStr}`;
    }
    return pilot;
  }
  return filename.replace(/\.igc$/i, '');
}

class StorageService {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;

  /**
   * Initialize the database connection.
   */
  async init(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        console.warn('IndexedDB not available - storage disabled');
        resolve();
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.error('Failed to open IndexedDB:', request.error);
        resolve(); // Resolve anyway - storage will be disabled
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Tasks store
        if (!db.objectStoreNames.contains(TASKS_STORE)) {
          const tasksStore = db.createObjectStore(TASKS_STORE, { keyPath: 'id' });
          tasksStore.createIndex('by-name', 'name', { unique: false });
          tasksStore.createIndex('by-stored', 'storedAt', { unique: false });
          tasksStore.createIndex('by-accessed', 'lastAccessedAt', { unique: false });
        }

        // Tracks store
        if (!db.objectStoreNames.contains(TRACKS_STORE)) {
          const tracksStore = db.createObjectStore(TRACKS_STORE, { keyPath: 'id' });
          tracksStore.createIndex('by-name', 'name', { unique: false });
          tracksStore.createIndex('by-stored', 'storedAt', { unique: false });
          tracksStore.createIndex('by-accessed', 'lastAccessedAt', { unique: false });
          tracksStore.createIndex('by-filename', 'filename', { unique: false });
        }
      };
    });

    return this.initPromise;
  }

  /**
   * Check if storage is available
   */
  isAvailable(): boolean {
    return this.db !== null;
  }

  // === Tasks ===

  /**
   * Store a task (upsert - updates if exists).
   */
  async storeTask(code: string, task: XCTask, rawJson: string): Promise<void> {
    await this.init();
    if (!this.db) return;

    const now = Date.now();
    const stored: StoredTask = {
      id: code.toLowerCase(),
      name: deriveTaskName(code, task),
      task,
      rawJson,
      storedAt: now,
      lastAccessedAt: now,
    };

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(TASKS_STORE, 'readwrite');
      const store = tx.objectStore(TASKS_STORE);

      // Check if task exists to preserve storedAt
      const getReq = store.get(stored.id);
      getReq.onsuccess = () => {
        const existing = getReq.result as StoredTask | undefined;
        if (existing) {
          stored.storedAt = existing.storedAt;
        }
        const putReq = store.put(stored);
        putReq.onerror = () => reject(putReq.error);
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Get a stored task by code.
   */
  async getTask(code: string): Promise<StoredTask | null> {
    await this.init();
    if (!this.db) return null;

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(TASKS_STORE, 'readonly');
      const store = tx.objectStore(TASKS_STORE);
      const request = store.get(code.toLowerCase());

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * List all stored tasks, ordered by most recently accessed.
   */
  async listTasks(): Promise<StoredTask[]> {
    await this.init();
    if (!this.db) return [];

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(TASKS_STORE, 'readonly');
      const store = tx.objectStore(TASKS_STORE);
      const index = store.index('by-accessed');
      const request = index.openCursor(null, 'prev'); // Descending order

      const results: StoredTask[] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Update last accessed timestamp for a task.
   */
  async touchTask(code: string): Promise<void> {
    await this.init();
    if (!this.db) return;

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(TASKS_STORE, 'readwrite');
      const store = tx.objectStore(TASKS_STORE);
      const request = store.get(code.toLowerCase());

      request.onsuccess = () => {
        const task = request.result as StoredTask | undefined;
        if (task) {
          task.lastAccessedAt = Date.now();
          store.put(task);
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // === Tracks ===

  /**
   * Store a track (upsert by content hash).
   * Returns the track ID.
   */
  async storeTrack(filename: string, content: string, igcFile: IGCFile): Promise<string> {
    await this.init();
    const id = await hashContent(content);
    if (!this.db) return id;

    const now = Date.now();
    const stored: StoredTrack = {
      id,
      name: deriveTrackName(filename, igcFile),
      filename,
      content,
      summary: {
        pilot: igcFile.header.pilot,
        glider: igcFile.header.gliderType,
        date: igcFile.header.date?.toISOString().split('T')[0],
      },
      storedAt: now,
      lastAccessedAt: now,
    };

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(TRACKS_STORE, 'readwrite');
      const store = tx.objectStore(TRACKS_STORE);

      // Check if track exists to preserve storedAt
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const existing = getReq.result as StoredTrack | undefined;
        if (existing) {
          stored.storedAt = existing.storedAt;
        }
        const putReq = store.put(stored);
        putReq.onerror = () => reject(putReq.error);
      };

      tx.oncomplete = () => resolve(id);
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Get a stored track by ID.
   */
  async getTrack(id: string): Promise<StoredTrack | null> {
    await this.init();
    if (!this.db) return null;

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(TRACKS_STORE, 'readonly');
      const store = tx.objectStore(TRACKS_STORE);
      const request = store.get(id);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * List all stored tracks, ordered by most recently accessed.
   */
  async listTracks(): Promise<StoredTrack[]> {
    await this.init();
    if (!this.db) return [];

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(TRACKS_STORE, 'readonly');
      const store = tx.objectStore(TRACKS_STORE);
      const index = store.index('by-accessed');
      const request = index.openCursor(null, 'prev'); // Descending order

      const results: StoredTrack[] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Update last accessed timestamp for a track.
   */
  async touchTrack(id: string): Promise<void> {
    await this.init();
    if (!this.db) return;

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(TRACKS_STORE, 'readwrite');
      const store = tx.objectStore(TRACKS_STORE);
      const request = store.get(id);

      request.onsuccess = () => {
        const track = request.result as StoredTrack | undefined;
        if (track) {
          track.lastAccessedAt = Date.now();
          store.put(track);
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // === Clear Operations ===

  /**
   * Clear all stored tasks.
   */
  async clearAllTasks(): Promise<void> {
    await this.init();
    if (!this.db) return;

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(TASKS_STORE, 'readwrite');
      const store = tx.objectStore(TASKS_STORE);
      const request = store.clear();

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Clear all stored tracks.
   */
  async clearAllTracks(): Promise<void> {
    await this.init();
    if (!this.db) return;

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(TRACKS_STORE, 'readwrite');
      const store = tx.objectStore(TRACKS_STORE);
      const request = store.clear();

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Clear all stored tasks and tracks.
   */
  async clearAll(): Promise<void> {
    await Promise.all([
      this.clearAllTasks(),
      this.clearAllTracks(),
    ]);
  }

  // === Utilities ===

  /**
   * Get storage statistics.
   */
  async getStats(): Promise<{ taskCount: number; trackCount: number }> {
    await this.init();
    if (!this.db) return { taskCount: 0, trackCount: 0 };

    const taskCount = await this.getCount(TASKS_STORE);
    const trackCount = await this.getCount(TRACKS_STORE);

    return { taskCount, trackCount };
  }

  private getCount(storeName: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.count();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}

export const storage = new StorageService();
