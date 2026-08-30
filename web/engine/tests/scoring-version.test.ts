/**
 * Guards the scoring cache-consistency invariant.
 *
 * The competition API keys every scoring cache entry by
 * SCORING_ENGINE_VERSION, guaranteeing a cached score and a cached per-pilot
 * analysis always come from the same engine generation and therefore always
 * agree. That guarantee now holds by construction — the generation IS a hash
 * of the scoring sources — so what is left to check is the one seam the
 * derivation has: the generated module is written to disk by a separate step,
 * and everything that consumes it (tsc, vite, wrangler, bun test) reads that
 * file rather than recomputing.
 *
 * So this asserts the file on disk matches the sources beside it. It fails
 * when someone edits a scoring source and runs the tests without
 * regenerating — the state in which the engine would ship a cache key that
 * does not describe its own code.
 *
 * When it fails: `bun run engine:fingerprint`. There is no number to bump and
 * no hash to paste; `bun run deps` (and therefore `bun run test`) regenerates
 * before anything reads it, so this only fires on a direct `bun test`.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import {
  SCORING_ENGINE_VERSION,
  SCORING_SOURCE_FINGERPRINT,
} from '../src/scoring-version';
import {
  computeScoringFingerprint,
  renderGeneratedModule,
  GENERATED_MODULE,
} from '../../scripts/scoring-fingerprint';

describe('scoring engine version', () => {
  it('is the content hash of the scoring sources on disk', () => {
    const fp = computeScoringFingerprint();

    if (fp.fingerprint !== SCORING_SOURCE_FINGERPRINT) {
      throw new Error(
        `The generated scoring fingerprint is stale.\n\n` +
          `The competition API keys its scoring caches by SCORING_ENGINE_VERSION ` +
          `so cached scores and analyses always come from one engine generation. ` +
          `That value is derived from the ${fp.files.length} scoring sources ` +
          `(${fp.files.join(', ')}), which have changed since it was last written.\n\n` +
          `  bun run engine:fingerprint\n\n` +
          `Then describe what moved in a new web/engine/scoring-changes/ note.`,
      );
    }

    expect(SCORING_ENGINE_VERSION).toBe(fp.version);
  });

  it('writes a module byte-for-byte reproducible from the sources', () => {
    // The generator only writes when the content differs, so a mismatch here
    // would mean a hand edit to a file whose header says not to edit it.
    expect(existsSync(GENERATED_MODULE)).toBe(true);
    expect(readFileSync(GENERATED_MODULE, 'utf8')).toBe(
      renderGeneratedModule(computeScoringFingerprint()),
    );
  });

  it('derives a version that fits an exact integer and the D1 column', () => {
    // engine_version is INTEGER NOT NULL in task_scores (migration 0012) and
    // task_analysis (0019), and every consumer compares it with =/!=.
    // 48 bits keeps it an exact JS integer, so no consumer needs to change.
    expect(Number.isSafeInteger(SCORING_ENGINE_VERSION)).toBe(true);
    expect(SCORING_ENGINE_VERSION).toBeGreaterThan(0);
    expect(SCORING_ENGINE_VERSION).toBeLessThan(2 ** 48);
  });
});
