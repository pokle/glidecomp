// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * Skip-unchanged logic for re-seeded tracks (migration 0032).
 *
 * A re-seed rebuilds a comp's D1 rows from the source folders, but the R2
 * objects are content-addressed by nothing — the key is `(comp, task,
 * pilot)` — so the only way to know an upload is redundant is to compare
 * content. The seed hashes each source IGC (SHA-256 of the raw text) and
 * compares it with the hash stored on the pilot's existing `task_track`
 * row; a match means the object already in R2 decompresses to exactly this
 * track, so the delete-and-put is skipped.
 *
 * The rules are deliberately conservative, because a wrong skip silently
 * serves stale scoring evidence:
 *
 *  - a NULL stored hash means "content unknown" and NEVER skips (rows
 *    written before 0032, or any path that failed to stamp one);
 *  - only an exact hash match skips; anything else re-uploads.
 *
 * On a skip, the D1 row keeps the OLD file_size: that is the byte size of
 * the gzip actually sitting in R2, and the freshly-compressed copy can be
 * a few bytes different (gzip output varies across zlib versions — the
 * very reason the hash covers the raw text, not the compressed bytes).
 */

/** What survives of a pilot's previous track row across the re-seed wipe. */
export interface OldTrackInfo {
  /** SHA-256 (hex) of the raw IGC text, or null when unknown. */
  hash: string | null;
  /** Byte size of the gzipped object in R2. */
  size: number;
}

export interface TrackSyncDecision {
  /** True: delete-and-put the object. False: the object in R2 already holds
   * this exact track — leave it alone. */
  upload: boolean;
  /** What the rebuilt task_track row's file_size should say — the size of
   * the object that will actually be in R2 after this seed. */
  fileSize: number;
}

/** Decide whether one pilot's track needs uploading, given what the wiped
 * row said about the object already in R2 (undefined: no previous row). */
export function trackSyncDecision(
  old: OldTrackInfo | undefined,
  sha256: string,
  newGzSize: number,
): TrackSyncDecision {
  if (old && old.hash !== null && old.hash === sha256) {
    return { upload: false, fileSize: old.size };
  }
  return { upload: true, fileSize: newGzSize };
}

/**
 * The previous seed's objects nothing in this seed claimed — tracks of
 * pilots or tasks the source no longer describes. Deleted at the END of the
 * seed (after every upload landed): a crash mid-seed then leaves at worst a
 * few unreachable objects, never a live row pointing at a deleted object.
 */
export function orphanedTrackKeys(
  oldKeys: Iterable<string>,
  liveKeys: ReadonlySet<string>,
): string[] {
  return [...oldKeys].filter((k) => !liveKeys.has(k));
}
