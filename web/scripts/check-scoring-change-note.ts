#!/usr/bin/env bun
/**
 * Fail when a branch changes the engine's scoring behaviour without saying
 * what moved.
 *
 * This is what is left of the old fingerprint guard. That guard's real value
 * was never the hash — the cache key derives itself now — it was that it
 * stopped an author and made them write down what changed and why. Thirty-odd
 * such notes exist, several citing the FAI spec clause and the archive
 * measurements behind a decision, and they are worth more than the version
 * number they were attached to.
 *
 * It compares against the MERGE BASE rather than a value checked into the
 * tree, which is the whole point: there is no stored baseline, so there is
 * nothing for two parallel branches to conflict over. A note is a new file in
 * web/engine/scoring-changes/, and two branches adding two different files
 * merge as pure additions.
 *
 * Usage:
 *   bun web/scripts/check-scoring-change-note.ts [--base <ref>]
 *
 * Skips itself (exit 0) when the base ref is unavailable — a shallow clone, a
 * detached checkout, or a tree with no git at all. It is a review aid, not a
 * correctness gate: nothing downstream depends on a note existing, so being
 * unable to check is not a reason to fail a build.
 */

import { spawnSync } from 'node:child_process';
import { relative } from 'node:path';
import {
  computeScoringFingerprint,
  ENGINE_SRC_DIR,
  CHANGES_DIR,
} from './scoring-fingerprint';

const REPO_ROOT = process.cwd();
const SRC_PREFIX = `${relative(REPO_ROOT, ENGINE_SRC_DIR)}/`;
const NOTES_PREFIX = `${relative(REPO_ROOT, CHANGES_DIR)}/`;

function git(...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

const baseFlag = process.argv.indexOf('--base');
const requested = baseFlag !== -1 ? process.argv[baseFlag + 1] : undefined;
const candidates = requested ? [requested] : ['origin/master', 'master'];

let base: string | undefined;
for (const ref of candidates) {
  const merged = git('merge-base', 'HEAD', ref);
  if (merged.ok && merged.out) {
    base = merged.out;
    break;
  }
}

if (!base) {
  console.log(
    `scoring change note: skipped — no merge base against ${candidates.join(' or ')}`,
  );
  process.exit(0);
}

// Diffed against the merge base with no second endpoint, so the WORKING TREE
// is what gets compared. CI has everything committed either way, but locally
// this is the difference between the check being useful before you commit and
// only telling you off afterwards. Untracked files need asking for separately
// — a brand new note is the normal case here, and `git diff` cannot see one.
const diff = git('diff', '--name-only', base);
if (!diff.ok) {
  console.log('scoring change note: skipped — could not diff against the merge base');
  process.exit(0);
}
const untracked = git('ls-files', '--others', '--exclude-standard');

const changed = [...diff.out.split('\n'), ...untracked.out.split('\n')].filter(Boolean);

// Only the files the fingerprint actually hashes count as a scoring change.
// Anything else under src/ — task analysis, weather, the 3D replay — cannot
// move a published score and needs no note.
const hashed = new Set(
  computeScoringFingerprint().files.map((f) => `${SRC_PREFIX}${f}`),
);
const touched = changed.filter((f) => hashed.has(f));

if (touched.length === 0) {
  console.log('scoring change note: not required — no scoring source changed');
  process.exit(0);
}

const notes = changed.filter(
  (f) => f.startsWith(NOTES_PREFIX) && f.endsWith('.md') && !f.endsWith('README.md'),
);

if (notes.length > 0) {
  console.log(
    `scoring change note: ok — ${notes.length} note(s) for ${touched.length} changed scoring source(s)`,
  );
  process.exit(0);
}

console.error(
  `This branch changes ${touched.length} scoring source(s):\n` +
    touched.map((f) => `  ${f}`).join('\n') +
    `\n\nEvery such change rolls the engine generation and re-scores every ` +
    `competition that reads it, so it needs a note saying what moved and why.\n\n` +
    `Add one file to ${NOTES_PREFIX} — see its README for the shape:\n\n` +
    `  ${NOTES_PREFIX}NNN-short-slug.md\n\n` +
    `Say whether points move, and if they do, by how much and for whom. If ` +
    `nothing observable changes (a refactor, a comment), say that — the ` +
    `generation still rolls, and a reader of the changelog linked from ` +
    `/scoring deserves to know the recompute was harmless.\n`,
);
process.exit(1);
