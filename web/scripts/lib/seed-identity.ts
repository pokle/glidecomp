// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * Stable identity for re-seeded competitions.
 *
 * A comp's task ids and pilot ids are surfaced in URLs (`/comp/:comp/task/:task
 * /pilot/:pilot`, sqid-encoded), so a re-seed that deletes and reinserts those
 * rows hands out fresh auto-increment ids and every shared link 404s. The comp
 * row itself has always been reused (matched by name), which is why comp ids
 * survive and the deeper ones did not.
 *
 * The fix is to match the same way one level down: a task is identified by its
 * seeded NAME within the comp, a pilot registration by the same (class, id-or-
 * name) key the seed already uses to collapse a pilot's tasks onto one
 * comp_pilot row. A match reuses the row (and its id); anything the source no
 * longer describes is deleted.
 *
 * These helpers are pure so the matching rule can be unit-tested without a
 * database — see seed-identity.test.ts.
 */

/**
 * Registry key for a pilot within a class: the federation id when known (the
 * primary match key), else the display name, scoped by pilot class. A pilot who
 * flew in two classes (e.g. floater one day, open the next) gets one comp_pilot
 * row per class; within a class, all their tasks share a single row.
 *
 * The `|` separator only has to be absent from `pilotClass`: the second field is
 * last and self-describing (`id:` / `name:`), so nothing a pilot name contains
 * can shift the parse. Classes come from the checked-in comp.json manifests
 * ("open" / "floater"), so `|` can't collide. This key is in-memory only — the
 * DB stores name / id / class as separate columns — so the separator is free to
 * change. (It used to be a literal NUL, which made the whole file read as binary
 * to grep/rg and git's word-diff; don't reintroduce one.)
 */
export function pilotKey(
  pilotClass: string,
  id: string | null,
  name: string,
): string {
  return `${pilotClass}|${id ? `id:${id}` : `name:${name}`}`;
}

/**
 * Match key for a pilot's DISPLAY NAME within a class, normalised the two ways
 * the same person's name differs between our two sources: the IGC header
 * (`HFPLTPILOT:`) and AirScore's published results table. Whitespace runs
 * collapse and case is dropped; nothing else is touched, because anything more
 * aggressive starts merging different people.
 */
export function pilotNameKey(pilotClass: string, name: string): string {
  return `${pilotClass}|${name.replace(/\s+/g, " ").trim().toLowerCase()}`;
}

/**
 * Index from (class, name) to the registry key of the pilot's ID-keyed
 * registration — the lookup that lets a TRACK-LESS published row join the
 * comp_pilot row its own tracked days already have.
 *
 * It is needed because the two sources identify a pilot differently: a task
 * folder's IGC filename carries their federation id (`emms_84258_050126.igc`),
 * while AirScore's published results table carries only a name. Keyed
 * separately, a pilot who flew one day and had an unusable tracklog on another
 * — a header-only "Failed security check" file, or none at all — split into TWO
 * comp_pilot rows: they appeared twice in the scores with a share of their
 * tasks each, and counted twice in the S7F §9.1 launch-validity buckets. The
 * Corryong Cup 2026 floater class publishes a block of 13 such rows; 15 of that
 * comp's 80 registrations were one person seeded twice.
 *
 * A name held by two DIFFERENT ids in one class is genuinely ambiguous — the
 * comp really does have two people of that name — and maps to null, so the
 * caller falls back to a name-keyed row rather than guessing which one flew.
 */
export function buildTrackedNameIndex(
  tracked: Iterable<{ pilotClass: string; name: string; id: string | null }>,
): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const p of tracked) {
    if (!p.id) continue; // name-keyed already — nothing to join onto
    const nameKey = pilotNameKey(p.pilotClass, p.name);
    const key = pilotKey(p.pilotClass, p.id, p.name);
    if (!index.has(nameKey)) index.set(nameKey, key);
    else if (index.get(nameKey) !== key) index.set(nameKey, null); // ambiguous
  }
  return index;
}

/**
 * The registry key for a track-less published pilot: their own ID-keyed
 * registration when the name resolves to exactly one, else a name-keyed row
 * (the historical behaviour, and the only safe answer when it's ambiguous).
 */
export function trackLessPilotKey(
  pilotClass: string,
  name: string,
  trackedByName: ReadonlyMap<string, string | null>,
): string {
  return (
    trackedByName.get(pilotNameKey(pilotClass, name)) ??
    pilotKey(pilotClass, null, name)
  );
}

/** "open" → "Open", so task names read "Task 1 (Open)". */
export function classLabel(pilotClass: string): string {
  return pilotClass.charAt(0).toUpperCase() + pilotClass.slice(1);
}

/**
 * The name a task is seeded under, and therefore the key it is matched by on a
 * re-seed. Open and floater "Task 1" share a date but are distinct rows, so the
 * class is part of the name (and of the identity).
 */
export function taskSeedName(name: string, pilotClass: string): string {
  return `${name} (${classLabel(pilotClass)})`;
}

/** An existing D1 row, reduced to the two things matching needs. */
export interface ExistingRow {
  id: number;
  key: string;
}

export interface MatchResult {
  /** key → the existing id to reuse. Only keys that matched appear. */
  reused: Map<string, number>;
  /** Existing ids the source no longer describes — delete them. */
  orphanIds: number[];
}

/**
 * Match the keys we are about to seed against the rows already in D1.
 *
 * Every wanted key that an existing row carries reuses that row's id; every
 * existing row left over is an orphan and must be deleted, so a re-seed still
 * leaves the comp holding exactly what the source describes.
 *
 * Duplicates on either side are handled deliberately rather than incidentally:
 *
 *  - Two existing rows with the same key (an admin hand-created a second
 *    "Task 2 (Open)", or a pilot got registered twice) can't both be reused —
 *    the seed's read-back maps a key to ONE id. The lowest id wins, since it is
 *    the one the older, already-shared URLs point at, and the rest join the
 *    orphans.
 *  - A repeated wanted key is a no-op: it resolves to the same id, which is the
 *    same collapsing the in-memory registry already does.
 */
export function matchExisting(
  wantedKeys: Iterable<string>,
  existing: readonly ExistingRow[],
): MatchResult {
  // Lowest id first, so the first row seen for a key is the one we keep.
  const byKey = new Map<string, number[]>();
  for (const row of [...existing].sort((a, b) => a.id - b.id)) {
    const ids = byKey.get(row.key);
    if (ids) ids.push(row.id);
    else byKey.set(row.key, [row.id]);
  }

  const reused = new Map<string, number>();
  for (const key of wantedKeys) {
    const ids = byKey.get(key);
    if (ids && ids.length > 0) reused.set(key, ids[0]);
  }

  const orphanIds: number[] = [];
  for (const [key, ids] of byKey) {
    // Every id beyond the first is a duplicate and always an orphan; the first
    // is an orphan only when nothing wanted it.
    const keep = reused.get(key);
    for (const id of ids) if (id !== keep) orphanIds.push(id);
  }
  orphanIds.sort((a, b) => a - b);
  return { reused, orphanIds };
}
