/**
 * The scoring engine's cache identity, DERIVED from its sources.
 *
 * The competition API folds this into every scoring cache key (task scores,
 * comp scores, per-track analysis, per-pilot transparency), so results
 * computed by two different engine generations can never be served side by
 * side. The identity therefore has to change whenever scoring behaviour
 * changes — and the only way to be sure of that without trusting a human to
 * remember is to make it a hash of the code itself.
 *
 * It used to be a hand-maintained integer beside a hand-pasted hash, guarded
 * by a test that failed until the two agreed. That guard worked, but it put
 * three merge conflicts in one file on every pair of parallel engine
 * branches, and one of them was not resolvable by picking a side: a hash over
 * the MERGED tree matches neither parent, so the correct value existed on
 * neither branch and had to be re-derived by hand after every merge. Deriving
 * it here makes the merged tree produce the right key by construction.
 *
 * Nothing orders this value — every consumer compares it with `=` or `!=`
 * (score-store.ts, field-analysis-store.ts, routes/cache.ts) or interpolates
 * it into a string key (state-key.ts, geom-hash.ts) — so an opaque number
 * serves as well as a sequence, and the readable history lives in
 * web/engine/scoring-changes/ instead.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { directorySourceTree, scoringSourceFiles } from './scoring-source-closure';

/** The engine's source root — what the closure walk and the hash range over. */
export const ENGINE_SRC_DIR = join(import.meta.dir, '..', 'engine', 'src');

/** The module this fingerprint is written into. Generated, and gitignored. */
export const GENERATED_MODULE = join(ENGINE_SRC_DIR, 'scoring-fingerprint.generated.ts');

/** Where a behaviour change is expected to leave a note. */
export const CHANGES_DIR = join(import.meta.dir, '..', 'engine', 'scoring-changes');

/**
 * Entry modules whose behaviour defines a score.
 *
 * track-quality.ts is here even though no other root imports it: the backend
 * calls it to decide whether a track is scored AT ALL, so a threshold re-tune
 * moves published scores. Without it in this list the hash would be silently
 * blind to exactly the code most likely to be adjusted later.
 *
 * manual-flight.ts is here for the same reason. It measures a track-less
 * pilot's flown distance and builds their FlightScoringData, and the backend
 * calls it directly (manual-flight-store.ts) rather than through any root
 * below — so its geometry reaches published scores while sitting outside
 * every other root's import closure.
 */
export const SCORING_ROOTS = [
  'gap-scoring.ts',
  'open-distance-scoring.ts',
  'turnpoint-sequence.ts',
  'igc-parser.ts',
  'xctsk-parser.ts',
  'track-quality.ts',
  'manual-flight.ts',
];

export interface ScoringFingerprint {
  /** SHA-256 (hex) over every scoring-relevant source, in path order. */
  fingerprint: string;
  /**
   * The cache key the engine exports: the leading 48 bits of the hash.
   *
   * 48 bits so it stays an exact JS integer (well under 2^53) and fits the
   * existing `engine_version INTEGER NOT NULL` column in task_scores and
   * task_field_analysis — no migration, no consumer change. Collisions are
   * the only failure mode and would take ~2^24 generations to become likely.
   */
  version: number;
  /** The hashed files, relative to the engine's src/, sorted. */
  files: string[];
}

/**
 * Hash the transitive import closure of {@link SCORING_ROOTS}.
 *
 * The construction — path, NUL, bytes, NUL, in sorted path order — is carried
 * over unchanged from the guard test this replaces, so the value stays
 * comparable with the fingerprints recorded against earlier generations. NUL
 * is the separator because it is the one byte that cannot appear in a path,
 * so no filename can forge a boundary. The old test spelled it as a literal
 * NUL character inside the quotes, which made the whole file grep as binary;
 * written as an escape it hashes identically and stays readable.
 */
export function computeScoringFingerprint(srcDir: string = ENGINE_SRC_DIR): ScoringFingerprint {
  const files = scoringSourceFiles(SCORING_ROOTS, directorySourceTree(srcDir));
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(readFileSync(join(srcDir, file)));
    hash.update('\0');
  }
  const fingerprint = hash.digest('hex');
  return {
    fingerprint,
    version: Number.parseInt(fingerprint.slice(0, 12), 16),
    files,
  };
}

/** The exact text {@link GENERATED_MODULE} should hold for this fingerprint. */
export function renderGeneratedModule(fp: ScoringFingerprint): string {
  return `// GENERATED FILE — do not edit, and do not commit it (it is gitignored).
//
// Written by web/scripts/generate-scoring-fingerprint.ts from the scoring
// source closure. Refresh it with \`bun run engine:fingerprint\`.
//
// Deriving this rather than declaring it is what keeps parallel engine
// branches from conflicting over a version number — see docs/scoring-version.md
// and the change notes in web/engine/scoring-changes/.

/** SHA-256 (hex) over the ${fp.files.length} scoring-relevant engine sources. */
export const SCORING_SOURCE_FINGERPRINT =
  "${fp.fingerprint}";

/** The leading 48 bits of that hash — the engine generation's cache key. */
export const SCORING_ENGINE_VERSION = ${fp.version};
`;
}
