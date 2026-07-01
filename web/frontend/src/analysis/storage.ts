/**
 * User-file storage backed by the competition-api worker.
 *
 * Tracks and tasks moved from browser IndexedDB to R2 (tracks) and D1 (tasks)
 * via /api/user/* (own) and /api/u/:username/* (public-by-link reads).
 * Annotations are per-track and also server-backed.
 *
 * The legacy IndexedDB stores (`tracks`, `tasks`, `annotations`) are dropped
 * by `cleanupLegacyIndexedDb()`, called once after one-time migration runs
 * (see auth/user-files-migration.ts).
 *
 * Unauthenticated callers get a no-op surface: `list*` returns `[]`, `get*`
 * returns `null`, and `store*` throws `AuthRequiredError` so the analysis page
 * can fall back to in-memory loading without persisting anything.
 */

import type { XCTask, IGCFile } from '@glidecomp/engine';
import { parseXCTask } from '@glidecomp/engine';

export class AuthRequiredError extends Error {
  constructor() {
    super('Sign in required to store files');
    this.name = 'AuthRequiredError';
  }
}

/** Error thrown when an upload hits a per-user quota. */
export class QuotaExceededError extends Error {
  constructor(
    message: string,
    public readonly kind: 'tracks' | 'tasks' | 'bytes',
    public readonly limit: number
  ) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

// ── Public types ────────────────────────────────────────────────────────────

export interface StoredTask {
  /** Lowercased task code (XContest code, or filename slug for local files). */
  id: string;
  /** Display name for command menu / dashboard cards. */
  name: string;
  /** The parsed XCTask object. */
  task: XCTask;
  /** Original JSON source. */
  rawJson: string;
  /** ISO timestamp. */
  storedAt: number;
  /** ISO timestamp. */
  lastAccessedAt: number;
}

export interface StoredTrack {
  /** SHA-256 hex of file content. */
  id: string;
  /** Display name for command menu / dashboard cards. */
  name: string;
  /** Original filename. */
  filename: string;
  /** Raw IGC text (decompressed on read). */
  content: string;
  summary: {
    pilot?: string;
    glider?: string;
    date?: string;
  };
  storedAt: number;
  lastAccessedAt: number;
  /**
   * Number of bytes in R2 (gzipped). Useful for quota UI; clients can fall
   * back to `content.length` if absent (e.g. for not-yet-uploaded items).
   */
  fileSize?: number;
}

export interface AnnotationStroke {
  /** UUID generated client-side. */
  id: string;
  /** Geographic coordinates [lng, lat][] (clamped to valid ranges server-side). */
  points: [number, number][];
  timestamp: number;
  color: string;
  width: number;
}

// ── Internal types ──────────────────────────────────────────────────────────

interface ApiTrack {
  track_id: string;
  filename: string;
  display_name: string;
  pilot: string | null;
  glider: string | null;
  flight_date: string | null;
  file_size: number;
  stored_at: string;
  last_accessed_at: string;
}

interface ApiTask {
  task_code: string;
  display_name: string;
  xctsk?: unknown;
  stored_at: string;
  last_accessed_at: string;
}

interface ApiAnnotation {
  stroke_id: string;
  color: string;
  width: number;
  points: [number, number][];
  timestamp: number;
}

function parseIso(s: string): number {
  const t = Date.parse(s);
  return isNaN(t) ? 0 : t;
}

function apiTrackToStored(t: ApiTrack, content = ''): StoredTrack {
  return {
    id: t.track_id,
    name: t.display_name,
    filename: t.filename,
    content,
    summary: {
      pilot: t.pilot ?? undefined,
      glider: t.glider ?? undefined,
      date: t.flight_date ?? undefined,
    },
    storedAt: parseIso(t.stored_at),
    lastAccessedAt: parseIso(t.last_accessed_at),
    fileSize: t.file_size,
  };
}

function apiTaskToStored(t: ApiTask): StoredTask {
  const xctsk = t.xctsk as Record<string, unknown> | undefined;
  // The API always returns xctsk for GET-by-code; list endpoints omit it.
  const rawJson = xctsk ? JSON.stringify(xctsk) : '';
  let task: XCTask;
  try {
    task = xctsk ? parseXCTask(rawJson) : ({ turnpoints: [] } as unknown as XCTask);
  } catch {
    task = { turnpoints: [] } as unknown as XCTask;
  }
  return {
    id: t.task_code,
    name: t.display_name,
    task,
    rawJson,
    storedAt: parseIso(t.stored_at),
    lastAccessedAt: parseIso(t.last_accessed_at),
  };
}

async function gzipString(text: string): Promise<Blob> {
  const stream = new Blob([text]).stream().pipeThrough(
    new CompressionStream('gzip')
  );
  return new Response(stream).blob();
}

export async function gunzipResponse(res: Response): Promise<string> {
  // The /api/user endpoints return gzipped bodies with Content-Encoding: gzip;
  // most browsers auto-decompress when fetch sees that header. But some
  // dev-server proxies strip it, so we decompress defensively if the header
  // is still present after fetch resolves.
  const ce = res.headers.get('Content-Encoding');
  if (ce && ce.toLowerCase().includes('gzip')) {
    const stream = res.body!.pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }
  return res.text();
}

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    return data.error || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

interface QuotaErrorBody {
  error: string;
  quota?: { kind: 'tracks' | 'tasks' | 'bytes'; limit: number };
}

async function throwHttpError(res: Response): Promise<never> {
  let body: QuotaErrorBody = { error: `HTTP ${res.status}` };
  try {
    body = (await res.json()) as QuotaErrorBody;
  } catch {
    /* non-JSON body */
  }
  if (body.quota) {
    throw new QuotaExceededError(body.error, body.quota.kind, body.quota.limit);
  }
  throw new Error(body.error || `HTTP ${res.status}`);
}

// ── IndexedDB (annotations bootstrap + legacy cleanup) ──────────────────────

const LEGACY_DB_NAME = 'glidecomp';
const LEGACY_DB_VERSION = 3;
const LEGACY_TASKS_STORE = 'tasks';
const LEGACY_TRACKS_STORE = 'tracks';
const LEGACY_ANNOTATIONS_STORE = 'annotations';

/**
 * Open the IndexedDB at v3 and drop the legacy stores if they still exist.
 * Resolves immediately on browsers without IndexedDB (storage just stays
 * server-only). Idempotent.
 */
async function cleanupLegacyIndexedDb(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve) => {
    const req = indexedDB.open(LEGACY_DB_NAME, LEGACY_DB_VERSION);
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      for (const name of [
        LEGACY_TASKS_STORE,
        LEGACY_TRACKS_STORE,
        LEGACY_ANNOTATIONS_STORE,
      ]) {
        if (db.objectStoreNames.contains(name)) {
          db.deleteObjectStore(name);
        }
      }
    };
  });
}

