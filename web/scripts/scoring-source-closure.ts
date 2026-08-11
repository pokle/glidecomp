/**
 * The import closure the scoring fingerprint guard hashes.
 *
 * Split out of the old scoring-version guard test so the traversal itself can
 * be tested.
 * It could not be before: it read the real src/ directory, so the only way to
 * ask "does this follow a subdirectory import?" was to move a scoring source
 * into a subdirectory and see what happened.
 *
 * Why the traversal has to be exact: the guard's promise is that changing any
 * file that can affect a score changes the engine generation, and so rolls
 * every scoring cache keyed by it. A dependency the walk fails to follow is
 * not a missing file in a list someone will notice — it is a hole that stays
 * open until a scoring change slips through it and two engine generations
 * serve contradictory cached scores. So a specifier this module cannot resolve is a hard error,
 * never a skip.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, normalize, sep } from 'node:path';

/**
 * The files a module depends on, as source text keyed by a path relative to
 * the source root. Abstracted so the traversal can be driven from an
 * in-memory tree in tests instead of the real directory.
 */
export interface SourceTree {
  read(path: string): string;
  exists(path: string): boolean;
}

/** A {@link SourceTree} over a real directory. */
export function directorySourceTree(root: string): SourceTree {
  return {
    read: (path) => readFileSync(join(root, path), 'utf8'),
    exists: (path) => existsSync(join(root, path)),
  };
}

/** A {@link SourceTree} over a map of path → source, for tests. */
export function virtualSourceTree(files: Record<string, string>): SourceTree {
  return {
    read: (path) => {
      const source = files[path];
      if (source === undefined) throw new Error(`no such file: ${path}`);
      return source;
    },
    exists: (path) => path in files,
  };
}

/**
 * Every relative module specifier in a source file.
 *
 * Covers the four spellings that create a dependency — `import … from 'x'`,
 * `export … from 'x'`, a side-effect `import 'x'`, and a dynamic
 * `import('x')` — because any of them can carry scoring code, and a spelling
 * this misses is a silent hole rather than a visible one.
 *
 * Specifiers inside comments are matched too. That is deliberate: filtering
 * them out means parsing the file, and over-collecting only ever hashes an
 * extra real file (or fails loudly on a specifier that names nothing), while
 * under-collecting is the failure this module exists to prevent.
 */
const RELATIVE_SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"](\.\.?\/[^'"]*)['"]/g;

/** Module specifiers TypeScript resolves without the extension being written. */
const IMPLICIT_EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

/**
 * Resolve one relative specifier to a path within the source root.
 *
 * Resolution is relative to the IMPORTING FILE's directory, not to the root —
 * that is the whole point. The previous walk joined every specifier onto the
 * root, which happened to be correct only because every scoring source sat
 * directly in src/, and would have silently mis-resolved `../geo` and
 * `./stats` the moment one didn't.
 */
export function resolveRelativeImport(
  fromFile: string,
  specifier: string,
  tree: SourceTree,
): string {
  const base = normalize(join(dirname(fromFile), specifier)).split(sep).join('/');

  if (base === '..' || base.startsWith('../')) {
    throw new Error(
      `Scoring source ${fromFile} imports '${specifier}', which resolves outside ` +
        `the engine's src/ directory. The fingerprint guard can only hash files ` +
        `beneath src/, so this dependency would go unhashed — move it under src/, ` +
        `or extend tests/scoring-source-closure.ts to cover it.`,
    );
  }

  for (const candidate of [base, ...IMPLICIT_EXTENSIONS.map((ext) => base + ext)]) {
    if (tree.exists(candidate)) return candidate;
  }

  throw new Error(
    `Scoring source ${fromFile} imports '${specifier}', which resolves to no file ` +
      `under src/ (tried ${base} and ${IMPLICIT_EXTENSIONS.join(', ')}). The ` +
      `fingerprint guard refuses to skip a dependency it cannot resolve, because ` +
      `an unfollowed import is a scoring change that ships without a version bump.`,
  );
}

/**
 * The transitive closure of `roots`, sorted, as paths relative to the source
 * root. Every path in the result is a file the tree could read.
 */
export function scoringSourceFiles(roots: string[], tree: SourceTree): string[] {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, specifier] of tree.read(file).matchAll(RELATIVE_SPECIFIER)) {
      queue.push(resolveRelativeImport(file, specifier, tree));
    }
  }
  return [...seen].sort();
}
