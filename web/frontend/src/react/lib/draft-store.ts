/**
 * Drafts that survive navigation: work an organiser has started and not yet
 * saved, kept where a reload, Back and Forward can find it again.
 *
 * The overlays rule in CLAUDE.md made every editor a page, and a page cannot
 * be handed state in memory by the page underneath it — a reload, or a link
 * opened elsewhere, would not have it. Most pages simply fetch what they need.
 * A draft is the exception: a CSV file read in the browser (the roster import,
 * #810), a waypoint file edited before it is saved as a set (#811), a task
 * route edited before it is saved (#812). Nothing on the server holds those
 * yet, so the browser has to. See docs/drafts.md for the decision and what it
 * weighed.
 *
 * **sessionStorage, keyed by what the draft edits.** One store per kind of
 * draft (`defineDraft`), and inside it one draft per key — the comp's id for
 * the roster import, the comp and task for a route. Per tab: two tabs hold two
 * drafts that never clobber each other, and a tab closed takes its drafts with
 * it. A few megabytes is far more than a roster or a waypoint file needs.
 *
 * **Never another account's.** Each draft records the user it belongs to, and
 * one read by anyone else is thrown away unread. `signOut()` clears them all
 * (auth/client.ts), so a hidden comp's roster never waits in a shared browser
 * for the next person to sign in.
 *
 * **Never an old shape.** Each kind has a `version`; a draft stored under any
 * other (a tab that outlived a deploy which changed the shape) is thrown away,
 * as is one older than `maxAgeMs` (a tab its browser restored a week later).
 * `isValid` can check the value itself too.
 *
 * So a load can always come back empty, and every page that reads a draft
 * says what it does then: the import page starts again at choosing the file.
 *
 * Pure apart from the storage it is given — no React here (the hook is
 * `use-draft.ts`), and no `window` at module scope (SSR-safe).
 */

/** Every draft's storage key starts with this. */
export const DRAFT_PREFIX = "glidecomp:draft:";

/** A day: long enough for an afternoon's editing, short of a restored tab. */
export const DEFAULT_DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** What a draft edits, most general first: `[compId]`, `[compId, taskId]`. */
export type DraftKey = readonly string[];

/** What is written to storage, around the value. */
interface StoredDraft {
  /** The kind's version when it was saved. */
  v: number;
  /** The user id it belongs to. */
  owner: string;
  /** When it was saved, ms since the epoch. */
  at: number;
  value: unknown;
}

export interface DraftStore<T> {
  readonly kind: string;
  /**
   * The draft under `key`, if there is one that `owner` saved, in this
   * kind's current shape, recently enough. Anything else is removed and
   * reads as null.
   */
  load(key: DraftKey, owner: string): T | null;
  /**
   * Keep `value` under `key` for `owner`. False when storage refused it (full,
   * or blocked): the caller still has the value, it just will not survive a
   * reload.
   */
  save(key: DraftKey, owner: string, value: T): boolean;
  /** Forget the draft under `key`: it was saved, discarded or replaced. */
  clear(key: DraftKey): void;
}

export interface DraftOptions<T> {
  /** Names the editor, and is part of every key: "roster-import". */
  kind: string;
  /**
   * The shape of `T`. Bump it when that shape changes: a draft saved under
   * another version is thrown away rather than read as this one.
   */
  version: number;
  /** A deeper check of a stored value than its version. */
  isValid?: (value: unknown) => value is T;
  /** How long a draft is kept. Defaults to a day. */
  maxAgeMs?: number;
  /** For tests. */
  now?: () => number;
  /** For tests. Defaults to this tab's sessionStorage, or none. */
  storage?: () => Storage | null;
}

/**
 * This tab's sessionStorage, or null where there is none — on the server, or
 * where the browser refuses it (reading `window.sessionStorage` itself throws
 * when storage is blocked).
 */
export function sessionDraftStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The storage key for one draft. Each part is encoded, so none can forge a `/`. */
export function draftStorageKey(kind: string, key: DraftKey): string {
  return `${DRAFT_PREFIX}${encodeURIComponent(kind)}:${key.map(encodeURIComponent).join("/")}`;
}

function isStoredDraft(x: unknown): x is StoredDraft {
  if (typeof x !== "object" || x === null) return false;
  const d = x as Record<string, unknown>;
  return (
    typeof d.v === "number" &&
    typeof d.owner === "string" &&
    typeof d.at === "number" &&
    "value" in d
  );
}

export function defineDraft<T>(options: DraftOptions<T>): DraftStore<T> {
  const {
    kind,
    version,
    isValid,
    maxAgeMs = DEFAULT_DRAFT_MAX_AGE_MS,
    now = Date.now,
    storage = sessionDraftStorage,
  } = options;

  function remove(store: Storage, storageKey: string) {
    try {
      store.removeItem(storageKey);
    } catch {
      // Nothing to do: a store that refuses a removal refused the write too.
    }
  }

  return {
    kind,
    load(key, owner) {
      const store = storage();
      if (!store) return null;
      const storageKey = draftStorageKey(kind, key);
      let raw: string | null;
      try {
        raw = store.getItem(storageKey);
      } catch {
        return null;
      }
      if (raw === null) return null;
      let stored: unknown;
      try {
        stored = JSON.parse(raw);
      } catch {
        stored = null;
      }
      const age = isStoredDraft(stored) ? now() - stored.at : NaN;
      const usable =
        isStoredDraft(stored) &&
        stored.v === version &&
        stored.owner === owner &&
        age >= 0 &&
        age <= maxAgeMs &&
        (!isValid || isValid(stored.value));
      if (!usable) {
        // Someone else's, an old shape, too old, or not a draft at all: it is
        // never going to be read, so it does not stay.
        remove(store, storageKey);
        return null;
      }
      return (stored as StoredDraft).value as T;
    },
    save(key, owner, value) {
      const store = storage();
      if (!store) return false;
      const stored: StoredDraft = { v: version, owner, at: now(), value };
      try {
        store.setItem(draftStorageKey(kind, key), JSON.stringify(stored));
        return true;
      } catch {
        return false;
      }
    },
    clear(key) {
      const store = storage();
      if (store) remove(store, draftStorageKey(kind, key));
    },
  };
}

/**
 * Forget every draft of every kind in this tab — at sign-out, so nothing one
 * account was editing is left for the next.
 */
export function clearAllDrafts(storage: Storage | null = sessionDraftStorage()): void {
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k?.startsWith(DRAFT_PREFIX)) keys.push(k);
    }
    for (const k of keys) storage.removeItem(k);
  } catch {
    // Storage blocked: then nothing was ever stored in it either.
  }
}