// ── Storage service ─────────────────────────────────────────────────────────

interface Session {
  signedIn: boolean;
  username: string | null;
}

class StorageService {
  /** When non-null, list/get operate against /api/u/:username/ instead of /api/user/. */
  private publicUsername: string | null = null;
  private session: Session | null = null;
  private trackContentCache = new Map<string, string>();
  private initPromise: Promise<void> | null = null;

  /**
   * Initialise — resolves the current session and triggers legacy IndexedDB
   * cleanup. Idempotent and safe to call multiple times.
   */
  async init(): Promise<void> {
    if (this.session !== null) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      try {
        const res = await fetch('/api/auth/me', { credentials: 'include' });
        if (res.ok) {
          const data = (await res.json()) as {
            user: { username: string | null } | null;
          };
          this.session = {
            signedIn: !!data.user,
            username: data.user?.username ?? null,
          };
        } else {
          this.session = { signedIn: false, username: null };
        }
      } catch {
        this.session = { signedIn: false, username: null };
      }
      await cleanupLegacyIndexedDb();
    })();
    return this.initPromise;
  }

  /** Compatibility shim — there's no longer a DB handle to close. */
  close(): void {
    // No-op. Kept so callers (e.g. dashboard.ts delete-account flow) compile.
  }

  /**
   * Browser-storage availability is now "is the user signed in" — anonymous
   * users get in-memory analysis only.
   */
  isAvailable(): boolean {
    return this.session?.signedIn ?? false;
  }

  /**
   * Switch to public-link mode: subsequent get/list calls resolve against
   * `/api/u/:username/`. Pass `null` to switch back to the caller's own files.
   */
  setPublicNamespace(username: string | null): void {
    this.publicUsername = username;
    // Public-mode reads belong to a different owner — bust the per-id cache
    // to avoid mixing content between namespaces.
    this.trackContentCache.clear();
  }

  /** True when the caller is viewing someone else's files. */
  isPublicMode(): boolean {
    return this.publicUsername !== null;
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────

  async storeTask(code: string, _task: XCTask, rawJson: string): Promise<void> {
    await this.init();
    if (!this.session?.signedIn) throw new AuthRequiredError();
    if (this.publicUsername) throw new Error('Cannot upload in public-link mode');

    let xctsk: unknown;
    try {
      xctsk = JSON.parse(rawJson);
    } catch {
      throw new Error('Invalid task JSON');
    }
    const res = await fetch('/api/user/tasks', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_code: code.toLowerCase(), xctsk }),
    });
    if (!res.ok) await throwHttpError(res);
  }

  async getTask(code: string): Promise<StoredTask | null> {
    await this.init();
    if (!this.session?.signedIn && !this.publicUsername) return null;
    const url = this.publicUsername
      ? `/api/u/${encodeURIComponent(this.publicUsername)}/task/${encodeURIComponent(code.toLowerCase())}`
      : `/api/user/tasks/${encodeURIComponent(code.toLowerCase())}`;
    const res = await fetch(url, { credentials: 'include' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(await readError(res));
    const body = (await res.json()) as ApiTask;
    return apiTaskToStored(body);
  }

  async listTasks(): Promise<StoredTask[]> {
    await this.init();
    if (!this.session?.signedIn || this.publicUsername) return [];
    const res = await fetch('/api/user/tasks', { credentials: 'include' });
    if (!res.ok) return [];
    const body = (await res.json()) as { tasks: ApiTask[] };
    return body.tasks.map(apiTaskToStored);
  }

  async touchTask(_code: string): Promise<void> {
    // No-op: GET bumps last_accessed_at on the server. Kept for API compat.
  }

  async deleteTask(code: string): Promise<void> {
    await this.init();
    if (!this.session?.signedIn) return;
    if (this.publicUsername) throw new Error('Cannot delete in public-link mode');
    const res = await fetch(
      `/api/user/tasks/${encodeURIComponent(code.toLowerCase())}`,
      { method: 'DELETE', credentials: 'include' }
    );
    if (!res.ok) throw new Error(await readError(res));
  }

  // ── Tracks ────────────────────────────────────────────────────────────────

  async storeTrack(
    filename: string,
    content: string,
    _igcFile: IGCFile
  ): Promise<string> {
    await this.init();
    if (!this.session?.signedIn) throw new AuthRequiredError();
    if (this.publicUsername) throw new Error('Cannot upload in public-link mode');

    const gz = await gzipString(content);
    const res = await fetch('/api/user/tracks', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'gzip',
        'x-filename': filename,
      },
      body: gz,
    });
    if (!res.ok) await throwHttpError(res);
    const body = (await res.json()) as ApiTrack;
    // Seed the cache so the very next getTrack() doesn't re-fetch.
    this.trackContentCache.set(body.track_id, content);
    return body.track_id;
  }

  async getTrack(id: string): Promise<StoredTrack | null> {
    await this.init();
    if (!this.session?.signedIn && !this.publicUsername) return null;

    // List endpoint already gave us metadata; per-track GET gives content.
    const url = this.publicUsername
      ? `/api/u/${encodeURIComponent(this.publicUsername)}/track/${encodeURIComponent(id)}`
      : `/api/user/tracks/${encodeURIComponent(id)}`;
    const res = await fetch(url, { credentials: 'include' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(await readError(res));

    const content =
      this.trackContentCache.get(id) ?? (await gunzipResponse(res));
    this.trackContentCache.set(id, content);

    // The download endpoint echoes display name + filename in custom headers
    // so callers don't need a second metadata round-trip. (CORS expose-headers
    // is set in the worker.) Fallbacks keep us safe if the proxy strips them.
    const displayName = res.headers.get('X-Display-Name') ?? '';
    const filename = res.headers.get('X-Filename') ?? `${id.slice(0, 8)}.igc`;
    return {
      id,
      name: displayName || filename.replace(/\.igc$/i, ''),
      filename,
      content,
      summary: {},
      storedAt: 0,
      lastAccessedAt: Date.now(),
    };
  }

  /**
   * Variant used by the dashboard download flow when the caller already has
   * the metadata row (from listTracks) and just needs raw content.
   */
  async getTrackContent(id: string): Promise<string | null> {
    await this.init();
    if (!this.session?.signedIn && !this.publicUsername) return null;
    if (this.trackContentCache.has(id)) {
      return this.trackContentCache.get(id) ?? null;
    }
    const url = this.publicUsername
      ? `/api/u/${encodeURIComponent(this.publicUsername)}/track/${encodeURIComponent(id)}`
      : `/api/user/tracks/${encodeURIComponent(id)}`;
    const res = await fetch(url, { credentials: 'include' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(await readError(res));
    const content = await gunzipResponse(res);
    this.trackContentCache.set(id, content);
    return content;
  }

  async listTracks(): Promise<StoredTrack[]> {
    await this.init();
    if (!this.session?.signedIn || this.publicUsername) return [];
    const res = await fetch('/api/user/tracks', { credentials: 'include' });
    if (!res.ok) return [];
    const body = (await res.json()) as { tracks: ApiTrack[] };
    return body.tracks.map((t) => apiTrackToStored(t));
  }

  async touchTrack(_id: string): Promise<void> {
    // No-op: GET bumps last_accessed_at on the server.
  }

  async deleteTrack(id: string): Promise<void> {
    await this.init();
    if (!this.session?.signedIn) return;
    if (this.publicUsername) throw new Error('Cannot delete in public-link mode');
    const res = await fetch(`/api/user/tracks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!res.ok) throw new Error(await readError(res));
    this.trackContentCache.delete(id);
  }

  // ── Annotations ───────────────────────────────────────────────────────────
  //
  // Annotations are scoped to a (user, track). The track owner can write;
  // anyone viewing can read. In public-link mode list*/store* operate against
  // /api/u/:username/ (read-only) and write methods are no-ops.

  async listAnnotations(trackId: string): Promise<AnnotationStroke[]> {
    await this.init();
    if (!trackId) return [];
    if (!this.session?.signedIn && !this.publicUsername) return [];
    const url = this.publicUsername
      ? `/api/u/${encodeURIComponent(this.publicUsername)}/track/${encodeURIComponent(trackId)}/annotations`
      : `/api/user/tracks/${encodeURIComponent(trackId)}/annotations`;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return [];
    const body = (await res.json()) as { annotations: ApiAnnotation[] };
    return body.annotations.map((a) => ({
      id: a.stroke_id,
      points: a.points,
      timestamp: a.timestamp,
      color: a.color,
      width: a.width,
    }));
  }

  async storeAnnotation(
    trackId: string,
    stroke: AnnotationStroke
  ): Promise<void> {
    await this.init();
    if (!trackId || !this.session?.signedIn || this.publicUsername) return;
    const res = await fetch(
      `/api/user/tracks/${encodeURIComponent(trackId)}/annotations/${encodeURIComponent(stroke.id)}`,
      {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          color: stroke.color,
          width: stroke.width,
          points: stroke.points,
          timestamp: stroke.timestamp,
        }),
      }
    );
    if (!res.ok) throw new Error(await readError(res));
  }

  async deleteAnnotation(trackId: string, strokeId: string): Promise<void> {
    await this.init();
    if (!trackId || !this.session?.signedIn || this.publicUsername) return;
    const res = await fetch(
      `/api/user/tracks/${encodeURIComponent(trackId)}/annotations/${encodeURIComponent(strokeId)}`,
      { method: 'DELETE', credentials: 'include' }
    );
    if (!res.ok && res.status !== 404)
      throw new Error(await readError(res));
  }

  async clearAnnotations(trackId: string): Promise<void> {
    await this.init();
    if (!trackId || !this.session?.signedIn || this.publicUsername) return;
    const res = await fetch(
      `/api/user/tracks/${encodeURIComponent(trackId)}/annotations`,
      { method: 'DELETE', credentials: 'include' }
    );
    if (!res.ok) throw new Error(await readError(res));
  }

  // ── Bulk clears (kept for API compat — current callers only fire these
  //    from the delete-account flow, which now does the work server-side). ──

  async clearAllTasks(): Promise<void> {
    // Server-side, account deletion cascades via the user FK. UI delete flows
    // call deleteTask per row.
  }

  async clearAllTracks(): Promise<void> {
    // See clearAllTasks().
  }

  async clearAll(): Promise<void> {
    // See clearAllTasks().
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  async getStats(): Promise<{ taskCount: number; trackCount: number }> {
    const [tasks, tracks] = await Promise.all([
      this.listTasks(),
      this.listTracks(),
    ]);
    return { taskCount: tasks.length, trackCount: tracks.length };
  }
}

export const storage = new StorageService();
