/**
 * One-time IndexedDB → server migration for tracks and tasks.
 *
 * Runs once per device, only when the user is signed in. Reads the legacy
 * `glidecomp` IndexedDB at v2 (the version active before this change) and
 * uploads the rows it finds to the new `/api/user/...` endpoints. Annotations
 * had no track association in the legacy schema so they're dropped with a
 * console warning.
 *
 * After a successful pass we set `localStorage["glidecomp:user-files-migrated"]`
 * so subsequent loads don't even open the legacy DB. The storage layer's own
 * v3 upgrade (in analysis/storage.ts) then drops the stale stores.
 */

const MIGRATED_FLAG = 'glidecomp:user-files-migrated';
const LEGACY_DB_NAME = 'glidecomp';
const LEGACY_DB_VERSION = 2;
const TRACKS_STORE = 'tracks';
const TASKS_STORE = 'tasks';
const ANNOTATIONS_STORE = 'annotations';

interface LegacyTrack {
  id: string;
  filename: string;
  content: string;
}

interface LegacyTask {
  id: string;
  rawJson: string;
}

/**
 * Resolve when the legacy DB is open. Resolves with `null` if IndexedDB isn't
 * available, the DB doesn't exist, or the read times out.
 */
function openLegacy(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    const req = indexedDB.open(LEGACY_DB_NAME, LEGACY_DB_VERSION);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      // First-time visitors hit onupgradeneeded with the empty DB. There's
      // nothing to migrate, so let the transaction complete and the DB will
      // be cleaned up by storage.ts's v3 upgrade later.
    };
  });
}

function readAll<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve) => {
    if (!db.objectStoreNames.contains(storeName)) return resolve([]);
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result as T[]) ?? []);
    req.onerror = () => resolve([]);
  });
}

async function gzipBlob(text: string): Promise<Blob> {
  const stream = new Blob([text]).stream().pipeThrough(
    new CompressionStream('gzip')
  );
  return new Response(stream).blob();
}

async function uploadTrack(track: LegacyTrack): Promise<void> {
  const gz = await gzipBlob(track.content);
  const res = await fetch('/api/user/tracks', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'gzip',
      'x-filename': track.filename,
    },
    body: gz,
  });
  if (!res.ok) {
    throw new Error(`Track upload failed: HTTP ${res.status}`);
  }
}

async function uploadTask(task: LegacyTask): Promise<void> {
  let xctsk: unknown;
  try {
    xctsk = JSON.parse(task.rawJson);
  } catch {
    throw new Error('Malformed legacy task JSON');
  }
  const res = await fetch('/api/user/tasks', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_code: task.id.toLowerCase(), xctsk }),
  });
  if (!res.ok) {
    throw new Error(`Task upload failed: HTTP ${res.status}`);
  }
}

/**
 * Run the one-time migration. No-op if already done. Safe to call on every
 * page load — the localStorage flag and DB existence check short-circuit.
 */
export async function runUserFilesMigration(): Promise<void> {
  if (typeof window === 'undefined') return;
  if (localStorage.getItem(MIGRATED_FLAG) === '1') return;

  const db = await openLegacy();
  if (!db) {
    localStorage.setItem(MIGRATED_FLAG, '1');
    return;
  }

  try {
    const [tracks, tasks, annotations] = await Promise.all([
      readAll<LegacyTrack>(db, TRACKS_STORE),
      readAll<LegacyTask>(db, TASKS_STORE),
      readAll<unknown>(db, ANNOTATIONS_STORE),
    ]);

    // Annotations had no track association in the legacy schema. We can't
    // attach them to anything sensible, so we drop them with a heads-up.
    if (annotations.length > 0) {
      console.warn(
        `[user-files-migration] Dropping ${annotations.length} legacy annotation stroke(s) — they were not associated with a track and cannot be migrated.`
      );
    }

    if (tracks.length === 0 && tasks.length === 0) {
      localStorage.setItem(MIGRATED_FLAG, '1');
      return;
    }

    let trackOk = 0;
    let taskOk = 0;
    const errors: string[] = [];

    // Serialise so we don't blow through quotas in parallel — the server's
    // per-user idempotency also makes ordering deterministic.
    for (const track of tracks) {
      try {
        await uploadTrack(track);
        trackOk++;
      } catch (err) {
        errors.push(`track ${track.id.slice(0, 8)}: ${(err as Error).message}`);
      }
    }
    for (const task of tasks) {
      try {
        await uploadTask(task);
        taskOk++;
      } catch (err) {
        errors.push(`task ${task.id}: ${(err as Error).message}`);
      }
    }

    if (errors.length > 0) {
      console.warn(
        `[user-files-migration] Migrated ${trackOk}/${tracks.length} tracks, ${taskOk}/${tasks.length} tasks. Failures:\n${errors.join('\n')}`
      );
    } else if (trackOk + taskOk > 0) {
      console.info(
        `[user-files-migration] Migrated ${trackOk} track(s) and ${taskOk} task(s) to the cloud.`
      );
    }

    // Mark complete only if at least the run finished. Tracks that hit a
    // quota cap stay in IndexedDB until the user clears the localStorage flag;
    // a follow-up release can offer a "retry migration" UI if needed.
    localStorage.setItem(MIGRATED_FLAG, '1');
  } finally {
    db.close();
  }
}
