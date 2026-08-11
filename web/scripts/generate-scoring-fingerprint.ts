#!/usr/bin/env bun
/**
 * Write web/engine/src/scoring-fingerprint.generated.ts from the engine's
 * scoring sources.
 *
 * The engine is consumed as raw TypeScript everywhere — the package's
 * `exports` point at src/index.ts, wrangler's `main` is src/index.ts, and
 * vite, tsc and bun test all read the same files — so there is no bundle step
 * to hook. The generated module simply has to exist on disk before any of
 * them run, which is why this is called from `postinstall`, from `deps`, and
 * from the dev, build and deploy scripts.
 *
 * Usage:
 *   bun web/scripts/generate-scoring-fingerprint.ts           # write
 *   bun web/scripts/generate-scoring-fingerprint.ts --check   # verify only
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { relative } from 'node:path';
import {
  computeScoringFingerprint,
  renderGeneratedModule,
  GENERATED_MODULE,
} from './scoring-fingerprint';

const check = process.argv.includes('--check');
const quiet = process.argv.includes('--quiet');
const here = relative(process.cwd(), GENERATED_MODULE);

const fp = computeScoringFingerprint();
const wanted = renderGeneratedModule(fp);
const current = existsSync(GENERATED_MODULE) ? readFileSync(GENERATED_MODULE, 'utf8') : null;

if (current === wanted) {
  if (!quiet) console.log(`scoring fingerprint up to date (engine ${fp.version})`);
  process.exit(0);
}

if (check) {
  console.error(
    `${here} is ${current === null ? 'missing' : 'stale'}.\n\n` +
      `The scoring cache key is derived from the engine's ${fp.files.length} ` +
      `scoring sources, so it has to be regenerated after they change:\n\n` +
      `  bun run engine:fingerprint\n`,
  );
  process.exit(1);
}

// Only write when the content actually differs. An unconditional write would
// touch the mtime on every dev-server start and every script that calls this,
// which vite and wrangler both watch — a no-op regeneration would restart them.
writeFileSync(GENERATED_MODULE, wanted);
if (!quiet) {
  console.log(
    `${current === null ? 'wrote' : 'updated'} ${here} — engine ${fp.version} ` +
      `(${fp.fingerprint.slice(0, 12)}…, ${fp.files.length} sources)`,
  );
}
